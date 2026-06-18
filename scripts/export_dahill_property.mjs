// Fresh, georeferenced photo-textured export of 1840 Dahill Ln, Hayward CA.
// ---------------------------------------------------------------------------
// ONE FRAME, end to end: FLAT ENU with the house centroid C at the world origin.
//   worldX =  e - C[0]
//   worldZ = -(n - C[1])     (glTF is Y-up; +Z = south, -Z = north, +X = east)
//   worldY =  terrain height (metres, DEM)
// The satellite mosaic (exports/google_aerial.jpg) is NORTH-UP and georeferenced
// to flat-ENU bounds A = {E0,E1,Nt,Nb}. Every textured surface uses the SAME UV:
//   u = (e - E0) / (E1 - E0)            (east  -> right)
//   v = (Nt - n) / (Nt - Nb)            (north -> top of the north-up image; v=0 = top)
// Getting v backwards flips the texture N-S — the original bug. Geometry and the
// aerial UVs therefore live in ONE flat frame, so footprints sit on their roofs.
//
// DEM handling differs from the old pipeline: instead of resampling the lat/lon
// DEM grid through an enToLL/llToEN curvature round-trip (which mixed a curved
// sampling frame with flat UVs and drifted geometry metres off the imagery), the
// DEM's lat/lon CORNERS are converted to flat-ENU ONCE to define a flat rectangle,
// and the grid is laid out linearly inside it. Heights are read row-major. Result:
// terrain vertices, building bases, ribbons and aerial UVs are all the same flat
// frame the verified 2-D overlay uses.
//
// Run:  node scripts/export_dahill_property.mjs
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

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rd = p => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
const S = rd('src/assets/scene.json');
const C = S.center;                                       // house centroid (flat ENU)
const A = rd('exports/google_aerial.json');               // satellite bounds (flat ENU, north-up)

// --- the ONE frame ---------------------------------------------------------
const LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * Math.PI / 180);
const llToEN = (lat, lon) => [(lon - LON0) * COSLAT * 111320, (lat - LAT0) * 110540];
const w2 = (e, n) => [e - C[0], -(n - C[1])];             // flat ENU -> world (house at origin)
const aerialUV = (e, n) => [(e - A.E0) / (A.E1 - A.E0), (A.Nt - n) / (A.Nt - A.Nb)];  // north-up
// world XZ back to aerial UV: invert w2 (e = X + C[0], n = C[1] - Z), then aerialUV.
const aerialUVxz = (X, Z) => aerialUV(X + C[0], C[1] - Z);

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

// --- terrain: 1 m DEM laid out as a FLAT-ENU rectangle (corners -> ENU) -----
const D = rd('exports/dem_1m.json');
const { cols, rows, h } = D;
// Convert the DEM lat/lon corners to flat-ENU ONCE. lat/lon is linear over this
// ~360 m patch, so the flat-ENU rectangle is an exact map of the grid.
const [eW, nN] = llToEN(D.latN, D.lonW);                  // top-left  (north, west)
const [eE, nS] = llToEN(D.latS, D.lonE);                  // bot-right (south, east)
const dE = eE - eW, dN = nS - nN;                         // dN < 0 (n decreases going south)
// crop to a square patch a touch inside the DEM so edges stay clean
const cropHalf = Math.min(Math.abs(nN - nS), Math.abs(eE - eW)) / 2 - 4;
// height bilinear-sampled at flat-ENU (e,n)
function terrainAt(X, Z) {
  const e = X + C[0], n = C[1] - Z;
  let fi = (e - eW) / dE * (cols - 1), fj = (n - nN) / dN * (rows - 1);
  fi = Math.max(0, Math.min(cols - 1.001, fi)); fj = Math.max(0, Math.min(rows - 1.001, fj));
  const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
  const a = h[j * cols + i], b = h[j * cols + i + 1], c = h[(j + 1) * cols + i], d = h[(j + 1) * cols + i + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
{
  const pos = [], uv = [], idx = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const e = eW + dE * (i / (cols - 1)), n = nN + dN * (j / (rows - 1));
    const [X, Z] = w2(e, n);
    pos.push(X, h[j * cols + i], Z);
    const [uu, vv] = aerialUV(e, n); uv.push(uu, vv);
  }
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1; idx.push(a, c, b, b, c, d);
  }
  var terrainMesh = mkMesh(pos, idx, 0xffffff, 'Terrain', { uvs: uv });
}

const inPatch = (X, Z) => Math.abs(X) <= cropHalf && Math.abs(Z) <= cropHalf;
const centroidEN = p => p.reduce((a, q) => [a[0] + q[0] / p.length, a[1] + q[1] / p.length], [0, 0]);

// --- buildings: walls (facade tex) + roof (aerial-projected satellite tex) ---
// Roof verts get aerial UVs so the satellite roof imagery lands on each roof in
// the exact same frame as the terrain — buildings read as their own rooftops.
const TILE = 3.0;
const COL = existsSync(path.join(ROOT, 'exports/buildings_color.json')) ? rd('exports/buildings_color.json') : {};
const STUCCO = [0.82, 0.78, 0.70];
const wallColor = ib => COL[ib] || STUCCO;

