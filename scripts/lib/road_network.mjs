// road_network.mjs — pure-2D road + sidewalk NETWORK + inferred road paint, in WORLD XZ.
//
// The single-textured-terrain pipeline paints ONE ground surface. This module produces the
// 2D geometry a ground-atlas rasterizer fills: FILLED `surfaces` (asphalt / driveway /
// concrete-sidewalk / curb / crosswalk, painted in z order) and thin `paint` marks
// (double-yellow / lane-dash / edge-line / stop-bar / crosswalk-stripe) stamped on top.
// No heights, no lift, no THREE — everything is [x,z] in the world frame w2 produces.
//
// It REPLACES the old per-source floating ribbons (buildSidewalkConnectors et al). The hard
// mandate: sidewalks come to ROUNDED CORNERS at EVERY intersection, ALWAYS — derived from
// junction geometry, never from OSM, never silently dropped. See buildCurbReturns.
//
// Frame note: scene.roads use raw ENU [e,n] (pass through env.w2). map_surfaces driveways /
// crossings / polygons are ALREADY in world XZ (gltf-y-up, x=east, z=-north) — used as-is.

import {
  offsetLine, centreDashes, zebraCrosswalk, smoothLine,
  roadSpec, clipPolylineToBox, buildRoadJunctions,
  isCulDeSacRoad, vkey,
} from '../road_prep.mjs';

// ---- constants (locked by the design doc) --------------------------------
const SW_WIDTH = 1.8;            // sidewalk concrete width
const SW_GAP = 2.2;              // gap from road edge to walk CENTRELINE
const CURB_WIDTH = 0.55;         // painted curb band width
const CURB_RETURN_R = { tertiary: 6, residential: 4, default: 4.5 }; // fillet radius by class
const R_MIN = 1.5;              // quarter-disc fallback radius (degenerate corners)
const STOP_SETBACK = 1.5;       // stop bar set back from curb line, along the leg
const STOP_BAR_THICK = 0.30;    // stop bar depth (along leg)
const XWALK_GAP = 0.5;          // crosswalk inboard gap past the stop bar
const XWALK_DEPTH = 2.4;        // crosswalk band depth (along leg)
const STITCH_EPS = 0.6;         // weld sidewalk endpoints within this distance
const CW_MARGIN = 0.35;         // keep concrete this far OUTSIDE the carriageway edge (curb gutter)
const R_TRIM = 9;               // suppress lane/edge paint within this of a junction
const DASH_HALF = 0.05;         // half-width of painted lane/edge lines (0.10 m wide)
const COL_YELLOW = '#f2c81e';
const COL_WHITE = '#e8e8e8';

// =====================================================================================
// small 2D helpers (pure, terse)
// =====================================================================================
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len2 = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => { const L = len2(a) || 1; return [a[0] / L, a[1] / L]; };
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const finite = (p) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// Intersect infinite line (p + d*t) with (q + e*s); null when (near-)parallel.
function lineIntersect(p, d, q, e) {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  const X = [p[0] + d[0] * t, p[1] + d[1] * t];
  return finite(X) ? X : null;
}

// Convex hull (monotone chain) of a small point set; returns CCW ring (>=3 pts) or null.
function convexHull(pts) {
  const p = pts.filter(finite).map(q => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return null;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  const ring = lo.slice(0, -1).concat(up.slice(0, -1));
  return ring.length >= 3 ? ring : null;
}

// Sutherland–Hodgman clip of a CLOSED polygon to the DEM rect [x0,x1]×[z0,z1].
function clipPolygonToRect(ring, rect) {
  const { x0, x1, z0, z1 } = rect;
  const edges = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= z0, (p) => p[1] <= z1,
  ];
  const isect = [
    (a, b) => lerp(a, b, (x0 - a[0]) / (b[0] - a[0])),
    (a, b) => lerp(a, b, (x1 - a[0]) / (b[0] - a[0])),
    (a, b) => lerp(a, b, (z0 - a[1]) / (b[1] - a[1])),
    (a, b) => lerp(a, b, (z1 - a[1]) / (b[1] - a[1])),
  ];
  let out = ring.filter(finite);
  for (let e = 0; e < 4; e++) {
    if (out.length < 3) return [];
    const inside = edges[e], cut = isect[e], next = [];
    for (let i = 0; i < out.length; i++) {
      const cur = out[i], prv = out[(i + out.length - 1) % out.length];
      const ci = inside(cur), pi = inside(prv);
      if (ci) { if (!pi) next.push(cut(prv, cur)); next.push(cur); }
      else if (pi) next.push(cut(prv, cur));
    }
    out = next.filter(finite);
  }
  return out;
}

// quarter/semicircle arc of points around centre C, from angle a0 sweeping by `sweep`.
function arcPts(C, R, a0, sweep, steps) {
  const out = [];
  for (let s = 0; s <= steps; s++) {
    const a = a0 + sweep * (s / steps);
    out.push([C[0] + Math.cos(a) * R, C[1] + Math.sin(a) * R]);
  }
  return out;
}

// Build a thin axis-aligned quad ring (4 pts) for a bar centred at `c`, running `dir`
// (unit) for `length`, spanning `span` across. Used for stop bars.
function barRing(c, dir, length, span) {
  const n = [-dir[1], dir[0]];
  const hl = length / 2, hs = span / 2;
  const a = [c[0] - dir[0] * hl, c[1] - dir[1] * hl];
  const b = [c[0] + dir[0] * hl, c[1] + dir[1] * hl];
  return [
    [a[0] + n[0] * hs, a[1] + n[1] * hs], [a[0] - n[0] * hs, a[1] - n[1] * hs],
    [b[0] - n[0] * hs, b[1] - n[1] * hs], [b[0] + n[0] * hs, b[1] + n[1] * hs],
  ];
}

