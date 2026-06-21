// export_property_single_surface.mjs — the SKUNKWORKS rethought exporter.
//
// Produces ONE welded terrain whose surface, collision, and foot-placement coincide by
// construction, with roads/sidewalks/curbs/crosswalks/lane-paint PAINTED into the terrain's
// own ground textures (no stacked floating ribbons -> z-fighting is structurally impossible).
// Houses sit on that surface with Street-View facades projected INTO their wall UVs; trees are
// their own layer; a side-channel surface-class raster annotates grass/dirt/bush for later Unity
// foliage. Behind its own filename so the legacy pipeline is untouched.
//
// Run:  node --max-old-space-size=6144 scripts/export_property_single_surface.mjs [level]
//   level (dahill default) selects the input set; output -> exports/<slug>-single.glb (+ sidecars)

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
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
const { NodeIO } = await import('@gltf-transform/core');

import { loadDEM, makeGeo, buildTerrainMesh } from './lib/terrain_mesh.mjs';
import { buildRoadNetwork } from './lib/road_network.mjs';
import { curbLinesFromRoads } from './road_prep.mjs';
import { bakeGroundAtlas } from './lib/ground_atlas.mjs';
import { buildSurfaceAnnotation } from './lib/surface_annotation.mjs';
import { bakeFacadeAtlas } from './lib/facade_atlas.mjs';
import { makeBuildingColor } from './lib/building_color.mjs';
import { buildBuildingLayer } from './lib/building_layer.mjs';
import { buildTreeLayer } from './lib/tree_layer.mjs';
import { fillMissingBuildings } from './lib/fill_missing.mjs';
import sharp from 'sharp';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const R = (...p) => path.join(ROOT, ...p);
const LEVEL = process.argv[2] || 'dahill';

// input set per level (dahill = working scene at root; others = exports/<dir>/ sidecars)
const SETS = {
  dahill:  { scene: 'src/assets/scene.json', dir: 'exports',                     slug: 'dahill' },
  canyon:  { scene: 'exports/canyon-middle-school/scene.json', dir: 'exports/canyon-middle-school', slug: 'canyon' },
  stanton: { scene: 'exports/stanton-elementary/scene.json', dir: 'exports/stanton-elementary', slug: 'stanton' },
  meemaw:  { scene: 'exports/meemaw/scene.json', dir: 'exports/meemaw', slug: 'meemaw' },
  xq:      { scene: 'exports/xq/scene.json', dir: 'exports/xq', slug: 'xq' },
};
const SET = SETS[LEVEL] || SETS.dahill;
const pick = (name) => existsSync(R(SET.dir, name)) ? R(SET.dir, name) : R('exports', name);

const S = JSON.parse(readFileSync(R(SET.scene), 'utf8'));
const C = S.center;
const ORIGIN = S.origin || {};
const LAT0 = Number.isFinite(+ORIGIN.lat) ? +ORIGIN.lat : 37.6835313;
const LON0 = Number.isFinite(+ORIGIN.lon) ? +ORIGIN.lon : -122.0686199;
const COSLAT = Math.cos(LAT0 * Math.PI / 180);
const w2 = (e, n) => [e - C[0], -(n - C[1])];

const MS = existsSync(pick('map_surfaces_osm.json')) ? JSON.parse(readFileSync(pick('map_surfaces_osm.json'), 'utf8')) : {};
const AB = JSON.parse(readFileSync(pick('google_aerial.json'), 'utf8'));
const aerialPath = pick('google_aerial.jpg');

console.log(`\n=== single-surface export: ${SET.slug} ===`);
console.log(`scene: ${SET.scene}  buildings=${(S.buildings || []).length} roads=${(S.roads || []).length}`);

// ---- 1) terrain (the ONE welded surface) -------------------------------------------
const D = loadDEM(pick('dem_1m.json'));
const geo = makeGeo(D, { C, LAT0, LON0, COSLAT });
// ONE ground texture region over the whole DEM rect (texCoreHalf covers the full patch) so there
// is NO core/far texture boundary — the visible white seam at ±300 m is gone by construction.
// The mesh stays adaptive (1 m core + 4 m far) but samples a single texture/material.
const terrain = buildTerrainMesh({ D, geo, opts: { uniformStep: 2, texCoreHalf: 600 } });
const terrainAt = terrain.terrainAt;
console.log(`terrain: ${terrain.stats.verts} verts, ${terrain.stats.tris} tris ` +
  `(core ${terrain.stats.coreTris}, far ${terrain.stats.farTris}), Y[${terrain.stats.minY.toFixed(1)}..${terrain.stats.maxY.toFixed(1)}]`);