function gableTris(rect, base, wallH) {                   // open gable shell for one roof rect
  let [rcx, rcy, w, d, deg] = rect;
  let L = w, Sp = d, ang = deg * Math.PI / 180;
  if (d > w) { L = d; Sp = w; ang += Math.PI / 2; }
  const rise = Math.min(2.6, Math.max(0.85, Sp * 0.30));
  const ov = 0.45, hw = L / 2 + ov, hd = Sp / 2 + ov, y0 = wallH - 0.04, y1 = wallH - 0.04 + rise;
  const A0 = [-hw, y0, -hd], B0 = [hw, y0, -hd], Cc = [hw, y0, hd], D0 = [-hw, y0, hd], R1 = [-hw, y1, 0], R2 = [hw, y1, 0];
  const seq = [A0, R1, R2, A0, R2, B0, Cc, R2, R1, Cc, R1, D0, B0, R2, Cc, A0, D0, R1];
  const ca = Math.cos(ang), sa = Math.sin(ang), [tx, tz] = w2(rcx, rcy), out = [];
  for (const [x, y, z] of seq) out.push(x * ca + z * sa + tx, y + base, -x * sa + z * ca + tz);
  return out;
}
// roof triangle, upward winding, with aerial UVs for satellite roof imagery
function pushRoofTri(R, a, b, c) {
  const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
  const tri = (uz * vx - ux * vz) < 0 ? [a, c, b] : [a, b, c];
  for (const v of tri) { R.pos.push(v[0], v[1], v[2]); const [u, w] = aerialUVxz(v[0], v[2]); R.uv.push(u, w); }
}
function emitRing(ring, base, wallH, roofRects, wallC, W, R) {
  if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
  const yb = base, yt = base + wallH, vt = wallH / TILE;
  let dist = 0;
  for (let i = 0; i < ring.length; i++) {                 // walls
    const [xi, zi] = ring[i], [xj, zj] = ring[(i + 1) % ring.length];
    const seg = Math.hypot(xj - xi, zj - zi), u0 = dist / TILE, u1 = (dist + seg) / TILE; dist += seg;
    W.pos.push(xi, yb, zi, xj, yb, zj, xj, yt, zj, xi, yb, zi, xj, yt, zj, xi, yt, zi);
    W.uv.push(u0, 0, u1, 0, u1, vt, u0, 0, u1, vt, u0, vt);
    for (let k = 0; k < 6; k++) W.col.push(wallC[0], wallC[1], wallC[2]);
  }
  const v2 = ring.map(([x, z]) => new THREE.Vector2(x, z));  // flat eave cap
  for (const [a, c, d] of THREE.ShapeUtils.triangulateShape(v2, []))
    pushRoofTri(R, [ring[a][0], yt, ring[a][1]], [ring[c][0], yt, ring[c][1]], [ring[d][0], yt, ring[d][1]]);
  if (roofRects) for (const r of roofRects) {              // gables
    const g = gableTris(r, base, wallH);
    for (let k = 0; k < g.length; k += 9)
      pushRoofTri(R, [g[k], g[k + 1], g[k + 2]], [g[k + 3], g[k + 4], g[k + 5]], [g[k + 6], g[k + 7], g[k + 8]]);
  }
  return ring;
}
const wallHeight = b => { const H = b.h || 4.5; return ((b.r && b.r.length) ? Math.max(2.4, H * 0.8) : H) + 0.5; };
const emitBuilding = (b, ib, base, W, R) =>
  emitRing(b.p.map(([e, n]) => w2(e, n)), base, wallHeight(b), b.r, wallColor(ib), W, R);

// --- assemble --------------------------------------------------------------
const scene = new THREE.Scene(); scene.name = '1840_Dahill_Property';
scene.add(terrainMesh);
const buildingPolys = [];

const pip = (x, z, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) c = !c; } return c; };
const P = existsSync(path.join(ROOT, 'exports/parcels.json')) ? rd('exports/parcels.json') : { parcels: [] };
const MINE = (P.parcels || []).filter(p => p.mine).map(p => p.ring.map(([e, n]) => w2(e, n)));  // world-space owner lots
const inMine = (x, z) => MINE.some(r => pip(x, z, r));

const houseIdx = S.buildings.findIndex(b => b.house);
const hW = { pos: [], uv: [], col: [] }, hR = { pos: [], uv: [] };
if (houseIdx >= 0) {
  const hb = S.buildings[houseIdx], hc = centroidEN(hb.p), base = terrainAt(...w2(hc[0], hc[1])) - 0.5;
  buildingPolys.push(emitBuilding(hb, houseIdx, base, hW, hR));
  scene.add(mkMesh(hW.pos, null, 0xffffff, 'House_walls', { uvs: hW.uv, colors: hW.col }));
  scene.add(mkMesh(hR.pos, null, 0xffffff, 'House_roof', { uvs: hR.uv }));
}
const bW = { pos: [], uv: [], col: [] }, bR = { pos: [], uv: [] };
let nBld = 0, nSkip = 0;
S.buildings.forEach((b, ib) => {
  if (b.house) return;
  const cw = w2(...centroidEN(b.p));
  if (!inPatch(cw[0], cw[1])) return;
  if (inMine(cw[0], cw[1])) { nSkip++; return; }           // keep owner lots clear (back lot empty)
  const base = terrainAt(cw[0], cw[1]) - 0.5;
  buildingPolys.push(emitBuilding(b, ib, base, bW, bR));
  nBld++;
});
if (bW.pos.length) {
  scene.add(mkMesh(bW.pos, null, 0xffffff, 'Buildings_walls', { uvs: bW.uv, colors: bW.col }));
  scene.add(mkMesh(bR.pos, null, 0xffffff, 'Buildings_roofs', { uvs: bR.uv }));
}