// Expand centreline + width into a closed ring (square caps). Mitre-clamped offset so
// curb-side walk edges don't pinch on corners.
function bandRing(centerline, width) {
  if (centerline.length < 2) return null;
  const L = offsetLine(centerline, width / 2);
  const R = offsetLine(centerline, -width / 2);
  return L.concat(R.reverse());
}

// =====================================================================================
// A. junction graph
// =====================================================================================
// Wrap buildRoadJunctions and attach, per junction, the non-service "walk arms" with their
// outward unit directions + spec, sorted CCW by angle. Service-only junctions keep arms=[].
export function buildRoadGraph(scene, env) {
  const roads = scene.roads || [];
  const junctions = buildRoadJunctions(roads, env.w2, { includeService: true });
  for (const j of junctions) {
    const walk = j.arms.filter(a => !a.spec.isService)
      .map(a => ({ ...a, ang: Math.atan2(a.dz, a.dx) }))
      .sort((p, q) => p.ang - q.ang);
    // de-dup near-identical arm directions (split OSM ways)
    const arms = [];
    for (const a of walk) {
      if (arms.some(b => b.dx * a.dx + b.dz * a.dz > 0.985 && b.spec.width === a.spec.width)) continue;
      arms.push(a);
    }
    j.walkArms = arms;
  }
  return junctions;
}

// =====================================================================================
// B. sidewalk parallel runs — road edges offset out to walk centrelines, trimmed back
//    at junctions so the fillets / caps can close them.
// =====================================================================================
// One run per road side. Centreline offset = spec.width/2 + SW_GAP. Service excluded.
// Each run is trimmed inward at any end that lands on/near a real junction so the corner
// fillet owns the corner. Returns [{ line:[[x,z]...], spec, side, road }].
export function buildSidewalkRuns(scene, env, junctions) {
  const roads = scene.roads || [];
  const half = env.clipHalf;
  const runs = [];
  // junction centres (world) for end-trim test
  const jc = junctions.map(j => [j.x, j.z]);
  const TRIM = (spec) => spec.width / 2 + SW_GAP + 1.5; // trim length so the fillet meets cleanly

  for (const r of roads) {
    const spec = roadSpec(r);
    if (spec.isService) continue;                 // service ways get no sidewalk
    const pl = r.p || r;
    if (!Array.isArray(pl) || pl.length < 2) continue;
    const lw = pl.map(([e, n]) => env.w2(e, n));
    const pieces = Number.isFinite(half) ? clipPolylineToBox(lw, half) : [lw];
    for (let piece of pieces) {
      piece = smoothLine(piece, { lo: 6, hi: 135 });
      if (piece.length < 2) continue;
      const d = spec.width / 2 + SW_GAP;
      for (const side of [1, -1]) {
        let line = offsetLine(piece, d * side);
        line = trimRunEndsAtJunctions(line, jc, TRIM(spec));
        if (line.length >= 2) runs.push({ line, spec, side, road: r });
      }
    }
  }
  return runs;
}

// Trim a run's endpoints inward when the endpoint sits near a junction centre, so the
// straight run stops short and the corner fillet fills the gap. Cumulative-length walk.
function trimRunEndsAtJunctions(line, junctionCentres, trim) {
  const nearJ = (p) => junctionCentres.some(c => Math.hypot(c[0] - p[0], c[1] - p[1]) < trim + 4);
  let out = line.map(p => [p[0], p[1]]);
  if (nearJ(out[0])) out = trimFrom(out, trim, false);
  if (out.length >= 2 && nearJ(out[out.length - 1])) out = trimFrom(out, trim, true);
  return out;
}
function trimFrom(line, dist, fromEnd) {
  const pts = fromEnd ? line.slice().reverse() : line.slice();
  let acc = 0, i = 1;
  for (; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + seg >= dist) {
      const t = (dist - acc) / (seg || 1);
      pts[i - 1] = lerp(pts[i - 1], pts[i], t);
      const rest = pts.slice(i - 1);
      return fromEnd ? rest.reverse() : rest;
    }
    acc += seg;
  }
  return fromEnd ? [pts[pts.length - 1]] : [pts[0]]; // fully consumed
}

