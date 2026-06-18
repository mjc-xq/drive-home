// Export the real GIS model of 1840 Dahill Lane to a clean GLB for cleanup in
// Blender. Separate, named layers (objects):
//   Terrain            - crisp 1 m bare-earth LiDAR DTM (exports/dem_1m.json from
//                        fetch_dem.py); falls back to scene.json's coarse Terrarium
//                        DEM if the 1 m patch isn't present. UVs map to the aerial
//                        bounds so you can drop src/assets/aerial_opt.jpg on it.
//   House              - your footprint (scene.json building with house:true).
//   Buildings          - other OSM footprints within the patch, extruded.
//   Trees              - HEURISTIC positions (riparian band along the creek + open
//                        yard, avoiding buildings/roads). OSM had no real trees and
//                        the venv lacks point-cloud libs, so move/replace freely.
//   Creek_SanLorenzo   - the creek centerline as a flat ribbon on the terrain.
//   Roads              - nearby road centerlines as flat ribbons.
//
// Frame: glTF Y-up, metres, ORIGIN AT YOUR HOUSE centroid (x=east, z=-north).
// Blender's glTF importer converts Y-up -> Z-up on import.
//
// Run:  node scripts/export_property_glb.mjs
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

const THREE = await import('three');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
const { makeGeoENU } = await import('../src/engine/coords.js');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const S = JSON.parse(readFileSync(path.join(ROOT, 'src/assets/scene.json'), 'utf8'));
const C = S.center, A = S.aerial;                          // house centroid (flat ENU), aerial bounds
// Curvature-correct ENU, identical to the frame the app's Google photoreal tiles
// use (coords.js makeGeoENU), origin = house lat/lon. Replaces the old flat approx
// (0.4%-low latitude constant) that drifted metres from Google with distance.
const LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * Math.PI / 180), D2R = Math.PI / 180;
const houseLat = LAT0 + C[1] / 110540, houseLon = LON0 + C[0] / (COSLAT * 111320);
const ENU = makeGeoENU(houseLat, houseLon);
const flatToLL = (e, n) => [LAT0 + n / 110540, LON0 + e / (COSLAT * 111320)];   // scene.json flat -> lat/lon
const w2 = (e, n) => { const [lat, lon] = flatToLL(e, n); const [E, N] = ENU.toEN(lat, lon); return [E, -N]; };
// aerial: world/lat-lon -> web-mercator fraction within the photo's lat/lon corners
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2));
const aLatN = LAT0 + A.Nt / 110540, aLatS = LAT0 + A.Nb / 110540;
const aLonW = LON0 + A.E0 / (COSLAT * 111320), aLonE = LON0 + A.E1 / (COSLAT * 111320);
const aMyN = mercY(aLatN), aMyS = mercY(aLatS);
const aerialUVll = (lat, lon) => [(lon - aLonW) / (aLonE - aLonW), (mercY(lat) - aMyS) / (aMyN - aMyS)];

// ---- terrain: crisp 1 m DEM patch if present, else coarse Terrarium ------
const DEMPATH = path.join(ROOT, 'exports/dem_1m.json');
let terrainAt, terrainMesh, cropHalf, terrSrc;
function mkMesh(positions, indices, color, name, opts = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (opts.uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(opts.uvs, 2));
  if (opts.colors) g.setAttribute('color', new THREE.Float32BufferAttribute(opts.colors, 3));
  if (indices) g.setIndex(indices);
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0, name: name + '_mat' });
  if (opts.colors) m.vertexColors = true;
  if (opts.flat) m.flatShading = true;
  m.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(g, m); mesh.name = name; return mesh;
}

