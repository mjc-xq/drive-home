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
// Full PHOTO pipeline (fences must land in the final file):
//   node scripts/export_property_glb.mjs
//   blender --background --python scripts/place_trees.py   # -> 1840-dahill-property-trees.glb
//   blender --background --python scripts/place_fences.py  # rewrites that same file
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
const S = JSON.parse(readFileSync(path.join(ROOT, 'src/assets/scene.json'), 'utf8'));
const C = S.center;                                        // house centroid (flat ENU)
let A = S.aerial;                                          // aerial bounds (flat ENU)
const GAERIAL = path.join(ROOT, 'exports/google_aerial.json');
if (existsSync(GAERIAL)) A = JSON.parse(readFileSync(GAERIAL, 'utf8'));   // prefer Google satellite
// FLAT ENU end-to-end — the SAME frame as the verified 2-D overlay (footprint
// flat-ENU -> aerial-bounds pixel). Geometry and aerial UVs now share one frame, so
// the 3-D export lands exactly where the 2-D overlay does. (makeGeoENU was only
// needed to match the Google PHOTOREAL tiles, now dropped; it placed geometry in a
// curvature frame while the aerial UVs were flat -> the metres of drift between the
// buildings/creek and the satellite texture.)
const LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * Math.PI / 180);
const llToEN = (lat, lon) => [(lon - LON0) * COSLAT * 111320, (lat - LAT0) * 110540];  // GEO0-relative flat ENU
const enToLL = (e, n) => [LAT0 + n / 110540, LON0 + e / (COSLAT * 111320)];
const w2 = (e, n) => [e - C[0], -(n - C[1])];                  // flat ENU -> world (house centroid at origin)
// world XZ -> aerial-bounds UV: LINEAR in flat ENU, v=0 at the north/top edge — the
// exact mapping the 2-D overlay and fetch_terrain_colors.py use.
const aerialUVen = (e, n) => [(e - A.E0) / (A.E1 - A.E0), (A.Nt - n) / (A.Nt - A.Nb)];

// ---- terrain: crisp 1 m DEM patch if present, else coarse Terrarium ------
const DEMPATH = path.join(ROOT, 'exports/dem_1m.json');
let terrainAt, terrainMesh, cropHalf, terrSrc, tXmin, tXmax, tZmin, tZmax;
function mkMesh(positions, indices, color, name, opts = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (opts.uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(opts.uvs, 2));
  if (opts.colors) g.setAttribute('color', new THREE.Float32BufferAttribute(opts.colors, 3));
  if (indices) g.setIndex(indices);
  g.computeVertexNormals();
  const opacity = opts.opacity ?? 1;
  const m = new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.95, metalness: 0, name: name + '_mat', transparent: opacity < 1, opacity });
  if (opts.emissive) {
    const e = color instanceof THREE.Color ? color.clone() : new THREE.Color(color);
    m.emissive = e.multiplyScalar(opts.emissive);
  }
  if (opts.colors) m.vertexColors = true;
  if (opts.flat) m.flatShading = true;
  if (opacity < 1) m.depthWrite = false;
  m.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(g, m); mesh.name = name; return mesh;
}

if (existsSync(DEMPATH)) {
  const D = JSON.parse(readFileSync(DEMPATH, 'utf8'));
  const { cols, rows, h } = D;
  const dLat = D.latN - D.latS, dLon = D.lonE - D.lonW;
  cropHalf = dLat * 110540 / 2 - 4;
  // real terrain world bounds — the patch is narrower E-W than N-S (and may be off-centre
  // from the house), so a symmetric ±cropHalf box let trees fall past the E-W edge into
  // mid-air. Filter geometry against these actual bounds instead.
  tXmin = (D.lonW - LON0) * COSLAT * 111320 - C[0]; tXmax = (D.lonE - LON0) * COSLAT * 111320 - C[0];
  const _za = -((D.latN - LAT0) * 110540 - C[1]), _zb = -((D.latS - LAT0) * 110540 - C[1]);
  tZmin = Math.min(_za, _zb); tZmax = Math.max(_za, _zb);
  terrSrc = D.source;
  // DEM grid is linear in lat/lon (4326). Sample by world -> lat/lon (curvature-correct).
  terrainAt = (X, Z) => {
    const [lat, lon] = enToLL(X + C[0], C[1] - Z);
    let fi = (lon - D.lonW) / dLon * cols - 0.5, fj = (D.latN - lat) / dLat * rows - 0.5;
    fi = Math.max(0, Math.min(cols - 1.001, fi)); fj = Math.max(0, Math.min(rows - 1.001, fj));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
    const a = h[j * cols + i], b = h[j * cols + i + 1], c = h[(j + 1) * cols + i], d = h[(j + 1) * cols + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  // aerial as a sharp TEXTURE (UVs); the USDZ is generated + verified separately.
  const pos = [], uv = [], idx = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i;
    const lat = D.latN - (j + 0.5) / rows * dLat, lon = D.lonW + (i + 0.5) / cols * dLon;
    const [e, n] = llToEN(lat, lon); pos.push(e - C[0], h[k], -(n - C[1]));
    const w = aerialUVen(e, n); uv.push(w[0], w[1]);
  }
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1; idx.push(a, c, b, b, c, d);
  }
  terrainMesh = mkMesh(pos, idx, 0xffffff, 'Terrain', { uvs: uv });
} else {
  throw new Error('exports/dem_1m.json missing — run: scripts/.venv/bin/python scripts/fetch_dem.py 400');
}

const inPatch = (X, Z) => X >= tXmin && X <= tXmax && Z >= tZmin && Z <= tZmax;
const inTerrain = (X, Z, m = 5) => X >= tXmin + m && X <= tXmax - m && Z >= tZmin + m && Z <= tZmax - m;
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
const TILE = 5.0;   // bigger facade tile -> sparser windows (was a dense 3 m grid)
const aerialUV = (X, Z) => aerialUVen(X + C[0], C[1] - Z);
// Per-building wall colour from Street View (exports/buildings_color.json) and a
// clean solid roof colour (NADIR aerial on pitched roofs looks wrong, so roofs are
// solid). Walls = facade window texture x SV colour; roofs = solid shingle.
const COL = existsSync(path.join(ROOT, 'exports/buildings_color.json'))
  ? JSON.parse(readFileSync(path.join(ROOT, 'exports/buildings_color.json'), 'utf8')) : {};
// Real per-roof colour sampled from the aerial (fetch_roof_colors.py) — terracotta,
// gray shingle, brown — instead of a random palette.
const RCOL = existsSync(path.join(ROOT, 'exports/buildings_roof_color.json'))
  ? JSON.parse(readFileSync(path.join(ROOT, 'exports/buildings_roof_color.json'), 'utf8')) : {};