// ---- 2) road + sidewalk network + inferred paint -----------------------------------
// clip the road network + curbs to the REAL terrain extent (per level), not a fixed ±596 — else
// roads/sidewalks are generated far beyond the smaller school/xq terrains (B1).
const _dr = terrain.demRect;
const clipHalf = Math.max(Math.abs(_dr.x0), Math.abs(_dr.x1), Math.abs(_dr.z0), Math.abs(_dr.z1));
const network = buildRoadNetwork(S, MS, { w2, clipHalf, demRect: _dr });
const curbLines = curbLinesFromRoads(S.roads || [], w2, { clipHalf });
console.log(`network: ${network.surfaces.length} surfaces, ${network.paint.length} paint groups, ${curbLines.length} curb lines`);

// ---- 3) bake ground textures (de-roaded aerial bed + painted features) -------------
const groundDir = R(SET.dir === 'exports' ? 'exports/_ground' : path.join(SET.dir, '_ground'));
const ground = await bakeGroundAtlas({
  aerialPath, aerialBounds: AB, C, demRect: terrain.demRect, texCoreHalf: terrain.texCoreHalf,
  network, curbLines, outDir: groundDir, coreSize: 6144, farSize: 2048,
});
console.log(`ground: core=${path.basename(ground.core.albedo)} far=${path.basename(ground.far.albedo)} pavedPolys=${ground.pavedPolys.length}`);

// ---- 4) assemble THREE scene -------------------------------------------------------
const scene = new THREE.Scene(); scene.name = `${SET.slug}_single_surface`;

function meshFromPrim(prim, name, matName) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(prim.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(prim.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(prim.uv, 2));
  g.setAttribute('tangent', new THREE.Float32BufferAttribute(prim.tan, 4));
  g.setIndex(prim.idx);
  const m = new THREE.MeshStandardMaterial({ name: matName, color: 0xffffff, roughness: 0.95, metalness: 0 });
  m.side = THREE.FrontSide;
  const mesh = new THREE.Mesh(g, m); mesh.name = name; return mesh;
}
// Terrain: core (crisp painted ground) + far (coarse aerial backdrop). Both start with 'Terrain'
// so the runtime classifies them; disjoint opaque triangle sets -> one surface, no z-fight.
scene.add(meshFromPrim(terrain.corePrim, 'Terrain', 'TerrainCore_mat'));
// far prim is empty when texCoreHalf covers the whole patch (single texture region) — only add it
// if it actually has triangles, so there is one terrain material and no ±300 m seam.
if (terrain.farPrim.idx.length) scene.add(meshFromPrim(terrain.farPrim, 'Terrain_far', 'TerrainFar_mat'));

// ---- 4b) houses + trees + creek (the eye-level vertical structure) ------------------
const houseIndex = (S.buildings || []).findIndex((b) => b.house);
const svFacadesPath = pick('sv_facades.json');
const svWalls = existsSync(svFacadesPath) ? (JSON.parse(readFileSync(svFacadesPath, 'utf8')).walls || []) : [];
const facadeDir = SET.dir === 'exports' ? R('exports/_facades') : R(SET.dir, '_facades');
const facade = svWalls.length
  ? await bakeFacadeAtlas({ buildings: S.buildings, svWalls, svDir: R(SET.dir), houseIndex, demRect: terrain.demRect, w2, outDir: facadeDir })
  : { pages: [], rectByWall: {}, heroBuildings: [], stuccoTile: R('exports/facade.png') };
console.log(`facade: ${facade.pages.length} atlas page(s), ${Object.keys(facade.rectByWall).length} hero walls (toggleable photo overlay; windowed stucco underneath)`);

