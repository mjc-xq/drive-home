// Shared road-prep helpers for BOTH exporters (export_property_glb.mjs and
// export_stylized_glb.mjs) so the photo and stylized models draw IDENTICAL roads.
//
// What lives here (all pure geometry, no THREE dependency):
//   clipPolylineToBox(lw, H)  - Liang-Barsky segment clip to [-H,H]^2; emits
//                               edge-exact crossings and splits a road that leaves
//                               and re-enters the box into several pieces.
//   smoothLine(lw)            - centripetal Catmull-Rom (alpha=0.5) curve pass,
//                               gated so only genuinely-curved vertices (turn angle
//                               8deg..100deg) are rounded; straight runs and ~square
//                               junction corners are left crisp.
//   buildVertHit(roads, w2)   - Map of quantized world vertex -> touch count, shared
//                               by the cul-de-sac and junction logic.
//   vkey(x, z)                - the quantization key used by buildVertHit.
//   roadSpec(r)               - { width, lanes, isService } from r.k / r.w.
//   isCulDeSacRoad(r)         - true only for named courts/cul-de-sacs needing bulbs.
//   snapCreekToChannel(...)   - pull a creek centreline toward the DEM channel bottom.
//   buildSidewalkConnectors(...) - rounded sidewalk returns around intersections.
//   buildSidewalkEndCaps(...) - U-shaped sidewalk returns at residential dead ends.
//   fanDisc / ringAnnulus     - triangle-fan disc + curb annulus (callbacks emit
//                               into the caller's pos/idx arrays so the exporter
//                               controls terrain height + lift).
//   trimEndInward(piece, t)   - move a clipped piece's end vertex inward along its
//                               tangent (junction gapping).
//   nearAny(x, z, pts, r)     - true if (x,z) is within r of any point in pts.

// ---- segment clip (Liang-Barsky) -----------------------------------------
// Clip a single segment a->b to the square [-H,H]^2. Returns the clipped
// [pa, pb] (each a fresh [x,z]) or null if the segment is fully outside.
function clipSeg(ax, az, bx, bz, H) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const p = [-dx, dx, -dz, dz];
  const q = [ax + H, H - ax, az + H, H - az];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; }       // parallel & outside
    else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
  }
  return [[ax + t0 * dx, az + t0 * dz], [ax + t1 * dx, az + t1 * dz]];
}

// Clip a whole world polyline to [-H,H]^2, returning an ARRAY of pieces (each
// >=2 pts). Walks segment by segment, stitching consecutive in-box clipped
// segments into one piece and starting a new piece whenever the road leaves
// the box. Crossings land exactly on the box edge (no snapping to an interior
// vertex, which was the truncation bug).
export function clipPolylineToBox(lw, H) {
  const pieces = [];
  let cur = null;
  const EPS = 1e-6;
  const same = (p, q) => Math.abs(p[0] - q[0]) < EPS && Math.abs(p[1] - q[1]) < EPS;
  for (let k = 1; k < lw.length; k++) {
    const a = lw[k - 1], b = lw[k];
    const c = clipSeg(a[0], a[1], b[0], b[1], H);
    if (!c) { cur = null; continue; }                    // segment fully outside -> break run
    const [ca, cb] = c;
    if (cur && same(cur[cur.length - 1], ca)) cur.push(cb);
    else { cur = [ca, cb]; pieces.push(cur); }
    // if the clipped segment ended before b (left the box), force a break
    if (!same(cb, b)) cur = null;
  }
  return pieces.filter(p => p.length >= 2);
}