if (existsSync(DEMPATH)) {
  const D = JSON.parse(readFileSync(DEMPATH, 'utf8'));
  const { cols, rows, h } = D;
  const dLat = D.latN - D.latS, dLon = D.lonE - D.lonW;
  cropHalf = dLat * 110540 / 2 - 4;
  terrSrc = D.source;
  // DEM grid is linear in lat/lon (4326). Sample by world -> lat/lon (curvature-correct).
  terrainAt = (X, Z) => {
    const g = ENU.toGeo(X, -Z);
    let fi = (g.lon - D.lonW) / dLon * cols - 0.5, fj = (D.latN - g.lat) / dLat * rows - 0.5;
    fi = Math.max(0, Math.min(cols - 1.001, fi)); fj = Math.max(0, Math.min(rows - 1.001, fj));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
    const a = h[j * cols + i], b = h[j * cols + i + 1], c = h[(j + 1) * cols + i], d = h[(j + 1) * cols + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  // aerial baked as PER-VERTEX colours (exports/terrain_colors.json) — rides with
  // the geometry, so it can't slide in a texture/UV/USDZ export. Sampled per cell
  // at its true position, so it aligns with the buildings (also placed by position).
  const TCP = path.join(ROOT, 'exports/terrain_colors.json');
  const TC = existsSync(TCP) ? JSON.parse(readFileSync(TCP, 'utf8')).rgb : null;
  const pos = [], col = [], idx = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i;
    const lat = D.latN - (j + 0.5) / rows * dLat, lon = D.lonW + (i + 0.5) / cols * dLon;
    const [E, N] = ENU.toEN(lat, lon); pos.push(E, h[k], -N);
    if (TC) col.push(TC[k * 3], TC[k * 3 + 1], TC[k * 3 + 2]); else col.push(0.54, 0.6, 0.36);
  }
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1; idx.push(a, c, b, b, c, d);
  }
  terrainMesh = mkMesh(pos, idx, 0xffffff, 'Terrain', { colors: col });
} else {
  throw new Error('exports/dem_1m.json missing — run: scripts/.venv/bin/python scripts/fetch_dem.py 400');
}

const inPatch = (X, Z) => Math.abs(X) <= cropHalf && Math.abs(Z) <= cropHalf;
const centroidEN = p => p.reduce((a, q) => [a[0] + q[0] / p.length, a[1] + q[1] / p.length], [0, 0]);

// ---- buildings: walls + flat eave cap + gabled roofs (ported from geom.js) -
// gablePrism: open gable shell (2 slopes + 2 end triangles) for one roof rect,
// rotated/translated into world space.
function gableTris(rect, base, wallH) {
  let [rcx, rcy, w, d, deg] = rect;
  let L = w, Sp = d, ang = deg * Math.PI / 180;
  if (d > w) { L = d; Sp = w; ang += Math.PI / 2; }
  const rise = Math.min(2.6, Math.max(0.85, Sp * 0.30));
  const ov = 0.45, hw = L / 2 + ov, hd = Sp / 2 + ov, y0 = wallH - 0.04, y1 = wallH - 0.04 + rise;
  const A = [-hw, y0, -hd], B = [hw, y0, -hd], Cc = [hw, y0, hd], D = [-hw, y0, hd], R1 = [-hw, y1, 0], R2 = [hw, y1, 0];
  const seq = [A, R1, R2, A, R2, B, Cc, R2, R1, Cc, R1, D, B, R2, Cc, A, D, R1];
  const ca = Math.cos(ang), sa = Math.sin(ang), [tx, tz] = w2(rcx, rcy), out = [];
  for (const [x, y, z] of seq) out.push(x * ca + z * sa + tx, y + base, -x * sa + z * ca + tz);
  return out;
}
// Emit a building into WALL triangles (facade UV: u = perimeter dist / TILE,
// v = height / TILE -> tiled stucco+window texture) and ROOF triangles (cap +
// gables, UV = nadir aerial projection -> real satellite roof imagery).
const TILE = 3.0;
const aerialUV = (X, Z) => { const g = ENU.toGeo(X, -Z); return aerialUVll(g.lat, g.lon); };
// Per-building wall colour from Street View (exports/buildings_color.json) and a
// clean solid roof colour (NADIR aerial on pitched roofs looks wrong, so roofs are
// solid). Walls = facade window texture x SV colour; roofs = solid shingle.
const COL = existsSync(path.join(ROOT, 'exports/buildings_color.json'))
  ? JSON.parse(readFileSync(path.join(ROOT, 'exports/buildings_color.json'), 'utf8')) : {};
