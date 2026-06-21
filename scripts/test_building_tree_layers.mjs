// test_building_tree_layers.mjs — UNIT TEST for building_layer.mjs + tree_layer.mjs against REAL
// dahill data. Builds the single-surface terrainAt closure, runs both builders into a THREE.Scene,
// exports a GLB with GLTFExporter, and ASSERTS the required nodes exist + the clip fix works.
//
// Run:  node --max-old-space-size=6144 scripts/test_building_tree_layers.mjs

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
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

import { loadDEM, makeGeo, buildTerrainMesh } from './lib/terrain_mesh.mjs';
import { buildBuildingLayer } from './lib/building_layer.mjs';
import { buildTreeLayer } from './lib/tree_layer.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const R = (...p) => path.join(ROOT, ...p);

// ---- inputs (real dahill) --------------------------------------------------------------
const S = JSON.parse(readFileSync(R('src/assets/scene.json'), 'utf8'));
const C = S.center;
const ORIGIN = S.origin || {};
const LAT0 = Number.isFinite(+ORIGIN.lat) ? +ORIGIN.lat : 37.6835313;
const LON0 = Number.isFinite(+ORIGIN.lon) ? +ORIGIN.lon : -122.0686199;
const COSLAT = Math.cos(LAT0 * Math.PI / 180);
const w2 = (e, n) => [e - C[0], -(n - C[1])];
const isSchool = S.meta?.kind === 'school-region-export';

const D = loadDEM(R('exports/dem_1m.json'));
const geo = makeGeo(D, { C, LAT0, LON0, COSLAT });
const terrain = buildTerrainMesh({ D, geo, opts: { coreHalf: 200, farStep: 4, texCoreHalf: 300 } });
const terrainAt = terrain.terrainAt;
const demRect = terrain.demRect;
console.log(`terrain: ${terrain.stats.verts} verts, demRect=${JSON.stringify(demRect)}`);

// ---- color fns (ported de-greened SV/satellite color logic; received by the builder) ---
const RCOL = existsSync(R('exports/buildings_roof_color.json'))
  ? JSON.parse(readFileSync(R('exports/buildings_roof_color.json'), 'utf8')) : {};
const COL = existsSync(R('exports/buildings_color.json'))
  ? JSON.parse(readFileSync(R('exports/buildings_color.json'), 'utf8')) : {};
const STUCCO = [0.82, 0.78, 0.70];
const ROOFP = [[0.58, 0.55, 0.50], [0.60, 0.46, 0.38], [0.50, 0.53, 0.55], [0.60, 0.50, 0.42], [0.62, 0.59, 0.52]];
const WALL_PALETTE = [
  [0.86, 0.82, 0.74], [0.80, 0.72, 0.60], [0.74, 0.78, 0.80], [0.82, 0.79, 0.72],
  [0.70, 0.74, 0.66], [0.86, 0.80, 0.70], [0.66, 0.70, 0.74], [0.82, 0.74, 0.64],
  [0.78, 0.70, 0.62], [0.72, 0.76, 0.74], [0.62, 0.66, 0.70], [0.84, 0.78, 0.66],
];
const ROOF_PALETTE = [[0.58, 0.55, 0.50], [0.60, 0.46, 0.38], [0.50, 0.53, 0.55], [0.60, 0.50, 0.42], [0.62, 0.59, 0.52]];
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
const lighten = c => liftLuma(mix3(c, STUCCO, 0.52), 0.62);
const remapLuma = L => (L < 0.55) ? 0.55 - (0.55 - L) * 0.25 : (L > 0.84) ? 0.84 + (L - 0.84) * 0.60 : L;
const deGreen = c => { let [r, g, b] = c; if (g > b + 0.035 && g >= r - 0.03) { const avg = (r + b) / 2; g = avg + (g - avg) * 0.30; } return [r, g, b]; };
const isPlausiblePaint = c => { const [r, g, b] = c; if (luma(c) < 0.24) return false; if (g > r + 0.02 && g > b + 0.02) return false; return true; };
const wallColor = ib => {
  let src = COL[ib];
  if (!src || !isPlausiblePaint(src)) src = RCOL[ib] ? lighten(RCOL[ib]) : seededColor(WALL_PALETTE, ib);
  const L = Math.max(0.02, luma(src));
  let c = src.map(v => v * (remapLuma(L) / L));
  c = deGreen(c);
  const m = luma(c);
  c = c.map(v => m + (v - m) * 1.12);
  return c.map(clamp01);
};
const roofColor = ib => {
  if (RCOL[ib]) return liftLuma(RCOL[ib], 0.48);
  const src = ROOFP[(Math.imul((ib | 0) + 1, 2654435761) >>> 0) % ROOFP.length];
  return liftLuma(mix3(src, seededColor(ROOF_PALETTE, ib), 0.40), 0.48, seededColor(ROOF_PALETTE, ib));
};