// ---- curve smoothing (centripetal Catmull-Rom, gated) --------------------
const SMOOTH_STEP = 4.0;                                  // m between spline samples
function turnAngle(p0, p1, p2) {
  const ax = p1[0] - p0[0], az = p1[1] - p0[1], bx = p2[0] - p1[0], bz = p2[1] - p1[1];
  const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
  let c = (ax * bx + az * bz) / (la * lb);
  c = Math.max(-1, Math.min(1, c));
  return Math.acos(c);                                    // 0 = straight, pi = U-turn
}
// Only smooth a vertex whose turn angle is in [8deg, 100deg]: leave near-straight
// runs and ~square junction corners alone so grids/corners stay crisp.
const LO = 8 * Math.PI / 180, HI = 100 * Math.PI / 180;
export function smoothLine(lw) {
  if (lw.length < 3) return lw.map(p => [p[0], p[1]]);
  // decide per-interior-vertex whether it should be rounded
  const round = new Array(lw.length).fill(false);
  for (let i = 1; i < lw.length - 1; i++) {
    const a = turnAngle(lw[i - 1], lw[i], lw[i + 1]);
    round[i] = a >= LO && a <= HI;
  }
  const out = [[lw[0][0], lw[0][1]]];
  for (let i = 0; i < lw.length - 1; i++) {
    const P1 = lw[i], P2 = lw[i + 1];
    // only spline the span if at least one of its endpoints is a "round" vertex
    if (!round[i] && !round[i + 1]) { out.push([P2[0], P2[1]]); continue; }
    const P0 = lw[Math.max(0, i - 1)], P3 = lw[Math.min(lw.length - 1, i + 2)];
    const segLen = Math.hypot(P2[0] - P1[0], P2[1] - P1[1]);
    const N = Math.max(2, Math.ceil(segLen / SMOOTH_STEP));
    for (let s = 1; s <= N; s++) {
      const t = s / N, t2 = t * t, t3 = t2 * t;
      const bx = 0.5 * ((2 * P1[0]) + (-P0[0] + P2[0]) * t + (2 * P0[0] - 5 * P1[0] + 4 * P2[0] - P3[0]) * t2 + (-P0[0] + 3 * P1[0] - 3 * P2[0] + P3[0]) * t3);
      const bz = 0.5 * ((2 * P1[1]) + (-P0[1] + P2[1]) * t + (2 * P0[1] - 5 * P1[1] + 4 * P2[1] - P3[1]) * t2 + (-P0[1] + 3 * P1[1] - 3 * P2[1] + P3[1]) * t3);
      out.push([bx, bz]);
    }
  }
  return out;
}

// ---- shared junction / cul-de-sac vertex map -----------------------------
export const vkey = (x, z) => `${x.toFixed(1)},${z.toFixed(1)}`;
// Count how many road vertices land on each quantized world position. A tip with
// count<=1 is a dead-end; a vertex with count>=2 is a junction.
export function buildVertHit(roads, w2) {
  const m = new Map();
  for (const r of roads) {
    const pl = r.p || r; if (!Array.isArray(pl)) continue;
    for (const [e, n] of pl) {
      const [x, z] = w2(e, n);
      const k = vkey(x, z); m.set(k, (m.get(k) || 0) + 1);
    }
  }
  return m;
}

// ---- width / lanes from class ---------------------------------------------
// Realistic carriageway widths. OSM r.w (when present) is often a thin centreline
// hint; clamp named streets to a class FLOOR so roads never render too narrow.
// Service ways are driveways/parking aisles in this export, so keep them driveway
// sized instead of inflating them to a full residential street.
export function roadSpec(r) {
  const k = r.k;
  const w = +r.w || 0;
  if (k === 'tertiary') return { width: Math.max(11, w), lanes: 2, isService: false };
  if (k === 'residential') return { width: Math.max(9, w), lanes: 2, isService: false };
  if (k === 'service') {
    const service = String(r.s || '').toLowerCase();
    return { width: service === 'parking_aisle' ? 5.0 : 3.6, lanes: 1, isService: true };
  }
  return { width: Math.max(9, w), lanes: 2, isService: false };
}
// rank for junction priority (higher wins / runs unbroken)
export function roadRank(r) {
  const k = r.k;
  if (k === 'tertiary') return 3;
  if (k === 'residential') return 2;
  if (k === 'service') return 1;
  return 2;
}