const STUCCO = [0.82, 0.78, 0.70];
const ROOFP = [[0.58, 0.55, 0.50], [0.60, 0.46, 0.38], [0.50, 0.53, 0.55], [0.60, 0.50, 0.42], [0.62, 0.59, 0.52]];
const WALL_PALETTE = [
  [0.78, 0.73, 0.64], [0.72, 0.75, 0.68], [0.73, 0.70, 0.65],
  [0.68, 0.72, 0.73], [0.80, 0.76, 0.68], [0.69, 0.66, 0.60],
];
const ROOF_PALETTE = [
  [0.58, 0.55, 0.50], [0.60, 0.46, 0.38], [0.50, 0.53, 0.55],
  [0.60, 0.50, 0.42], [0.62, 0.59, 0.52],
];
const clamp01 = v => Math.max(0, Math.min(1, v));
const mix3 = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
const luma = c => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const liftLuma = (c, minL, target = STUCCO) => {
  const L = luma(c);
  if (L >= minL) return c.map(clamp01);
  const denom = Math.max(0.001, luma(target) - L);
  return mix3(c, target, Math.min(1, (minL - L) / denom)).map(clamp01);
};
const seededColor = (palette, ib) => palette[(Math.imul((ib | 0) + 17, 1103515245) >>> 0) % palette.length];
const lighten = c => liftLuma(mix3(c, STUCCO, 0.52), 0.62);   // plausible wall from a roof colour
// walls: source samples often include shadow/tree occlusion; normalize to paint,
// not black placeholder boxes.
const wallColor = ib => {
  const src = COL[ib] || (RCOL[ib] ? lighten(RCOL[ib]) : STUCCO);
  let c = liftLuma(src, 0.58, seededColor(WALL_PALETTE, ib));
  c = mix3(c, seededColor(WALL_PALETTE, ib), 0.34);
  return liftLuma(c, 0.62, STUCCO);
};
// roofs: real sampled colour, but lift deep satellite shadows so they read as roof
// material instead of black voids in review renders.
const roofColor = ib => {
  const src = RCOL[ib] || ROOFP[(Math.imul((ib | 0) + 1, 2654435761) >>> 0) % ROOFP.length];
  return liftLuma(mix3(src, seededColor(ROOF_PALETTE, ib), 0.40), 0.48, seededColor(ROOF_PALETTE, ib));
};

function pushWallRect(pos, ax, az, ex, ez, nx, nz, s0, s1, y0, y1, off = 0.09) {
  const A = [ax + ex * s0 + nx * off, y0, az + ez * s0 + nz * off];
  const B = [ax + ex * s1 + nx * off, y0, az + ez * s1 + nz * off];
  const Cc = [ax + ex * s1 + nx * off, y1, az + ez * s1 + nz * off];
  const Dd = [ax + ex * s0 + nx * off, y1, az + ez * s0 + nz * off];
  for (const v of [A, B, Cc, A, Cc, Dd]) pos.push(v[0], v[1], v[2]);
}
function emitFacadeShellDetails(ring, base, wallH, D) {
  if (!D) return;
  const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
  const yBase = base + 0.12, yTop = base + wallH - 0.16;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1.4 || wallH < 2.1) continue;
    let ex = (bx - ax) / L, ez = (bz - az) / L;
    let nx = -ez, nz = ex;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if ((mx - cen[0]) * nx + (mz - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
    if (D.trim) {
      pushWallRect(D.trim, ax, az, ex, ez, nx, nz, 0.02, Math.min(0.14, L), yBase, yTop, 0.116);
      pushWallRect(D.trim, ax, az, ex, ez, nx, nz, Math.max(0, L - 0.14), L - 0.02, yBase, yTop, 0.116);
      pushWallRect(D.trim, ax, az, ex, ez, nx, nz, 0.08, L - 0.08, base + wallH - 0.24, base + wallH - 0.08, 0.118);
      pushWallRect(D.trim, ax, az, ex, ez, nx, nz, 0.08, L - 0.08, base + 0.16, base + 0.30, 0.118);
      for (let y = base + 2.65; y < base + wallH - 0.55; y += 2.55) {
        pushWallRect(D.trim, ax, az, ex, ez, nx, nz, 0.18, L - 0.18, y - 0.035, y + 0.035, 0.121);
      }
    }
    if (D.siding) {
      for (let y = base + 0.82; y < base + wallH - 0.65; y += 0.92) {
        pushWallRect(D.siding, ax, az, ex, ez, nx, nz, 0.22, L - 0.22, y - 0.006, y + 0.006, 0.124);
      }
    }
  }
}
function emitFacadeDetails(ring, base, wallH, D, opts = {}) {
  if (!D) return;
  emitFacadeShellDetails(ring, base, wallH, D);
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
    const bay = opts.house ? 3.0 : 3.35 + (((i * 97 + Math.round(L * 10)) % 5) - 2) * 0.10;
    const count = Math.max(1, Math.min(12, Math.floor((L - 1.0) / bay)));
    const floors = Math.max(1, Math.min(3, Math.floor((wallH - 1.15) / 2.55)));
    for (let f = 0; f < floors; f++) {
      const y0 = base + 1.10 + f * 2.45;
      const y1 = Math.min(y0 + 1.02, yt - 0.42);
      if (y1 - y0 < 0.45) continue;
      for (let w = 0; w < count; w++) {
        if (!opts.house && count > 3 && ((w + i + f) % 7) === 5) continue;
        const jitter = (((i + 3) * 37 + (w + 11) * 19 + f * 13) % 17 - 8) / 100;
        const s = (w + 1 + jitter) * L / (count + 1);
        if (s < 0.85 || L - s < 0.85) continue;
        const hw = Math.min(0.64, Math.max(0.34, L / (count + 1) * (0.18 + ((w + i) % 3) * 0.025)));
        pushWallRect(D.trim, ax, az, ex, ez, nx, nz, s - hw - 0.12, s + hw + 0.12, y0 - 0.10, y1 + 0.10, 0.082);
        pushWallRect(D.glass, ax, az, ex, ez, nx, nz, s - hw, s + hw, y0, y1, 0.105);
        pushWallRect(D.trim, ax, az, ex, ez, nx, nz, s - 0.025, s + 0.025, y0 + 0.05, y1 - 0.05, 0.118);
        pushWallRect(D.trim, ax, az, ex, ez, nx, nz, s - hw - 0.18, s + hw + 0.18, y0 - 0.20, y0 - 0.12, 0.115);
      }
    }
  }
}