const STUCCO = [0.82, 0.78, 0.70];
const ROOFP = [[0.34, 0.32, 0.30], [0.40, 0.36, 0.31], [0.30, 0.30, 0.31], [0.37, 0.33, 0.29], [0.26, 0.26, 0.27]];
const wallColor = ib => COL[ib] || STUCCO;
const roofColor = ib => ROOFP[(Math.imul((ib | 0) + 1, 2654435761) >>> 0) % ROOFP.length];

// push a roof triangle with upward-facing winding, solid roof colour (no texture)
function pushUpTri(Rf, col, a, b, c) {
  const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
  const tri = (uz * vx - ux * vz) < 0 ? [a, c, b] : [a, b, c];
  for (const v of tri) { Rf.pos.push(v[0], v[1], v[2]); Rf.col.push(col[0], col[1], col[2]); }
}
// W = {pos,uv,col} facade walls (window texture x wallC);  Rf = {pos,col} solid roof
function emitRing(ring, base, wallH, roofRects, wallC, roofC, W, Rf) {
  if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
  const yb = base, yt = base + wallH, vt = wallH / TILE;
  let dist = 0;
  for (let i = 0; i < ring.length; i++) {           // walls
    const [xi, zi] = ring[i], [xj, zj] = ring[(i + 1) % ring.length];
    const seg = Math.hypot(xj - xi, zj - zi), u0 = dist / TILE, u1 = (dist + seg) / TILE; dist += seg;
    W.pos.push(xi, yb, zi, xj, yb, zj, xj, yt, zj, xi, yb, zi, xj, yt, zj, xi, yt, zi);
    W.uv.push(u0, 0, u1, 0, u1, vt, u0, 0, u1, vt, u0, vt);
    for (let k = 0; k < 6; k++) W.col.push(wallC[0], wallC[1], wallC[2]);
  }
  const v2 = ring.map(([x, z]) => new THREE.Vector2(x, z));   // flat eave cap
  for (const [a, c, d] of THREE.ShapeUtils.triangulateShape(v2, []))
    pushUpTri(Rf, roofC, [ring[a][0], yt, ring[a][1]], [ring[c][0], yt, ring[c][1]], [ring[d][0], yt, ring[d][1]]);
  if (roofRects) for (const r of roofRects) {        // gables
    const g = gableTris(r, base, wallH);
    for (let k = 0; k < g.length; k += 9)
      pushUpTri(Rf, roofC, [g[k], g[k + 1], g[k + 2]], [g[k + 3], g[k + 4], g[k + 5]], [g[k + 6], g[k + 7], g[k + 8]]);
  }
  return ring;
}
const emitBuilding = (b, ib, base, wallH, W, Rf) =>
  emitRing(b.p.map(([e, n]) => w2(e, n)), base, wallH, b.r, wallColor(ib), roofColor(ib), W, Rf);

// ---- assemble ------------------------------------------------------------
const scene = new THREE.Scene(); scene.name = '1840_Dahill_Property';
scene.add(terrainMesh);

