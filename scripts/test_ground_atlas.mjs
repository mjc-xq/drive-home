// scratch test: bake the dahill ground atlas and report. (deleted after use)
import { readFileSync } from 'node:fs';
import { buildRoadNetwork } from './lib/road_network.mjs';
import { curbLinesFromRoads } from './road_prep.mjs';
import { loadDEM, makeGeo } from './lib/terrain_mesh.mjs';
import { bakeGroundAtlas } from './lib/ground_atlas.mjs';
import sharp from 'sharp';

const ROOT = new URL('..', import.meta.url).pathname;
const S = JSON.parse(readFileSync(ROOT + 'src/assets/scene.json', 'utf8'));
const MS = JSON.parse(readFileSync(ROOT + 'exports/map_surfaces_osm.json', 'utf8'));
const AB = JSON.parse(readFileSync(ROOT + 'exports/google_aerial.json', 'utf8'));
const C = S.center, LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * Math.PI / 180);
const w2 = (e, n) => [e - C[0], -(n - C[1])];
const env = { w2, clipHalf: 596 };

const t0 = Date.now();
const network = buildRoadNetwork(S, MS, env);
const curbLines = curbLinesFromRoads(S.roads, w2, { clipHalf: 596 });
console.log('network ms', Date.now() - t0, 'surfaces', network.surfaces.length, 'paint', network.paint.length, 'curbLines', curbLines.length);

const D = loadDEM(ROOT + 'exports/dem_1m.json');
const geo = makeGeo(D, { C, LAT0, LON0, COSLAT });

const t1 = Date.now();
const res = await bakeGroundAtlas({
  aerialPath: ROOT + 'exports/google_aerial.jpg', aerialBounds: AB, C, demRect: geo.demRect,
  texCoreHalf: 300, network, curbLines, outDir: '/tmp/_ground_test', coreSize: 4096, farSize: 2048,
});
console.log('bake ms', Date.now() - t1);
console.log('outputs', JSON.stringify(res.core), res.far, 'pavedPolys', res.pavedPolys.length);

// downscale core albedo + a tight crop near the house (origin) for inspection
await sharp(res.core.albedo).resize(1100, 1100).toFile('/tmp/core_albedo_small.png');
// origin = texel (2048,2048) of 4096; crop 1400px around it -> the house block
await sharp(res.core.albedo).extract({ left: 1348, top: 1348, width: 1400, height: 1400 }).resize(1000, 1000).toFile('/tmp/core_albedo_house.png');
await sharp(res.core.orm).resize(800, 800).toFile('/tmp/core_orm_small.png');
console.log('wrote /tmp/core_albedo_small.png /tmp/core_albedo_house.png /tmp/core_orm_small.png');