// Only named courts / cul-de-sac style roads should get a bulb. Treating every
// residential dead-end as a court creates big black discs on ordinary road stubs
// and clipped OSM segments.
export function isCulDeSacRoad(r) {
  const name = String(r?.n || '').toLowerCase();
  return /\b(court|ct|cul[- ]?de[- ]?sac|circle|cir)\b/.test(name);
}

// Pull each creek vertex toward the lowest DEM point along a perpendicular probe.
// The raw OSM waterway is a centreline hint; the bare-earth DEM is the best local
// evidence for the actual channel. A small smoothing pass removes vertex-to-vertex
// zig-zag from the probe while preserving the broad path.
export function snapCreekToChannel(lineW, terrainAt, opts = {}) {
  const radius = opts.radius ?? 18;
  const step = opts.step ?? 1.5;
  const strength = opts.strength ?? 0.9;
  const smoothPasses = opts.smoothPasses ?? 2;
  if (!Array.isArray(lineW) || lineW.length < 3) return (lineW || []).map(p => [p[0], p[1]]);

  let out = lineW.map((p, i) => {
    const a = lineW[Math.max(0, i - 1)], b = lineW[Math.min(lineW.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    const nx = -dz, nz = dx;
    let bx = p[0], bz = p[1], bh = terrainAt(p[0], p[1]);
    for (let t = -radius; t <= radius + 1e-6; t += step) {
      const x = p[0] + nx * t, z = p[1] + nz * t;
      const h = terrainAt(x, z);
      if (h < bh) { bh = h; bx = x; bz = z; }
    }
    return [p[0] + (bx - p[0]) * strength, p[1] + (bz - p[1]) * strength];
  });

  for (let pass = 0; pass < smoothPasses; pass++) {
    const sm = out.map(p => [p[0], p[1]]);
    for (let i = 1; i < out.length - 1; i++) {
      sm[i] = [
        (out[i - 1][0] + out[i][0] * 2 + out[i + 1][0]) / 4,
        (out[i - 1][1] + out[i][1] * 2 + out[i + 1][1]) / 4,
      ];
    }
    out = sm;
  }
  return out;
}

// Build rounded sidewalk connector arcs around each road junction. The main sidewalk
// ribbons run parallel to road centrelines and are intentionally gapped near
// intersections; these arcs sew those ends together around the curb return instead
// of leaving squared-off, non-meeting strips.
export function buildSidewalkConnectors(roads, w2, opts = {}) {
  const sideGap = opts.sideGap ?? 2.2;         // centre of walk = road edge + gap
  const leadExtra = opts.leadExtra ?? 1.2;     // how far along each arm before curving
  const maxGap = opts.maxGapRad ?? (145 * Math.PI / 180);
  const minGap = opts.minGapRad ?? (18 * Math.PI / 180);
  const step = opts.step ?? 2.2;
  const inPatch = opts.inPatch || (() => true);
  const hit = buildVertHit(roads, w2);
  const byJunction = new Map();

  const addArm = (key, j, r, vi, ni) => {
    if (roadSpec(r).isService) return;         // driveways/service roads do not get sidewalks
    const p = w2(...j), q = w2(...r.p[ni]);
    let dx = q[0] - p[0], dz = q[1] - p[1];
    const L = Math.hypot(dx, dz);
    if (L < 0.5) return;
    dx /= L; dz /= L;
    const spec = roadSpec(r);
    const sideDist = spec.width / 2 + sideGap;
    const lead = Math.max(3.0, Math.min(8.0, spec.width / 2 + leadExtra));
    let bucket = byJunction.get(key);
    if (!bucket) {
      bucket = { c: p, pts: [] };
      byJunction.set(key, bucket);
    }
    const armKey = `${key}/${vi}/${ni}/${r.n || r.k || ''}`;
    for (const side of [1, -1]) {
      const nx = -dz * side, nz = dx * side;
      const x = p[0] + dx * lead + nx * sideDist;
      const z = p[1] + dz * lead + nz * sideDist;
      if (!inPatch(x, z)) continue;
      bucket.pts.push({ x, z, a: Math.atan2(z - p[1], x - p[0]), armKey, side, dx, dz });
    }
  };

  for (const r of roads || []) {
    const pl = r.p || r;
    if (!Array.isArray(pl)) continue;
    for (let i = 0; i < pl.length; i++) {
      const p = w2(...pl[i]);
      const key = vkey(p[0], p[1]);
      if ((hit.get(key) || 0) < 2) continue;
      if (i > 0) addArm(key, pl[i], r, i, i - 1);
      if (i < pl.length - 1) addArm(key, pl[i], r, i, i + 1);
    }
  }

  const arcs = [];
  const normGap = (a0, a1) => {
    let g = a1 - a0;
    while (g <= 0) g += Math.PI * 2;
    return g;
  };
  for (const { c, pts } of byJunction.values()) {
    // Merge duplicate endpoints from split OSM ways that share the same arm.
    const unique = [];
    for (const p of pts.sort((a, b) => a.a - b.a)) {
      if (!unique.some(q => Math.hypot(q.x - p.x, q.z - p.z) < 0.8)) unique.push(p);
    }
    // If two road ways meet as a straight continuation, the corner-return arcs below
    // intentionally skip the ~180 degree gap. Add same-side straight bridges so the
    // sidewalk remains continuous through split OSM ways and simple through-junctions.
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const p0 = unique[i], p1 = unique[j];
        if (p0.armKey === p1.armKey) continue;
        const dot = p0.dx * p1.dx + p0.dz * p1.dz;
        if (dot > -0.92) continue;                  // only near-collinear arms
        if (p0.side !== -p1.side) continue;          // same physical side of the road
        if (Math.hypot(p0.x - p1.x, p0.z - p1.z) > 18) continue;
        arcs.push([[p0.x, p0.z], [p1.x, p1.z]]);
      }
    }

    if (unique.length < 3) continue;
    for (let i = 0; i < unique.length; i++) {
      const p0 = unique[i], p1 = unique[(i + 1) % unique.length];
      if (p0.armKey === p1.armKey) continue;       // never bridge across one road mouth
      const gap = normGap(p0.a, p1.a);
      if (gap < minGap || gap > maxGap) continue;
      const r0 = Math.hypot(p0.x - c[0], p0.z - c[1]);
      const r1 = Math.hypot(p1.x - c[0], p1.z - c[1]);
      const steps = Math.max(2, Math.ceil(gap * Math.max(r0, r1) / step));
      const arc = [];
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const a = p0.a + gap * t;
        const rr = r0 * (1 - t) + r1 * t;
        const x = c[0] + Math.cos(a) * rr;
        const z = c[1] + Math.sin(a) * rr;
        if (!inPatch(x, z)) continue;
        arc.push([x, z]);
      }
      if (arc.length >= 2) arcs.push(arc);
    }
  }
  return arcs;
}