// =====================================================================================
// C. curb returns — ALWAYS one filleted corner per adjacent walk-arm pair at every junction.
//    VETO-FREE: never dropped, never NaN. Degenerate corners fall back to a quarter-disc cap.
// =====================================================================================
// filletCorner: returns a CLOSED concrete corner polygon for the wedge between two outward
// arm directions A,B at junction centre c. Always valid. `widthA/widthB` are road widths.
export function filletCorner(c, A, B, widthA, widthB, klass) {
  const R = CURB_RETURN_R[klass] ?? CURB_RETURN_R.default;
  const dA = norm([A.dx ?? A[0], A.dz ?? A[1]]);
  const dB = norm([B.dx ?? B[0], B.dz ?? B[1]]);
  const cosang = Math.max(-1, Math.min(1, dot2(dA, dB)));
  const ang = Math.acos(cosang);
  const DEG12 = 12 * Math.PI / 180;
  // Degenerate: near-collinear (ang→0) or hairpin (π-ang→0) → quarter-disc cap.
  if (ang < DEG12 || Math.PI - ang < DEG12) return quarterDiscCap(c, dA, dB);

  // offset distances to the walk OUTER (curb-side) edge per arm
  const offA = widthA / 2 + SW_GAP - SW_WIDTH / 2;  // walk inner (curb) edge offset
  const offB = widthB / 2 + SW_GAP - SW_WIDTH / 2;
  // The two curb-edge lines, each offset toward the OTHER arm (into the wedge).
  const nA = [-dA[1], dA[0]];
  const sA = dot2(nA, dB) >= 0 ? 1 : -1;
  const pA = [c[0] + nA[0] * sA * offA, c[1] + nA[1] * sA * offA];
  const nB = [-dB[1], dB[0]];
  const sB = dot2(nB, dA) >= 0 ? 1 : -1;
  const pB = [c[0] + nB[0] * sB * offB, c[1] + nB[1] * sB * offB];
  const X = lineIntersect(pA, dA, pB, dB);          // inside corner where curb edges cross
  if (!X || !finite(X)) return quarterDiscCap(c, dA, dB);

  // tangent points OUTWARD from X along each arm dir; fillet centre on the bisector
  const tdist = Math.max(0, Math.min(12, R / Math.tan(ang / 2)));
  const tpA = [X[0] + dA[0] * tdist, X[1] + dA[1] * tdist];
  const tpB = [X[0] + dB[0] * tdist, X[1] + dB[1] * tdist];
  const bis = norm([dA[0] + dB[0], dA[1] + dB[1]]);
  if (!finite(bis) || (bis[0] === 0 && bis[1] === 0)) return quarterDiscCap(c, dA, dB);
  const fd = R / Math.max(0.05, Math.sin(ang / 2));
  const F = [X[0] + bis[0] * fd, X[1] + bis[1] * fd];
  if (!finite(F)) return quarterDiscCap(c, dA, dB);

  // arc from tpA to tpB around F (short sweep). Polygon = X -> tpA -> arc -> tpB -> X.
  let a0 = Math.atan2(tpA[1] - F[1], tpA[0] - F[0]);
  let a1 = Math.atan2(tpB[1] - F[1], tpB[0] - F[0]);
  let sweep = a1 - a0;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;
  const steps = Math.max(2, Math.ceil(R * Math.abs(sweep) / 0.8));
  const poly = [X, tpA, ...arcPts(F, R, a0, sweep, steps).slice(1, -1), tpB];
  const clean = poly.filter(finite);
  return clean.length >= 3 ? clean : quarterDiscCap(c, dA, dB);
}

// Guaranteed-valid quarter-disc cap (radius R_MIN) seated between two arm dirs, pointing
// into their wedge. Never NaN. Used for degenerate / hairpin corners.
function quarterDiscCap(c, dA, dB) {
  let bis = norm([dA[0] + dB[0], dA[1] + dB[1]]);
  if (!finite(bis) || (bis[0] === 0 && bis[1] === 0)) bis = [-dA[1], dA[0]]; // perp fallback for opposite arms
  const C = [c[0] + bis[0] * (R_MIN + 0.6), c[1] + bis[1] * (R_MIN + 0.6)];
  const a0 = Math.atan2(-bis[1], -bis[0]) - Math.PI / 2;
  return arcPts(C, R_MIN, a0, Math.PI, 8).filter(finite);
}

// buildCurbReturns: one filled concrete corner per ADJACENT walk-arm pair, at EVERY junction
// with >=2 non-service arms. Veto-free. Returns array of CLOSED corner polygons.
export function buildCurbReturns(junctions) {
  const corners = [];
  for (const j of junctions) {
    const arms = j.walkArms || [];
    if (arms.length < 2) continue;
    const c = [j.x, j.z];
    const classOf = (a) => a.spec.width >= 11 ? 'tertiary' : a.spec.width >= 9 ? 'residential' : 'default';
    const n = arms.length;
    // adjacent pairs around the sorted ring. For exactly 2 arms, one pair (no wrap dup).
    const pairs = n === 2 ? [[0, 1]] : arms.map((_, i) => [i, (i + 1) % n]);
    for (const [i, k] of pairs) {
      const A = arms[i], B = arms[k];
      const klass = classOf(A.spec.width >= B.spec.width ? A : B);
      const poly = filletCorner(c, A, B, A.spec.width, B.spec.width, klass);
      if (poly && poly.length >= 3) corners.push(poly);
    }
  }
  return corners;
}

// =====================================================================================
// C2. carriageway keep-out — concrete (sidewalk/fillet/cap/ring) must NEVER cross the
//     asphalt. Build a set of {a,b,half} road segments + cul-de-sac bulb discs, then push
//     any concrete vertex that lands inside (within half+CW_MARGIN of a centreline, or inside
//     a bulb radius) OUT to that keep-out boundary along the outward normal/radial.
// =====================================================================================
export function buildCarriageway(scene, env) {
  const roads = scene.roads || [];
  const w2 = env.w2, half = env.clipHalf;
  const segs = [];   // { a:[x,z], b:[x,z], half }  carriageway half-width per centreline segment
  const bulbs = [];  // { c:[x,z], r }              cul-de-sac asphalt bulb discs
  for (const r of roads) {
    const spec = roadSpec(r);
    if (spec.isService) continue;                  // driveways have no curb to protect
    const pl = r.p || r;
    if (!Array.isArray(pl) || pl.length < 2) continue;
    const lw = pl.map(([e, n]) => w2(e, n));
    const pieces = Number.isFinite(half) ? clipPolylineToBox(lw, half) : [lw];
    for (let piece of pieces) {
      piece = smoothLine(piece, { lo: 6, hi: 135 });
      for (let i = 1; i < piece.length; i++) segs.push({ a: piece[i - 1], b: piece[i], half: spec.width / 2 });
    }
    if (isCulDeSacRoad(r)) {
      const hit = new Map();
      for (const rr of roads) { const p = rr.p || rr; if (!Array.isArray(p)) continue; for (const [e, n] of p) { const [x, z] = w2(e, n); const k = vkey(x, z); hit.set(k, (hit.get(k) || 0) + 1); } }
      for (const end of [0, pl.length - 1]) {
        const tip = w2(...pl[end]);
        if ((hit.get(vkey(tip[0], tip[1])) || 0) > 1) continue;
        bulbs.push({ c: tip, r: spec.width / 2 + 4 });
      }
    }
  }
  return { segs, bulbs };
}