// push a roof triangle with upward-facing winding, solid roof colour (no texture)
function pushUpTri(Rf, col, a, b, c) {
  const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
  const tri = (uz * vx - ux * vz) < 0 ? [a, c, b] : [a, b, c];
  for (const v of tri) { Rf.pos.push(v[0], v[1], v[2]); Rf.col.push(col[0], col[1], col[2]); }
}
// push a roof-PHOTO triangle (upward winding) with nadir aerial UV -> real satellite
// roof imagery. Used only on flat roofs (nadir on pitched roofs smears), as a separate
// toggleable 'Roofs_photo' layer lifted just above the solid cap.
function pushPhotoTri(RfP, a, b, c) {
  const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
  const tri = (uz * vx - ux * vz) < 0 ? [a, c, b] : [a, b, c];
  for (const v of tri) { RfP.pos.push(v[0], v[1], v[2]); const w = aerialUV(v[0], v[2]); RfP.uv.push(w[0], w[1]); }
}
function pushWallFace(W, wallC, xi, zi, xj, zj, yb, yt, u0, u1, vt, cen) {
  const A = [xi, yb, zi], B = [xj, yb, zj], Cc = [xj, yt, zj], Dd = [xi, yt, zi];
  const L = Math.max(0.001, Math.hypot(xj - xi, zj - zi));
  const nx = -(zj - zi) / L, nz = (xj - xi) / L;
  const out = (((xi + xj) * 0.5 - cen[0]) * nx + ((zi + zj) * 0.5 - cen[1]) * nz) >= 0;
  const verts = out ? [A, B, Cc, A, Cc, Dd] : [A, Cc, B, A, Dd, Cc];
  const uvs = out
    ? [u0, 0, u1, 0, u1, vt, u0, 0, u1, vt, u0, vt]
    : [u0, 0, u1, vt, u1, 0, u0, 0, u0, vt, u1, vt];
  for (const v of verts) W.pos.push(v[0], v[1], v[2]);
  W.uv.push(...uvs);
  for (let k = 0; k < 6; k++) W.col.push(wallC[0], wallC[1], wallC[2]);
}
// W = {pos,uv,col} facade walls (window texture x wallC);  Rf = {pos,col} solid roof.
// RfP = {pos,uv} optional satellite-photo cap (flat roofs only) for the toggle layer.
function emitRing(ring, base, wallH, roofRects, wallC, roofC, W, Rf, RfP, detail, detailOpts = {}) {
  if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
  const yb = base, yt = base + wallH, vt = wallH / TILE;
  const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
  let dist = 0;
  for (let i = 0; i < ring.length; i++) {           // walls
    const [xi, zi] = ring[i], [xj, zj] = ring[(i + 1) % ring.length];
    const seg = Math.hypot(xj - xi, zj - zi), u0 = dist / TILE, u1 = (dist + seg) / TILE; dist += seg;
    pushWallFace(W, wallC, xi, zi, xj, zj, yb, yt, u0, u1, vt, cen);
  }
  const v2 = ring.map(([x, z]) => new THREE.Vector2(x, z));   // flat eave cap
  const capTris = THREE.ShapeUtils.triangulateShape(v2, []);
  for (const [a, c, d] of capTris)
    pushUpTri(Rf, roofC, [ring[a][0], yt, ring[a][1]], [ring[c][0], yt, ring[c][1]], [ring[d][0], yt, ring[d][1]]);
  // satellite roof-photo cap: ONLY flat roofs (no gable), lifted just above the solid cap
  if (RfP && !(roofRects && roofRects.length)) {
    const yp = yt + 0.06;
    for (const [a, c, d] of capTris)
      pushPhotoTri(RfP, [ring[a][0], yp, ring[a][1]], [ring[c][0], yp, ring[c][1]], [ring[d][0], yp, ring[d][1]]);
  }
  if (roofRects) for (const r of roofRects) {        // gables
    const g = gableTris(r, base, wallH);
    for (let k = 0; k < g.length; k += 9)
      pushUpTri(Rf, roofC, [g[k], g[k + 1], g[k + 2]], [g[k + 3], g[k + 4], g[k + 5]], [g[k + 6], g[k + 7], g[k + 8]]);
  }
  emitFacadeDetails(ring, base, wallH, detail, detailOpts);
  return ring;
}
const emitBuilding = (b, ib, base, wallH, W, Rf, RfP, detail, detailOpts) =>
  emitRing(b.p.map(([e, n]) => w2(e, n)), base, wallH, b.r, wallColor(ib), roofColor(ib), W, Rf, RfP, detail, detailOpts);

// ---- assemble ------------------------------------------------------------
const scene = new THREE.Scene(); scene.name = '1840_Dahill_Property';
scene.add(terrainMesh);

// OSM/Overture height (or a sane default) — NOT LiDAR (the LiDAR heights were noisy)
const wallHeight = b => { const H = b.h || 4.5; return ((b.r && b.r.length) ? Math.max(2.4, H * 0.8) : H) + 0.5; };
const houseIdx = S.buildings.findIndex(b => b.house);
const buildingPolys = [];                       // world-space rings for tree avoidance
const buildingCollision = [];
const svFacadeTextures = new Map();
const hW = { pos: [], uv: [], col: [] }, hRf = { pos: [], col: [] };
const hD = { glass: [], trim: [], siding: [] };
let houseRing = null, houseWallH = 0;
const RfP = { pos: [], uv: [] };   // satellite roof-photo caps (flat roofs) -> toggle layer
if (houseIdx >= 0) {
  const houseB = S.buildings[houseIdx];
  const hc = centroidEN(houseB.p), base = terrainAt(...w2(hc[0], hc[1])) - 0.5;
  houseWallH = wallHeight(houseB, houseIdx);
  houseRing = emitBuilding(houseB, houseIdx, base, houseWallH, hW, hRf, RfP, hD, { house: true, autoWindows: false });
  buildingPolys.push(houseRing);
  buildingCollision.push({ ring: houseRing, base, h: houseWallH });
  // base colour = the building's own SV (walls) / satellite (roof) colour, so it renders
  // in EVERY viewer (Quick Look + many glTF viewers ignore per-vertex COLOR_0).
  scene.add(mkMesh(hW.pos, null, new THREE.Color(...wallColor(houseIdx)), 'House_walls', { uvs: hW.uv, emissive: 0.42 }));
  scene.add(mkMesh(hRf.pos, null, new THREE.Color(...roofColor(houseIdx)), 'House_roof', { emissive: 0.36 }));
  if (hD.siding.length) scene.add(mkMesh(hD.siding, null, 0xbcb4a4, 'House_siding_lines', { emissive: 0.18 }));
  if (hD.trim.length) scene.add(mkMesh(hD.trim, null, 0xd8d0bd, 'House_window_trim'));
  if (hD.glass.length) scene.add(mkMesh(hD.glass, null, 0x223647, 'House_windows'));
}
const bW = { pos: [], uv: [], col: [] }, bRf = { pos: [], col: [] };
const bD = { glass: [], trim: [], siding: [] };
const wallGroups = [], roofGroups = [];   // per-building [start, count, colour] -> material array
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
  const h = wallHeight(b, ib);
  const ws = bW.pos.length / 3, rs = bRf.pos.length / 3;
  const ring = emitBuilding(b, ib, base, h, bW, bRf, RfP, bD, {});
  buildingPolys.push(ring);
  buildingCollision.push({ ring, base, h });
  wallGroups.push([ws, bW.pos.length / 3 - ws, wallColor(ib)]);
  roofGroups.push([rs, bRf.pos.length / 3 - rs, roofColor(ib)]);
  nBld++;
});
// gap-fill LiDAR buildings DISABLED — they produced false structures (incl. one in
// the back yard) and crossed property lines. The photoreal layer covers genuinely
// missing buildings; the clean model stays trustworthy instead.
const nFill = 0;
// Per-building MATERIALS (base colour = the building's SV/satellite colour) via geometry
// groups, one Buildings mesh each — colour renders in every viewer (no reliance on COLOR_0).
function groupedMesh(buf, groups, name, withUV) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  if (withUV) g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
  g.computeVertexNormals();
  const mats = groups.map(([start, count, col], i) => {
    g.addGroup(start, count, i);
    const base = new THREE.Color(col[0], col[1], col[2]);
    const m = new THREE.MeshStandardMaterial({ color: base, roughness: 0.95, metalness: 0, name: `${name}_${i}` });
    m.emissive = base.clone().multiplyScalar(/walls/i.test(name) ? 0.42 : 0.36);
    m.side = THREE.DoubleSide; return m;
  });
  const mesh = new THREE.Mesh(g, mats); mesh.name = name; return mesh;
}
if (bW.pos.length) {
  scene.add(groupedMesh(bW, wallGroups, 'Buildings_walls', true));
  scene.add(groupedMesh(bRf, roofGroups, 'Buildings_roofs', false));
  if (bD.siding.length) scene.add(mkMesh(bD.siding, null, 0xb6ad9f, 'Buildings_siding_lines', { emissive: 0.18 }));
  if (bD.trim.length) scene.add(mkMesh(bD.trim, null, 0xd2c9b8, 'Buildings_window_trim'));
  if (bD.glass.length) scene.add(mkMesh(bD.glass, null, 0x203342, 'Buildings_windows'));
}
// Satellite roof-photo layer (flat roofs): real aerial imagery, lifted just above the
// solid roof. A separate node so it can be toggled on/off (hide it -> solid colours).
if (RfP.pos.length) scene.add(mkMesh(RfP.pos, null, 0xffffff, 'Roofs_photo', { uvs: RfP.uv }));
function addStreetViewFacadeOverlays() {
  const manifest = path.join(ROOT, 'exports/sv_facades.json');
  if (!existsSync(manifest)) return 0;
  const data = JSON.parse(readFileSync(manifest, 'utf8'));
  let count = 0;
  for (const wall of data.walls || []) {
    const img = path.join(ROOT, 'exports', wall.image || '');
    const b = S.buildings[wall.building];
    if (!b || !existsSync(img) || !wall.A || !wall.B) continue;
    const A0 = w2(...wall.A), B0 = w2(...wall.B);
    const L = Math.hypot(B0[0] - A0[0], B0[1] - A0[1]);
    if (L < 1.5) continue;
    let ex = (B0[0] - A0[0]) / L, ez = (B0[1] - A0[1]) / L;
    let nx = -ez, nz = ex;
    const ring = b.p.map(([e, n]) => w2(e, n));
    const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
    const mx = (A0[0] + B0[0]) / 2, mz = (A0[1] + B0[1]) / 2;
    if ((mx - cen[0]) * nx + (mz - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
    const base = terrainAt(mx, mz) - 0.46;
    const top = base + (wall.wallH || wallHeight(b));
    const off = 0.16;
    const A = [A0[0] + nx * off, base, A0[1] + nz * off];
    const B = [B0[0] + nx * off, base, B0[1] + nz * off];
    const Cc = [B0[0] + nx * off, top, B0[1] + nz * off];
    const Dd = [A0[0] + nx * off, top, A0[1] + nz * off];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...A, ...B, ...Cc, ...A, ...Cc, ...Dd], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0], 2));
    g.computeVertexNormals();
    const matName = `SVFacade_${wall.building}_${wall.edge}`;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, name: matName, emissive: new THREE.Color(1, 1, 1).multiplyScalar(0.16) });
    mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = matName;
    mesh.userData = { source: 'Google Street View Static', date: wall.date || '', building: wall.building, edge: wall.edge };
    scene.add(mesh);
    svFacadeTextures.set(matName, img);
    count++;
  }
  return count;
}
const nSVFacades = addStreetViewFacadeOverlays();

