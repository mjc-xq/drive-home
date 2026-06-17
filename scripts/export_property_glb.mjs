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
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const S = JSON.parse(readFileSync(path.join(ROOT, 'src/assets/scene.json'), 'utf8'));
const C = S.center, A = S.aerial;                          // house centroid ENU, aerial bounds
const wx = e => e - C[0], wz = n => C[1] - n;              // ENU -> three world (house at origin)

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
  const Emin = (D.lonW - D.LON0) * D.COSLAT * 111320, Emax = (D.lonE - D.LON0) * D.COSLAT * 111320;
  const Nmin = (D.latS - D.LAT0) * 110540, Nmax = (D.latN - D.LAT0) * 110540;
  const dE = Emax - Emin, dN = Nmax - Nmin;
  cropHalf = Math.min(dE, dN) / 2 - 4;
  terrSrc = D.source;
  // bilinear sample in DEM grid; world -> ENU -> fractional pixel (north = row 0)
  terrainAt = (X, Z) => {
    const e = X + C[0], n = C[1] - Z;
    let fi = (e - Emin) / dE * cols - 0.5, fj = (Nmax - n) / dN * rows - 0.5;
    fi = Math.max(0, Math.min(cols - 1.001, fi)); fj = Math.max(0, Math.min(rows - 1.001, fj));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
    const a = h[j * cols + i], b = h[j * cols + i + 1], c = h[(j + 1) * cols + i], d = h[(j + 1) * cols + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  const pos = [], uv = [], idx = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const e = Emin + (i + 0.5) / cols * dE, n = Nmax - (j + 0.5) / rows * dN;
    pos.push(wx(e), h[j * cols + i], wz(n));
    uv.push((e - A.E0) / (A.E1 - A.E0), (n - A.Nb) / (A.Nt - A.Nb));
  }
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1; idx.push(a, c, b, b, c, d);
  }
  terrainMesh = mkMesh(pos, idx, 0x8a9a5b, 'Terrain', { uvs: uv });
} else {
  const T = S.terrain, TN = T.n, TH = T.half, TSTEP = (2 * TH) / (TN - 1), H = T.h;
  terrSrc = 'AWS Terrarium ~30 m DEM (coarse fallback — run fetch_dem.py for 1 m)';
  cropHalf = 140;
  terrainAt = (X, Z) => {
    const e = X + C[0], n = -Z + C[1];
    let fi = Math.max(0, Math.min(TN - 1.001, (e + TH) / TSTEP)), fj = Math.max(0, Math.min(TN - 1.001, (TH - n) / TSTEP));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
    const a = H[j * TN + i], b = H[j * TN + i + 1], c = H[(j + 1) * TN + i], d = H[(j + 1) * TN + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  const pos = [], uv = [], idx = [];
  for (let j = 0; j < TN; j++) for (let i = 0; i < TN; i++) {
    const e = -TH + i * TSTEP, n = TH - j * TSTEP; pos.push(wx(e), H[j * TN + i], wz(n));
    uv.push((e - A.E0) / (A.E1 - A.E0), (n - A.Nb) / (A.Nt - A.Nb));
  }
  for (let j = 0; j < TN - 1; j++) for (let i = 0; i < TN - 1; i++) {
    const a = j * TN + i, b = a + 1, c = a + TN, d = c + 1; idx.push(a, c, b, b, c, d);
  }
  terrainMesh = mkMesh(pos, idx, 0x8a9a5b, 'Terrain', { uvs: uv });
}

const inPatch = (X, Z) => Math.abs(X) <= cropHalf && Math.abs(Z) <= cropHalf;
const centroidEN = p => p.reduce((a, q) => [a[0] + q[0] / p.length, a[1] + q[1] / p.length], [0, 0]);

// ---- footprint extrusion -------------------------------------------------
function extrude(polyEN, yBot, yTop) {
  const ring = polyEN.map(([e, n]) => new THREE.Vector2(wx(e), wz(n)));
  if (ring.length > 1 && ring[0].equals(ring[ring.length - 1])) ring.pop();
  const tris = THREE.ShapeUtils.triangulateShape(ring, []);
  const N = ring.length, pos = [], idx = [];
  for (const p of ring) pos.push(p.x, yTop, p.y);
  for (const p of ring) pos.push(p.x, yBot, p.y);
  for (const [a, b, c] of tris) idx.push(a, c, b);
  for (const [a, b, c] of tris) idx.push(N + a, N + b, N + c);
  for (let i = 0; i < N; i++) { const j = (i + 1) % N; idx.push(i, N + i, j, j, N + i, N + j); }
  return { pos, idx };
}

// ---- assemble ------------------------------------------------------------
const scene = new THREE.Scene(); scene.name = '1840_Dahill_Property';
scene.add(terrainMesh);

const houseB = S.buildings.find(b => b.house);
const buildingPolys = [];                       // world-space rings for tree avoidance
if (houseB) {
  const hc = centroidEN(houseB.p), base = terrainAt(wx(hc[0]), wz(hc[1])) - 0.5;
  const { pos, idx } = extrude(houseB.p, base, base + (houseB.h || 4.5));
  scene.add(mkMesh(pos, idx, 0xc98a5e, 'House'));
  buildingPolys.push(houseB.p.map(([e, n]) => [wx(e), wz(n)]));
}
const bPos = [], bIdx = [];
let nBld = 0;
for (const b of S.buildings) {
  if (b.house) continue;
  const cen = centroidEN(b.p); if (!inPatch(wx(cen[0]), wz(cen[1]))) continue;
  const base = terrainAt(wx(cen[0]), wz(cen[1])) - 0.5;
  const { pos, idx } = extrude(b.p, base, base + (b.h || 4.5));
  const off = bPos.length / 3; for (const v of pos) bPos.push(v); for (const v of idx) bIdx.push(v + off);
  buildingPolys.push(b.p.map(([e, n]) => [wx(e), wz(n)])); nBld++;
}
if (nBld) scene.add(mkMesh(bPos, bIdx, 0xb8b0a4, 'Buildings'));

// roads (context) + collect world polylines for tree spacing
const roadLines = [];
const rPos = [], rIdx = [];
function ribbon(lineW, width, lift, posArr, idxArr) {
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
  const lw = pl.map(([e, n]) => [wx(e), wz(n)]).filter(([x, z]) => Math.abs(x) <= cropHalf + 3 && Math.abs(z) <= cropHalf + 3);
  if (lw.length < 2) continue;
  roadLines.push(lw); ribbon(lw, 7, 0.04, rPos, rIdx);
}
if (rIdx.length) scene.add(mkMesh(rPos, rIdx, 0x555555, 'Roads'));

// creek ribbon
let creekW = null;
if (S.creek && S.creek.p) {
  creekW = S.creek.p.map(([e, n]) => [wx(e), wz(n)]).filter(([x, z]) => Math.abs(x) <= cropHalf + 3 && Math.abs(z) <= cropHalf + 3);
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

// ---- export GLB ----------------------------------------------------------
const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false });
mkdirSync(path.join(ROOT, 'exports'), { recursive: true });
const out = path.join(ROOT, 'exports', '1840-dahill-property.glb');
writeFileSync(out, Buffer.from(glb));

const objs = [];
scene.traverse(o => { if (o.isMesh) objs.push(`  ${o.name.padEnd(18)} ${o.geometry.attributes.position.count} verts`); });
console.log(`terrain: ${terrSrc}`);
console.log(`crop half: ${cropHalf.toFixed(0)} m   buildings: ${nBld}   trees: ${trees.length} (${treeSrc})`);
console.log('layers:\n' + objs.join('\n'));
console.log(`wrote ${out} (${(Buffer.from(glb).length / 1024).toFixed(0)} KB)`);
