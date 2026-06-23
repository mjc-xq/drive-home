// road_geometry.mjs — a REMOVABLE road + curb GEOMETRY layer that drapes EXACTLY on the welded
// terrain surface (samples `terrainAt`, never approximates it). It reuses the very same polygons the
// ground-atlas PAINTS (network.surfaces / curbLines), so the geometry and the paint beneath it agree
// to the polygon. The painted roads stay on the ground bed UNDER this layer: keep the layer for crisp
// asphalt + raised curbs, or delete the `RoadLayer` node to fall back to the paint.
//
// Frame: world XZ (same as building/tree layers). Y is up. Heights come from terrainAt(x,z), the exact
// height function the terrain mesh was built from, plus a tiny per-class offset to avoid z-fighting.
//
// Nodes added under group `RoadLayer`:
//   Roads_asphalt    dark asphalt carriageway (+ driveways, lighter)
//   Roads_sidewalk   concrete sidewalks + filleted corners + cul-de-sac wraps
//   Roads_crosswalk  crosswalk slabs
//   Roads_curb       RAISED curb lip (top face + vertical faces) along every curb line
//   Roads_markings   proud lane paint (double-yellow / dashes / edge lines / stop bars / xwalk stripes)

// Small lifts: the fill now CONFORMS to the terrain (drapedFill subdivides + drapes interior vertices),
// so the asphalt hugs the surface — only a hair of lift is needed to beat z-fighting with the painted
// bed, and a small lift keeps the edges from floating over the grass.
const ASPHALT_Y   = 0.06;    // carriageway just above the painted bed (covers coarser-conform error)
const DRIVEWAY_Y  = 0.05;
const SIDEWALK_Y  = 0.06;
const CROSSWALK_Y = 0.07;
const MARKING_Y   = 0.08;    // lane paint rides just above the asphalt geometry
const CURB_H      = 0.14;    // raised curb lip top
const SEG_MAX     = 1.0;     // densify polygon edges to <= this (m) so edges follow terrain curvature

const COL = {
  asphalt:        [0.205, 0.205, 0.220],
  'asphalt-light':[0.370, 0.370, 0.385],
  concrete:       [0.610, 0.602, 0.580],
  'concrete-light':[0.728, 0.720, 0.698],
  'concrete-curb':[0.560, 0.552, 0.532],
  yellow:         [0.92, 0.74, 0.16],
  white:          [0.90, 0.90, 0.87],
};

const norm2 = (a, b) => { const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };

// centreline polyline + width -> closed ring (left side forward, right side back)
function bandRing(line, width) {
  if (!line || line.length < 2) return null;
  const hw = width / 2, L = [], R = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    const [tx, tz] = norm2(a, b);             // tangent
    const nx = -tz, nz = tx;                  // left normal
    const p = line[i];
    L.push([p[0] + nx * hw, p[1] + nz * hw]);
    R.push([p[0] - nx * hw, p[1] - nz * hw]);
  }
  return L.concat(R.reverse());
}

// insert points along edges longer than SEG_MAX so a long road polygon still conforms to the surface
function densify(ring) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    out.push(a);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(L / SEG_MAX);
    for (let k = 1; k < n; k++) { const t = k / n; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}

// triangulate a (densified) ring with optional holes, then SUBDIVIDE each triangle until its edges
// are <= MAX_SUB and DRAPE every (incl. interior) vertex on the terrain — so the fill CONFORMS to the
// terrain surface (grade + crown + micro-relief), not just at the outline. This is what stops the
// terrain poking through a flat-fan interior; with it, only a hair of lift is needed.
// NB: ShapeUtils.triangulateShape needs real THREE.Vector2 points (it calls .equals()), not {x,y}.
const MAX_SUB = 2.5;   // subdivide road triangles to <= this edge length (m); ~terrain resolution. Finer
                       // (1.6) conforms tighter but ~doubles tris -> a heavier Blender master; 2.5 + the
                       // modest lift above keeps roads solid with a much lighter mesh.
