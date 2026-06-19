// Build a NO-PHOTO, stylized, game-ready GLB of the 1840 Dahill Lane neighborhood.
// Everything is flat-shaded solid colour — NO satellite / photographic ground or
// building textures (the only bitmaps are the stylized bark/leaf maps that ship
// inside the provided tree GLBs). Output: exports/1840-dahill-stylized.glb.
//
// Named, separately-deletable objects:
//   Terrain_Grass     - flat-shaded green DTM following exports/dem_1m.json.
//   Grass_Wind        - parent of hundreds of instanced grass-blade clumps. Each
//                       clump is its OWN node and is swayed by a looping glTF node
//                       animation ("GrassWind") -> the grass MOVES in any viewer
//                       that plays animations (Blender, three.js, Quick Look).
//   Roads / Sidewalks / Curbs - real ribbon geometry along scene.json roads[].
//   House_walls / House_roof  - the owner's extruded footprint.
//   Buildings_walls / Buildings_roofs - every other footprint, coloured per
//                       exports/buildings_color.json (flat colour, no photo).
//   Tree_#### nodes   - each tree from Trees.glb / Acacia.glb is its OWN named
//                       node (never merged) so it can be deleted individually in
//                       Blender. Grouped under the "Trees" node. Scale/rotation
//                       varies per tree.
//   YourLots / LotLines - parcel outlines; the owner's two lots highlighted, the
//                       back lot left empty (no building).
//
// Frame: flat-ENU, glTF Y-up, metres, origin at house centroid C (scene.json.center).
//   e = (lon-LON0)*cos(LAT0)*111320 ; n = (lat-LAT0)*110540
//   worldX = e - C[0] ; worldZ = -(n - C[1])
// scene.json polygons are already e/n, so w2(e,n) = [e-C[0], -(n-C[1])].
//
// Run:  node scripts/export_stylized_glb.mjs
// Full STYLIZED pipeline (fences must land in the final file):
//   node scripts/export_stylized_glb.mjs
//   blender --background --python scripts/place_fences.py -- exports/1840-dahill-stylized.glb
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

globalThis.self = globalThis;
if (typeof globalThis.FileReader === 'undefined') {       // GLTFExporter binary packer shim
  globalThis.FileReader = class {
    readAsArrayBuffer(b) { b.arrayBuffer().then(x => { this.result = x; this.onloadend && this.onloadend(); }); }
    readAsDataURL(b) { b.arrayBuffer().then(x => { this.result = `data:${b.type || 'application/octet-stream'};base64,${Buffer.from(x).toString('base64')}`; this.onloadend && this.onloadend(); }); }
  };
}

import { clipPolylineToBox, smoothLine, buildVertHit, vkey, roadSpec, roadRank, isCulDeSacRoad, snapCreekToChannel, buildSidewalkConnectors, buildSidewalkEndCaps, fanDisc, ringAnnulus, trimEndInward } from './road_prep.mjs';

const THREE = await import('three');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ex = f => path.join(ROOT, 'exports', f);
const S = JSON.parse(readFileSync(path.join(ROOT, 'src/assets/scene.json'), 'utf8'));
const C = S.center;                                       // house centroid (flat ENU)

// ---- flat-ENU frame (exactly as specified) -------------------------------
const LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * Math.PI / 180);
const w2 = (e, n) => [e - C[0], -(n - C[1])];                          // scene.json e/n -> world X,Z
// world X,Z -> lat/lon (inverse of the flat frame) for sampling the DEM grid
const worldToLL = (X, Z) => {
  const e = X + C[0], n = -Z + C[1];
  return [LAT0 + n / 110540, LON0 + e / (COSLAT * 111320)];
};

// ---- terrain: 1 m bare-earth DTM as flat-shaded grass ---------------------
const D = JSON.parse(readFileSync(ex('dem_1m.json'), 'utf8'));
const { cols, rows, h } = D;
const dLat = D.latN - D.latS, dLon = D.lonE - D.lonW;
const cropHalf = dLat * 110540 / 2 - 4;                   // square crop half-width (m)
// REAL terrain world bounds (the DEM patch may be off-centre from the house and is
// narrower E-W than N-S), so a symmetric ±cropHalf box lets trees fall past the edge
// into mid-air. Mirror the photo model: filter against these actual bounds.
const tXmin = (D.lonW - LON0) * COSLAT * 111320 - C[0], tXmax = (D.lonE - LON0) * COSLAT * 111320 - C[0];
const _zA = -((D.latN - LAT0) * 110540 - C[1]), _zB = -((D.latS - LAT0) * 110540 - C[1]);
const tZmin = Math.min(_zA, _zB), tZmax = Math.max(_zA, _zB);
// strictly inside the terrain (with margin) — used to drop out-of-range trees
const inTerrain = (X, Z, m = 4) => X >= tXmin + m && X <= tXmax - m && Z >= tZmin + m && Z <= tZmax - m;
// bilinear DEM sample at world X,Z
const terrainAt = (X, Z) => {
  const [lat, lon] = worldToLL(X, Z);
  let fi = (lon - D.lonW) / dLon * cols - 0.5, fj = (D.latN - lat) / dLat * rows - 0.5;
  fi = Math.max(0, Math.min(cols - 1.001, fi)); fj = Math.max(0, Math.min(rows - 1.001, fj));
  const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
  const a = h[j * cols + i], b = h[j * cols + i + 1], c = h[(j + 1) * cols + i], d = h[(j + 1) * cols + i + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
};

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rand = mulberry32(1840);

function mkMesh(positions, indices, color, name, opts = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (opts.colors) g.setAttribute('color', new THREE.Float32BufferAttribute(opts.colors, 3));
  if (opts.uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(opts.uvs, 2));
  if (indices) g.setIndex(indices);
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.95, metalness: 0, name: name + '_mat' });
  if (opts.colors) m.vertexColors = true;
  if (opts.flat) m.flatShading = true;
  m.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(g, m); mesh.name = name; return mesh;
}

// Build the grass terrain. Two flat green tones blended by a hashed value so the
// flat-shaded triangles read as a stylized lawn rather than one solid sheet.
const GRASS_A = new THREE.Color(0x5c8f3a), GRASS_B = new THREE.Color(0x76a64a);
{
  const pos = [], col = [], idx = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const lat = D.latN - (j + 0.5) / rows * dLat, lon = D.lonW + (i + 0.5) / cols * dLon;
    const e = (lon - LON0) * COSLAT * 111320, n = (lat - LAT0) * 110540;
    const X = e - C[0], Z = -(n - C[1]);
    pos.push(X, h[j * cols + i], Z);
    const t = (Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1;     // hashed mottle
    const c = GRASS_A.clone().lerp(GRASS_B, Math.abs(t));
    col.push(c.r, c.g, c.b);
  }
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1; idx.push(a, c, b, b, c, d);
  }
  // flat green BASE colour, NO per-vertex COLOR_0 — viewers like Quick Look render
  // displayColor/vertex over the base, which washed the lawn to white. Base-only = green everywhere.
  var terrainMesh = mkMesh(pos, idx, new THREE.Color(0.42, 0.6, 0.29), 'Terrain_Grass', { flat: true });
}

const scene = new THREE.Scene(); scene.name = '1840_Dahill_Stylized';
scene.add(terrainMesh);

// optional SATELLITE GROUND layer: same DTM geometry, textured with the real Google
// aerial, sitting 15 cm UNDER the grass. Hide Terrain_Grass + Grass_Wind in Blender to
// switch the ground from stylized lawn to satellite imagery.
const AER = existsSync(ex('google_aerial.json')) ? JSON.parse(readFileSync(ex('google_aerial.json'), 'utf8')) : null;
if (AER) {
  const sPos = [], sUv = [], sIdx = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const lat = D.latN - (j + 0.5) / rows * dLat, lon = D.lonW + (i + 0.5) / cols * dLon;
    const e = (lon - LON0) * COSLAT * 111320, n = (lat - LAT0) * 110540;
    sPos.push(e - C[0], h[j * cols + i] - 0.5, -(n - C[1]));   // 0.5 m under grass (no z-fighting)
    sUv.push((e - AER.E0) / (AER.E1 - AER.E0), (AER.Nt - n) / (AER.Nt - AER.Nb));
  }
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1; sIdx.push(a, c, b, b, c, d);
  }
  scene.add(mkMesh(sPos, sIdx, 0xffffff, 'SatelliteGround', { uvs: sUv }));
}

