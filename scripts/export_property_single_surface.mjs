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
import { execFileSync } from 'node:child_process';
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
const io = new NodeIO();   // shared: reads the photoreal GLB (4b-ii) AND the exported scene (5)

import { loadDEM, makeGeo, buildTerrainMesh } from './lib/terrain_mesh.mjs';
import { gradeDemUnderRoads } from './lib/dem_road_grade.mjs';
import { buildRoadNetwork, buildPlantingStripPoints } from './lib/road_network.mjs';
import { buildRoadGeometryLayer } from './lib/road_geometry.mjs';
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
  xq:      { scene: 'exports/xq/scene.json', dir: 'exports/xq', slug: 'xq', dropOffPatch: true, photoreal: false },
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

// ---- tiny column-major 4x4 matrix helpers (photoreal node-transform flattening) ----
// compose a TRS into a column-major mat4 (matches THREE/glTF column-major layout).
function composeTRS(t, q, s) {
  const [x, y, z, w] = q, [sx, sy, sz] = s;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
// a * b for column-major mat4 (a applied after b, i.e. world = parent * local).
function mul4(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

const MS = existsSync(pick('map_surfaces_osm.json')) ? JSON.parse(readFileSync(pick('map_surfaces_osm.json'), 'utf8')) : {};
const AB = JSON.parse(readFileSync(pick('google_aerial.json'), 'utf8'));
const aerialPath = pick('google_aerial.jpg');

console.log(`\n=== single-surface export: ${SET.slug} ===`);
console.log(`scene: ${SET.scene}  buildings=${(S.buildings || []).length} roads=${(S.roads || []).length}`);

// ---- 1) terrain (the ONE welded surface) -------------------------------------------
const D = loadDEM(pick('dem_1m.json'));
// Grade/smooth the RAW DEM under road corridors BEFORE the mesh is built, so undulations under a
// road no longer read as bumps. Mutates D.h in place; preserves the slow real grade (only removes
// high-frequency chatter, feathers to zero at the shoulder so there is no cliff at the corridor edge).
const grade = gradeDemUnderRoads({ D, C, LAT0, LON0, COSLAT, roads: S.roads, w2, opts: {} });
console.log(`terrain grade: ${grade.cellsModified} cells under roads (cut ${grade.maxCut.toFixed(2)}m / fill ${grade.maxFill.toFixed(2)}m)`);
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

// ---- 4b-i) SV-DETECTED OPENINGS: door/window/garage rects per wall (from detect_facade_openings.py).
// Each svWall may now carry an `openings` array [{kind,x0,y0,x1,y1}] normalised on its wall crop
// (x=left->right along the edge, y=eave(0)->ground(1)). Key them 'b{building}_e{edge}' (the same
// identity as rectByWall) and hand them to buildBuildingLayer via facade.openingsByWall so photo
// walls get REAL 3D recessed glass / door slabs / garage panels. Backward-safe: walls without an
// `openings` array contribute nothing, so levels predating the detector behave exactly as before.
const openingsByWall = {};
let nOpenings = 0;
for (const wall of svWalls) {
  if (!Array.isArray(wall.openings) || !wall.openings.length) continue;
  if (wall.building == null || wall.edge == null) continue;
  openingsByWall[`b${wall.building}_e${wall.edge}`] = wall.openings;
  nOpenings += wall.openings.length;
}
facade.openingsByWall = openingsByWall;
if (nOpenings) console.log(`openings: ${nOpenings} detected door/window/garage rects across ${Object.keys(openingsByWall).length} wall(s)`);

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

// BACKYARD PHANTOM EXCLUSION (dahill only): a real OSM building (b1013) landed in the owner's
// back lot / pig yard, where there should be open yard. Drop it by world-XZ centroid so it never
// renders OR collides. Tight radius — only this one footprint; never runs on other levels.
if (LEVEL === 'dahill') {
  const EXCLUDE_XZ = [[-15.0, -19.9]];   // b1511 — inferred-aerial phantom (oversized rectangle behind house, toward creek)
  const EXCLUDE_R = 6.0;
  const beforeEx = S.buildings.length;
  S.buildings = S.buildings.filter((b) => {
    if (!b.p || b.p.length < 3) return true;
    const cen = b.p.reduce((a, p) => [a[0] + p[0] / b.p.length, a[1] + p[1] / b.p.length], [0, 0]);
    const [X, Z] = w2(cen[0], cen[1]);
    return !EXCLUDE_XZ.some(([ex, ez]) => Math.hypot(X - ex, Z - ez) < EXCLUDE_R);
  });
  if (beforeEx - S.buildings.length) console.log(`backyard exclusion: dropped ${beforeEx - S.buildings.length} building(s)`);
}

// Colour sidecars load from THIS level's dir ONLY (never the root pick() fallback): a missing
// per-level colour file must yield {} -> tasteful fallback palette, NOT another level's colour map.
// (That cross-contamination is exactly why meemaw/xq rendered with dahill's stale 108-entry file.)
const pickColor = (name) => R(SET.dir, name);
const { wallColor, roofColor } = makeBuildingColor(pickColor);
const isSchool = S.meta?.kind === 'school-region-export';

// ---- 4b-ii) PHOTOREAL high-rise towers (xq): replace the extruded towers with a Google-photoreal
// mesh. We CLIP the photoreal to the tall footprints only ("the building, not the melty street"),
// VERTICALLY SEAT it on the terrain, add it as a 'Buildings_photoreal' node, and tell the building
// layer to SKIP those towers' extruded walls/roofs (keeping only their collision prism). The
// photoreal texture(s) are attached as raw bytes in the gltf-transform post-pass (same pattern as
// the ground/facade textures), so no image decode is needed here. Missing GLB -> warn + fall back
// to extruded towers (photorealFootprints stays empty). Off for every non-photoreal level.
const photorealFootprints = new Set();           // building indices (ib) whose massing the GLB covers
const photorealTextures = [];                    // [{matName, bytes, mime}] attached in the post-pass
if (SET.photoreal) {
  const prPath = R('exports', `${SET.slug}-photoreal.glb`);
  if (!existsSync(prPath)) {
    console.warn(`  ! photoreal GLB missing (${path.relative(ROOT, prPath)}) — falling back to extruded towers`);
  } else {
    try {
      // (a) footprints to cover with photoreal: b.h > photorealMinH (default 20 = towers only).
      // xq sets it low (4) so SHORT downtown buildings also get the real photogrammetry mesh —
      // which is also seated on the terrain, fixing the "buildings sink below the surface" look.
      const MIN_PR_H = SET.photorealMinH ?? 20;
      const tallPolys = [];                      // [{ib, ring:[[x,z]...], cen:[x,z]}]
      (S.buildings || []).forEach((b, ib) => {
        if (!b || !b.p || b.p.length < 3 || !(b.h > MIN_PR_H)) return;
        if (b.house) return;   // keep the owner-house anchor EXTRUDED so House_walls (recenter +
                               // the build's required collision node) is still emitted, not photoreal-skipped.
        const ring = b.p.map(([e, n]) => w2(e, n));
        const cen = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
        tallPolys.push({ ib, ring, cen });
        photorealFootprints.add(ib);
      });
      if (!tallPolys.length) {
        console.warn('  ! photoreal: no tall footprints (b.h > 20) — nothing to clip; falling back to extruded');
      } else {
        const BUF = 4.0;                         // buffer the footprints ~4 m so eaves/setbacks survive
        const inPolyXZ = (x, z, ring) => {
          let inside = false;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, zi] = ring[i], [xj, zj] = ring[j];
            if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
          }
          return inside;
        };
        const distToRing = (x, z, ring) => {     // min distance to any edge (for the buffer band)
          let best = Infinity;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [ax, az] = ring[j], [bx, bz] = ring[i];
            let dx = bx - ax, dz = bz - az; const l2 = dx * dx + dz * dz || 1;
            let t = ((x - ax) * dx + (z - az) * dz) / l2; t = Math.max(0, Math.min(1, t));
            best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
          }
          return best;
        };
        const inAnyTall = (x, z) => tallPolys.some(tp =>
          inPolyXZ(x, z, tp.ring) || distToRing(x, z, tp.ring) <= BUF);

        // (b) load the photoreal GLB with the same NodeIO, walk every mesh node, bake the node's
        //     world transform into its primitive positions, then keep only triangles whose centroid
        //     (X,Z) lands in a tall footprint. Group kept tris by their material's baseColor texture
        //     so each distinct texture becomes its own THREE mesh (textures attached in the post-pass).
        const prDoc = await io.read(prPath);
        const flatten = (node, m) => {           // accumulate world matrices (column-major 4x4)
          const t = node.getTranslation(), r = node.getRotation(), s = node.getScale();
          const local = composeTRS(t, r, s);
          const world = mul4(m, local);
          const out = [];
          const mesh = node.getMesh();
          if (mesh) out.push({ mesh, world });
          for (const c of node.listChildren()) out.push(...flatten(c, world));
          return out;
        };
        const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const meshNodes = [];
        for (const sc of prDoc.getRoot().listScenes())
          for (const root of sc.listChildren()) meshNodes.push(...flatten(root, I4));

        // group kept geometry by texture image (dedup by image pointer); each group -> a THREE mesh.
        const groups = new Map();                // texImage(Texture|null) -> {pos:[], uv:[], tex}
        const groupFor = (tex) => {
          const key = tex || '__notex__';
          let g = groups.get(key);
          if (!g) { g = { pos: [], uv: [], tex }; groups.set(key, g); }
          return g;
        };
        const keptY = [];                        // photoreal Y of kept verts (for vertical seat)
        for (const { mesh, world } of meshNodes) {
          for (const prim of mesh.listPrimitives()) {
            const posAcc = prim.getAttribute('POSITION');
            if (!posAcc) continue;
            const uvAcc = prim.getAttribute('TEXCOORD_0');
            const idxAcc = prim.getIndices();
            const P = posAcc.getArray(), U = uvAcc ? uvAcc.getArray() : null;
            const pc = posAcc.getElementSize(), uc = uvAcc ? uvAcc.getElementSize() : 0;
            const mat = prim.getMaterial();
            const tex = mat && mat.getBaseColorTexture ? mat.getBaseColorTexture() : null;
            const g = groupFor(tex);
            const nv = posAcc.getCount();
            const idx = idxAcc ? idxAcc.getArray() : null;
            const triCount = idx ? idx.length / 3 : nv / 3;
            const wpos = new Array(nv * 3);
            for (let v = 0; v < nv; v++) {       // bake world transform
              const x = P[v * pc], y = P[v * pc + 1], z = P[v * pc + 2];
              wpos[v * 3] = world[0] * x + world[4] * y + world[8] * z + world[12];
              wpos[v * 3 + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
              wpos[v * 3 + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
            }
            for (let t = 0; t < triCount; t++) {
              const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
              const cx = (wpos[a * 3] + wpos[b * 3] + wpos[c * 3]) / 3;
              const cz = (wpos[a * 3 + 2] + wpos[b * 3 + 2] + wpos[c * 3 + 2]) / 3;
              if (!inAnyTall(cx, cz)) continue;  // drop ground/streets/low-rise
              for (const vi of [a, b, c]) {
                g.pos.push(wpos[vi * 3], wpos[vi * 3 + 1], wpos[vi * 3 + 2]);
                keptY.push(wpos[vi * 3 + 1]);
                if (U) g.uv.push(U[vi * uc], U[vi * uc + 1]); else g.uv.push(0, 0);
              }
            }
          }
        }

        const totalTris = [...groups.values()].reduce((a, g) => a + g.pos.length / 9, 0);
        if (!totalTris) {
          console.warn('  ! photoreal: no triangles fell inside the tall footprints — falling back to extruded towers');
          photorealFootprints.clear();
        } else {
          // (b) VERTICAL SEAT: shift kept verts in Y so tower bases sit on the terrain. delta =
          //     median(terrainAt at the tall centroids) - median(photoreal kept Y). The photoreal's
          //     absolute Y can be off by the geoid; this lands the bases on our DEM.
          const med = (arr) => { const s = [...arr].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };
          const terrCen = tallPolys.map(tp => terrainAt(tp.cen[0], tp.cen[1]));
          const dy = med(terrCen) - med(keptY);
          let gi = 0;
          for (const g of groups.values()) {
            const pos = g.pos.slice();
            for (let i = 1; i < pos.length; i += 3) pos[i] += dy;
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
            geo.computeVertexNormals();
            const matName = `Buildings_photoreal_${gi}_mat`;
            // unlit-ish: low roughness contribution, full baseColor texture (attached in post-pass).
            const m = new THREE.MeshStandardMaterial({ name: matName, color: 0xffffff, roughness: 1, metalness: 0, side: THREE.FrontSide });
            const mesh = new THREE.Mesh(geo, m);
            mesh.name = gi === 0 ? 'Buildings_photoreal' : `Buildings_photoreal_${gi}`;
            mesh.userData = { source: 'Google Photorealistic 3D Tiles', photoreal: true };
            scene.add(mesh);
            // remember this group's texture bytes for the post-pass (raw, no decode)
            if (g.tex) {
              const img = g.tex.getImage();
              if (img) photorealTextures.push({ matName, bytes: img, mime: g.tex.getMimeType() || 'image/jpeg' });
            }
            gi++;
          }
          console.log(`photoreal: ${totalTris} tris over ${tallPolys.length} tall footprint(s), seated dy=${dy.toFixed(2)}m, ${groups.size} texture group(s)`);
        }
      }
    } catch (e) {
      console.warn(`  ! photoreal load failed (${e.message}) — falling back to extruded towers`);
      photorealFootprints.clear();
    }
  }
}

const bres = buildBuildingLayer({ THREE, scene, S, w2, terrainAt, demRect: terrain.demRect, isSchool, wallColor, roofColor, facade, ROOT,
  roadLines: network.surfaces.filter(s => s.kind === 'asphalt' && s.centerline).map(s => s.centerline), dropOffPatch: SET.dropOffPatch,
  photorealFootprints });
console.log(`buildings: emitted=${bres.counts.emitted} skipped=${bres.counts.skipped} clipped=${bres.counts.clipped} (drop ${(100 * bres.counts.skipped / Math.max(1, bres.counts.emitted + bres.counts.skipped)).toFixed(1)}%)`);

// ---- procedural trees: planting-strip (curb<->sidewalk, all levels) + owner front-yard (dahill) --
const ptInRing = (x, z, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1]; if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) c = !c; } return c; };
// VEGETATION-DRIVEN street trees: sample the aerial along the planting strip and place a tree ONLY
// where there's real tree canopy (dark green) — natural clusters, NOT even spacing.
const stripPts = [];
try {
  const fa = await sharp(ground.far.albedo).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const FW = fa.info.width, FH = fa.info.height, FD = fa.data;
  const { x0, x1, z0, z1 } = terrain.demRect;
  const canopyAt = (x, z) => {
    const u = (x - x0) / (x1 - x0), v = (z - z0) / (z1 - z0);
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;
    const px = Math.min(FW - 1, (u * FW) | 0), py = Math.min(FH - 1, (v * FH) | 0);
    const i = (py * FW + px) * 3;
    const r = FD[i], g = FD[i + 1], b = FD[i + 2];
    return g > r + 6 && g > b + 6 && (r + g + b) / 3 < 115;   // green-dominant + darkish = canopy (not bright grass/paint)
  };
  const cand = buildPlantingStripPoints(S, { w2, clipHalf }, [], { spacing: 5 });   // dense candidates
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const p of cand) {
    if (!canopyAt(p.x, p.z)) continue;                          // only where the aerial shows tree canopy
    const x = p.x + (rnd() - 0.5) * 2.5, z = p.z + (rnd() - 0.5) * 2.5;   // jitter off the perfect line
    if (stripPts.some(q => Math.hypot(q.x - x, q.z - z) < 5)) continue;   // natural min spacing
    stripPts.push({ x, z });
  }
} catch (e) { console.warn('  ! planting-strip canopy sampling skipped:', e.message); }
const frontPts = [];
if (LEVEL === 'dahill') {
  const ownerLot = fillParcels.find((p) => p.apn === '416-120-67');   // house lot; ring is world XZ
  if (ownerLot && Array.isArray(ownerLot.ring) && ownerLot.ring.length >= 3) {
    const ring = ownerLot.ring;
    let lo0 = 1e9, lo1 = 1e9, hi0 = -1e9, hi1 = -1e9;
    for (const [x, z] of ring) { lo0 = Math.min(lo0, x); lo1 = Math.min(lo1, z); hi0 = Math.max(hi0, x); hi1 = Math.max(hi1, z); }
    const inB = (x, z) => (bres.buildingPolys || []).some((r) => ptInRing(x, z, r));
    const onP = (x, z) => (ground.pavedPolys || []).some((r) => ptInRing(x, z, r));
    let seed = 1840; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let t = 0; frontPts.length < 3 && t < 600; t++) {
      const x = lo0 + rnd() * (hi0 - lo0), z = lo1 + rnd() * (hi1 - lo1);
      if (!ptInRing(x, z, ring) || inB(x, z) || onP(x, z)) continue;
      if (frontPts.some((q) => Math.hypot(q.x - x, q.z - z) < 4)) continue;
      frontPts.push({ x, z });
    }
  }
}
const extraTrees = [
  ...stripPts.map((p, k) => ({ x: p.x, z: p.z, height: 6, i: 100000 + k, small: true })),  // street/strip trees (small, no blobs)
  ...frontPts.map((p, k) => ({ x: p.x, z: p.z, height: 4.5, i: 200000 + k, small: true })),// front-yard ornamentals
];
console.log(`extra trees: ${stripPts.length} planting-strip + ${frontPts.length} front-yard`);
const tres = await buildTreeLayer({ THREE, scene, w2, terrainAt, demRect: terrain.demRect, ROOT, dir: SET.dir, treesPlacedPath: pick('trees_placed.json'), creek: S.creek, buildingPolys: bres.buildingPolys, pavedPolys: ground.pavedPolys, extraTrees });
console.log(`trees: ${tres.nTrees} (own 'Trees' layer), shrubs: ${tres.nShrubs}, creek: ${tres.hasCreek}`);