// Build U-shaped sidewalk returns around ordinary residential dead ends. These are
// distinct from court bulbs: the road stays a normal terminal street, but the walks
// on each side meet around the end instead of stopping as two unrelated strips.
export function buildSidewalkEndCaps(roads, w2, opts = {}) {
  const sideGap = opts.sideGap ?? 2.2;
  const step = opts.step ?? 2.0;
  const inPatch = opts.inPatch || (() => true);
  const isCourt = opts.isCourt || isCulDeSacRoad;
  const hit = buildVertHit(roads, w2);
  const arcs = [];

  for (const r of roads || []) {
    const pl = r.p || r;
    if (!Array.isArray(pl) || pl.length < 2) continue;
    const spec = roadSpec(r);
    if (spec.isService || isCourt(r)) continue;

    for (const end of [0, pl.length - 1]) {
      const tip = w2(...pl[end]);
      const key = vkey(tip[0], tip[1]);
      if ((hit.get(key) || 0) > 1) continue;
      if (!inPatch(tip[0], tip[1])) continue;

      const prev = w2(...pl[end === 0 ? 1 : pl.length - 2]);
      let tx = tip[0] - prev[0], tz = tip[1] - prev[1];
      const L = Math.hypot(tx, tz);
      if (L < 0.5) continue;
      tx /= L; tz /= L;

      const radius = spec.width / 2 + sideGap;
      const theta = Math.atan2(tz, tx);
      const steps = Math.max(6, Math.ceil(Math.PI * radius / step));
      const arc = [];
      for (let s = 0; s <= steps; s++) {
        const a = theta + Math.PI / 2 - Math.PI * s / steps;
        const x = tip[0] + Math.cos(a) * radius;
        const z = tip[1] + Math.sin(a) * radius;
        if (!inPatch(x, z)) continue;
        arc.push([x, z]);
      }
      if (arc.length >= 2) arcs.push(arc);
    }
  }
  return arcs;
}