// Push a single point OUT of the carriageway keep-out (centreline band + bulb discs), if it
// lies inside. Returns a (possibly moved) point that sits on/outside the curb gutter line.
// Pushing out of one segment can nudge a vertex inside a NEIGHBOURING segment (sharp corners,
// court mouths), so iterate to convergence (few passes) — each pass relocates to the single
// deepest intrusion, which monotonically shrinks the worst overlap.
function clampPointOutOfRoad(p, cway, margin = CW_MARGIN) {
  let q = [p[0], p[1]];
  for (let iter = 0; iter < 6; iter++) {
    let worst = 0, target = null;
    for (const { c, r } of cway.bulbs) {
      const dx = q[0] - c[0], dz = q[1] - c[1];
      const d = Math.hypot(dx, dz), keep = r + margin, over = keep - d;
      if (over > worst) {
        worst = over;
        target = d < 1e-6 ? [c[0] + keep, c[1]] : [c[0] + dx / d * keep, c[1] + dz / d * keep];
      }
    }
    for (const { a, b, half } of cway.segs) {
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const L2 = dx * dx + dz * dz || 1;
      let t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / L2;
      t = Math.max(0, Math.min(1, t));
      const cx = a[0] + t * dx, cz = a[1] + t * dz;
      let ox = q[0] - cx, oz = q[1] - cz;
      const d = Math.hypot(ox, oz), keep = half + margin, over = keep - d;
      if (over > worst) {
        worst = over;
        if (d < 1e-6) { const nl = Math.hypot(dx, dz) || 1; ox = -dz / nl; oz = dx / nl; }
        else { ox /= d; oz /= d; }
        target = [cx + ox * keep, cz + oz * keep];
      }
    }
    if (!target || worst < 1e-3) break;
    q = target;
  }
  return finite(q) ? q : p;
}

// Clamp every vertex of a closed concrete polygon out of the carriageway. Vertices already
// outside are untouched, so straight runs keep their shape; only the bits that crossed the
// asphalt get tucked back to the curb gutter line.
function clampPolyOutOfRoad(poly, cway) {
  if (!poly || !cway) return poly;
  return poly.map(p => clampPointOutOfRoad(p, cway));
}

// =====================================================================================
// D. dead-end U-returns + cul-de-sac rings — no road veto.
// =====================================================================================
// buildDeadEndCaps: a closed semicircle concrete polygon wrapping each ordinary residential
// dead end (not a court). Outer arc at walk outer edge, inner arc at walk inner edge.
export function buildDeadEndCaps(scene, env, junctions) {
  const roads = scene.roads || [];
  const w2 = env.w2, half = env.clipHalf;
  // a junction-vertex set (world keys) so we don't cap a junction tip
  const jKeys = new Set(junctions.map(j => vkey(j.x, j.z)));
  // count vertex touches to find true dead ends
  const hit = new Map();
  for (const r of roads) {
    const pl = r.p || r; if (!Array.isArray(pl)) continue;
    for (const [e, n] of pl) { const [x, z] = w2(e, n); const k = vkey(x, z); hit.set(k, (hit.get(k) || 0) + 1); }
  }
  const caps = [];
  for (const r of roads) {
    const pl = r.p || r;
    if (!Array.isArray(pl) || pl.length < 2) continue;
    const spec = roadSpec(r);
    if (spec.isService || isCulDeSacRoad(r)) continue;
    for (const end of [0, pl.length - 1]) {
      const tip = w2(...pl[end]);
      if (Number.isFinite(half) && (Math.abs(tip[0]) > half || Math.abs(tip[1]) > half)) continue;
      const k = vkey(tip[0], tip[1]);
      if ((hit.get(k) || 0) > 1 || jKeys.has(k)) continue;  // not a true dead end
      const prev = w2(...pl[end === 0 ? 1 : pl.length - 2]);
      const t = norm(sub(tip, prev));
      if (t[0] === 0 && t[1] === 0) continue;
      const rOut = spec.width / 2 + SW_GAP + SW_WIDTH / 2;
      const rIn = Math.max(0.2, spec.width / 2 + SW_GAP - SW_WIDTH / 2);
      const theta = Math.atan2(t[1], t[0]);
      // outer arc (left→right around the tip) then inner arc back → closed annular cap
      const outer = arcPts(tip, rOut, theta + Math.PI / 2, -Math.PI, 14);
      const inner = arcPts(tip, rIn, theta - Math.PI / 2, Math.PI, 14);
      const poly = outer.concat(inner).filter(finite);
      if (poly.length >= 3) caps.push(poly);
    }
  }
  return caps;
}