// OSM/Overture height (or a sane default) — NOT LiDAR (the LiDAR heights were noisy)
const wallHeight = b => { const H = b.h || 4.5; return ((b.r && b.r.length) ? Math.max(2.4, H * 0.8) : H) + 0.5; };
const houseIdx = S.buildings.findIndex(b => b.house);
const buildingPolys = [];                       // world-space rings for tree avoidance
const hW = { pos: [], uv: [], col: [] }, hRf = { pos: [], col: [] };
if (houseIdx >= 0) {
  const houseB = S.buildings[houseIdx];
  const hc = centroidEN(houseB.p), base = terrainAt(...w2(hc[0], hc[1])) - 0.5;
  buildingPolys.push(emitBuilding(houseB, houseIdx, base, wallHeight(houseB, houseIdx), hW, hRf));
  scene.add(mkMesh(hW.pos, null, 0xffffff, 'House_walls', { uvs: hW.uv, colors: hW.col }));
  scene.add(mkMesh(hRf.pos, null, 0xffffff, 'House_roof', { colors: hRf.col }));
}
const bW = { pos: [], uv: [], col: [] }, bRf = { pos: [], col: [] };
// Keep the OWNER'S two lots clear of any generated building except the house —
// the back lot stays empty for a manually-placed shed. Parcel rings from parcels.json.
const pip = (x, z, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) c = !c; } return c; };
const MINE = existsSync(path.join(ROOT, 'exports/parcels.json'))
  ? (JSON.parse(readFileSync(path.join(ROOT, 'exports/parcels.json'), 'utf8')).parcels || []).filter(p => p.mine).map(p => p.ring) : [];
const inMine = (x, z) => MINE.some(r => pip(x, z, r));
let nBld = 0, nSkip = 0;
S.buildings.forEach((b, ib) => {
  if (b.house) return;
  const cen = centroidEN(b.p); const cw = w2(cen[0], cen[1]); if (!inPatch(cw[0], cw[1])) return;
  if (inMine(cw[0], cw[1])) { nSkip++; return; }     // never put others' buildings on the owner's lots
  const base = terrainAt(cw[0], cw[1]) - 0.5;
  buildingPolys.push(emitBuilding(b, ib, base, wallHeight(b, ib), bW, bRf));
  nBld++;
});
// gap-fill LiDAR buildings DISABLED — they produced false structures (incl. one in
// the back yard) and crossed property lines. The photoreal layer covers genuinely
// missing buildings; the clean model stays trustworthy instead.
const nFill = 0;
if (bW.pos.length) {
  scene.add(mkMesh(bW.pos, null, 0xffffff, 'Buildings_walls', { uvs: bW.uv, colors: bW.col }));
  scene.add(mkMesh(bRf.pos, null, 0xffffff, 'Buildings_roofs', { colors: bRf.col }));
}

// roads (context) + collect world polylines for tree spacing
const roadLines = [];
const rPos = [], rIdx = [];
function ribbon(lineW, width, lift, posArr, idxArr) {
  // densify: terrain height is sampled per vertex, so subdivide long segments
  // (parcel corners / cul-de-sacs are sparse) to make the ribbon hug the ground
  const dense = [lineW[0]];
  for (let k = 1; k < lineW.length; k++) {
    const a = lineW[k - 1], b = lineW[k], seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(seg / 2.5));
    for (let s = 1; s <= steps; s++) dense.push([a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps]);
  }
  lineW = dense;
  const hw = width / 2; let row = 0;
  for (let k = 0; k < lineW.length; k++) {
    const [x, z] = lineW[k], p = lineW[Math.max(0, k - 1)], q = lineW[Math.min(lineW.length - 1, k + 1)];
    let dx = q[0] - p[0], dz = q[1] - p[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const nx = -dz, nz = dx, lx = x + nx * hw, lz = z + nz * hw, rx = x - nx * hw, rz = z - nz * hw;
    const off = posArr.length / 3;
    posArr.push(lx, terrainAt(lx, lz) + lift, lz, rx, terrainAt(rx, rz) + lift, rz);
    if (k > 0) { const a = off - 2, b = a + 1, c = off, d = off + 1; idxArr.push(a, c, b, b, c, d); }
    row++;
  }
}
for (const r of S.roads || []) {
  const pl = (r.p || r); if (!Array.isArray(pl)) continue;
  const lw = pl.map(([e, n]) => w2(e, n)).filter(([x, z]) => Math.abs(x) <= cropHalf + 3 && Math.abs(z) <= cropHalf + 3);
  if (lw.length < 2) continue;
  roadLines.push(lw); ribbon(lw, 7, 0.04, rPos, rIdx);
}
if (rIdx.length) scene.add(mkMesh(rPos, rIdx, 0x555555, 'Roads'));