function drapedFill(THREE, ShapeUtils, ring, holes, terrainAt, yOff, pos) {
  // NB: do NOT densify before triangulating — the longest-edge bisection below refines the whole fill
  // (boundary included) to MAX_SUB, so pre-densifying just multiplies the triangle count.
  const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
  const holeContours = (holes || []).map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
  if (contour.length < 3) return;
  let tris;
  try { tris = ShapeUtils.triangulateShape(contour, holeContours); } catch { return; }
  const all = contour.concat(...holeContours);
  const drape = (p) => pos.push(p[0], terrainAt(p[0], p[1]) + yOff, p[1]);   // p = [x, z]
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const d2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  // LONGEST-EDGE BISECTION: split only the longest edge each step. This refines long road polygons
  // along their length WITHOUT exploding thin ones (4-way midpoint split made 131k verts per sidewalk).
  // Preserves orientation; leaf pushes reversed (a,c,b) for Y-up normals.
  const emit = (a, b, c, d) => {
    const eab = d2(a, b), ebc = d2(b, c), eca = d2(c, a), maxE = Math.max(eab, ebc, eca);
    if (d <= 0 || maxE <= MAX_SUB) { drape(a); drape(c); drape(b); return; }
    if (eab === maxE)      { const m = mid(a, b); emit(a, m, c, d - 1); emit(m, b, c, d - 1); }
    else if (ebc === maxE) { const m = mid(b, c); emit(a, b, m, d - 1); emit(a, m, c, d - 1); }
    else                   { const m = mid(c, a); emit(a, b, m, d - 1); emit(b, c, m, d - 1); }
  };
  for (const [ia, ib, ic] of tris) {
    const a = all[ia], b = all[ib], c = all[ic];
    emit([a.x, a.y], [b.x, b.y], [c.x, c.y], 9);   // depth cap guards pathological tris (~512 leaves max)
  }
}

// a RAISED curb lip from a centreline: top strip at +CURB_H plus the two vertical side faces.
function curbLip(line, width, terrainAt, pos) {
  if (!line || line.length < 2) return;
  const hw = width / 2;
  const seg = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    const [tx, tz] = norm2(a, b); const nx = -tz, nz = tx; const p = line[i];
    const lx = p[0] + nx * hw, lz = p[1] + nz * hw, rx = p[0] - nx * hw, rz = p[1] - nz * hw;
    seg.push({ lx, lz, rx, rz, gl: terrainAt(lx, lz), gr: terrainAt(rx, rz) });
  }
  const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
  };
  for (let i = 0; i < seg.length - 1; i++) {
    const s = seg[i], t = seg[i + 1];
    const sTopL = s.gl + CURB_H, tTopL = t.gl + CURB_H, sTopR = s.gr + CURB_H, tTopR = t.gr + CURB_H;
    // top face
    quad(s.lx, sTopL, s.lz, t.lx, tTopL, t.lz, t.rx, tTopR, t.rz, s.rx, sTopR, s.rz);
    // left vertical face (ground -> top)
    quad(s.lx, s.gl, s.lz, t.lx, t.gl, t.lz, t.lx, tTopL, t.lz, s.lx, sTopL, s.lz);
    // right vertical face (top -> ground)
    quad(s.rx, sTopR, s.rz, t.rx, tTopR, t.rz, t.rx, t.gr, t.rz, s.rx, s.gr, s.rz);
  }
}

// thin proud quad strips for painted marks (lines) — a flat ribbon draped on the surface.
function markingRibbon(line, width, terrainAt, pos) {
  const ring = bandRing(line, width);
  if (ring) drapedFillNoTri(ring, terrainAt, MARKING_Y, pos);
}
// a band ring from bandRing() is a simple strip (L forward, R back) — fan it directly (already convex-ish)
function drapedFillNoTri(ring, terrainAt, yOff, pos) {
  const n = ring.length, half = n / 2;
  for (let i = 0; i < half - 1; i++) {
    const Lx = ring[i], Lx1 = ring[i + 1], Rx = ring[n - 1 - i], Rx1 = ring[n - 2 - i];
    const P = (p) => pos.push(p[0], terrainAt(p[0], p[1]) + yOff, p[1]);
    P(Lx); P(Rx); P(Lx1);   P(Lx1); P(Rx); P(Rx1);
  }
}