// buildCulDeSacRings: a concrete annulus ring polygon (outer ring + inner hole) around each
// named court / cul-de-sac terminus. Returns [{ polygon, holes:[hole] }].
export function buildCulDeSacRings(scene, env, junctions) {
  const roads = scene.roads || [];
  const w2 = env.w2, half = env.clipHalf;
  const hit = new Map();
  for (const r of roads) {
    const pl = r.p || r; if (!Array.isArray(pl)) continue;
    for (const [e, n] of pl) { const [x, z] = w2(e, n); const k = vkey(x, z); hit.set(k, (hit.get(k) || 0) + 1); }
  }
  const rings = [];
  for (const r of roads) {
    if (!isCulDeSacRoad(r)) continue;
    const pl = r.p || r;
    if (!Array.isArray(pl) || pl.length < 2) continue;
    const spec = roadSpec(r);
    for (const end of [0, pl.length - 1]) {
      const tip = w2(...pl[end]);
      if (Number.isFinite(half) && (Math.abs(tip[0]) > half || Math.abs(tip[1]) > half)) continue;
      const k = vkey(tip[0], tip[1]);
      if ((hit.get(k) || 0) > 1) continue;
      const bulbR = spec.width / 2 + 4;               // bulb pad radius (matches asphalt bulb)
      const rIn = bulbR + SW_GAP - SW_WIDTH / 2;
      const rOut = bulbR + SW_GAP + SW_WIDTH / 2;
      const outer = arcPts(tip, rOut, 0, Math.PI * 2, 40).filter(finite);
      const inner = arcPts(tip, rIn, 0, Math.PI * 2, 40).filter(finite);
      if (outer.length >= 3 && inner.length >= 3) rings.push({ polygon: outer, holes: [inner] });
    }
  }
  return rings;
}

// =====================================================================================
// E. stitch — weld run/fillet/cap geometry into connected concrete polygons + curb edge.
// =====================================================================================
// We weld the straight run endpoints to nearby fillet/cap geometry by SNAPPING endpoints
// within STITCH_EPS, then emit each piece as a filled concrete band (sidewalk runs) plus the
// corner/cap/ring polygons. The inner (curb-side) edge of every straight run is emitted as a
// `curb` centerline. This keeps the network visually continuous while staying robust 2D.
export function stitchSidewalkNetwork(runs, corners, caps, culRings, cway = null) {
  // Build a snap registry of all corner/cap rim points so run ends weld to them.
  const anchors = [];
  for (const poly of corners) for (const p of poly) anchors.push(p);
  for (const poly of caps) for (const p of poly) anchors.push(p);
  const snap = (p) => {
    let best = null, bd = STITCH_EPS;
    for (const a of anchors) { const d = Math.hypot(a[0] - p[0], a[1] - p[1]); if (d < bd) { bd = d; best = a; } }
    return best ? [best[0], best[1]] : p;
  };
  // Every concrete polygon is tucked back out of the carriageway so no sidewalk/fillet/cap
  // ever paints gray over the asphalt (bugs: concrete jutting into the road; sidewalk cutting
  // into the cul-de-sac bulb). No-op when cway is absent.
  const tuck = (poly) => cway ? clampPolyOutOfRoad(poly, cway) : poly;

  const surfaces = [];   // concrete-sidewalk filled polygons
  const curbLines = [];  // shared welded curb geometry (inner edge of each run)

  for (const run of runs) {
    let line = run.line.map(p => [p[0], p[1]]);
    if (line.length < 2) continue;
    line[0] = snap(line[0]);
    line[line.length - 1] = snap(line[line.length - 1]);
    line = smoothLine(line, { lo: 4, hi: 160 });
    if (line.length < 2) continue;
    const ring = bandRing(line, SW_WIDTH);
    if (ring && ring.length >= 3) surfaces.push({ polygon: tuck(ring) });
    // inner (curb-side) edge: offset the walk centreline toward the road by SW_WIDTH/2.
    // The road is on the side opposite `side`; walk centreline was offset by +d*side from
    // the road centreline, so the curb side is toward -side.
    const inner = offsetLine(line, -(SW_WIDTH / 2) * run.side);
    if (inner.length >= 2) curbLines.push({ line: cway ? clampPolyOutOfRoad(inner, cway) : inner, side: run.side, spec: run.spec });
  }
  for (const poly of corners) surfaces.push({ polygon: tuck(poly) });
  for (const poly of caps) surfaces.push({ polygon: tuck(poly) });
  // Cul-de-sac annulus: tuck the OUTER ring out of any carriageway, but leave the inner hole
  // as-is — the hole is the asphalt cutout and is already sized to the bulb radius.
  for (const ring of culRings) surfaces.push({ polygon: tuck(ring.polygon), holes: ring.holes });
  return { surfaces, curbLines };
}

// =====================================================================================
// F. road surfaces + junction blend pads + cul-de-sac bulbs
// =====================================================================================
export function buildRoadSurfaces(scene, env) {
  const roads = scene.roads || [];
  const half = env.clipHalf;
  const out = [];
  for (const r of roads) {
    const spec = roadSpec(r);
    const pl = r.p || r;
    if (!Array.isArray(pl) || pl.length < 2) continue;
    const lw = pl.map(([e, n]) => env.w2(e, n));
    const pieces = Number.isFinite(half) ? clipPolylineToBox(lw, half) : [lw];
    const court = isCulDeSacRoad(r);   // courts/cul-de-sacs/loops get NO lane lines (see buildLanePaint)
    for (let piece of pieces) {
      piece = smoothLine(piece, { lo: 6, hi: 135 });
      if (piece.length < 2) continue;
      out.push({
        kind: spec.isService ? 'driveway' : 'asphalt',
        centerline: piece,
        width: spec.width,
        court,
        z: spec.isService ? 1 : 0,
        material: spec.isService ? 'asphalt-light' : 'asphalt',
      });
    }
  }
  return out;
}