// ---- 4a-bis) FILL MISSING BUILDINGS: lots that have a real house in the aerial (and/or Mapbox)
// but none in our OSM/Overture scene.buildings. Inferred footprints flow through the existing
// massing/seating/collision path below unchanged (they are scene-building shaped). ------------
const fillParcels = existsSync(pick('parcels.json')) ? (JSON.parse(readFileSync(pick('parcels.json'), 'utf8')).parcels || []) : [];
const fillEnv = (() => {                                  // read .env.local (Vite-style) for the Mapbox token
  const f = R('.env.local'); const o = {};
  if (existsSync(f)) for (const ln of readFileSync(f, 'utf8').split('\n')) {
    const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return o;
})();
const filled = await fillMissingBuildings({
  S, parcels: fillParcels, aerialPath, aerialBounds: AB, C, demRect: terrain.demRect, w2, env: fillEnv,
}).catch(e => { console.warn('  ! fill-missing skipped:', e.message); return null; });
if (filled) { S.buildings = filled.buildings; console.log(`fill-missing: +${filled.added} buildings (${filled.notes})`); }

// CREEK-CHANNEL EXCLUSION: no building belongs in the creekbed. Drop any footprint whose centroid
// sits within the creek channel (CREEK_KEEPOUT m of the snapped centreline) — removes both stray
// OSM footprints and over-eager aerial-inferred lots that landed in the ravine/vegetation.
if (S.creek && Array.isArray(S.creek.p) && S.creek.p.length > 1) {
  const cw = S.creek.p.map(([e, n]) => w2(e, n));
  const segD = (X, Z) => {
    let best = Infinity;
    for (let i = 1; i < cw.length; i++) {
      const a = cw[i - 1], b = cw[i]; let dx = b[0] - a[0], dz = b[1] - a[1]; const l2 = dx * dx + dz * dz || 1;
      let t = ((X - a[0]) * dx + (Z - a[1]) * dz) / l2; t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(X - (a[0] + t * dx), Z - (a[1] + t * dz)));
    }
    return best;
  };
  const CREEK_KEEPOUT = 6.0;   // ~ creek half-width (3.75 m) + bank margin
  const before = S.buildings.length;
  S.buildings = S.buildings.filter((b) => {
    if (!b.p || b.p.length < 3) return true;
    const cen = b.p.reduce((a, p) => [a[0] + p[0] / b.p.length, a[1] + p[1] / b.p.length], [0, 0]);
    const [X, Z] = w2(cen[0], cen[1]);
    return segD(X, Z) > CREEK_KEEPOUT;
  });
  if (before - S.buildings.length) console.log(`creek exclusion: dropped ${before - S.buildings.length} building(s) in the creek channel`);
}

const { wallColor, roofColor } = makeBuildingColor(pick);
const isSchool = S.meta?.kind === 'school-region-export';
const bres = buildBuildingLayer({ THREE, scene, S, w2, terrainAt, demRect: terrain.demRect, isSchool, wallColor, roofColor, facade, ROOT,
  roadLines: network.surfaces.filter(s => s.kind === 'asphalt' && s.centerline).map(s => s.centerline) });
console.log(`buildings: emitted=${bres.counts.emitted} skipped=${bres.counts.skipped} clipped=${bres.counts.clipped} (drop ${(100 * bres.counts.skipped / Math.max(1, bres.counts.emitted + bres.counts.skipped)).toFixed(1)}%)`);

const tres = await buildTreeLayer({ THREE, scene, w2, terrainAt, demRect: terrain.demRect, ROOT, dir: SET.dir, treesPlacedPath: pick('trees_placed.json'), creek: S.creek, buildingPolys: bres.buildingPolys });
console.log(`trees: ${tres.nTrees} (own 'Trees' layer), shrubs: ${tres.nShrubs}, creek: ${tres.hasCreek}`);

// ---- collision proxies (invisible; runtime bakes a trimesh + hides these) -----------
function proxyMesh(pos, idx, name) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (idx) g.setIndex(idx);
  g.computeVertexNormals();
  // invisible alpha-mask proxy: discarded by every viewer, never z-fights the visual surface
  const m = new THREE.MeshStandardMaterial({ name: name + '_mat', color: 0xff00ff, transparent: false, alphaTest: 0.5, opacity: 0 });
  m.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(g, m); mesh.name = name; return mesh;
}
// Collision_Terrain IS the visual terrain's final verts/indices -> walkable surface == what you see.
scene.add(proxyMesh(terrain.collision.pos, terrain.collision.idx, 'Collision_Terrain'));

// ---- 5) export GLB, then attach the ground textures via gltf-transform --------------
mkdirSync(R('exports'), { recursive: true });
const outGlb = R('exports', `${SET.slug}-single.glb`);
const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false });
const io = new NodeIO();
const doc = await io.readBinary(new Uint8Array(glb));