// roads / mapped service ways (context) + collect world polylines for tree spacing
const roadLines = [], streetLines = [];
const rPos = [], rIdx = [], drvPos = [], drvIdx = [], drvSrcPos = [], drvSrcIdx = [], parkSrcPos = [], parkSrcIdx = [];
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
// Good-looking roads: dark asphalt + raised light curbs both sides + dashed yellow
// centre line (matches the reference). Separate named layers so each is editable.
// Width/lanes per class (roadSpec); roads clipped to ROAD_HALF (> terrain) so they
// run off the patch edge; centrelines smoothed (Catmull-Rom) for real curves; courts
// get turnaround bulbs and junctions get one clean asphalt pad (see road_prep.mjs).
// Roads must reach the patch edge but NOT hang past it into the void: the terrain
// mesh only covers the DEM patch, and terrainAt clamps beyond it, so any ribbon
// vertex past the patch floats. Clip roads to the patch (cropHalf, ~4 m inside the
// ±200 m terrain) so they run edge-to-edge while every vertex stays on real ground.
const ROAD_HALF = cropHalf;
const cuPos = [], cuIdx = [], dPos = [];
const swPos = [], swIdx = [], swSrcPos = [], swSrcIdx = [], xwalkPos = [], xwalkIdx = [];
// layer stack (m above terrain). Asphalt lifted well clear so the aerial/grass under-
// layer never bleeds through; each higher layer sits above the last.
const LIFT_ASPHALT = 0.55, LIFT_DRIVEWAY = 0.60, LIFT_SIDEWALK = 0.62, LIFT_CURB = 0.70, LIFT_DASH = 0.61;
const SW_WIDTH = 1.8, SW_GAP = 2.2;         // road edge -> sidewalk centre spacing
const MAPSURFACES = path.join(ROOT, 'exports/map_surfaces_osm.json');
const mapSurfaces = existsSync(MAPSURFACES) ? JSON.parse(readFileSync(MAPSURFACES, 'utf8')) : {};
const hasMappedDriveways = !!((mapSurfaces.drivewayPolygons || []).length || (mapSurfaces.driveways || []).length || (mapSurfaces.parkingAreas || []).length);
// offset a polyline along its left normal, with a mitre clamp so curbs don't pinch /
// self-cross on sharp corners (offset scaled by 1/max(0.35,cos(halfTurn))).
const offsetLine = (lw, d) => lw.map((p, k) => {
  const a = lw[Math.max(0, k - 1)], b = lw[Math.min(lw.length - 1, k + 1)];
  let ax = p[0] - a[0], az = p[1] - a[1], bx = b[0] - p[0], bz = b[1] - p[1];
  const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
  ax /= la; az /= la; bx /= lb; bz /= lb;
  let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
  const cosHalf = Math.sqrt(Math.max(0, (1 + (ax * bx + az * bz)) / 2));   // cos(halfTurn)
  const m = d / Math.max(0.35, cosHalf);
  return [p[0] - dz * m, p[1] + dx * m];          // offset along the left normal (-dz, dx)
});
function centreDashes(lw, halfW, lift, skip) {      // 3 m dash / 3.5 m gap, 0.28 m wide
  const ON = 3.0, OFF = 3.5; let draw = true, acc = 0;
  for (let k = 1; k < lw.length; k++) {
    const a = lw[k - 1], b = lw[k]; let dx = b[0] - a[0], dz = b[1] - a[1];
    const seg = Math.hypot(dx, dz) || 1; dx /= seg; dz /= seg; const nx = -dz, nz = dx;
    let t = 0;
    while (t < seg - 1e-6) {
      const len = Math.min((draw ? ON : OFF) - acc, seg - t);
      const mx = a[0] + dx * (t + len / 2), mz = a[1] + dz * (t + len / 2);
      if (draw && !(skip && skip(mx, mz))) {        // no centre line through junctions / bulbs
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
// curb ribbon that skips samples within R_TRIM of a junction (no curb across an
// intersection). Densify + offset already done by the caller; here we just drop
// quads whose midpoint is near a junction.
function curbRibbon(lineW, width, lift, posArr, idxArr, skip) {
  const dense = [lineW[0]];
  for (let k = 1; k < lineW.length; k++) {
    const a = lineW[k - 1], b = lineW[k], seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(seg / 2.5));
    for (let s = 1; s <= steps; s++) dense.push([a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps]);
  }
  lineW = dense;
  const hw = width / 2;
  let prev = null;                                  // [lx,lz,rx,rz, off] of previous emitted row
  for (let k = 0; k < lineW.length; k++) {
    const [x, z] = lineW[k], p = lineW[Math.max(0, k - 1)], q = lineW[Math.min(lineW.length - 1, k + 1)];
    let dx = q[0] - p[0], dz = q[1] - p[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const nx = -dz, nz = dx, lx = x + nx * hw, lz = z + nz * hw, rx = x - nx * hw, rz = z - nz * hw;
    if (skip && skip(x, z)) { prev = null; continue; }     // gap the curb at the junction
    const off = posArr.length / 3;
    posArr.push(lx, terrainAt(lx, lz) + lift, lz, rx, terrainAt(rx, rz) + lift, rz);
    if (prev !== null) { const a = prev, b = a + 1, c = off, d = off + 1; idxArr.push(a, c, b, b, c, d); }
    prev = off;
  }
}
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
      curbRibbon(piece, width, lift, posArr, idxArr, null);
      roadLines.push(piece);
    }
  }
}

// shared junction/dead-end vertex map and rank lookup
const vertHit = buildVertHit(S.roads || [], w2);
const junctionPts = [];                            // world XZ of every junction vertex
for (const r of S.roads || []) {
  const pl = r.p || r; if (!Array.isArray(pl)) continue;
  for (const [e, n] of pl) { const [x, z] = w2(e, n); if ((vertHit.get(vkey(x, z)) || 0) >= 2 && !junctionPts.some(p => p[0] === x && p[1] === z)) junctionPts.push([x, z]); }
}
const R_TRIM_FOR = w => w / 2 + 0.5;
// at a junction vertex, the widest road meeting there (drives trim distance + pad size)
const junctionWidth = new Map();                   // vkey -> max road width at that vertex
const junctionMaxRank = new Map();
for (const r of S.roads || []) {
  const pl = r.p || r; if (!Array.isArray(pl)) continue;
  const sp = roadSpec(r), rk = roadRank(r);
  for (const [e, n] of pl) {
    const [x, z] = w2(e, n), k = vkey(x, z);
    if ((vertHit.get(k) || 0) >= 2) {
      junctionWidth.set(k, Math.max(junctionWidth.get(k) || 0, sp.width));
      junctionMaxRank.set(k, Math.max(junctionMaxRank.get(k) || 0, rk));
    }
  }
}
// cul-de-sac bulb centres (computed first so dashes can avoid them too)
// bulbs / end-caps / junction pads only where they fully sit on terrain (use the
// real patch bounds with a margin, not the symmetric ROAD_HALF box, so no disc
// edge spills past the terrain into the void)
const inHalf = (x, z) => inTerrain(x, z, 14);
const isCourt = isCulDeSacRoad;
const bulbs = [];                                  // {cx,cz,R} for residential courts
for (const r of S.roads || []) {
  const pl = r.p || r; if (!Array.isArray(pl)) continue;
  const spec = roadSpec(r); if (!isCourt(r)) continue;
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
  const pl = (r.p || r); if (!Array.isArray(pl)) continue;
  const lwRaw = pl.map(([e, n]) => w2(e, n));
  const spec = roadSpec(r), rk = roadRank(r);
  for (let piece of clipPolylineToBox(lwRaw, ROAD_HALF)) {
    // trim each end that meets a HIGHER-ranked road inward so the side street butts up
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
      if (!hasMappedDriveways) ribbon(piece, spec.width, LIFT_DRIVEWAY, drvPos, drvIdx);
      continue;
    }
    streetLines.push(piece);
    ribbon(piece, spec.width, LIFT_ASPHALT, rPos, rIdx);                                // asphalt
    curbRibbon(offsetLine(piece, spec.width / 2 + 0.3), 0.55, LIFT_CURB, cuPos, cuIdx, skipNearJunction);
    curbRibbon(offsetLine(piece, -(spec.width / 2 + 0.3)), 0.55, LIFT_CURB, cuPos, cuIdx, skipNearJunction);
    if (spec.lanes >= 2) centreDashes(piece, 0.14, LIFT_DASH, skipNearJunction);
    if (!spec.isService) {
      const swDist = spec.width / 2 + SW_GAP;
      curbRibbon(offsetLine(piece, swDist), SW_WIDTH, LIFT_SIDEWALK, swPos, swIdx, skipNearJunction);
      curbRibbon(offsetLine(piece, -swDist), SW_WIDTH, LIFT_SIDEWALK, swPos, swIdx, skipNearJunction);
    }
  }
}
// Road-edge sidewalks: actual pedestrian paths run parallel to the carriageway,
// then meet through rounded connector arcs around intersection curb returns.
for (const run of buildSidewalkConnectors(S.roads || [], w2, {
  sideGap: SW_GAP,
  inPatch: (x, z) => inTerrain(x, z, 6),
})) curbRibbon(run, SW_WIDTH, LIFT_SIDEWALK, swPos, swIdx, null);
for (const run of buildSidewalkEndCaps(S.roads || [], w2, {
  sideGap: SW_GAP,
  inPatch: (x, z) => inTerrain(x, z, 6),
  isCourt,
})) curbRibbon(run, SW_WIDTH, LIFT_SIDEWALK, swPos, swIdx, null);
// cul-de-sac bulbs / service end-caps at true dead-ends inside ROAD_HALF.
// Court bulbs were precomputed above (reused here so dashes/curbs avoided them);
// service stubs just get a small rounded end-cap (no fake roundabout).
const emitAsphalt = (x, z) => { const o = rPos.length / 3; rPos.push(x, terrainAt(x, z) + LIFT_ASPHALT, z); return o; };
const emitDriveway = (x, z) => { const o = drvPos.length / 3; drvPos.push(x, terrainAt(x, z) + LIFT_DRIVEWAY, z); return o; };
const emitCurb = (x, z) => { const o = cuPos.length / 3; cuPos.push(x, terrainAt(x, z) + LIFT_CURB, z); return o; };
const emitSidewalk = (x, z) => { const o = swPos.length / 3; swPos.push(x, terrainAt(x, z) + LIFT_SIDEWALK, z); return o; };
for (const { cx, cz, R } of bulbs) {
  fanDisc(cx, cz, R, 24, emitAsphalt, rIdx);
  ringAnnulus(cx, cz, R, R + 0.3, 24, emitCurb, cuIdx);
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
    if ((vertHit.get(vkey(tip[0], tip[1])) || 0) > 1) continue;   // not a dead-end
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
const DRIVEWAYSJSON = path.join(ROOT, 'exports/driveways_osm.json');
if (!hasMappedDriveways && existsSync(DRIVEWAYSJSON)) {
  const mapped = JSON.parse(readFileSync(DRIVEWAYSJSON, 'utf8')).driveways || [];
  for (const d of mapped) {
    const width = d.service === 'parking_aisle' ? 5.0 : 3.6;
    for (let piece of clipPolylineToBox(d.p || [], ROAD_HALF)) {
      piece = smoothLine(piece);
      if (piece.length < 2) continue;
      roadLines.push(piece);
      ribbon(piece, width, LIFT_DRIVEWAY, drvPos, drvIdx);
    }
  }
}
if (rIdx.length) scene.add(mkMesh(rPos, rIdx, 0x2f2f33, 'Roads'));
if (drvIdx.length) scene.add(mkMesh(drvPos, drvIdx, 0x77787a, 'Driveways'));
if (drvSrcIdx.length) scene.add(mkMesh(drvSrcPos, drvSrcIdx, 0x7d7f80, 'Driveways_Mapped'));
if (parkSrcIdx.length) scene.add(mkMesh(parkSrcPos, parkSrcIdx, 0x6f7272, 'ParkingAreas_Mapped'));
if (swIdx.length) scene.add(mkMesh(swPos, swIdx, 0xb9b6ae, 'Sidewalks'));   // light concrete, road-edge derived
if (swSrcIdx.length) scene.add(mkMesh(swSrcPos, swSrcIdx, 0xc4c0b6, 'Sidewalks_Mapped'));
if (xwalkIdx.length) scene.add(mkMesh(xwalkPos, xwalkIdx, 0xd9d5ca, 'Crosswalks_Mapped'));
if (cuIdx.length) scene.add(mkMesh(cuPos, cuIdx, 0xcacaca, 'RoadCurbs'));
if (dPos.length) scene.add(mkMesh(dPos, null, 0xf2c81e, 'RoadLines'));

// creek ribbon
let creekW = null;
if (S.creek && S.creek.p) {
  creekW = S.creek.p.map(([e, n]) => w2(e, n)).filter(([x, z]) => Math.abs(x) <= cropHalf + 3 && Math.abs(z) <= cropHalf + 3);
  creekW = snapCreekToChannel(creekW, terrainAt, { radius: 18, step: 1.5, strength: 0.9, smoothPasses: 2 });
  if (creekW.length >= 2) {
    const CREEK_WIDTH = Number.isFinite(+process.env.CREEK_WIDTH_M) ? +process.env.CREEK_WIDTH_M : 6.0;
    const CREEK_DEPTH = Number.isFinite(+process.env.CREEK_DEPTH_M) ? +process.env.CREEK_DEPTH_M : 0.22;
    const cPos = [], cIdx = []; flatWaterRibbon(creekW, CREEK_WIDTH, CREEK_DEPTH, cPos, cIdx);
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
  const back = edges.reduce((a, b) => {
    const da = (a.nx * front.nx + a.nz * front.nz);
    const db = (b.nx * front.nx + b.nz * front.nz);
    return db < da ? b : a;
  }, front);
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

// ---- Doors ----------------------------------------------------------------
const houseCue = { glass: [], trim: [] };
emitOwnerHouseFacadeCues(houseRing, houseWallH, houseCue);
if (houseCue.trim.length) scene.add(mkMesh(houseCue.trim, null, 0xd8d0bd, 'House_window_trim'));
if (houseCue.glass.length) scene.add(mkMesh(houseCue.glass, null, 0x223647, 'House_windows'));

const dwPos = [], dwCol = [], garagePos = [], garageTrim = [], DOORCOL = [0.26, 0.18, 0.12];
let houseDoor = null, houseGarage = null;       // for the tree clear-zone / front fence orientation
buildingPolys.forEach((ring, bi) => {
  if (ring.length < 2) return;
  const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
  let best = null, bestD = Infinity;                       // edge whose midpoint is nearest a road
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    if (Math.hypot(bx - ax, bz - az) < 1.6) continue;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2, d = distToLines(mx, mz, roadLines, 1e9);
    if (d < bestD) { bestD = d; best = [ax, az, bx, bz]; }
  }
  if (!best) return;
  const [ax, az, bx, bz] = best;
  let ex = bx - ax, ez = bz - az; const L = Math.hypot(ex, ez) || 1; ex /= L; ez /= L;
  let nx = -ez, nz = ex;                                    // outward normal (away from centroid)
  const m0x = (ax + bx) / 2, m0z = (az + bz) / 2;
  if ((m0x - cen[0]) * nx + (m0z - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
  // The HOUSE garage is the road/NE (higher-X) end of its front wall, so put the door
  // on the SW (lower-X) half, not the middle of the garage.
  let t = 0.5;
  if (bi === 0) t = (ax > bx) ? 0.72 : 0.28;
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
    for (let p = 1; p <= 3; p++) {
      const y = gb + 0.06 + p * (2.12 / 4);
      pushWallRect(garageTrim, ax, az, ex, ez, nx, nz, gs - ghw + 0.05, gs + ghw - 0.05, y - 0.025, y + 0.025, 0.145);
    }
    pushWallRect(garageTrim, ax, az, ex, ez, nx, nz, gs - 0.025, gs + 0.025, gb + 0.12, gb + 2.08, 0.145);
  }
});
if (dwPos.length) scene.add(mkMesh(dwPos, null, new THREE.Color(...DOORCOL), 'Doors', {}));
if (garageTrim.length) scene.add(mkMesh(garageTrim, null, 0xd8d0bd, 'GarageDoor_trim'));
if (garagePos.length) scene.add(mkMesh(garagePos, null, 0x5e6266, 'GarageDoors'));

// Driveways are sourced from mapped service ways above. Do not synthesize a custom
// garage-to-road strip here; if the map has no driveway, leave it for hand editing.

// Real LiDAR-canopy trees (exports/trees.json from fetch_trees.py) if present,
// else heuristic positions along the creek + open yard.
const TREE_RADIUS = 150;   // wider tree band (still inside the terrain bounds)
const TREESJSON = path.join(ROOT, 'exports/trees.json');
let trees, treeSrc;
if (existsSync(TREESJSON)) {
  // Keep only trees that sit ON the terrain patch and OFF buildings, and clamp the noisy
  // LiDAR canopy size/height (raw heights ran to 35 m towers; ~94 points fell beyond the
  // cropped terrain and floated in mid-air). This keeps every tree on the ground and the
  // house readable instead of buried.
  const raw = JSON.parse(readFileSync(TREESJSON, 'utf8')).trees;
  const baseOK = ([x, z]) => inTerrain(x, z) && !onBuilding(x, z) && Math.hypot(x, z) <= TREE_RADIUS
    && (!houseDoor || Math.hypot(x - houseDoor[0], z - houseDoor[1]) > 5);     // keep the front door clear
  const context = [], owner = [];
  for (const t of raw) {
    if (!baseOK(t)) continue;
    (inMine(t[0], t[1]) ? owner : context).push(t);
  }
  const ownerKeep = owner
    .filter(([, , cr = 0, th = 0]) => cr >= 1.4 && th >= 5)
    .sort((a, b) => ((b[2] || 0) * (b[3] || 0)) - ((a[2] || 0) * (a[3] || 0)))
    .slice(0, 12);
  trees = context.concat(ownerKeep)
    .map(([x, z, cr, th]) => [x, z, Math.min(cr || 2.5, 5), Math.max(4, Math.min(16, th || 7))]);
  treeSrc = `LiDAR canopy 2021 (real; ${trees.length} within ${TREE_RADIUS} m, ${ownerKeep.length} on owner lots)`;
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
  // Tree POSITIONS only — real tree models (Trees.glb / Acacia.glb) are instanced as
  // separate, individually-deletable objects by scripts/place_trees.py. Frame: glTF
  // Y-up world (x=east, y=up, z=-north), house at origin; base = terrain height.
  const placed = trees.map(([x, z, cr, th], i) => ({
    i, x: +x.toFixed(2), z: +z.toFixed(2), base: +terrainAt(x, z).toFixed(2),
    canopyR: +cr.toFixed(2), height: +th.toFixed(2),
  }));
  writeFileSync(path.join(ROOT, 'exports/trees_placed.json'),
    JSON.stringify({ frame: 'gltf-y-up; x=east, y=up, z=-north; house at origin', count: placed.length, trees: placed }));
}

function addCreekArtAndShrubs() {
  if (creekW && creekW.length >= 2) {
    const creekWidth = Number.isFinite(+process.env.CREEK_WIDTH_M) ? +process.env.CREEK_WIDTH_M : 6.0;
    const bankPos = [], bankIdx = [], flowPos = [], flowIdx = [], rockPos = [], rockIdx = [], reedPos = [];
    ribbon(offsetLine(creekW, creekWidth / 2 + 0.75), 1.35, 0.18, bankPos, bankIdx);
    ribbon(offsetLine(creekW, -(creekWidth / 2 + 0.75)), 1.35, 0.18, bankPos, bankIdx);
    let phase = 0;
    for (let k = 1; k < creekW.length; k++) {
      const a = creekW[k - 1], b = creekW[k];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const seg = Math.hypot(dx, dz) || 1; dx /= seg; dz /= seg;
      const nx = -dz, nz = dx;
      for (let s = (phase % 8); s < seg; s += 9) {
        const len = Math.min(3.4, seg - s);
        if (len < 1.2) continue;
        const x0 = a[0] + dx * s + nx * 0.55, z0 = a[1] + dz * s + nz * 0.55;
        const x1 = a[0] + dx * (s + len) + nx * 0.55, z1 = a[1] + dz * (s + len) + nz * 0.55;
        const y0 = terrainAt(x0, z0) + 0.35, y1 = terrainAt(x1, z1) + 0.35, hw = 0.08;
        const off = flowPos.length / 3;
        flowPos.push(x0 + nx * hw, y0, z0 + nz * hw, x0 - nx * hw, y0, z0 - nz * hw, x1 + nx * hw, y1, z1 + nz * hw, x1 - nx * hw, y1, z1 - nz * hw);
        flowIdx.push(off, off + 2, off + 1, off + 1, off + 2, off + 3);
      }
      phase += seg;
    }
    const emitRock = (x, z) => { const o = rockPos.length / 3; rockPos.push(x, terrainAt(x, z) + 0.26, z); return o; };
    for (let k = 1; k < creekW.length; k++) {
      const a = creekW[k - 1], b = creekW[k];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const seg = Math.hypot(dx, dz) || 1; dx /= seg; dz /= seg;
      const nx = -dz, nz = dx;
      for (let s = 0; s < seg; s += 8) for (const side of [1, -1]) if (rand() < 0.38) {
        const x = a[0] + dx * s + nx * side * (creekWidth / 2 + 0.9 + rand() * 1.5);
        const z = a[1] + dz * s + nz * side * (creekWidth / 2 + 0.9 + rand() * 1.5);
        if (inTerrain(x, z, 2)) fanDisc(x, z, 0.18 + rand() * 0.42, 8, emitRock, rockIdx);
      }
      for (let s = 0; s < seg; s += 5) for (const side of [1, -1]) if (rand() < 0.55) {
        const x = a[0] + dx * s + nx * side * (creekWidth / 2 + 1.4);
        const z = a[1] + dz * s + nz * side * (creekWidth / 2 + 1.4);
        if (!inTerrain(x, z, 2)) continue;
        const y = terrainAt(x, z) + 0.18, h = 0.45 + rand() * 0.55, w = 0.035;
        reedPos.push(x - nx * w, y, z - nz * w, x + nx * w, y, z + nz * w, x + dx * 0.08, y + h, z + dz * 0.08);
      }
    }
    if (bankIdx.length) scene.add(mkMesh(bankPos, bankIdx, 0x756d58, 'Creek_Banks'));
    if (flowIdx.length) scene.add(mkMesh(flowPos, flowIdx, 0x9fd6f1, 'Creek_FlowLines'));
    if (rockIdx.length) scene.add(mkMesh(rockPos, rockIdx, 0x77786f, 'Creek_Rocks'));
    if (reedPos.length) scene.add(mkMesh(reedPos, null, 0x607a3d, 'Creek_Reeds'));
  }

  const shrubPos = [], shrubIdx = [];
  const pushShrub = (x, z, r, h) => {
    const sides = 9, base = shrubPos.length / 3, y = terrainAt(x, z) + 0.08;
    for (let k = 0; k < sides; k++) {
      const a = k / sides * Math.PI * 2;
      shrubPos.push(x + Math.cos(a) * r * (0.75 + rand() * 0.35), y, z + Math.sin(a) * r * (0.75 + rand() * 0.35));
    }
    shrubPos.push(x, y + h, z);
    const top = base + sides;
    for (let k = 0; k < sides; k++) shrubIdx.push(base + k, base + ((k + 1) % sides), top);
  };
  const shrubOK = (x, z) => inTerrain(x, z, 3) && !onBuilding(x, z) && distToLines(x, z, roadLines, 5.5) >= 5.5;
  for (let i = 0; i < 420 && shrubIdx.length / 3 < 180; i++) {
    let x, z;
    if (creekW && rand() < 0.55) {
      const seg = creekW[Math.floor(rand() * Math.max(1, creekW.length - 1))];
      x = seg[0] + (rand() - 0.5) * 22; z = seg[1] + (rand() - 0.5) * 22;
    } else {
      x = tXmin + rand() * (tXmax - tXmin); z = tZmin + rand() * (tZmax - tZmin);
    }
    if (shrubOK(x, z)) pushShrub(x, z, 0.45 + rand() * 0.75, 0.45 + rand() * 0.75);
  }
  if (shrubIdx.length) scene.add(mkMesh(shrubPos, shrubIdx, 0x4d7437, 'Shrubs'));
}
addCreekArtAndShrubs();

// ---- Game-level collision / LOD proxies ----------------------------------
function appendIndexed(srcPos, srcIdx, dstPos, dstIdx) {
  if (!srcPos.length || !srcIdx.length) return;
  const base = dstPos.length / 3;
  dstPos.push(...srcPos);
  for (const i of srcIdx) dstIdx.push(base + i);
}
function pushExtrudedRing(pos, idx, ring, base, h) {
  if (!ring || ring.length < 3) return;
  const off = pos.length / 3;
  for (const [x, z] of ring) pos.push(x, base, z);
  for (const [x, z] of ring) pos.push(x, base + h, z);
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(off + i, off + j, off + n + j, off + i, off + n + j, off + n + i);
  }
  const tris = THREE.ShapeUtils.triangulateShape(ring.map(([x, z]) => new THREE.Vector2(x, z)), []);
  for (const [a, b, c] of tris) idx.push(off + n + a, off + n + b, off + n + c);
}
function pushTreeCylinder(pos, idx, x, z, radius, height) {
  const sides = 8, base = pos.length / 3, y0 = terrainAt(x, z), y1 = y0 + height;
  for (let k = 0; k < sides; k++) {
    const a = k / sides * Math.PI * 2;
    const px = x + Math.cos(a) * radius, pz = z + Math.sin(a) * radius;
    pos.push(px, y0, pz, px, y1, pz);
  }
  for (let k = 0; k < sides; k++) {
    const j = (k + 1) % sides;
    idx.push(base + k * 2, base + j * 2, base + j * 2 + 1, base + k * 2, base + j * 2 + 1, base + k * 2 + 1);
  }
}
function addGameLevelLayers() {
  const tPos = [], tIdx = [], step = 8;
  const xs = [], zs = [];
  for (let x = tXmin; x <= tXmax + 0.01; x += step) xs.push(Math.min(x, tXmax));
  for (let z = tZmin; z <= tZmax + 0.01; z += step) zs.push(Math.min(z, tZmax));
  for (const z of zs) for (const x of xs) tPos.push(x, terrainAt(x, z), z);
  for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) {
    const a = j * xs.length + i, b = a + 1, c = a + xs.length, d = c + 1;
    tIdx.push(a, c, b, b, c, d);
  }
  if (tIdx.length) scene.add(mkMesh(tPos, tIdx, 0xff00ff, 'Collision_Terrain', { opacity: 0 }));

  const roadColPos = [], roadColIdx = [];
  for (const [p, ix] of [[rPos, rIdx], [drvPos, drvIdx], [drvSrcPos, drvSrcIdx], [parkSrcPos, parkSrcIdx], [swPos, swIdx], [swSrcPos, swSrcIdx], [xwalkPos, xwalkIdx]]) appendIndexed(p, ix, roadColPos, roadColIdx);
  if (roadColIdx.length) scene.add(mkMesh(roadColPos, roadColIdx, 0x00ffff, 'Collision_Roads', { opacity: 0 }));

  const bPos = [], bIdx = [];
  for (const b of buildingCollision) pushExtrudedRing(bPos, bIdx, b.ring, b.base, b.h);
  if (bIdx.length) {
    scene.add(mkMesh(bPos, bIdx, 0xff00ff, 'Collision_Buildings', { opacity: 0 }));
    scene.add(mkMesh(bPos, bIdx, 0x808080, 'LOD_Buildings_Low', { opacity: 0 }));
  }

  const trPos = [], trIdx = [];
  for (const [x, z, cr = 2.5, th = 7] of trees) pushTreeCylinder(trPos, trIdx, x, z, Math.max(0.28, Math.min(0.55, cr * 0.16)), Math.max(2.2, Math.min(4.2, th * 0.38)));
  if (trIdx.length) scene.add(mkMesh(trPos, trIdx, 0x00ff00, 'Collision_Trees', { opacity: 0 }));
}
addGameLevelLayers();

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
  // property lines HIDDEN by default (set SHOW_LOTLINES=true to bring them back)
  const SHOW_LOTLINES = false;
  if (SHOW_LOTLINES && lIdx.length) scene.add(mkMesh(lPos, lIdx, 0xe8e2d0, 'LotLines'));
  if (SHOW_LOTLINES && yIdx.length) scene.add(mkMesh(yPos, yIdx, 0xffcf33, 'YourLots'));
}