const inPatch = (X, Z) => Math.abs(X) <= cropHalf && Math.abs(Z) <= cropHalf;
const centroidEN = p => p.reduce((a, q) => [a[0] + q[0] / p.length, a[1] + q[1] / p.length], [0, 0]);
function inPoly(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function distToLines(x, z, lines, max) {
  let best = max;
  for (const lw of lines) for (let k = 1; k < lw.length; k++) {
    const [ax, az] = lw[k - 1], [bx, bz] = lw[k]; let dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz || 1; let t = ((x - ax) * dx + (z - az) * dz) / L2; t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return best;
}

// ---- roads + sidewalks + curbs (real ribbon geometry) --------------------
const roadLines = [];        // world centrelines (for tree/grass avoidance)
function ribbonPart(lineW, width, lift, posArr, idxArr) {
  const dense = [lineW[0]];
  for (let k = 1; k < lineW.length; k++) {
    const a = lineW[k - 1], b = lineW[k], seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(seg / 2.5));
    for (let s = 1; s <= steps; s++) dense.push([a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps]);
  }
  lineW = dense;
  const hw = width / 2;
  for (let k = 0; k < lineW.length; k++) {
    const [x, z] = lineW[k], p = lineW[Math.max(0, k - 1)], q = lineW[Math.min(lineW.length - 1, k + 1)];
    let dx = q[0] - p[0], dz = q[1] - p[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const nx = -dz, nz = dx, lx = x + nx * hw, lz = z + nz * hw, rx = x - nx * hw, rz = z - nz * hw;
    const off = posArr.length / 3;
    posArr.push(lx, terrainAt(lx, lz) + lift, lz, rx, terrainAt(rx, rz) + lift, rz);
    if (k > 0) { const a = off - 2, b = a + 1, c = off, d = off + 1; idxArr.push(a, c, b, b, c, d); }
  }
}
function flatWaterRibbon(lineW, width, lift, posArr, idxArr) {
  const dense = [lineW[0]];
  for (let k = 1; k < lineW.length; k++) {
    const a = lineW[k - 1], b = lineW[k], seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(seg / 2.0));
    for (let s = 1; s <= steps; s++) dense.push([a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps]);
  }
  const ys = dense.map(([x, z]) => terrainAt(x, z) + lift);
  for (let pass = 0; pass < 2; pass++) {
    const sm = ys.slice();
    for (let i = 1; i < ys.length - 1; i++) sm[i] = (ys[i - 1] + ys[i] * 2 + ys[i + 1]) / 4;
    ys.splice(0, ys.length, ...sm);
  }
  const hw = width / 2;
  for (let k = 0; k < dense.length; k++) {
    const [x, z] = dense[k], p = dense[Math.max(0, k - 1)], q = dense[Math.min(dense.length - 1, k + 1)];
    let dx = q[0] - p[0], dz = q[1] - p[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const nx = -dz, nz = dx, lx = x + nx * hw, lz = z + nz * hw, rx = x - nx * hw, rz = z - nz * hw;
    const off = posArr.length / 3;
    posArr.push(lx, ys[k], lz, rx, ys[k], rz);      // same Y both banks: flat water top
    if (k > 0) { const a = off - 2, b = a + 1, c = off, d = off + 1; idxArr.push(a, c, b, b, c, d); }
  }
}
// Offset a polyline a fixed distance along its LEFT normal (-dz, dx), with a mitre
// clamp so curbs/sidewalks don't pinch / self-cross on sharp corners.
const offsetLine = (lw, d) => lw.map((p, k) => {
  const a = lw[Math.max(0, k - 1)], b = lw[Math.min(lw.length - 1, k + 1)];
  let ax = p[0] - a[0], az = p[1] - a[1], bx = b[0] - p[0], bz = b[1] - p[1];
  const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
  ax /= la; az /= la; bx /= lb; bz /= lb;
  let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
  const cosHalf = Math.sqrt(Math.max(0, (1 + (ax * bx + az * bz)) / 2));
  const m = d / Math.max(0.35, cosHalf);
  return [p[0] - dz * m, p[1] + dx * m];
});
// Dashed YELLOW centre line: 3 m dash / 3.5 m gap, ~0.28 m wide, just above the
// asphalt. Each dash is two ground-following triangles. skip() drops dashes that
// fall inside a junction / cul-de-sac bulb.
function centreDashes(lw, halfW, lift, dPos, skip) {
  const ON = 3.0, OFF = 3.5; let draw = true, acc = 0;
  for (let k = 1; k < lw.length; k++) {
    const a = lw[k - 1], b = lw[k]; let dx = b[0] - a[0], dz = b[1] - a[1];
    const seg = Math.hypot(dx, dz) || 1; dx /= seg; dz /= seg; const nx = -dz, nz = dx;
    let t = 0;
    while (t < seg - 1e-6) {
      const len = Math.min((draw ? ON : OFF) - acc, seg - t);
      const mx = a[0] + dx * (t + len / 2), mz = a[1] + dz * (t + len / 2);
      if (draw && !(skip && skip(mx, mz))) {
        const x0 = a[0] + dx * t, z0 = a[1] + dz * t, x1 = a[0] + dx * (t + len), z1 = a[1] + dz * (t + len);
        const y0 = terrainAt(x0, z0) + lift, y1 = terrainAt(x1, z1) + lift;
        dPos.push(x0 + nx * halfW, y0, z0 + nz * halfW, x0 - nx * halfW, y0, z0 - nz * halfW, x1 - nx * halfW, y1, z1 - nz * halfW,
                  x0 + nx * halfW, y0, z0 + nz * halfW, x1 - nx * halfW, y1, z1 - nz * halfW, x1 + nx * halfW, y1, z1 + nz * halfW);
      }
      t += len; acc += len;
      if (acc >= (draw ? ON : OFF) - 1e-6) { draw = !draw; acc = 0; }
    }
  }
}
// Curb/sidewalk ribbon that skips quads whose centreline sample is within R_TRIM of
// a junction (no curb/sidewalk across an intersection). Takes an ALREADY-offset line.
function skipRibbon(lineW, width, lift, posArr, idxArr, skip) {
  const dense = [lineW[0]];
  for (let k = 1; k < lineW.length; k++) {
    const a = lineW[k - 1], b = lineW[k], seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(seg / 2.5));
    for (let s = 1; s <= steps; s++) dense.push([a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps]);
  }
  lineW = dense;
  const hw = width / 2; let prev = null;
  for (let k = 0; k < lineW.length; k++) {
    const [x, z] = lineW[k], p = lineW[Math.max(0, k - 1)], q = lineW[Math.min(lineW.length - 1, k + 1)];
    let dx = q[0] - p[0], dz = q[1] - p[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const nx = -dz, nz = dx, lx = x + nx * hw, lz = z + nz * hw, rx = x - nx * hw, rz = z - nz * hw;
    if (skip && skip(x, z)) { prev = null; continue; }
    const off = posArr.length / 3;
    posArr.push(lx, terrainAt(lx, lz) + lift, lz, rx, terrainAt(rx, rz) + lift, rz);
    if (prev !== null) { const a = prev, b = a + 1, c = off, d = off + 1; idxArr.push(a, c, b, b, c, d); }
    prev = off;
  }
}

const rPos = [], rIdx = [];                 // asphalt streets
const drvPos = [], drvIdx = [];             // mapped service/driveway pavement
const drvSrcPos = [], drvSrcIdx = [], parkSrcPos = [], parkSrcIdx = [];
const swPos = [], swIdx = [];               // concrete sidewalks
const swSrcPos = [], swSrcIdx = [], xwalkPos = [], xwalkIdx = [];
const cbPos = [], cbIdx = [];               // raised light curbs
const dPos = [];                            // dashed yellow centre line
// layer stack (metres above terrain). Asphalt lifted well clear so the satellite/
// grass under-layer never bleeds through; each higher layer sits above the last.
const LIFT_ASPHALT = 0.55, LIFT_DRIVEWAY = 0.60, LIFT_SIDEWALK = 0.62, LIFT_CURB = 0.70, LIFT_DASH = 0.61;
const SW_WIDTH = 1.8, SW_GAP = 2.2;         // road edge -> sidewalk centre spacing
const MAPSURFACES = ex('map_surfaces_osm.json');
const mapSurfaces = existsSync(MAPSURFACES) ? JSON.parse(readFileSync(MAPSURFACES, 'utf8')) : {};
const hasMappedDriveways = !!((mapSurfaces.drivewayPolygons || []).length || (mapSurfaces.driveways || []).length || (mapSurfaces.parkingAreas || []).length);
// Roads must reach the patch edge but NOT hang past it into the void: the terrain
// mesh only covers the DEM patch, and terrainAt clamps beyond it, so any ribbon
// vertex past the patch floats. Clip roads to the patch (cropHalf, ~4 m inside the
// ±200 m terrain) so they run edge-to-edge while every vertex stays on real ground.
const ROAD_HALF = cropHalf;
function surfacePolygon(poly, lift, posArr, idxArr) {
  const ring = (poly || []).filter(p => Array.isArray(p) && p.length >= 2);
  if (ring.length < 3) return false;
  if (!ring.every(([x, z]) => x >= tXmin - 2 && x <= tXmax + 2 && z >= tZmin - 2 && z <= tZmax + 2)) return false;
  const base = posArr.length / 3;
  for (const [x, z] of ring) posArr.push(x, terrainAt(x, z) + lift, z);
  const pts = ring.map(([x, z]) => new THREE.Vector2(x, z));
  const tris = THREE.ShapeUtils.triangulateShape(pts, []);
  for (const [a, b, c] of tris) idxArr.push(base + a, base + b, base + c);
  return true;
}
function sourceRibbon(lines, width, lift, posArr, idxArr) {
  for (const src of lines || []) {
    const pl = src.p || src;
    if (!Array.isArray(pl) || pl.length < 2) continue;
    for (let piece of clipPolylineToBox(pl, ROAD_HALF)) {
      piece = smoothLine(piece);
      if (piece.length < 2) continue;
      skipRibbon(piece, width, lift, posArr, idxArr, null);
      roadLines.push(piece);
    }
  }
}

// shared junction / dead-end vertex map (same logic + data as the photo model)
const vertHit = buildVertHit(S.roads || [], w2);
// bulbs / end-caps / junction pads only where they fully sit on terrain (use the
// real patch bounds with a margin, not the symmetric ROAD_HALF box, so no disc
// edge spills past the terrain into the void)
const inHalf = (x, z) => inTerrain(x, z, 14);
const isCourt = isCulDeSacRoad;
const R_TRIM_FOR = w => w / 2 + 0.5;
const junctionPts = [], junctionWidth = new Map(), junctionMaxRank = new Map();
for (const r of S.roads || []) {
  const pl = r.p || r; if (!Array.isArray(pl)) continue;
  const sp = roadSpec(r), rk = roadRank(r);
  for (const [e, n] of pl) {
    const [x, z] = w2(e, n), k = vkey(x, z);
    if ((vertHit.get(k) || 0) >= 2) {
      if (!junctionPts.some(p => p[0] === x && p[1] === z)) junctionPts.push([x, z]);
      junctionWidth.set(k, Math.max(junctionWidth.get(k) || 0, sp.width));
      junctionMaxRank.set(k, Math.max(junctionMaxRank.get(k) || 0, rk));
    }
  }
}
// cul-de-sac bulb centres (computed first so dashes/curbs can avoid them)
const bulbs = [];
for (const r of S.roads || []) {
  const pl = r.p || r; if (!Array.isArray(pl) || !isCourt(r)) continue;
  const spec = roadSpec(r);
  for (const end of [0, 1]) {
    const i = end ? pl.length - 1 : 0, j = end ? pl.length - 2 : 1;
    if (j < 0 || j >= pl.length) continue;
    const tip = w2(...pl[i]), prev = w2(...pl[j]);
    if (!inHalf(tip[0], tip[1])) continue;
    if ((vertHit.get(vkey(tip[0], tip[1])) || 0) > 1) continue;
    let tx = tip[0] - prev[0], tz = tip[1] - prev[1]; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
    // realistic residential cul-de-sac bulb: ~10-12 m diameter -> radius ~5-6 m,
    // scaled gently to the road width but clamped so it never balloons over lots.
    const R = Math.max(5, Math.min(6, spec.width * 0.75));
    bulbs.push({ cx: tip[0] + tx * (R - spec.width / 2), cz: tip[1] + tz * (R - spec.width / 2), R });
  }
}
const skipNearJunction = (x, z) => junctionPts.some(([px, pz]) => {
  const w = junctionWidth.get(vkey(px, pz)) || 7; const r = R_TRIM_FOR(w);
  const dx = x - px, dz = z - pz; return dx * dx + dz * dz < r * r;
}) || bulbs.some(({ cx, cz, R }) => { const dx = x - cx, dz = z - cz; return dx * dx + dz * dz < R * R; });

for (const r of S.roads || []) {
  const pl = r.p || r; if (!Array.isArray(pl)) continue;
  const lwRaw = pl.map(([e, n]) => w2(e, n));
  const spec = roadSpec(r), rk = roadRank(r);
  for (let piece of clipPolylineToBox(lwRaw, ROAD_HALF)) {
    for (const which of ['first', 'last']) {
      const tip = which === 'first' ? piece[0] : piece[piece.length - 1];
      const k = vkey(tip[0], tip[1]);
      if ((vertHit.get(k) || 0) >= 2 && (junctionMaxRank.get(k) || 0) > rk) {
        trimEndInward(piece, which, R_TRIM_FOR(junctionWidth.get(k) || spec.width));
      }
    }
    piece = smoothLine(piece);
    if (piece.length < 2) continue;
    roadLines.push(piece);
    if (spec.isService) {
      if (!hasMappedDriveways) ribbonPart(piece, spec.width, LIFT_DRIVEWAY, drvPos, drvIdx);
      continue;
    }
    ribbonPart(piece, spec.width, LIFT_ASPHALT, rPos, rIdx);                              // asphalt
    skipRibbon(offsetLine(piece, spec.width / 2 + 0.3), 0.55, LIFT_CURB, cbPos, cbIdx, skipNearJunction);
    skipRibbon(offsetLine(piece, -(spec.width / 2 + 0.3)), 0.55, LIFT_CURB, cbPos, cbIdx, skipNearJunction);
    if (spec.lanes >= 2) centreDashes(piece, 0.14, LIFT_DASH, dPos, skipNearJunction);
    if (!spec.isService) {
      const swDist = spec.width / 2 + SW_GAP;
      skipRibbon(offsetLine(piece, swDist), SW_WIDTH, LIFT_SIDEWALK, swPos, swIdx, skipNearJunction);
      skipRibbon(offsetLine(piece, -swDist), SW_WIDTH, LIFT_SIDEWALK, swPos, swIdx, skipNearJunction);
    }
  }
}
// Road-edge sidewalks: actual pedestrian paths run parallel to the carriageway,
// then meet through rounded connector arcs around intersection curb returns.
for (const run of buildSidewalkConnectors(S.roads || [], w2, {
  sideGap: SW_GAP,
  inPatch: (x, z) => inTerrain(x, z, 6),
})) skipRibbon(run, SW_WIDTH, LIFT_SIDEWALK, swPos, swIdx, null);
for (const run of buildSidewalkEndCaps(S.roads || [], w2, {
  sideGap: SW_GAP,
  inPatch: (x, z) => inTerrain(x, z, 6),
  isCourt,
})) skipRibbon(run, SW_WIDTH, LIFT_SIDEWALK, swPos, swIdx, null);
// cul-de-sac bulbs (court) + service end-caps + junction blend pads
const emitAsphalt = (x, z) => { const o = rPos.length / 3; rPos.push(x, terrainAt(x, z) + LIFT_ASPHALT, z); return o; };
const emitDriveway = (x, z) => { const o = drvPos.length / 3; drvPos.push(x, terrainAt(x, z) + LIFT_DRIVEWAY, z); return o; };
const emitCurb = (x, z) => { const o = cbPos.length / 3; cbPos.push(x, terrainAt(x, z) + LIFT_CURB, z); return o; };
const emitSidewalk = (x, z) => { const o = swPos.length / 3; swPos.push(x, terrainAt(x, z) + LIFT_SIDEWALK, z); return o; };
for (const { cx, cz, R } of bulbs) {
  fanDisc(cx, cz, R, 24, emitAsphalt, rIdx);
  ringAnnulus(cx, cz, R, R + 0.3, 24, emitCurb, cbIdx);
  ringAnnulus(cx, cz, R + 0.95, R + 0.95 + SW_WIDTH, 32, emitSidewalk, swIdx);
}
for (const r of S.roads || []) {
  const pl = r.p || r; if (!Array.isArray(pl) || isCourt(r)) continue;
  const spec = roadSpec(r);
  for (const end of [0, 1]) {
    const i = end ? pl.length - 1 : 0, j = end ? pl.length - 2 : 1;
    if (j < 0 || j >= pl.length) continue;
    const tip = w2(...pl[i]);
    if (!inHalf(tip[0], tip[1])) continue;
    if ((vertHit.get(vkey(tip[0], tip[1])) || 0) > 1) continue;
    const emit = spec.isService ? emitDriveway : emitAsphalt;
    const idx = spec.isService ? drvIdx : rIdx;
    fanDisc(tip[0], tip[1], spec.width / 2, 12, emit, idx);
  }
}
// junction blend pads: a small asphalt fillet (radius = half the widest road, so it
// just fills the corner, never a big black coin over rooftops) centred on each
// real junction vertex that sits on terrain.
for (const [px, pz] of junctionPts) {
  if (!inHalf(px, pz)) continue;
  const w = junctionWidth.get(vkey(px, pz)) || 7;
  fanDisc(px, pz, w / 2 + 0.4, 20, emitAsphalt, rIdx);
}
for (const d of mapSurfaces.drivewayPolygons || []) surfacePolygon(d.polygon, LIFT_DRIVEWAY + 0.02, drvSrcPos, drvSrcIdx);
for (const p of mapSurfaces.parkingAreas || []) surfacePolygon(p.polygon, LIFT_DRIVEWAY + 0.01, parkSrcPos, parkSrcIdx);
sourceRibbon((mapSurfaces.driveways || []).filter(d => !(d.polygon)), 3.6, LIFT_DRIVEWAY + 0.03, drvSrcPos, drvSrcIdx);
sourceRibbon(mapSurfaces.sidewalks || [], SW_WIDTH, LIFT_SIDEWALK + 0.03, swSrcPos, swSrcIdx);
sourceRibbon(mapSurfaces.crossings || [], 2.4, LIFT_SIDEWALK + 0.04, xwalkPos, xwalkIdx);
const DRIVEWAYSJSON = ex('driveways_osm.json');
if (!hasMappedDriveways && existsSync(DRIVEWAYSJSON)) {
  const mapped = JSON.parse(readFileSync(DRIVEWAYSJSON, 'utf8')).driveways || [];
  for (const d of mapped) {
    const width = d.service === 'parking_aisle' ? 5.0 : 3.6;
    for (let piece of clipPolylineToBox(d.p || [], ROAD_HALF)) {
      piece = smoothLine(piece);
      if (piece.length < 2) continue;
      roadLines.push(piece);
      ribbonPart(piece, width, LIFT_DRIVEWAY, drvPos, drvIdx);
    }
  }
}
if (rIdx.length) scene.add(mkMesh(rPos, rIdx, 0x2f2f33, 'Roads', { rough: 0.98 }));       // dark asphalt
if (drvIdx.length) scene.add(mkMesh(drvPos, drvIdx, 0x77787a, 'Driveways', { rough: 0.95 }));
if (drvSrcIdx.length) scene.add(mkMesh(drvSrcPos, drvSrcIdx, 0x7d7f80, 'Driveways_Mapped', { rough: 0.95 }));
if (parkSrcIdx.length) scene.add(mkMesh(parkSrcPos, parkSrcIdx, 0x6f7272, 'ParkingAreas_Mapped', { rough: 0.95 }));
if (swIdx.length) scene.add(mkMesh(swPos, swIdx, 0xb9b6ae, 'Sidewalks', { rough: 0.95 })); // light concrete
if (swSrcIdx.length) scene.add(mkMesh(swSrcPos, swSrcIdx, 0xc4c0b6, 'Sidewalks_Mapped', { rough: 0.95 }));
if (xwalkIdx.length) scene.add(mkMesh(xwalkPos, xwalkIdx, 0xd9d5ca, 'Crosswalks_Mapped', { rough: 0.95 }));
if (cbIdx.length) scene.add(mkMesh(cbPos, cbIdx, 0xcacaca, 'Curbs', { rough: 0.9 }));      // raised light curbs
if (dPos.length) scene.add(mkMesh(dPos, null, 0xf2c81e, 'RoadLines', { rough: 0.6 }));      // dashed yellow centre line

// ---- buildings: extrude footprints, flat colour per Street View ----------
const COL = existsSync(ex('buildings_color.json')) ? JSON.parse(readFileSync(ex('buildings_color.json'), 'utf8')) : {};
// Real per-roof aerial colour (exports/buildings_roof_color.json), keyed by building
// index into scene.json buildings; values are LINEAR RGB. Used as the flat roof
// colour when present — still NO photo texture, just a measured solid colour.
const RCOL = existsSync(ex('buildings_roof_color.json')) ? JSON.parse(readFileSync(ex('buildings_roof_color.json'), 'utf8')) : {};
const STUCCO = [0.82, 0.78, 0.70];
const wallColor = ib => COL[ib] || STUCCO;
// WHOLE building takes its Street View colour (per the brief): the roof is the same
// SV colour, just darkened ~0.8 for a little depth. (Was the aerial roof colour.)
function roofColor(ib) {
  return wallColor(ib).map(c => Math.max(0, c * 0.8));
}
function _unusedRoofColor(ib) {
  if (RCOL[ib]) return RCOL[ib];
  const w = wallColor(ib);
  const m = (w[0] + w[1] + w[2]) / 3;
  return [Math.max(0.12, w[0] * 0.45 + m * 0.05), Math.max(0.12, w[1] * 0.45 + m * 0.05), Math.max(0.14, w[2] * 0.45 + m * 0.08)];
}
const TILE = 3.0;
function pushWallRect(pos, ax, az, ex, ez, nx, nz, s0, s1, y0, y1, off = 0.09) {
  const A = [ax + ex * s0 + nx * off, y0, az + ez * s0 + nz * off];
  const B = [ax + ex * s1 + nx * off, y0, az + ez * s1 + nz * off];
  const Cc = [ax + ex * s1 + nx * off, y1, az + ez * s1 + nz * off];
  const Dd = [ax + ex * s0 + nx * off, y1, az + ez * s0 + nz * off];
  for (const v of [A, B, Cc, A, Cc, Dd]) pos.push(v[0], v[1], v[2]);
}
function emitFacadeDetails(ring, base, wallH, D, opts = {}) {
  if (!D) return;
  if (opts.autoWindows === false) return;
  const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
  const yt = base + wallH;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 2.4 || wallH < 2.7) continue;
    let ex = (bx - ax) / L, ez = (bz - az) / L;
    let nx = -ez, nz = ex;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if ((mx - cen[0]) * nx + (mz - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
    const bay = opts.house ? 3.0 : 3.35;
    const count = Math.max(1, Math.min(12, Math.floor((L - 1.0) / bay)));
    const floors = Math.max(1, Math.min(3, Math.floor((wallH - 1.15) / 2.55)));
    for (let f = 0; f < floors; f++) {
      const y0 = base + 1.10 + f * 2.45;
      const y1 = Math.min(y0 + 1.02, yt - 0.42);
      if (y1 - y0 < 0.45) continue;
      for (let w = 0; w < count; w++) {
        const s = (w + 1) * L / (count + 1);
        if (s < 0.85 || L - s < 0.85) continue;
        const hw = Math.min(0.58, Math.max(0.36, L / (count + 1) * 0.20));
        pushWallRect(D.trim, ax, az, ex, ez, nx, nz, s - hw - 0.12, s + hw + 0.12, y0 - 0.10, y1 + 0.10, 0.082);
        pushWallRect(D.glass, ax, az, ex, ez, nx, nz, s - hw, s + hw, y0, y1, 0.105);
        pushWallRect(D.trim, ax, az, ex, ez, nx, nz, s - 0.025, s + 0.025, y0 + 0.05, y1 - 0.05, 0.118);
        pushWallRect(D.trim, ax, az, ex, ez, nx, nz, s - hw - 0.18, s + hw + 0.18, y0 - 0.20, y0 - 0.12, 0.115);
      }
    }
  }
}
function gableTris(rect, base, wallH) {
  let [rcx, rcy, w, d, deg] = rect;
  let L = w, Sp = d, ang = deg * Math.PI / 180;
  if (d > w) { L = d; Sp = w; ang += Math.PI / 2; }
  const rise = Math.min(2.6, Math.max(0.85, Sp * 0.30));
  const ov = 0.45, hw = L / 2 + ov, hd = Sp / 2 + ov, y0 = wallH - 0.04, y1 = wallH - 0.04 + rise;
  const A = [-hw, y0, -hd], B = [hw, y0, -hd], Cc = [hw, y0, hd], Dd = [-hw, y0, hd], R1 = [-hw, y1, 0], R2 = [hw, y1, 0];
  const seq = [A, R1, R2, A, R2, B, Cc, R2, R1, Cc, R1, Dd, B, R2, Cc, A, Dd, R1];
  const ca = Math.cos(ang), sa = Math.sin(ang), [tx, tz] = w2(rcx, rcy), out = [];
  for (const [x, y, z] of seq) out.push(x * ca + z * sa + tx, y + base, -x * sa + z * ca + tz);
  return out;
}
function pushUpTri(Rf, col, a, b, c) {
  const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
  const tri = (uz * vx - ux * vz) < 0 ? [a, c, b] : [a, b, c];
  for (const v of tri) { Rf.pos.push(v[0], v[1], v[2]); Rf.col.push(col[0], col[1], col[2]); }
}
function emitRing(ring, base, wallH, roofRects, wallC, roofC, W, Rf, detail, detailOpts = {}) {
  if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
  const yb = base, yt = base + wallH;
  for (let i = 0; i < ring.length; i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[(i + 1) % ring.length];
    W.pos.push(xi, yb, zi, xj, yb, zj, xj, yt, zj, xi, yb, zi, xj, yt, zj, xi, yt, zi);
    for (let k = 0; k < 6; k++) W.col.push(wallC[0], wallC[1], wallC[2]);
  }
  const v2 = ring.map(([x, z]) => new THREE.Vector2(x, z));
  for (const [a, c, d] of THREE.ShapeUtils.triangulateShape(v2, []))
    pushUpTri(Rf, roofC, [ring[a][0], yt, ring[a][1]], [ring[c][0], yt, ring[c][1]], [ring[d][0], yt, ring[d][1]]);
  if (roofRects) for (const r of roofRects) {
    const g = gableTris(r, base, wallH);
    for (let k = 0; k < g.length; k += 9)
      pushUpTri(Rf, roofC, [g[k], g[k + 1], g[k + 2]], [g[k + 3], g[k + 4], g[k + 5]], [g[k + 6], g[k + 7], g[k + 8]]);
  }
  emitFacadeDetails(ring, base, wallH, detail, detailOpts);
  return ring;
}
const emitBuilding = (b, ib, base, wallH, W, Rf, detail, detailOpts) =>
  emitRing(b.p.map(([e, n]) => w2(e, n)), base, wallH, b.r, wallColor(ib), roofColor(ib), W, Rf, detail, detailOpts);
const wallHeight = b => { const H = b.h || 4.5; return ((b.r && b.r.length) ? Math.max(2.4, H * 0.8) : H) + 0.5; };

// owner's parcels: skip foreign buildings on them; keep the back lot empty
const pip = (x, z, r) => inPoly(x, z, r);
const PARCELS = existsSync(ex('parcels.json')) ? (JSON.parse(readFileSync(ex('parcels.json'), 'utf8')).parcels || []) : [];
const MINE = PARCELS.filter(p => p.mine).map(p => p.ring);
const inMine = (x, z) => MINE.some(r => pip(x, z, r));

const buildingPolys = [];
const houseIdx = S.buildings.findIndex(b => b.house);
const hW = { pos: [], col: [] }, hRf = { pos: [], col: [] };
const hD = { glass: [], trim: [] };
let houseRing = null, houseWallH = 0;
if (houseIdx >= 0) {
  const houseB = S.buildings[houseIdx];
  const hc = centroidEN(houseB.p), base = terrainAt(...w2(hc[0], hc[1])) - 0.5;
  houseWallH = wallHeight(houseB);
  houseRing = emitBuilding(houseB, houseIdx, base, houseWallH, hW, hRf, hD, { house: true, autoWindows: false });
  buildingPolys.push(houseRing);
  // base colour = building's own SV colour, so it renders in every viewer (not just COLOR_0)
  scene.add(mkMesh(hW.pos, null, new THREE.Color(...wallColor(houseIdx)), 'House_walls', { rough: 0.9 }));
  scene.add(mkMesh(hRf.pos, null, new THREE.Color(...roofColor(houseIdx)), 'House_roof', { rough: 0.85 }));
  if (hD.trim.length) scene.add(mkMesh(hD.trim, null, 0xd8d0bd, 'House_window_trim', { rough: 0.8 }));
  if (hD.glass.length) scene.add(mkMesh(hD.glass, null, 0x223647, 'House_windows', { rough: 0.55 }));
}
const bW = { pos: [], col: [] }, bRf = { pos: [], col: [] };
const bD = { glass: [], trim: [] };
const wallGroups = [], roofGroups = [];   // per-building [start, count, colour] -> material array
let nBld = 0, nSkip = 0;
S.buildings.forEach((b, ib) => {
  if (b.house) return;
  const cen = centroidEN(b.p); const cw = w2(cen[0], cen[1]); if (!inPatch(cw[0], cw[1])) return;
  if (inMine(cw[0], cw[1])) { nSkip++; return; }
  const base = terrainAt(cw[0], cw[1]) - 0.5;
  const ws = bW.pos.length / 3, rs = bRf.pos.length / 3;
  buildingPolys.push(emitBuilding(b, ib, base, wallHeight(b), bW, bRf, bD, {}));
  wallGroups.push([ws, bW.pos.length / 3 - ws, wallColor(ib)]);
  roofGroups.push([rs, bRf.pos.length / 3 - rs, roofColor(ib)]);
  nBld++;
});
// per-building MATERIALS (base colour = the SV colour) via geometry groups, so the colour
// renders in every viewer — no reliance on per-vertex COLOR_0 (Quick Look ignores it).
function groupedMesh(buf, groups, name, rough) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.computeVertexNormals();
  const mats = groups.map(([start, count, col], i) => {
    g.addGroup(start, count, i);
    const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(col[0], col[1], col[2]), roughness: rough, metalness: 0, name: `${name}_${i}` });
    m.side = THREE.DoubleSide; return m;
  });
  const mesh = new THREE.Mesh(g, mats); mesh.name = name; return mesh;
}
if (bW.pos.length) {
  scene.add(groupedMesh(bW, wallGroups, 'Buildings_walls', 0.9));
  scene.add(groupedMesh(bRf, roofGroups, 'Buildings_roofs', 0.85));
  if (bD.trim.length) scene.add(mkMesh(bD.trim, null, 0xd2c9b8, 'Buildings_window_trim', { rough: 0.8 }));
  if (bD.glass.length) scene.add(mkMesh(bD.glass, null, 0x203342, 'Buildings_windows', { rough: 0.55 }));
}
const onBuilding = (x, z) => buildingPolys.some(r => inPoly(x, z, r));