// Junction blend pads (convex hull of arm road-edge endpoints — fills the mouth better than
// a plain disc) + cul-de-sac bulbs (filled disc ring). Returns asphalt polygons.
export function buildJunctionPads(scene, env, junctions) {
  const pads = [];
  for (const j of junctions) {
    if (j.arms.length < 2) continue;
    const pts = [];
    const PAD = Math.max(2.5, j.width / 2);    // how far down each arm the pad reaches
    for (const a of j.arms) {
      const d = norm([a.dx, a.dz]);
      const n = [-d[1], d[0]];
      const hw = a.spec.width / 2;
      const base = [j.x + d[0] * PAD, j.z + d[1] * PAD];
      pts.push([base[0] + n[0] * hw, base[1] + n[1] * hw]);
      pts.push([base[0] - n[0] * hw, base[1] - n[1] * hw]);
    }
    const hull = convexHull(pts);
    if (hull && hull.length >= 3) pads.push({ kind: 'asphalt', polygon: hull, z: 0, material: 'asphalt' });
  }
  // cul-de-sac bulbs
  const roads = scene.roads || [];
  const w2 = env.w2, half = env.clipHalf;
  const hit = new Map();
  for (const r of roads) { const pl = r.p || r; if (!Array.isArray(pl)) continue; for (const [e, n] of pl) { const [x, z] = w2(e, n); const k = vkey(x, z); hit.set(k, (hit.get(k) || 0) + 1); } }
  for (const r of roads) {
    if (!isCulDeSacRoad(r)) continue;
    const pl = r.p || r; if (!Array.isArray(pl) || pl.length < 2) continue;
    const spec = roadSpec(r);
    for (const end of [0, pl.length - 1]) {
      const tip = w2(...pl[end]);
      if (Number.isFinite(half) && (Math.abs(tip[0]) > half || Math.abs(tip[1]) > half)) continue;
      if ((hit.get(vkey(tip[0], tip[1])) || 0) > 1) continue;
      const disc = arcPts(tip, spec.width / 2 + 4, 0, Math.PI * 2, 32).filter(finite);
      if (disc.length >= 3) pads.push({ kind: 'asphalt', polygon: disc, z: 0, material: 'asphalt' });
    }
  }
  return pads;
}

// =====================================================================================
// G. inferred paint — lane lines, stop bars, crosswalks
// =====================================================================================
// near-junction suppression test (within R_TRIM of any junction centre)
function makeJunctionSkip(junctions) {
  const jc = junctions.map(j => [j.x, j.z]);
  return (x, z) => jc.some(c => Math.hypot(c[0] - x, c[1] - z) < R_TRIM);
}

// buildLanePaint: per-class centre + edge marks along each road centreline (junction-gapped).
//   tertiary    : double solid yellow ±0.10 m + white edge lines.
//   residential : dashed yellow centre (centreDashes) + white edge lines.
export function buildLanePaint(roadSurfaces, junctions) {
  const skip = makeJunctionSkip(junctions);
  const doubleYellow = { kind: 'double-yellow', lines: [], width: 0.10, color: COL_YELLOW };
  const laneDash = { kind: 'lane-dash', rings: [], color: COL_YELLOW };
  const edgeLine = { kind: 'edge-line', lines: [], width: 0.10, color: COL_WHITE };

  for (const s of roadSurfaces) {
    if (s.kind !== 'asphalt' || !s.centerline || s.centerline.length < 2) continue;
    // Courts / cul-de-sacs / loop roads get NO centre or edge lane lines: a closed-loop
    // court centreline, offset and dashed, draws a GIANT yellow oval/circle that follows
    // no street. Real residential courts are unmarked anyway. (bug: giant yellow circle)
    if (s.court) continue;
    const cl = s.centerline, w = s.width;
    // Defensive guard: never paint a lane line around a (near-)closed loop — its first and
    // last vertex coincide, so any centre/edge line would wrap into a closed ring. Belt &
    // braces with the s.court skip above for unnamed loops.
    if (Math.hypot(cl[0][0] - cl[cl.length - 1][0], cl[0][1] - cl[cl.length - 1][1]) < 20) continue;
    const isTertiary = w >= 11;
    if (isTertiary) {
      // double yellow: two solid offset centrelines ±0.10, gapped through junctions
      for (const off of [0.10, -0.10]) {
        for (const piece of splitSkip(offsetLine(cl, off), skip)) doubleYellow.lines.push(piece);
      }
    } else {
      // dashed yellow centre
      for (const ring of centreDashes(cl, DASH_HALF, skip)) laneDash.rings.push(ring);
    }
    // white edge lines at ±(width/2 - 0.15)
    const eo = Math.max(0.2, w / 2 - 0.15);
    for (const off of [eo, -eo]) {
      for (const piece of splitSkip(offsetLine(cl, off), skip)) edgeLine.lines.push(piece);
    }
  }
  return { doubleYellow, laneDash, edgeLine };
}