// ---- ROAD GEOMETRY layer (removable; paint stays beneath) -------------------------------
// Streets + raised curbs + sidewalks + lane markings as real geometry, draped EXACTLY on the welded
// terrain (samples terrainAt — no approximation), reusing the same polygons the ground atlas painted.
// Grouped under node 'RoadLayer': keep it for crisp asphalt/curbs, or delete the group to reveal the
// painted roads on the ground bed underneath.
const rgeo = buildRoadGeometryLayer({ THREE, scene, network, curbLines, terrainAt });
console.log(`road geometry: ${rgeo.added} meshes under 'RoadLayer' (draped on surface; paint beneath)`);

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
// Each level's uncompressed editable MASTER lands in its OWN folder with a clear name:
//   exports/<slug>/<slug>.level.glb   (PLAIN glb — Blender/QuickLook readable; the compress step
// downstream produces the meshopt/webp game assets). See docs/LEVEL_GENERATOR.md.
mkdirSync(R('exports', SET.slug), { recursive: true });
const outGlb = R('exports', SET.slug, `${SET.slug}.level.glb`);
const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false });
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
// shared roof-tile texture (clay/shingle), tinted per-building by the real roof colour (roofColor
// factor) the same way the stucco tile is tinted by wallColor — fixes the flat untextured "wood" roofs.
const roofTilePath = R('exports/roof_tile.png');
const roofTex = existsSync(roofTilePath) ? await jtex(roofTilePath, 90) : null;
// photoreal tower textures: re-create each group's baseColor image (raw bytes from the source GLB)
// as a doc texture, keyed by the THREE material name we gave it, to attach in the loop below.
const photorealTexByMat = new Map();
for (const { matName, bytes, mime } of photorealTextures) {
  if (photorealTexByMat.has(matName)) continue;
  photorealTexByMat.set(matName, doc.createTexture(matName).setImage(new Uint8Array(bytes)).setMimeType(mime));
}
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
    } else if (/_roofs?_\d+$/.test(n) && roofTex) {   // per-building Building_<ib>_roof / House_roof material — tiled roof tile x per-building roofColor (KEEP the factor so the real roof colour tints the tile)
      m.setBaseColorTexture(roofTex);
      m.getBaseColorTextureInfo().setWrapS(REPEAT).setWrapT(REPEAT);
    } else if (photorealTexByMat.has(n)) {   // Google-photoreal tower: re-attach the baked baseColor texture
      m.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(photorealTexByMat.get(n));
      m.getBaseColorTextureInfo().setWrapS(CLAMP).setWrapT(CLAMP);
    }
  }
}
writeFileSync(outGlb, Buffer.from(await io.writeBinary(doc)));
console.log(`wrote ${path.relative(ROOT, outGlb)} (${(statSync(outGlb).size / 1e6).toFixed(1)} MB)`);