// ---- ANIMATED grass-blade clumps (looping glTF node animation) -----------
// Shared with export_stylized_glb.mjs via scripts/grass_wind.mjs: a `Grass_Wind`
// group of `GrassClump_####` nodes with a looping "GrassWind" sway clip. Added
// LAST so it only appends to the RNG stream and leaves every placement above
// byte-identical; the green vertex-coloured tufts sit over the aerial terrain.
const { buildGrassWind } = await import('./grass_wind.mjs');
const grass = buildGrassWind({
  THREE, scene, rand, terrainAt, cropHalf,
  openGround: (x, z) => inPatch(x, z) && !onBuilding(x, z) && distToLines(x, z, roadLines, 5.5) >= 5.5,
});
const animations = grass.clip ? [grass.clip] : [];
console.log(`grass clumps (animated nodes): ${grass.count}   wind clip: ${animations.length ? 'GrassWind (3s loop)' : 'none'}`);

// ---- export GLB, then embed photo textures via gltf-transform -------------
// (GLTFExporter can't encode images in Node — gltf-transform attaches the JPEG/
//  PNG bytes directly.) aerial -> Terrain + all roofs; facade -> all walls.
const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false, animations });
mkdirSync(path.join(ROOT, 'exports'), { recursive: true });
const out = path.join(ROOT, 'exports', '1840-dahill-property.glb');