// creek ribbon
let creekW = null;
if (S.creek && S.creek.p) {
  creekW = S.creek.p.map(([e, n]) => w2(e, n)).filter(([x, z]) => Math.abs(x) <= cropHalf + 3 && Math.abs(z) <= cropHalf + 3);
  if (creekW.length >= 2) {
    const cPos = [], cIdx = []; ribbon(creekW, 10, 0.05, cPos, cIdx);
    const cr = mkMesh(cPos, cIdx, 0x3a78c2, 'Creek_SanLorenzo'); cr.material.name = 'Creek_mat'; scene.add(cr);
  }
}

// ---- Trees (heuristic positions) -----------------------------------------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rand = mulberry32(1840);
function inPoly(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
const onBuilding = (x, z) => buildingPolys.some(r => inPoly(x, z, r));
function distToLines(x, z, lines, max) {
  let best = max;
  for (const lw of lines) for (let k = 1; k < lw.length; k++) {
    const [ax, az] = lw[k - 1], [bx, bz] = lw[k]; let dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz || 1; let t = ((x - ax) * dx + (z - az) * dz) / L2; t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return best;
}
// Real LiDAR-canopy trees (exports/trees.json from fetch_trees.py) if present,
// else heuristic positions along the creek + open yard.
const TREESJSON = path.join(ROOT, 'exports/trees.json');
let trees, treeSrc;
if (existsSync(TREESJSON)) {
  trees = JSON.parse(readFileSync(TREESJSON, 'utf8')).trees;   // [x, z, canopyR, height]
  treeSrc = 'LiDAR canopy 2021 (real)';
} else {
  trees = [];
  treeSrc = 'heuristic (no LiDAR/OSM trees)';
  const ok = (x, z) => inPatch(x, z) && !onBuilding(x, z) && distToLines(x, z, roadLines, 5) >= 4;
  if (creekW) for (let k = 1; k < creekW.length; k++) {
    const [ax, az] = creekW[k - 1], [bx, bz] = creekW[k]; let dx = bx - ax, dz = bz - az;
    const seg = Math.hypot(dx, dz) || 1; dx /= seg; dz /= seg; const nx = -dz, nz = dx;
    for (let s = 0; s < seg; s += 5) {
      const cx = ax + dx * s, cz = az + dz * s;
      for (const side of [1, -1]) if (rand() < 0.8) {
        const off = 7 + rand() * 10, x = cx + nx * off * side, z = cz + nz * off * side;
        if (ok(x, z)) trees.push([x, z, 2 + rand() * 2, 6 + rand() * 6]);
      }
    }
  }
  for (let n = 0; n < 900; n++) {
    const x = (rand() * 2 - 1) * cropHalf, z = (rand() * 2 - 1) * cropHalf;
    if (ok(x, z) && distToLines(x, z, [creekW || []], 9) >= 9 && rand() < 0.5) trees.push([x, z, 2 + rand() * 1.8, 5 + rand() * 5]);
    if (trees.length > 240) break;
  }
}
if (trees.length) {
  const tPos = [], tCol = [];
  const append = (geom, tx, ty, tz, col) => {
    const g = geom.index ? geom.toNonIndexed() : geom.clone(); g.translate(tx, ty, tz);
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i++) tPos.push(p[i]);
    for (let i = 0; i < p.length; i += 3) tCol.push(col.r, col.g, col.b);
  };
  const bark = new THREE.Color(0x6e5340);
  for (const [x, z, cr, th] of trees) {
    const base = terrainAt(x, z);
    const trunkH = th * 0.42;
    append(new THREE.CylinderGeometry(0.16, 0.26, trunkH, 5), x, base + trunkH / 2, z, bark);
    const can = new THREE.IcosahedronGeometry(cr, 0);
    const g = 0.42 + rand() * 0.16;
    append(can, x, base + trunkH + cr * 0.55, z, new THREE.Color(0.22 + rand() * 0.1, g, 0.26 + rand() * 0.08));
  }
  scene.add(mkMesh(tPos, null, 0x5e7d47, 'Trees', { colors: tCol, flat: true }));
}

// ---- Parcels / lot lines (real fences run along these) -------------------
// LotLines = all county parcel boundaries; YourLots = APN 416-120-67 (house) +
// 416-120-68 (back lot w/ creek), highlighted.
const PARCELSJSON = path.join(ROOT, 'exports/parcels.json');
let nParcels = 0, nMine = 0;
if (existsSync(PARCELSJSON)) {
  const P = JSON.parse(readFileSync(PARCELSJSON, 'utf8')).parcels || [];
  const lPos = [], lIdx = [], yPos = [], yIdx = [];
  for (const p of P) {
    const ring = p.ring.map(([x, z]) => [x, z]);
    if (ring.length < 2) continue;
    const closed = ring[0][0] === ring[ring.length - 1][0] ? ring : ring.concat([ring[0]]);
    if (p.mine) { ribbon(closed, 1.1, 0.25, yPos, yIdx); nMine++; }
    else { ribbon(closed, 0.5, 0.12, lPos, lIdx); }
    nParcels++;
  }
  if (lIdx.length) scene.add(mkMesh(lPos, lIdx, 0xe8e2d0, 'LotLines'));
  if (yIdx.length) scene.add(mkMesh(yPos, yIdx, 0xffcf33, 'YourLots'));
}

// ---- export GLB, then embed photo textures via gltf-transform -------------
// (GLTFExporter can't encode images in Node — gltf-transform attaches the JPEG/
//  PNG bytes directly.) aerial -> Terrain + all roofs; facade -> all walls.
const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false });
mkdirSync(path.join(ROOT, 'exports'), { recursive: true });
const out = path.join(ROOT, 'exports', '1840-dahill-property.glb');