// ---- 5b) DAHILL OWNER-LOT FENCES (post-step): tile the back/side-yard fence runs onto the
// just-written single-surface GLB via Blender. dahill-only — the runs are hardcoded in
// dahill's world frame + DEM, so we never run it for the other levels (place_fences.py also
// self-guards on the scene slug). Blender re-exports raw (no meshopt); build_dahilg_assets
// re-compresses, and the required collision/House_walls nodes survive the round-trip.
if (LEVEL === 'dahill' && !process.env.SKIP_FENCES) {
  const BLENDER = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
  if (existsSync(BLENDER)) {
    try {
      console.log('fences: tiling dahill back/side-yard runs via Blender...');
      // timeout: Blender re-exports the (large) GLB raw which can take ~70s; cap at 4 min so a genuinely
      // hung Blender (the script has no console) can't block the whole export forever (try/catch continues).
      execFileSync(BLENDER, ['--background', '--python', R('scripts/place_fences.py'), '--', outGlb],
        { stdio: ['ignore', 'inherit', 'inherit'], timeout: 240000 });
    } catch (e) {
      console.warn('  ! fence post-step failed (continuing without fences):', e.message);
    }
  } else {
    console.warn(`  ! Blender not found at ${BLENDER}; skipping dahill fences`);
  }
}

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