// ---- triangle-fan disc + curb annulus ------------------------------------
// fanDisc emits a filled disc (centre + N rim verts) by calling emit(x,z) for
// each vertex, which returns the vertex index; the caller pushes the position
// (with terrain height + lift) and we wire up the fan triangles.
export function fanDisc(cx, cz, R, N, emit, idxArr) {
  const cIdx = emit(cx, cz);
  const rim = [];
  for (let k = 0; k < N; k++) {
    const a = k / N * Math.PI * 2;
    rim.push(emit(cx + Math.cos(a) * R, cz + Math.sin(a) * R));
  }
  for (let k = 0; k < N; k++) idxArr.push(cIdx, rim[k], rim[(k + 1) % N]);
}
// ringAnnulus emits a curb ring (inner radius rIn, outer rOut) the same way.
export function ringAnnulus(cx, cz, rIn, rOut, N, emit, idxArr) {
  const inner = [], outer = [];
  for (let k = 0; k < N; k++) {
    const a = k / N * Math.PI * 2;
    inner.push(emit(cx + Math.cos(a) * rIn, cz + Math.sin(a) * rIn));
    outer.push(emit(cx + Math.cos(a) * rOut, cz + Math.sin(a) * rOut));
  }
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N;
    idxArr.push(inner[k], outer[k], inner[k1], inner[k1], outer[k], outer[k1]);
  }
}

// ---- junction helpers -----------------------------------------------------
// Move the end (first or last) vertex of a piece inward by dist along the
// tangent, so a side street butts up to (rather than overlaps) a through road.
// Mutates and returns the piece.
export function trimEndInward(piece, which, dist) {
  if (piece.length < 2) return piece;
  if (which === 'last') {
    const b = piece[piece.length - 1], a = piece[piece.length - 2];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1;
    if (dist >= L) return piece;                          // don't invert a short segment
    piece[piece.length - 1] = [b[0] - dx / L * dist, b[1] - dz / L * dist];
  } else {
    const a = piece[0], b = piece[1];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1;
    if (dist >= L) return piece;
    piece[0] = [a[0] + dx / L * dist, a[1] + dz / L * dist];
  }
  return piece;
}

export function nearAny(x, z, pts, r) {
  const r2 = r * r;
  for (const [px, pz] of pts) { const dx = x - px, dz = z - pz; if (dx * dx + dz * dz < r2) return true; }
  return false;
}