const { NodeIO } = await import('@gltf-transform/core');
const io = new NodeIO();
const doc = await io.readBinary(new Uint8Array(glb));
const gAerialJpg = path.join(ROOT, 'exports/google_aerial.jpg');
const aerialP = existsSync(gAerialJpg) ? gAerialJpg : path.join(ROOT, 'src/assets/aerial_opt.jpg');
const facadeP = path.join(ROOT, 'exports/facade.png');
const aerialTex = existsSync(aerialP) ? doc.createTexture('aerial').setImage(new Uint8Array(readFileSync(aerialP))).setMimeType('image/jpeg') : null;
const facadeTex = existsSync(facadeP) ? doc.createTexture('facade').setImage(new Uint8Array(readFileSync(facadeP))).setMimeType('image/png') : null;
const REPEAT = 10497, CLAMP = 33071;
let textured = 0;
for (const m of doc.getRoot().listMaterials()) {
  const n = m.getName() || '';
  if (aerialTex && /terrain|roofs_photo/i.test(n)) {
    m.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(aerialTex);
    m.getBaseColorTextureInfo().setWrapS(CLAMP).setWrapT(CLAMP); textured++;
  } else if (facadeTex && /walls/i.test(n)) {
    // KEEP each wall's per-building base colour (the SV colour set in three) and just
    // multiply the window texture over it -> wall = SV colour x windows, in every viewer.
    m.setBaseColorTexture(facadeTex);
    m.getBaseColorTextureInfo().setWrapS(REPEAT).setWrapT(REPEAT); textured++;
  } else if (svFacadeTextures.has(n)) {
    const tex = doc.createTexture(n + '_tex').setImage(new Uint8Array(readFileSync(svFacadeTextures.get(n)))).setMimeType('image/jpeg');
    m.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(tex);
    m.getBaseColorTextureInfo().setWrapS(CLAMP).setWrapT(CLAMP); textured++;
  }
}
writeFileSync(out, Buffer.from(await io.writeBinary(doc)));

const objs = [];
scene.traverse(o => { if (o.isMesh) objs.push(`  ${o.name.padEnd(18)} ${o.geometry.attributes.position.count} verts`); });
console.log(`terrain: ${terrSrc}`);
console.log(`crop half: ${cropHalf.toFixed(0)} m   buildings: ${nBld} (${nSkip} skipped on owner lots)   trees: ${trees.length} (${treeSrc})`);
console.log('layers:\n' + objs.join('\n'));
console.log(`street-view facade overlays: ${nSVFacades}`);
console.log(`textured materials: ${textured} (aerial->terrain/roofs, facade->walls)`);
console.log(`wrote ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
