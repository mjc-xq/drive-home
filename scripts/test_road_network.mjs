// Unit test for scripts/lib/road_network.mjs — load real scene + map_surfaces, run
// buildRoadNetwork, assert the output schema + the hard mandate (rounded corners at every
// real intersection), print counts. Run: node scripts/test_road_network.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoadNetwork } from './lib/road_network.mjs';
import { buildRoadJunctions, roadSpec } from './road_prep.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scene = JSON.parse(readFileSync(path.join(ROOT, 'src/assets/scene.json'), 'utf8'));
const mapSurfaces = JSON.parse(readFileSync(path.join(ROOT, 'exports/map_surfaces_osm.json'), 'utf8'));

const C = scene.center;
const w2 = (e, n) => [e - C[0], -(n - C[1])];
const clipHalf = 596;
const env = { w2, clipHalf, terrainAt: null, inTerrain: (x, z) => Math.abs(x) <= clipHalf && Math.abs(z) <= clipHalf };

const net = buildRoadNetwork(scene, mapSurfaces, env);

let failed = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL:', msg); failed++; } else console.log('  ok  :', msg); };

// ---- coordinate sanity: gather every coordinate the output emits ----
const coords = [];
const pushRing = (r) => { for (const p of r) coords.push(p); };
for (const s of net.surfaces) {
  if (s.centerline) pushRing(s.centerline);
  if (s.polygon) pushRing(s.polygon);
  if (s.holes) for (const h of s.holes) pushRing(h);
}
for (const p of net.paint) {
  if (p.lines) for (const l of p.lines) pushRing(l);
  if (p.rings) for (const r of p.rings) pushRing(r);
}
for (const c of net.curbLines) pushRing(c.line);

const noBad = coords.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
const inBox = coords.every(p => p[0] >= -601 && p[0] <= 601 && p[1] >= -601 && p[1] <= 601);

console.log('\n== assertions ==');
ok(net.surfaces.length > 0, `surfaces.length>0 (${net.surfaces.length})`);
ok(noBad, 'no NaN/Infinity in any coordinate');
ok(inBox, 'all coords within [-601,601]');
ok(net.curbLines.length > 0, `curbLines.length>0 (${net.curbLines.length})`);

const paintKinds = new Set(net.paint.map(p => p.kind));
ok(paintKinds.has('crosswalk-stripe'), 'paint includes crosswalk-stripe');
ok(paintKinds.has('double-yellow') || paintKinds.has('lane-dash') || paintKinds.has('edge-line'), 'paint includes lane marks');

// ---- hard mandate: every real junction with >=2 non-service arms produced a sidewalk
//      corner near it ----
const junctions = buildRoadJunctions(scene.roads || [], w2, { includeService: true });
const swPolys = net.surfaces.filter(s => s.kind === 'concrete-sidewalk' && s.polygon);
const cornerCentroid = (poly) => {
  let x = 0, z = 0; for (const p of poly) { x += p[0]; z += p[1]; } return [x / poly.length, z / poly.length];
};
const swCentroids = swPolys.map(s => cornerCentroid(s.polygon));
// scope to IN-BOX junctions: off-map corners are correctly clipped away by the DEM rect.
let multiArm = 0, withCorner = 0;
for (const j of junctions) {
  const nonService = j.arms.filter(a => !a.spec.isService);
  if (nonService.length < 2) continue;
  if (Math.abs(j.x) > clipHalf || Math.abs(j.z) > clipHalf) continue;
  multiArm++;
  const near = swCentroids.some(c => Math.hypot(c[0] - j.x, c[1] - j.z) < 18);
  if (near) withCorner++;
}
ok(multiArm > 0, `found ${multiArm} in-box real junctions with >=2 non-service arms`);
ok(withCorner === multiArm, `every in-box multi-arm junction has a sidewalk corner near it (${withCorner}/${multiArm})`);

// ---- counts ----
const count = (k, key = 'kind') => net.surfaces.filter(s => s[key] === k).length;
console.log('\n== counts ==');
console.log('  asphalt surfaces   :', count('asphalt'));
console.log('  driveway surfaces  :', count('driveway'));
console.log('  sidewalk polygons  :', swPolys.length);
console.log('  curb surfaces      :', count('curb'));
console.log('  curbLines          :', net.curbLines.length);
console.log('  crosswalk surfaces :', count('crosswalk'));
const stopBars = net.paint.find(p => p.kind === 'stop-bar');
const xwalkStripe = net.paint.find(p => p.kind === 'crosswalk-stripe');
console.log('  stop bars          :', stopBars ? stopBars.rings.length : 0);
console.log('  crosswalk stripes  :', xwalkStripe ? xwalkStripe.rings.length : 0);
console.log('  paint kinds        :', [...paintKinds].join(', '));
console.log('  meta.zOrder        :', net.meta.zOrder.join(' < '));

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