// ---- sidewalks derived from PARCEL front edges ---------------------------
// Real sidewalks border the property line and follow its curve. We build them from
// the parcel rings (parcels.json, WORLD coords): an edge is "road-facing" when its
// midpoint sits in a band just outside the carriageway (close enough to be the front
// edge, far enough to not be IN the road). Consecutive road-facing edges of a parcel
// are chained into a polyline so the ribbon curves continuously along the lot line.
// Returns an array of world polylines, each pushed STREET-SIDE of the property line
// by `inset` metres (so the concrete ribbon hugs the line on the road side).
//
//   parcels   : [{ ring:[[x,z],...] }]  world XZ rings
//   roadSegs  : [[ [ax,az],[bx,bz] ], ...]  world road centreline segments + half-widths
//   opts.bandMin / bandMax : how far (m) an edge midpoint may sit from a road centre
//                            to count as front-facing (defaults 4.5 .. 13)
//   opts.inset : push toward the road by this many m (default 0.4) so the ribbon
//                sits just street-side of the property line
//   opts.inPatch(x,z) : keep only edges whose midpoint is on terrain (optional)
export function distToSegs(px, pz, segs) {
  let best = Infinity;
  for (const [a, b] of segs) {
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const L2 = dx * dx + dz * dz || 1;
    let t = ((px - a[0]) * dx + (pz - a[1]) * dz) / L2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (a[0] + t * dx), pz - (a[1] + t * dz));
    if (d < best) best = d;
  }
  return best;
}
export function buildParcelSidewalks(parcels, roadSegs, opts = {}) {
  const bandMin = opts.bandMin ?? 4.5;
  const bandMax = opts.bandMax ?? 13;
  const inset = opts.inset ?? 0.4;
  const inPatch = opts.inPatch || (() => true);
  const minEdge = opts.minEdge ?? 1.2;           // drop tiny ring nicks
  const out = [];
  for (const p of parcels) {
    const ring = p.ring || p; if (!Array.isArray(ring) || ring.length < 3) continue;
    const N = ring.length;
    // closed ring: detect duplicate last==first
    const closed = Math.hypot(ring[0][0] - ring[N - 1][0], ring[0][1] - ring[N - 1][1]) < 1e-6;
    const M = closed ? N - 1 : N;                  // count of distinct vertices
    // mark each edge i (vertex i -> i+1) as road-facing or not. A front edge must:
    //  - have its MIDPOINT in the carriageway-side band (just outside the curb)
    //  - have BOTH endpoints reasonably close to a road (rejects a side lot line that
    //    only grazes the band at its near corner then angles off across the yard)
    //  - run roughly PARALLEL to the nearest road (|sin angle| small) so we trace the
    //    frontage, not a driveway/side line stabbing toward the street.
    const endMax = opts.endMax ?? (bandMax + 4);
    const maxSin = opts.maxSin ?? 0.55;            // <= ~33deg off the road tangent
    const facing = new Array(M).fill(false);
    for (let i = 0; i < M; i++) {
      const a = ring[i], b = ring[(i + 1) % M];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < minEdge) continue;
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      if (!inPatch(mx, mz)) continue;
      const d = distToSegs(mx, mz, roadSegs);
      if (d < bandMin || d > bandMax) continue;
      if (distToSegs(a[0], a[1], roadSegs) > endMax || distToSegs(b[0], b[1], roadSegs) > endMax) continue;
      const near = nearestRoadTangent(mx, mz, roadSegs);
      if (near) {
        let ex = (b[0] - a[0]) / len, ez = (b[1] - a[1]) / len;
        const sin = Math.abs(ex * near[1] - ez * near[0]);   // |edge x roadDir|
        if (sin > maxSin) continue;
      }
      facing[i] = true;
    }
    // chain consecutive facing edges (wrapping) into runs of vertices
    const used = new Array(M).fill(false);
    for (let s = 0; s < M; s++) {
      if (!facing[s] || used[s]) continue;
      // walk back to the start of this run
      let start = s;
      while (facing[(start - 1 + M) % M] && (start - 1 + M) % M !== s) start = (start - 1 + M) % M;
      const verts = [];
      let i = start;
      do {
        verts.push([ring[i][0], ring[i][1]]);
        used[i] = true;
        const nxt = (i + 1) % M;
        if (!facing[i]) break;
        verts.push([ring[nxt][0], ring[nxt][1]]);
        i = nxt;
      } while (facing[i] && i !== start);
      // dedupe consecutive identical pts
      const poly = [];
      for (const v of verts) if (!poly.length || Math.hypot(v[0] - poly[poly.length - 1][0], v[1] - poly[poly.length - 1][1]) > 1e-6) poly.push(v);
      if (poly.length < 2) continue;
      // push the run toward the road (street-side of the property line). Determine the
      // inward (toward road) normal per vertex from the nearest road centre point.
      const pushed = poly.map(([x, z]) => {
        // gradient of distance-to-roads ~ direction AWAY from road; we want toward it
        const near = nearestRoadPoint(x, z, roadSegs);
        if (!near) return [x, z];
        let dx = near[0] - x, dz = near[1] - z; const L = Math.hypot(dx, dz) || 1;
        return [x + dx / L * inset, z + dz / L * inset];
      });
      out.push(pushed);
    }
  }
  return out;
}
function nearestRoadPoint(px, pz, segs) {
  let best = null, bestD = Infinity;
  for (const [a, b] of segs) {
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const L2 = dx * dx + dz * dz || 1;
    let t = ((px - a[0]) * dx + (pz - a[1]) * dz) / L2;
    t = Math.max(0, Math.min(1, t));
    const cx = a[0] + t * dx, cz = a[1] + t * dz;
    const d = Math.hypot(px - cx, pz - cz);
    if (d < bestD) { bestD = d; best = [cx, cz]; }
  }
  return best;
}
// Unit tangent of the road segment nearest to (px,pz).
function nearestRoadTangent(px, pz, segs) {
  let best = null, bestD = Infinity;
  for (const [a, b] of segs) {
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    const L2 = L * L;
    let t = ((px - a[0]) * dx + (pz - a[1]) * dz) / L2;
    t = Math.max(0, Math.min(1, t));
    const cx = a[0] + t * dx, cz = a[1] + t * dz;
    const d = Math.hypot(px - cx, pz - cz);
    if (d < bestD) { bestD = d; best = [dx / L, dz / L]; }
  }
  return best;
}