const { NodeIO } = await import('@gltf-transform/core');
const io = new NodeIO();
const doc = await io.readBinary(new Uint8Array(glb));
// Terrain aerial is now per-vertex colour (no texture/UV — can't slide in export).
// Only the wall facade stays a tiled texture.
const facadeP = path.join(ROOT, 'exports/facade.png');
const facadeTex = existsSync(facadeP) ? doc.createTexture('facade').setImage(new Uint8Array(readFileSync(facadeP))).setMimeType('image/png') : null;
const REPEAT = 10497;
let textured = 0;
for (const m of doc.getRoot().listMaterials()) {
  const n = m.getName() || '';
  if (facadeTex && /walls/i.test(n)) {
    m.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(facadeTex);
    m.getBaseColorTextureInfo().setWrapS(REPEAT).setWrapT(REPEAT); textured++;
  }
}
writeFileSync(out, Buffer.from(await io.writeBinary(doc)));

const objs = [];
scene.traverse(o => { if (o.isMesh) objs.push(`  ${o.name.padEnd(18)} ${o.geometry.attributes.position.count} verts`); });
console.log(`terrain: ${terrSrc}`);
console.log(`crop half: ${cropHalf.toFixed(0)} m   buildings: ${nBld} (${nSkip} skipped on owner lots)   trees: ${trees.length} (${treeSrc})`);
console.log('layers:\n' + objs.join('\n'));
console.log(`textured materials: ${textured} (aerial->terrain/roofs, facade->walls)`);
console.log(`wrote ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