// Split a polyline wherever skip(midpoint) is true → array of unbroken painted pieces.
function splitSkip(line, skip) {
  const out = []; let cur = [];
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    const mid = i > 0 ? lerp(line[i - 1], p, 0.5) : p;
    if (i > 0 && skip(mid[0], mid[1])) { if (cur.length >= 2) out.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

// buildStopBars: a white stop bar across each approach leg of a REAL intersection
// (arms>=3, maxRank>=2), set back STOP_SETBACK behind the curb line (along the leg).
export function buildStopBars(junctions, clipHalf = 596) {
  const rings = [];
  for (const j of junctions) {
    const arms = j.walkArms || [];
    if (arms.length < 3 || j.maxRank < 2) continue;
    if (Math.abs(j.x) > clipHalf || Math.abs(j.z) > clipHalf) continue;  // off-map junction
    const c = [j.x, j.z];
    for (const a of arms) {
      if (a.spec.isService) continue;
      const d = norm([a.dx, a.dz]);
      const setback = a.spec.width / 2 + STOP_SETBACK;
      const bc = [c[0] + d[0] * setback, c[1] + d[1] * setback];   // bar centre along the leg
      // bar spans the right HALF of the carriageway (one approach lane group)
      const span = a.spec.width / 2;
      const n = [-d[1], d[0]];
      const off = [bc[0] + n[0] * span / 2, bc[1] + n[1] * span / 2];
      rings.push(barRing(off, d, STOP_BAR_THICK, span));
    }
  }
  return rings;
}

// buildCrosswalks: one inferred crosswalk per non-service leg at a real intersection,
// perpendicular to the leg, set back behind the stop bar, spanning curb-to-curb (leg width),
// striped via zebraCrosswalk. Prefers a nearby OSM crossing (within 6 m) when one exists.
export function buildCrosswalks(junctions, mapSurfaces, clipHalf = 596) {
  const osm = [];
  for (const cw of mapSurfaces.crossings || []) {
    const pl = cw.p || cw; if (!Array.isArray(pl) || pl.length < 2) continue;
    // an OSM crossing way can be a long sidewalk line; keep only the in-box piece
    const pieces = clipPolylineToBox(pl, clipHalf);
    if (!pieces.length) continue;
    const piece = pieces[0];
    const mid = piece[Math.floor(piece.length / 2)];
    osm.push({ mid, line: piece });
  }
  const usedOsm = new Set();
  const surfaces = [];   // crosswalk filled polygons (concrete-light)
  const stripes = [];    // zebra stripe rings

  for (const j of junctions) {
    const arms = j.walkArms || [];
    if (arms.length < 3 || j.maxRank < 2) continue;
    if (Math.abs(j.x) > clipHalf || Math.abs(j.z) > clipHalf) continue;  // off-map junction
    const c = [j.x, j.z];
    for (const a of arms) {
      if (a.spec.isService) continue;
      const d = norm([a.dx, a.dz]);
      const n = [-d[1], d[0]];
      const setback = a.spec.width / 2 + STOP_SETBACK + STOP_BAR_THICK / 2 + XWALK_GAP + XWALK_DEPTH / 2;
      const center = [c[0] + d[0] * setback, c[1] + d[1] * setback];
      // prefer an OSM crossing within 6 m of this inferred centre
      let oi = -1, bd = 6;
      for (let i = 0; i < osm.length; i++) { if (usedOsm.has(i)) continue; const m = osm[i].mid; const dd = Math.hypot(m[0] - center[0], m[1] - center[1]); if (dd < bd) { bd = dd; oi = i; } }
      const span = a.spec.width;                 // curb-to-curb
      // crossing line runs ACROSS the leg (perpendicular), so its direction is the normal n
      let crossLine;
      if (oi >= 0) { usedOsm.add(oi); crossLine = osm[oi].line; }
      else crossLine = [[center[0] - n[0] * span / 2, center[1] - n[1] * span / 2], [center[0] + n[0] * span / 2, center[1] + n[1] * span / 2]];
      // filled crosswalk pad (concrete-light) = band of XWALK_DEPTH along the leg over the crossing
      const ring = bandRing(crossLine, XWALK_DEPTH);
      if (ring && ring.length >= 3) surfaces.push(ring);
      // zebra stripes
      for (const r of zebraCrosswalk(crossLine, span)) stripes.push(r);
    }
  }
  return { surfaces, stripes };
}

// =====================================================================================
// driveways from map_surfaces (already world XZ) — emitted as `driveway` surfaces.
// =====================================================================================
function buildDriveways(mapSurfaces, env) {
  const out = [];
  const half = env.clipHalf;
  const inHalf = (p) => !Number.isFinite(half) || (Math.abs(p[0]) <= half && Math.abs(p[1]) <= half);
  for (const d of mapSurfaces.drivewayPolygons || []) {
    const poly = (d.polygon || []).filter(finite);
    if (poly.length >= 3 && poly.some(inHalf)) out.push({ kind: 'driveway', polygon: poly, z: 1, material: 'asphalt-light' });
  }
  for (const p of mapSurfaces.parkingAreas || []) {
    const poly = (p.polygon || []).filter(finite);
    if (poly.length >= 3 && poly.some(inHalf)) out.push({ kind: 'driveway', polygon: poly, z: 1, material: 'asphalt-light' });
  }
  for (const d of mapSurfaces.driveways || []) {
    if (d.polygon) continue;                   // already covered by a polygon
    const pl = (d.p || []).filter(finite);
    if (pl.length >= 2 && pl.some(inHalf)) out.push({ kind: 'driveway', centerline: pl, width: 3.6, z: 1, material: 'asphalt-light' });
  }
  return out;
}

// =====================================================================================
// TOP-LEVEL ASSEMBLY
// =====================================================================================
export function buildRoadNetwork(scene, mapSurfaces, env) {
  mapSurfaces = mapSurfaces || {};
  const C = scene.center || [20.91, 35.17];
  const demRect = { x0: -600, x1: 600, z0: -600, z1: 600 };
  const meta = { center: C, demRect, zOrder: ['asphalt', 'driveway', 'concrete-sidewalk', 'curb', 'crosswalk', 'paint'] };

  // --- graph + roads
  const junctions = buildRoadGraph(scene, env);
  const roadCenters = buildRoadSurfaces(scene, env);       // asphalt + driveway centerlines
  const pads = buildJunctionPads(scene, env, junctions);   // asphalt hull pads + bulbs

  // --- sidewalks (runs + corners + caps + cul-de-sac rings) → welded network + curb edges
  const cway = buildCarriageway(scene, env);               // asphalt keep-out (segments + bulbs)
  const runs = buildSidewalkRuns(scene, env, junctions);
  const corners = buildCurbReturns(junctions);
  const caps = buildDeadEndCaps(scene, env, junctions);
  const culRings = buildCulDeSacRings(scene, env, junctions);
  const { surfaces: swPolys, curbLines: curbFromRuns } = stitchSidewalkNetwork(runs, corners, caps, culRings, cway);

  // --- inferred paint
  const lane = buildLanePaint(roadCenters, junctions);
  const stopRings = buildStopBars(junctions, env.clipHalf);
  const { surfaces: xwalkPolys, stripes: xwalkStripes } = buildCrosswalks(junctions, mapSurfaces, env.clipHalf);

  // --- driveways from OSM (already world)
  const driveways = buildDriveways(mapSurfaces, env);

  // --- assemble surfaces (in z order; rasterizer paints later-z on top)
  const surfaces = [];
  const clipRing = (ring) => {
    const r = clipPolygonToRect(ring, demRect);
    return r.length >= 3 ? r : null;
  };
  // clip an OPEN polyline to the DEM box → array of in-box pieces (>=2 pts).
  const clipLine = (line) => clipPolylineToBox(line, env.clipHalf ?? 600);
  // asphalt: road bands (centerline) + hull pads/bulbs (polygon)
  for (const s of roadCenters) {
    if (s.kind === 'asphalt') surfaces.push({ kind: 'asphalt', centerline: s.centerline, width: s.width, z: 0, material: 'asphalt' });
  }
  for (const p of pads) { const c = clipRing(p.polygon); if (c) surfaces.push({ kind: 'asphalt', polygon: c, z: 0, material: 'asphalt' }); }
  // driveways
  for (const d of driveways) {
    if (d.polygon) { const c = clipRing(d.polygon); if (c) surfaces.push({ kind: 'driveway', polygon: c, z: 1, material: 'asphalt-light' }); }
    else for (const piece of clipLine(d.centerline)) surfaces.push({ kind: 'driveway', centerline: piece, width: d.width, z: 1, material: 'asphalt-light' });
  }
  for (const s of roadCenters) {
    if (s.kind === 'driveway') surfaces.push({ kind: 'driveway', centerline: s.centerline, width: s.width, z: 1, material: 'asphalt-light' });
  }
  // concrete sidewalks (filled polygons, clip closed rings rather than dropping a corner)
  for (const sw of swPolys) {
    const c = clipRing(sw.polygon); if (!c) continue;
    const entry = { kind: 'concrete-sidewalk', polygon: c, z: 2, material: 'concrete' };
    if (sw.holes && sw.holes.length) entry.holes = sw.holes.map(h => clipPolygonToRect(h, demRect)).filter(h => h.length >= 3);
    surfaces.push(entry);
  }
  // curb centerlines (z:3) — clip each to the box, keep curbLines as the shared welded source
  const curbLines = [];
  for (const cl of curbFromRuns) {
    for (const piece of clipLine(cl.line)) {
      curbLines.push({ line: piece, side: cl.side, spec: cl.spec });
      surfaces.push({ kind: 'curb', centerline: piece, width: CURB_WIDTH, z: 3, material: 'concrete-curb' });
    }
  }
  // crosswalk pads (z:4)
  for (const ring of xwalkPolys) { const c = clipRing(ring); if (c) surfaces.push({ kind: 'crosswalk', polygon: c, z: 4, material: 'concrete-light' }); }

  // --- assemble paint (highest z). Clip lane/edge line pieces to the box (offsetting a
  //     near-edge centreline outward can poke past the rect).
  const paint = [];
  const clipLines = (lines) => lines.flatMap(clipLine);
  lane.doubleYellow.lines = clipLines(lane.doubleYellow.lines);
  lane.edgeLine.lines = clipLines(lane.edgeLine.lines);
  if (lane.doubleYellow.lines.length) paint.push(lane.doubleYellow);
  if (lane.laneDash.rings.length) paint.push(lane.laneDash);
  if (lane.edgeLine.lines.length) paint.push(lane.edgeLine);
  // clip paint quad rings to the box (drop fully-outside, trim edge-straddlers)
  const clipQuads = (rings) => rings.map(r => clipPolygonToRect(r, demRect)).filter(r => r.length >= 3);
  const stopClipped = clipQuads(stopRings);
  const xwalkClipped = clipQuads(xwalkStripes);
  if (stopClipped.length) paint.push({ kind: 'stop-bar', rings: stopClipped, color: '#ffffff' });
  if (xwalkClipped.length) paint.push({ kind: 'crosswalk-stripe', rings: xwalkClipped, color: COL_WHITE });

  return { meta, surfaces, paint, curbLines };
}

export default buildRoadNetwork;