// ---- Doors ----------------------------------------------------------------
function emitOwnerHouseFacadeCues(ring, wallH, out) {
  if (!ring || ring.length < 3 || !out) return;
  const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
  const edges = ring.map(([ax, az], i) => {
    const [bx, bz] = ring[(i + 1) % ring.length];
    const L = Math.hypot(bx - ax, bz - az);
    let ex = (bx - ax) / (L || 1), ez = (bz - az) / (L || 1);
    let nx = -ez, nz = ex;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if ((mx - cen[0]) * nx + (mz - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
    return { i, ax, az, bx, bz, L, ex, ez, nx, nz, mx, mz, roadD: distToLines(mx, mz, roadLines, 1e9) };
  }).filter(e => e.L >= 2.2);
  if (!edges.length) return;
  const front = edges.reduce((a, b) => b.roadD < a.roadD ? b : a);
  const back = edges.reduce((a, b) => (b.nx * front.nx + b.nz * front.nz) < (a.nx * front.nx + a.nz * front.nz) ? b : a, front);
  const addWindow = (e, t, halfW = 0.48, y0 = 1.08, h = 0.92, wide = false) => {
    if (!e || e.L < 2.4) return;
    const s = Math.max(halfW + 0.18, Math.min(e.L - halfW - 0.18, e.L * t));
    const base = terrainAt(e.mx, e.mz) - 0.10;
    const yA = base + y0, yB = Math.min(base + y0 + h, base + wallH - 0.45);
    if (yB - yA < 0.35) return;
    pushWallRect(out.trim, e.ax, e.az, e.ex, e.ez, e.nx, e.nz, s - halfW - 0.12, s + halfW + 0.12, yA - 0.10, yB + 0.10, 0.086);
    pushWallRect(out.glass, e.ax, e.az, e.ex, e.ez, e.nx, e.nz, s - halfW, s + halfW, yA, yB, 0.118);
    pushWallRect(out.trim, e.ax, e.az, e.ex, e.ez, e.nx, e.nz, s - 0.025, s + 0.025, yA + 0.04, yB - 0.04, 0.13);
    if (wide) pushWallRect(out.trim, e.ax, e.az, e.ex, e.ez, e.nx, e.nz, s - halfW - 0.18, s + halfW + 0.18, yA - 0.20, yA - 0.12, 0.13);
  };
  const addDoorGlass = (e, t, halfW = 0.62) => {
    const s = Math.max(halfW + 0.22, Math.min(e.L - halfW - 0.22, e.L * t));
    const base = terrainAt(e.mx, e.mz) - 0.10;
    pushWallRect(out.trim, e.ax, e.az, e.ex, e.ez, e.nx, e.nz, s - halfW - 0.12, s + halfW + 0.12, base + 0.02, base + 2.16, 0.088);
    pushWallRect(out.glass, e.ax, e.az, e.ex, e.ez, e.nx, e.nz, s - halfW, s + halfW, base + 0.12, base + 2.04, 0.122);
  };
  const garageT = front.ax > front.bx ? 0.20 : 0.80;
  const doorT = front.ax > front.bx ? 0.72 : 0.28;
  addWindow(front, (doorT + garageT) / 2, 0.42, 1.18, 0.82);
  for (const e of edges) {
    if (e === front) continue;
    if (e === back) {
      addDoorGlass(e, 0.48, 0.82);
      if (e.L > 6.0) { addWindow(e, 0.23, 0.42); addWindow(e, 0.75, 0.42); }
    } else if (e.L > 5.5) {
      addWindow(e, 0.32, 0.46);
      addWindow(e, 0.68, 0.46);
    } else {
      addWindow(e, 0.50, 0.42);
    }
  }
}
const houseCue = { glass: [], trim: [] };
emitOwnerHouseFacadeCues(houseRing, houseWallH, houseCue);
if (houseCue.trim.length) scene.add(mkMesh(houseCue.trim, null, 0xd8d0bd, 'House_window_trim', { rough: 0.8 }));
if (houseCue.glass.length) scene.add(mkMesh(houseCue.glass, null, 0x223647, 'House_windows', { rough: 0.55 }));

const dwPos = [], dwCol = [], garagePos = [], garageTrim = [], DOORCOL = [0.24, 0.16, 0.10];
let houseDoor = null, houseGarage = null;
buildingPolys.forEach((ring, bi) => {
  if (ring.length < 2) return;
  const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
  let best = null, bestD = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    if (Math.hypot(bx - ax, bz - az) < 1.6) continue;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2, d = distToLines(mx, mz, roadLines, 1e9);
    if (d < bestD) { bestD = d; best = [ax, az, bx, bz]; }
  }
  if (!best) return;
  const [ax, az, bx, bz] = best;
  let ex = bx - ax, ez = bz - az; const L = Math.hypot(ex, ez) || 1; ex /= L; ez /= L;
  let nx = -ez, nz = ex; const m0x = (ax + bx) / 2, m0z = (az + bz) / 2;
  if ((m0x - cen[0]) * nx + (m0z - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
  let t = 0.5; if (bi === 0) t = (ax > bx) ? 0.72 : 0.28;   // house: door on SW (non-garage) half
  const dcx = ax + (bx - ax) * t, dcz = az + (bz - az) * t;
  const hw = 0.5, H = 2.1, base = terrainAt(dcx, dcz) - 0.1, cx = dcx + nx * 0.07, cz = dcz + nz * 0.07;
  const P = (s, y) => [cx + ex * s, base + y, cz + ez * s];
  const A = P(-hw, 0), B = P(hw, 0), Cc = P(hw, H), D = P(-hw, H);
  for (const tri of [[A, B, Cc], [A, Cc, D]]) for (const v of tri) { dwPos.push(v[0], v[1], v[2]); dwCol.push(...DOORCOL); }
  if (bi === 0) {
    houseDoor = [dcx, dcz]; houseGarage = (ax > bx) ? [ax, az] : [bx, bz];
    const gt = (ax > bx) ? 0.20 : 0.80;
    const gs = L * gt, ghw = Math.min(1.65, Math.max(1.25, L * 0.16));
    const gx = ax + ex * gs, gz = az + ez * gs, gb = terrainAt(gx, gz) - 0.08;
    pushWallRect(garageTrim, ax, az, ex, ez, nx, nz, gs - ghw - 0.16, gs + ghw + 0.16, gb - 0.03, gb + 2.35, 0.095);
    pushWallRect(garagePos, ax, az, ex, ez, nx, nz, gs - ghw, gs + ghw, gb + 0.06, gb + 2.18, 0.125);
  }
});
if (dwPos.length) scene.add(mkMesh(dwPos, null, new THREE.Color(...DOORCOL), 'Doors', {}));
if (garageTrim.length) scene.add(mkMesh(garageTrim, null, 0xd8d0bd, 'GarageDoor_trim', { rough: 0.8 }));
if (garagePos.length) scene.add(mkMesh(garagePos, null, 0x5e6266, 'GarageDoors', { rough: 0.65 }));
// Driveways are sourced from mapped service ways above. Do not synthesize a custom
// garage-to-road strip here; if the map has no driveway, leave it for hand editing.

// ---- creek centreline (for the riparian tree band) -----------------------
let creekW = null;
if (S.creek && S.creek.p) {
  creekW = S.creek.p.map(([e, n]) => w2(e, n)).filter(([x, z]) => Math.abs(x) <= cropHalf + 3 && Math.abs(z) <= cropHalf + 3);
  creekW = snapCreekToChannel(creekW, terrainAt, { radius: 18, step: 1.5, strength: 0.9, smoothPasses: 2 });
  if (creekW.length >= 2) {
    const CREEK_WIDTH = Number.isFinite(+process.env.CREEK_WIDTH_M) ? +process.env.CREEK_WIDTH_M : 6.0;
    const CREEK_DEPTH = Number.isFinite(+process.env.CREEK_DEPTH_M) ? +process.env.CREEK_DEPTH_M : 0.22;
    const cPos = [], cIdx = []; flatWaterRibbon(creekW, CREEK_WIDTH, CREEK_DEPTH, cPos, cIdx);
    scene.add(mkMesh(cPos, cIdx, 0x3a78c2, 'Creek_SanLorenzo', { rough: 0.4 }));
  }
}

// ---- ANIMATED grass-blade clumps (looping glTF node animation) -----------
// Each clump is a low-poly fan of blades and is ITS OWN named node. A looping
// "GrassWind" clip rotates every clump's quaternion about Z with a per-clump
// phase offset (derived from world position) so a wind gust appears to sweep
// across the field. The clip is exported into the GLB, so the grass animates
// in any viewer that auto-plays animations (Blender, three.js, Quick Look).
function bladeClumpGeometry() {
  // a few crossed quads, pivot at the base (y=0), ~0.55 m tall
  const pos = [], col = [];
  const base = new THREE.Color(0x4f8a30), tip = new THREE.Color(0x9fd45f);
  const blades = 5;
  for (let bI = 0; bI < blades; bI++) {
    const ang = (bI / blades) * Math.PI * 2 + rand() * 0.6;
    const r = 0.06 + rand() * 0.10, hgt = 0.42 + rand() * 0.30, lean = 0.06 + rand() * 0.05;
    const bx = Math.cos(ang) * r, bz = Math.sin(ang) * r, wdt = 0.035;
    const px = -Math.sin(ang) * wdt, pz = Math.cos(ang) * wdt;     // blade-width axis
    const tx = bx + Math.cos(ang) * lean, tz = bz + Math.sin(ang) * lean;
    // two tris forming a tapered blade
    const A = [bx - px, 0, bz - pz], B = [bx + px, 0, bz + pz], T = [tx, hgt, tz];
    for (const [v, c] of [[A, base], [B, base], [T, tip]]) { pos.push(...v); col.push(c.r, c.g, c.b); }
    for (const [v, c] of [[B, base], [A, base], [T, tip]]) { pos.push(...v); col.push(c.r, c.g, c.b); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
const grassMat = new THREE.MeshStandardMaterial({ name: 'Grass_mat', vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
const grassGroup = new THREE.Group(); grassGroup.name = 'Grass_Wind';
scene.add(grassGroup);

// scatter clumps on open ground only (off roads/sidewalks/buildings, near grade)
const grassOK = (x, z) => inPatch(x, z) && !onBuilding(x, z) && distToLines(x, z, roadLines, 5.5) >= 5.5;
const clumpNodes = [];
const GRID = 9;                                  // metres between candidate clumps
const MAXCLUMPS = 520;                           // keep the GLB lean
for (let z = -cropHalf; z <= cropHalf && clumpNodes.length < MAXCLUMPS; z += GRID) {
  for (let x = -cropHalf; x <= cropHalf && clumpNodes.length < MAXCLUMPS; x += GRID) {
    const jx = x + (rand() - 0.5) * GRID * 0.8, jz = z + (rand() - 0.5) * GRID * 0.8;
    if (!grassOK(jx, jz) || rand() < 0.45) continue;
    const clump = new THREE.Mesh(bladeClumpGeometry(), grassMat);
    clump.name = `GrassClump_${String(clumpNodes.length).padStart(4, '0')}`;
    const s = 1.4 + rand() * 1.8;                // clump footprint scale
    clump.scale.set(s, 1.2 + rand() * 1.3, s);
    clump.position.set(jx, terrainAt(jx, jz), jz);
    clump.rotation.y = rand() * Math.PI * 2;
    grassGroup.add(clump);
    clumpNodes.push(clump);
  }
}
// Build the looping wind animation: each clump sways about its local Z axis.
// Sample a sine sweep at keyframes; phase offset by position -> travelling gust.
const animations = [];
if (clumpNodes.length) {
  const PERIOD = 3.0, KEYS = 13;                                   // 3 s loop
  const times = Array.from({ length: KEYS }, (_, k) => k / (KEYS - 1) * PERIOD);
  const tracks = [];
  const axis = new THREE.Vector3(0, 0, 1), q = new THREE.Quaternion();
  for (const clump of clumpNodes) {
    const phase = (clump.position.x * 0.05 + clump.position.z * 0.03);  // gust sweep
    const amp = 0.13 + rand() * 0.06;                                   // sway radians
    const vals = [];
    for (let k = 0; k < KEYS; k++) {
      const t = times[k] / PERIOD * Math.PI * 2;
      const ang = Math.sin(t + phase) * amp + Math.sin(t * 2.3 + phase) * amp * 0.25;
      q.setFromAxisAngle(axis, ang);
      vals.push(q.x, q.y, q.z, q.w);
    }
    // bind by node UUID so the exporter resolves the right node regardless of name
    tracks.push(new THREE.QuaternionKeyframeTrack(`${clump.uuid}.quaternion`, times.slice(), vals));
  }
  animations.push(new THREE.AnimationClip('GrassWind', PERIOD, tracks));
}

// ---- parcel outlines (owner lots highlighted) ----------------------------
let nMine = 0;
if (PARCELS.length) {
  const lPos = [], lIdx = [], yPos = [], yIdx = [];
  for (const p of PARCELS) {
    const ring = p.ring.map(([x, z]) => [x, z]);
    if (ring.length < 2) continue;
    // skip parcels entirely outside the terrain crop (keeps the frame tight)
    if (!ring.some(([x, z]) => Math.abs(x) <= cropHalf + 2 && Math.abs(z) <= cropHalf + 2)) continue;
    const closed = ring[0][0] === ring[ring.length - 1][0] ? ring : ring.concat([ring[0]]);
    if (p.mine) { ribbonPart(closed, 1.1, 0.22, yPos, yIdx); nMine++; }
    else ribbonPart(closed, 0.5, 0.12, lPos, lIdx);
  }
  // property lines HIDDEN by default (set SHOW_LOTLINES=true to bring them back)
  const SHOW_LOTLINES = false;
  if (SHOW_LOTLINES && lIdx.length) scene.add(mkMesh(lPos, lIdx, 0xe8e2d0, 'LotLines'));
  if (SHOW_LOTLINES && yIdx.length) scene.add(mkMesh(yPos, yIdx, 0xffcf33, 'YourLots'));
}

// ---- export the base GLB (terrain/roads/houses/grass + animation) --------
const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false, animations });
mkdirSync(path.join(ROOT, 'exports'), { recursive: true });

// ---- place TREES: instance Trees.glb + Acacia.glb, one node per tree -----
// Done with @gltf-transform so each placed tree is a separate, named scene node
// (a copy of the source tree's node subtree) -> individually deletable in Blender.
const { NodeIO } = await import('@gltf-transform/core');
const { mergeDocuments, unpartition } = await import('@gltf-transform/functions');
const io = new NodeIO();
const doc = await io.readBinary(new Uint8Array(glb));
const root = doc.getRoot();
const mainScene = root.getDefaultScene() || root.listScenes()[0];

// Merged tree-template scene-roots to remove after cloning (so the original
// template nodes — placed at +200 m, scale 100 — don't ship in the GLB and get
// rendered far off the patch by Blender, which imports every node in the file).
const templateScrap = [];
// load tree source docs and merge their data into our doc, then clone per instance
async function loadTreeTemplates(file, opts) {
  const src = await io.read(file);
  const map = mergeDocuments(doc, src);           // copies meshes/materials/textures in
  const srcScene = src.getRoot().getDefaultScene() || src.getRoot().listScenes()[0];
  const tScene = map.get(srcScene);               // counterpart scene in our doc
  // collect candidate template nodes (those that carry a mesh, possibly nested)
  const templates = [];
  for (const top of tScene.listChildren()) {
    templateScrap.push(top);                       // dispose this whole subtree later
    if (top.getMesh()) templates.push(top);
    else {
      const walk = nd => { if (nd.getMesh()) templates.push(nd); nd.listChildren().forEach(walk); };
      walk(top);
    }
  }
  templateScrap.push(tScene);                      // dispose the empty merged scene too
  // Measure each template's TRUE upright AABB in the orientation the asset author
  // intended — i.e. with the template node's OWN rotation+scale applied but its
  // translation dropped (that's just its slot in the source layout). Each source
  // uses a different up-axis (Trees.glb nodes carry a -90°X rotation; Acacia is
  // already Y-up), and that node rotation is what stands the mesh up, so we bake
  // it into the AABB rather than guessing an axis. From the AABB we read:
  //   nominalH  - upright height (Y extent)            -> scale to a target height
  //   nominalW  - canopy width  (max of X,Z extents)   -> cap so no giant trees
  //   baseY     - trunk base Y (AABB Y-min)            -> seat exactly on terrain
  const compose = (t, q, s) => {
    const [x, y, z, w] = q, x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    return [(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0, (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0, (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0, t[0], t[1], t[2], 1];
  };
  const matMul = (a, b) => { const r = new Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j]; r[i * 4 + j] = s; } return r; };
  const xform = (M, p) => [p[0] * M[0] + p[1] * M[4] + p[2] * M[8] + M[12], p[0] * M[1] + p[1] * M[5] + p[2] * M[9] + M[13], p[0] * M[2] + p[1] * M[6] + p[2] * M[10] + M[14]];
  return templates.map(t => {
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    const rootM = compose([0, 0, 0], t.getRotation(), t.getScale());   // keep rotation+scale, drop translation
    const acc = (nd, M) => {
      const m = nd.getMesh();
      if (m) for (const p of m.listPrimitives()) {
        const a = p.getAttribute('POSITION'), mn = a.getMin([]), mx = a.getMax([]);
        for (const cx of [mn[0], mx[0]]) for (const cy of [mn[1], mx[1]]) for (const cz of [mn[2], mx[2]]) {
          const w = xform(M, [cx, cy, cz]); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
        }
      }
      nd.listChildren().forEach(c => acc(c, matMul(compose(c.getTranslation(), c.getRotation(), c.getScale()), M)));
    };
    acc(t, rootM);
    const nominalH = Math.max(0.01, hi[1] - lo[1]);
    // canopy width = horizontal BOUNDING DIAGONAL, so the cap holds for ANY yaw
    // (a random yaw can otherwise project a lopsided canopy past a per-axis cap).
    const nominalW = Math.max(0.01, Math.hypot(hi[0] - lo[0], hi[2] - lo[2]));
    return { node: t, opts, nominalH, nominalW, baseY: lo[1] };
  });
}

// deep-clone a template node subtree into a fresh node placed in the main scene
function cloneTree(template, name, X, Y, Z, scl, rotY) {
  // clone the template subtree. The ROOT clone keeps the template's scale/rotation
  // (which make the mesh stand upright at its built size) but DROPS the template's
  // own translation — that is just its arbitrary slot in the source layout, not
  // something we want propagated into our placement.
  const cloneNode = (srcNode, isRoot) => {
    const nn = doc.createNode();
    if (srcNode.getMesh()) nn.setMesh(srcNode.getMesh());
    const r = srcNode.getRotation(), s = srcNode.getScale();
    nn.setTranslation(isRoot ? [0, 0, 0] : [...srcNode.getTranslation()]);
    nn.setRotation([...r]); nn.setScale([...s]);
    for (const c of srcNode.listChildren()) nn.addChild(cloneNode(c, false));
    return nn;
  };
  const node = cloneNode(template.node, true);
  // wrap in a placement node: scale (normalises to target height) -> yaw -> place
  const wrap = doc.createNode(name);
  wrap.addChild(node);
  wrap.setScale([scl, scl, scl]);
  wrap.setRotation([0, Math.sin(rotY / 2), 0, Math.cos(rotY / 2)]);
  wrap.setTranslation([X, Y, Z]);
  return wrap;
}

// Instance from the clean individual-tree library (exports/tree_lib, built by
// build_tree_lib.py) — each file is ONE upright single tree (trunk base at origin).
// The investigation confirmed the raw GLBs were already single trees (the 23 m Acacia
// is one umbrella crown), so this is the same set, just normalised. NormalTrees ≤11 m
// canopy; the Acacia feature ≤16 m. wCap caps canopy width so no giant trees ship.
const TREE_LIB = path.join(ROOT, 'exports/tree_lib');
const treeMan = JSON.parse(readFileSync(path.join(TREE_LIB, 'manifest.json'), 'utf8'));
const treeTemplates = [];
for (const tm of treeMan.trees) {
  const opts = tm.feature ? { targetH: 9.0, hVar: 3.5, wCap: 16.0, feature: true }
                          : { targetH: 7.5, hVar: 3.0, wCap: 11.0, feature: false };
  treeTemplates.push(...await loadTreeTemplates(path.join(TREE_LIB, tm.file), opts));
}
const normalTpl = treeTemplates.filter(t => !t.opts.feature);
const featureTpl = treeTemplates.filter(t => t.opts.feature);

// a parent node grouping all trees (so the group is one tidy outliner entry,
// but every child Tree_#### is still its own deletable object)
const treesParent = doc.createNode('Trees');
mainScene.addChild(treesParent);

// tree placement heuristic: dense riparian band along the creek, scattered yards,
// avoiding buildings + roads. Every spot must be STRICTLY inside the real terrain
// bounds (inTerrain), not just the symmetric ±cropHalf box, so no tree falls past
// the E-W edge into mid-air.
const TREE_RADIUS = 150;   // wider tree band (still inside the terrain bounds)
const treeOK = (x, z) => inTerrain(x, z) && !onBuilding(x, z) && distToLines(x, z, roadLines, 4.5) >= 4.5 && Math.hypot(x, z) <= TREE_RADIUS
  && !inMine(x, z)                                                        // random trees stay off owner lots; real LiDAR owner trees are added below
  && (!houseDoor || Math.hypot(x - houseDoor[0], z - houseDoor[1]) > 5);  // keep the front door clear
const treeSpots = [];
const ownerTreeSpots = [];
const TREESJSON = ex('trees.json');
if (existsSync(TREESJSON)) {
  const owner = JSON.parse(readFileSync(TREESJSON, 'utf8')).trees
    .filter(([x, z, cr = 0, th = 0]) => inMine(x, z) && inTerrain(x, z) && !onBuilding(x, z)
      && distToLines(x, z, roadLines, 4.5) >= 4.5 && Math.hypot(x, z) <= TREE_RADIUS
      && (!houseDoor || Math.hypot(x - houseDoor[0], z - houseDoor[1]) > 5)
      && cr >= 1.4 && th >= 5)
    .sort((a, b) => ((b[2] || 0) * (b[3] || 0)) - ((a[2] || 0) * (a[3] || 0)))
    .slice(0, 12);
  for (const [x, z] of owner) ownerTreeSpots.push([x, z]);
  treeSpots.push(...ownerTreeSpots);
}
if (creekW) for (let k = 1; k < creekW.length; k++) {
  const [ax, az] = creekW[k - 1], [bx, bz] = creekW[k]; let dx = bx - ax, dz = bz - az;
  const seg = Math.hypot(dx, dz) || 1; dx /= seg; dz /= seg; const nx = -dz, nz = dx;
  for (let sgt = 0; sgt < seg; sgt += 6) {
    const cx = ax + dx * sgt, cz = az + dz * sgt;
    for (const side of [1, -1]) if (rand() < 0.7) {
      const off = 6 + rand() * 11, x = cx + nx * off * side, z = cz + nz * off * side;
      if (treeOK(x, z)) treeSpots.push([x, z]);
    }
  }
}
for (let n = 0; n < 1400 && treeSpots.length < 230; n++) {
  const x = tXmin + rand() * (tXmax - tXmin), z = tZmin + rand() * (tZmax - tZmin);
  if (treeOK(x, z) && distToLines(x, z, [creekW || []], 8) >= 8 && rand() < 0.4) treeSpots.push([x, z]);
}

let nTrees = 0, nClampW = 0;
for (const [x, z] of treeSpots) {
  // mostly everyday NormalTrees; an occasional Acacia feature tree near the creek
  const useFeature = featureTpl.length && rand() < 0.12;
  const pool = useFeature ? featureTpl : (normalTpl.length ? normalTpl : treeTemplates);
  const t = pool[Math.floor(rand() * pool.length)];
  const o = t.opts;
  const targetH = o.targetH + (rand() - 0.5) * o.hVar;
  // scale to the target height, then CLAMP so the canopy never exceeds wCap (keeps
  // out the 23 m-wide Acacia monster). Width scales with the same uniform factor.
  let scl = (targetH / t.nominalH) * (0.85 + rand() * 0.3);
  const wCapScl = o.wCap / t.nominalW;
  if (scl > wCapScl) { scl = wCapScl; nClampW++; }
  const rotY = rand() * Math.PI * 2;
  // SEAT the trunk base on the terrain: the template's lowest point sits at baseY in
  // its upright frame, so after the uniform scale it sits at baseY*scl above the wrap
  // origin; placing the wrap at terrain - baseY*scl lands the trunk base on the ground.
  const Y = terrainAt(x, z) - t.baseY * scl;
  const node = cloneTree(t, `Tree_${String(nTrees).padStart(4, '0')}`, x, Y, z, scl, rotY);
  treesParent.addChild(node);
  nTrees++;
}

// ---- write final GLB ------------------------------------------------------
// Remove the original tree templates (and their now-empty merged scenes) so they
// don't ship in the GLB; Blender imports EVERY node in a file, and the templates
// sit at +200 m / scale 100, which would render far off the patch. The placed
// Tree_#### clones reference the shared Mesh datablocks, so those survive.
for (const n of templateScrap) { try { n.dispose(); } catch { /* already gone */ } }
const { prune } = await import('@gltf-transform/functions');
await doc.transform(prune({ keepLeaves: false }), unpartition());   // drop orphans + single buffer
// texture the optional SatelliteGround layer with the Google aerial JPEG
const aerialJpg = ex('google_aerial.jpg');
if (existsSync(aerialJpg)) {
  const tex = doc.createTexture('satellite').setImage(new Uint8Array(readFileSync(aerialJpg))).setMimeType('image/jpeg');
  for (const m of doc.getRoot().listMaterials()) {
    if (/SatelliteGround/i.test(m.getName() || '')) {
      m.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(tex);
      const ti = m.getBaseColorTextureInfo(); if (ti) { ti.setWrapS(33071); ti.setWrapT(33071); }
    }
  }
}
const out = ex('1840-dahill-stylized.glb');
writeFileSync(out, Buffer.from(await io.writeBinary(doc)));

// ---- report ---------------------------------------------------------------
const sceneObjs = [];
scene.traverse(o => { if (o.isMesh && o.parent === scene) sceneObjs.push(`  ${o.name.padEnd(20)} ${o.geometry.attributes.position.count} verts`); });
console.log('terrain:', D.source);
console.log(`crop half: ${cropHalf.toFixed(0)} m`);
console.log(`buildings: ${nBld} (${nSkip} skipped on owner lots)   houseIdx: ${houseIdx}`);
console.log(`grass clumps (animated nodes): ${clumpNodes.length}   wind clip: ${animations.length ? animations[0].name + ' (' + animations[0].duration + 's loop)' : 'none'}`);
console.log(`trees placed (separate nodes): ${nTrees}   templates: ${treeTemplates.length}   canopy-width clamped: ${nClampW}`);
console.log(`owner-lot tree spots from LiDAR: ${ownerTreeSpots.length}`);
console.log('top-level meshes:\n' + sceneObjs.join('\n'));
console.log(`animations in doc: ${doc.getRoot().listAnimations().map(a => a.getName()).join(', ')}`);
console.log(`Tree_* nodes in doc: ${doc.getRoot().listNodes().filter(n => /^Tree_/.test(n.getName() || '')).length}`);
console.log(`wrote ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