const texOf = (p, mime) => doc.createTexture(path.basename(p)).setImage(new Uint8Array(readFileSync(p)))
  .setMimeType(mime || (p.endsWith('.jpg') ? 'image/jpeg' : 'image/png'));
// Photographic textures (aerial ground + Street-View facades) are stored as JPEG, not PNG — a
// 6144² ground PNG is ~50 MB and the facade atlas PNGs ~120 MB; JPEG cuts the inspectable GLB ~5×.
// ORM stays PNG (it is DATA — JPEG blocking would corrupt roughness/AO).
const jbytes = async (p, q = 85) => new Uint8Array(await sharp(p).jpeg({ quality: q, mozjpeg: true }).toBuffer());
const jtex = async (p, q) => doc.createTexture(path.basename(p)).setImage(await jbytes(p, q)).setMimeType('image/jpeg');
const coreAlb = await jtex(ground.core.albedo, 86);
const coreOrm = texOf(ground.core.orm);
const farAlb = await jtex(ground.far.albedo, 84);
const facadeTexes = await Promise.all(facade.pages.map((p) => jtex(p, 85)));
const stuccoTex = existsSync(facade.stuccoTile) ? await jtex(facade.stuccoTile, 88) : null;
const CLAMP = 33071, REPEAT = 10497;
for (const m of doc.getRoot().listMaterials()) {
  const n = m.getName() || '';
  if (n === 'TerrainCore_mat') {
    m.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(coreAlb);
    m.getBaseColorTextureInfo().setWrapS(CLAMP).setWrapT(CLAMP);
    // ORM: R=occlusion, G=roughness, B=metalness (one texture for both slots, glTF-legal)
    m.setMetallicRoughnessTexture(coreOrm).setRoughnessFactor(1).setMetallicFactor(1);
    m.getMetallicRoughnessTextureInfo().setWrapS(CLAMP).setWrapT(CLAMP);
    m.setOcclusionTexture(coreOrm);
    m.getOcclusionTextureInfo().setWrapS(CLAMP).setWrapT(CLAMP);
  } else if (n === 'TerrainFar_mat') {
    m.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(farAlb).setRoughnessFactor(0.95).setMetallicFactor(0);
    m.getBaseColorTextureInfo().setWrapS(CLAMP).setWrapT(CLAMP);
  } else {
    const fm = n.match(/^FacadeAtlasOverlay_page(\d+)_mat$/);
    if (fm && facadeTexes[+fm[1]]) {        // hero photo OVERLAY (SVFacade_page{N} quads, proud of the wall)
      m.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(facadeTexes[+fm[1]]);
      m.getBaseColorTextureInfo().setWrapS(CLAMP).setWrapT(CLAMP);
    } else if (/^Stucco_b\d+_mat$/.test(n) && stuccoTex) {   // tiled window/stucco x per-building wallColor (the always-present wall)
      m.setBaseColorTexture(stuccoTex);
      m.getBaseColorTextureInfo().setWrapS(REPEAT).setWrapT(REPEAT);
    }
  }
}
writeFileSync(outGlb, Buffer.from(await io.writeBinary(doc)));
console.log(`wrote ${path.relative(ROOT, outGlb)} (${(statSync(outGlb).size / 1e6).toFixed(1)} MB)`);

// ---- 6) surface annotation sidecar (vegetation) ------------------------------------
const buildingFootprintsWorld = (S.buildings || []).map(b => (b.p || []).map(([e, n]) => w2(e, n)));
const parcels = existsSync(pick('parcels.json')) ? (JSON.parse(readFileSync(pick('parcels.json'), 'utf8')).parcels || []) : [];
const treesPlaced = existsSync(pick('trees_placed.json')) ? (JSON.parse(readFileSync(pick('trees_placed.json'), 'utf8')).trees || []) : [];
const annot = await buildSurfaceAnnotation({
  aerialPath, aerialBounds: AB, C, demRect: terrain.demRect, rasterSize: 1024,
  pavedPolys: ground.pavedPolys, buildingFootprintsWorld, parcels, treesPlaced,
  outDir: groundDir, level: SET.slug,
}).catch(e => { console.warn('  ! surface annotation skipped:', e.message); return null; });
if (annot) console.log(`vegetation: ${path.basename(annot.classRasterPath)} + ${path.basename(annot.vegetationJsonPath)}`);

console.log('done.\n');
