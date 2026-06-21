// test_surface_annotation.mjs — unit test for surface_annotation.mjs against REAL data.
// Runs the annotator over the actual aerial/scene/parcels/trees and asserts the contract.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { buildSurfaceAnnotation, CLASS_LEGEND } from './lib/surface_annotation.mjs';

const j = async (p) => JSON.parse(await readFile(new URL(p, import.meta.url)));
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };

const root = '../';                                   // scripts/ -> repo root
const scene = await j(root + 'src/assets/scene.json');
const aerialBounds = await j(root + 'exports/google_aerial.json');
const parcelsDoc = await j(root + 'exports/parcels.json');
const treesDoc = await j(root + 'exports/trees_placed.json');

const C = scene.center;                               // [20.91,35.17]
const w2 = (e, n) => [e - C[0], -(n - C[1])];         // matches export_property_glb.mjs
const demRect = { x0: -600, x1: 600, z0: -600, z1: 600 };

// buildingFootprintsWorld from scene.json buildings via w2 (pavedPolys=[] per the test spec).
const buildingFootprintsWorld = scene.buildings
  .filter((b) => Array.isArray(b.p) && b.p.length >= 3)
  .map((b) => b.p.map(([e, n]) => w2(e, n)));

const t0 = Date.now();
const res = await buildSurfaceAnnotation({
  aerialPath: new URL(root + 'exports/google_aerial.jpg', import.meta.url).pathname,
  aerialBounds,
  C,
  demRect,
  rasterSize: 1024,
  pavedPolys: [],
  buildingFootprintsWorld,
  parcels: parcelsDoc.parcels,
  treesPlaced: treesDoc.trees,
  outDir: '/tmp/_veg_test/_ground/',
  level: 'level',
});
console.log(`built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// --- assertions -----------------------------------------------------------
const N = 1024;
assert(existsSync(res.classRasterPath), `class raster written: ${res.classRasterPath}`);
const meta = await sharp(res.classRasterPath).metadata();
assert(meta.width === N && meta.height === N, `class raster is ${N}² (got ${meta.width}×${meta.height})`);
assert(meta.channels === 1, `class raster is 1-channel/paletted (got channels=${meta.channels}, space=${meta.space})`);

assert(existsSync(res.vegetationJsonPath), `vegetation.json written: ${res.vegetationJsonPath}`);
const veg = JSON.parse(await readFile(res.vegetationJsonPath, 'utf8'));   // throws if unparseable
assert(veg.classRaster === 'level.surface_class.png', 'vegetation.json references class raster');
assert(veg.frame.rasterSize === N, 'vegetation.json frame.rasterSize');
assert(Array.isArray(veg.fencePaths) && veg.fencePaths.length > 0, `fencePaths non-empty (got ${veg.fencePaths.length})`);
assert(veg.fencePaths[0].ring && veg.fencePaths[0].ring.length >= 2, 'fence path has a ring');
assert(veg.trees.count === treesDoc.trees.length, 'trees.count matches source');

const total = Object.values(res.counts).reduce((a, b) => a + b, 0);
assert(total === N * N, `counts sum to ${N}² (got ${total})`);
assert(res.counts[3] > 0, `grass coverage > 0 (got ${res.counts[3]})`);

// --- report ---------------------------------------------------------------
console.log('\nPer-class coverage:');
for (const [id, name] of Object.entries(CLASS_LEGEND)) {
  const n = res.counts[id] || 0, pct = (100 * n / total).toFixed(2);
  console.log(`  ${id} ${name.padEnd(12)} ${pct.padStart(6)}%  (${n})`);
}
console.log('\nALL ASSERTIONS PASSED');