// ---- join sidewalk runs so they MEET at intersections --------------------
// buildParcelSidewalks emits one run per lot, so consecutive lots and corner lots
// leave gaps where the user sees "ends that don't meet". We greedily concatenate any
// two runs whose endpoints are within `thresh` m — but ONLY if the straight bridge
// between them does NOT cross a road centreline (so we never sew a sidewalk across the
// street; only along a frontage or around a corner). smoothLine() (applied by the
// caller) then rounds the joined corner, giving the curved corners at intersections.
function segsIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
export function joinSidewalkRuns(runs, roadSegs, thresh = 8) {
  runs = runs.map(r => r.slice());
  const crossesRoad = (a, b) => roadSegs.some(([c, d]) => segsIntersect(a, b, c, d));
  let merged = true;
  while (merged) {
    merged = false;
    outer:
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const A = runs[i], B = runs[j];
        // (endIndexA, endIndexB, reverseA so it ENDS at the join, reverseB so it STARTS at the join)
        const combos = [
          [A.length - 1, 0, false, false], [A.length - 1, B.length - 1, false, true],
          [0, 0, true, false], [0, B.length - 1, true, true],
        ];
        for (const [ai, bi, revA, revB] of combos) {
          const pa = A[ai], pb = B[bi];
          const dist = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
          if (dist > thresh) continue;
          if (dist > 0.5 && crossesRoad(pa, pb)) continue;       // never bridge across the road
          const a2 = revA ? A.slice().reverse() : A.slice();      // ends at pa
          const b2 = revB ? B.slice().reverse() : B.slice();      // starts at pb
          // drop a duplicate join vertex when the ends already coincide
          const join = dist <= 0.5 ? a2.concat(b2.slice(1)) : a2.concat(b2);
          runs.splice(j, 1); runs.splice(i, 1, join);
          merged = true; break outer;
        }
      }
    }
  }
  return runs;
}
