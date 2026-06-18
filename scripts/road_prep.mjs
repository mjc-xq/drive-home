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
export function roadSpec(r) {
  const k = r.k;
  if (k === 'tertiary') return { width: r.w || 9, lanes: 2, isService: false };
  if (k === 'residential') return { width: r.w || 7.5, lanes: 2, isService: false };
  if (k === 'service') return { width: r.w || 4.5, lanes: 1, isService: true };
  return { width: r.w || 7, lanes: 2, isService: false };
}
// rank for junction priority (higher wins / runs unbroken)
export function roadRank(r) {
  const k = r.k;
  if (k === 'tertiary') return 3;
  if (k === 'residential') return 2;
  if (k === 'service') return 1;
  return 2;
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