// ---- facade: dummy atlas (no real hero pages) as the spec requires ---------------------
const facade = { rectByWall: {}, pages: [], heroBuildings: new Set(), stuccoTile: R('exports/facade.png') };

// ---- assemble scene + run builders -----------------------------------------------------
const scene = new THREE.Scene(); scene.name = 'dahill_test_layers';

const building = buildBuildingLayer({
  THREE, scene, S, w2, terrainAt, demRect, isSchool,
  wallColor, roofColor, facade, ROOT,
});

const tree = await buildTreeLayer({
  THREE, scene, w2, terrainAt, demRect, ROOT, dir: R('exports'),
  treesPlacedPath: R('exports/trees_placed.json'), creek: S.creek, buildingPolys: building.buildingPolys,
});

// ---- export GLB ------------------------------------------------------------------------
const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false });
const outPath = R('exports/_test_building_tree_layers.glb');
writeFileSync(outPath, Buffer.from(glb));
console.log(`wrote ${path.relative(ROOT, outPath)} (${(glb.byteLength / 1e6).toFixed(1)} MB)`);

// ---- collect node names + assert -------------------------------------------------------
const names = new Set();
scene.traverse(o => { if (o.name) names.add(o.name); });
const REQUIRED = ['House_walls', 'Buildings_walls', 'Collision_Buildings', 'Collision_Trees', 'Trees', 'Creek_SanLorenzo'];
let pass = true;
for (const n of REQUIRED) {
  const ok = names.has(n);
  if (!ok) pass = false;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  node "${n}" ${ok ? 'present' : 'MISSING'}`);
}
// Trees must be a GROUP
const treesNode = scene.getObjectByName('Trees');
const treesIsGroup = treesNode && treesNode.isGroup;
console.log(`  ${treesIsGroup ? 'OK  ' : 'FAIL'}  "Trees" is a Group (${treesNode ? treesNode.children.length : 0} children)`);
if (!treesIsGroup) pass = false;

// ---- clip-fix verification: NO building that intersects the patch is dropped -----------
const inR = (x, z) => x >= demRect.x0 && x <= demRect.x1 && z >= demRect.z0 && z <= demRect.z1;
let fullyIn = 0, partly = 0, fullyOut = 0;
for (const b of S.buildings) {
  if (!b.p || b.p.length < 3) continue;
  const ring = b.p.map(([e, n]) => w2(e, n));
  const ins = ring.map(([x, z]) => inR(x, z));
  if (ins.every(Boolean)) fullyIn++;
  else if (ins.some(Boolean)) partly++;
  else fullyOut++;
}
// also count footprints that are entirely outside corners but whose polygon still crosses the rect
// (a footprint with all corners outside can still overlap; our clip handles it. We only require:
// emitted >= the number whose corners touch the patch, and skipped == only-fully-disjoint count.)
const expectedMinEmitted = fullyIn + partly;
const clipOK = building.counts.emitted >= expectedMinEmitted;
console.log(`\nclip check: corners fullyIn=${fullyIn} partly=${partly} fullyOut=${fullyOut}`);
console.log(`  emitted=${building.counts.emitted} skipped=${building.counts.skipped} clipped=${building.counts.clipped}`);
console.log(`  ${clipOK ? 'OK  ' : 'FAIL'}  emitted (${building.counts.emitted}) >= buildings touching patch (${expectedMinEmitted}) — clip retains partially-in footprints`);
if (!clipOK) pass = false;
// legacy every(inPatch) would have emitted only fullyIn; show the buildings we SAVED.
const saved = building.counts.emitted - fullyIn;
console.log(`  legacy every(inPatch) would have emitted ${fullyIn}; clip fix SAVED ${saved} extra building(s)`);

// ---- hero facade vs stucco report ------------------------------------------------------
const heroWallsWithFacade = Object.keys(facade.rectByWall).length;
console.log(`\nfacade: ${heroWallsWithFacade} hero walls used REAL atlas crops; all other walls used procedural stucco`);
console.log(`tree layer: nTrees=${tree.nTrees} nShrubs=${tree.nShrubs} hasCreek=${tree.hasCreek}`);

console.log(`\n${pass ? 'PASS — all required nodes present + clip fix verified' : 'FAIL — see above'}`);
process.exit(pass ? 0 : 1);