function meshFromPos(THREE, pos, name, rgb, rough = 0.9) {
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ name: `${name}_mat`, color: new THREE.Color(rgb[0], rgb[1], rgb[2]), roughness: rough, metalness: 0, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, m); mesh.name = name; return mesh;
}

export function buildRoadGeometryLayer({ THREE, scene, network, curbLines = [], terrainAt }) {
  if (!network || !network.surfaces) return { added: 0 };
  const ShapeUtils = THREE.ShapeUtils;

  const asphalt = [], driveway = [], sidewalk = [], crosswalk = [], curb = [], markYellow = [], markWhite = [];
  for (const s of network.surfaces) {
    // curb surfaces are a raised LIP from a centreline (not a flat fill)
    if (s.kind === 'curb' && s.centerline) { curbLip(s.centerline, s.width || 0.55, terrainAt, curb); continue; }
    // every other surface is a flat fill: a polygon (+ optional holes) or a centreline banded to a ring
    const ring = s.polygon || (s.centerline ? bandRing(s.centerline, s.width) : null);
    if (!ring || ring.length < 3) continue;
    const holes = s.polygon ? s.holes : null;   // holes only meaningful for an explicit polygon
    if (s.kind === 'asphalt')                drapedFill(THREE, ShapeUtils, ring, holes, terrainAt, ASPHALT_Y, asphalt);
    else if (s.kind === 'driveway')          drapedFill(THREE, ShapeUtils, ring, holes, terrainAt, DRIVEWAY_Y, driveway);
    else if (s.kind === 'concrete-sidewalk') drapedFill(THREE, ShapeUtils, ring, holes, terrainAt, SIDEWALK_Y, sidewalk);
    else if (s.kind === 'crosswalk')         drapedFill(THREE, ShapeUtils, ring, holes, terrainAt, CROSSWALK_Y, crosswalk);
  }
  // RAISED curb lip along every curb line (from curbLinesFromRoads + sidewalk-network curbs)
  for (const cl of curbLines) { const line = cl.line || cl; if (Array.isArray(line) && line.length >= 2) curbLip(line, 0.5, terrainAt, curb); }

  // lane paint marks as proud ribbons (kept-layer reads complete; paint beneath is the fallback)
  for (const p of (network.paint || [])) {
    const buf = /yellow/.test(p.kind) ? markYellow : markWhite;
    for (const ln of (p.lines || [])) markingRibbon(ln, p.width || 0.12, terrainAt, buf);
    for (const r of (p.rings || [])) { if (r.length >= 3) drapedFill(THREE, ShapeUtils, r, null, terrainAt, MARKING_Y, buf); }
  }

  const grp = new THREE.Group();
  grp.name = 'RoadLayer';
  grp.userData = { layer: 'roads', removable: true, note: 'street+curb geometry draped on terrain; painted roads remain on the ground bed beneath' };
  const add = (mesh) => { if (mesh) grp.add(mesh); };
  add(meshFromPos(THREE, asphalt,   'Roads_asphalt',   COL.asphalt, 0.93));
  add(meshFromPos(THREE, driveway,  'Roads_driveway',  COL['asphalt-light'], 0.92));
  add(meshFromPos(THREE, sidewalk,  'Roads_sidewalk',  COL.concrete, 0.86));
  add(meshFromPos(THREE, crosswalk, 'Roads_crosswalk', COL['concrete-light'], 0.85));
  add(meshFromPos(THREE, curb,      'Roads_curb',      COL['concrete-curb'], 0.84));
  add(meshFromPos(THREE, markYellow,'Roads_markings_yellow', COL.yellow, 0.6));
  add(meshFromPos(THREE, markWhite, 'Roads_markings_white',  COL.white, 0.6));
  if (grp.children.length) scene.add(grp);
  return { added: grp.children.length, group: grp };
}

export default buildRoadGeometryLayer;