// --- ribbons (roads, creek, parcels) ground-hugging ------------------------
function ribbon(lineW, width, lift, posArr, idxArr) {
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
const roadLines = [];
{
  const rPos = [], rIdx = [];
  for (const r of S.roads || []) {
    const pl = r.p || r; if (!Array.isArray(pl)) continue;
    const lw = pl.map(([e, n]) => w2(e, n)).filter(([x, z]) => Math.abs(x) <= cropHalf + 3 && Math.abs(z) <= cropHalf + 3);
    if (lw.length < 2) continue;
    roadLines.push(lw); ribbon(lw, r.w || 7, 0.04, rPos, rIdx);
  }
  if (rIdx.length) scene.add(mkMesh(rPos, rIdx, 0x555555, 'Roads'));
}
let creekW = null;
if (S.creek && S.creek.p) {
  creekW = S.creek.p.map(([e, n]) => w2(e, n)).filter(([x, z]) => Math.abs(x) <= cropHalf + 3 && Math.abs(z) <= cropHalf + 3);
  if (creekW.length >= 2) {
    const cPos = [], cIdx = []; ribbon(creekW, 10, 0.05, cPos, cIdx);
    const cr = mkMesh(cPos, cIdx, 0x3a78c2, 'Creek_SanLorenzo'); cr.material.name = 'Creek_mat'; scene.add(cr);
  }
}

// --- parcels / lot lines ---------------------------------------------------
if ((P.parcels || []).length) {
  const lPos = [], lIdx = [], yPos = [], yIdx = [];
  for (const p of P.parcels) {
    const ring = p.ring.map(([e, n]) => w2(e, n));
    if (ring.length < 2) continue;
    const closed = ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring : ring.concat([ring[0]]);
    if (p.mine) ribbon(closed, 1.1, 0.25, yPos, yIdx);
    else ribbon(closed, 0.5, 0.12, lPos, lIdx);
  }
  if (lIdx.length) scene.add(mkMesh(lPos, lIdx, 0xe8e2d0, 'LotLines'));
  if (yIdx.length) scene.add(mkMesh(yPos, yIdx, 0xffcf33, 'YourLots'));
}

// --- export GLB, embed photo textures via gltf-transform -------------------
const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false });
mkdirSync(path.join(ROOT, 'exports'), { recursive: true });
const out = path.join(ROOT, 'exports', '1840-dahill-property.glb');

const { NodeIO } = await import('@gltf-transform/core');
const io = new NodeIO();
const doc = await io.readBinary(new Uint8Array(glb));
const aerialP = path.join(ROOT, 'exports/google_aerial.jpg');
const facadeP = path.join(ROOT, 'exports/facade.png');
const aerialTex = existsSync(aerialP) ? doc.createTexture('aerial').setImage(new Uint8Array(readFileSync(aerialP))).setMimeType('image/jpeg') : null;
const facadeTex = existsSync(facadeP) ? doc.createTexture('facade').setImage(new Uint8Array(readFileSync(facadeP))).setMimeType('image/png') : null;
const REPEAT = 10497, CLAMP = 33071;
let textured = 0;
for (const m of doc.getRoot().listMaterials()) {
  const n = m.getName() || '';
  if (aerialTex && /(terrain|roof)/i.test(n)) {            // satellite on terrain AND roofs
    m.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(aerialTex);
    m.getBaseColorTextureInfo().setWrapS(CLAMP).setWrapT(CLAMP); textured++;
  } else if (facadeTex && /walls/i.test(n)) {
    m.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(facadeTex);
    m.getBaseColorTextureInfo().setWrapS(REPEAT).setWrapT(REPEAT); textured++;
  }
}
writeFileSync(out, Buffer.from(await io.writeBinary(doc)));

const objs = [];
scene.traverse(o => { if (o.isMesh) objs.push(`  ${o.name.padEnd(18)} ${o.geometry.attributes.position.count} verts`); });
console.log(`frame: flat-ENU, house centroid at origin; UV v=(Nt-n)/(Nt-Nb) north-up`);
console.log(`crop half: ${cropHalf.toFixed(0)} m   buildings: ${nBld} (${nSkip} on owner lots skipped)`);
console.log('layers:\n' + objs.join('\n'));
console.log(`textured materials: ${textured} (aerial->terrain+roofs, facade->walls)`);
console.log(`wrote ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
