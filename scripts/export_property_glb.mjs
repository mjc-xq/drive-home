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
import { createHash } from 'node:crypto';
import path from 'node:path';

globalThis.self = globalThis;
if (typeof globalThis.FileReader === 'undefined') {       // GLTFExporter binary packer shim
  globalThis.FileReader = class {
    readAsArrayBuffer(b) { b.arrayBuffer().then(x => { this.result = x; this.onloadend && this.onloadend(); }); }
    readAsDataURL(b) { b.arrayBuffer().then(x => { this.result = `data:${b.type || 'application/octet-stream'};base64,${Buffer.from(x).toString('base64')}`; this.onloadend && this.onloadend(); }); }
  };
}

import { clipPolylineToBox, smoothLine, buildVertHit, vkey, roadSpec, roadRank, isCulDeSacRoad, snapCreekToChannel, buildRoadJunctions, buildSidewalkConnectors, buildSidewalkEndCaps, emitGroundRibbon, fanDisc, ringAnnulus, trimEndInward, roadSegmentsWorld, distPointSeg } from './road_prep.mjs';

const THREE = await import('three');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

// ---- tree-library loader (self-contained tree emission; no Blender) -------
// Reads the 6 exports/tree_lib/tree_0N.glb templates with a gltf-transform NodeIO
// (registering the meshopt + draco decoders exactly like build_dahilg_assets.mjs) and
// converts EACH template ONCE into a single shared THREE.BufferGeometry + a single shared
// THREE.MeshStandardMaterial. All prims of a template are merged into one positions/normals/
// (uvs) buffer; a per-vertex COLOR carries each prim's representative base colour (bark brown
// vs leaf green, alpha-weighted from its baseColor texture), so the foliage/trunk read right
// with ONE vertex-coloured material. Sharing the SAME geom+mat object across all placed trees
// of a template lets the downstream build (dedup + instanceStaticRepeats) collapse them into
// EXT_mesh_gpu_instancing. Falls back to a name-based colour if a texture can't be decoded.
async function loadTreeTemplates() {
  const libDir = path.join(ROOT, 'exports/tree_lib');
  const manifestPath = path.join(libDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  const { NodeIO, Logger } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder } = await import('meshoptimizer');
  const { default: draco3d } = await import('draco3dgltf');
  const { default: sharpTex } = await import('sharp');
  const tio = new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.ERROR))
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'meshopt.decoder': MeshoptDecoder,
    });
  await MeshoptDecoder.ready;
  // alpha-weighted average sRGB of a baseColor texture -> linear THREE.Color (so transparent
  // leaf-card background doesn't drag the foliage colour dark); null if it can't be decoded.
  const texColor = async (mat) => {
    try {
      const tex = mat && mat.getBaseColorTexture();
      const img = tex && tex.getImage();
      if (!img) return null;
      const { data } = await sharpTex(Buffer.from(img)).resize(16, 16, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let r = 0, g = 0, b = 0, w = 0;
      for (let i = 0; i < data.length; i += 4) { const a = data[i + 3] / 255; r += data[i] * a; g += data[i + 1] * a; b += data[i + 2] * a; w += a; }
      if (w < 1e-3) return null;
      return new THREE.Color().setRGB(r / w / 255, g / w / 255, b / w / 255, THREE.SRGBColorSpace);
    } catch { return null; }
  };
  // role of a template material by its name: 'leaf' (foliage) vs 'bark' (trunk). Used to
  // pick the right per-instance palette (green hues for leaves, brown for bark) so every
  // tree keeps bark BROWN + leaves GREEN, just varied in hue. 'acacia' is foliage here; the
  // acacia trunk is split off geometrically below (its one material covers trunk + canopy).
  const nameRole = (n) => /leaf|leaves|acacia|foliage|canopy/i.test(n) ? 'leaf'
    : /bark|trunk|wood|stem/i.test(n) ? 'bark' : 'leaf';
  // Per-instance VARIETY palettes (no per-vertex COLOR_0 — that round-trips as un-normalized
  // ubyte and renders WHITE). ~4 leaf hues + ~3 bark hues; a tree picks one of each by index
  // hash. Reused variant material-ARRAYS keep GPU instancing (folds by geom + material set).
  const LEAF_HUES = [
    new THREE.Color(0.20, 0.42, 0.12),   // deep green
    new THREE.Color(0.42, 0.46, 0.16),   // olive
    new THREE.Color(0.50, 0.58, 0.18),   // yellow-green
    new THREE.Color(0.28, 0.50, 0.17),   // fresh mid-green (replaced a too-blue teal)
  ];
  const BARK_HUES = [
    new THREE.Color(0.32, 0.20, 0.13),   // medium brown
    new THREE.Color(0.42, 0.30, 0.20),   // warm tan-brown
    new THREE.Color(0.24, 0.16, 0.11),   // dark brown
  ];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const templates = [];
  for (const entry of manifest.trees) {
    const f = path.join(libDir, entry.file);
    if (!existsSync(f)) continue;
    const doc = await tio.read(f);
    const pos = [], nor = [], uv = [], idx = [];
    const groups = [];                 // { start, count, role } per source prim
    let vbase = 0, ymin = Infinity, ymax = -Infinity;
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const P = prim.getAttribute('POSITION'); if (!P) continue;
        const N = prim.getAttribute('NORMAL'), U = prim.getAttribute('TEXCOORD_0'), I = prim.getIndices();
        const role = nameRole(prim.getMaterial()?.getName() || '');
        const n = P.getCount(), e = [];
        const gStart = idx.length;
        for (let k = 0; k < n; k++) {
          P.getElement(k, e); pos.push(e[0], e[1], e[2]);
          if (e[1] < ymin) ymin = e[1]; if (e[1] > ymax) ymax = e[1];
          if (N) { N.getElement(k, e); nor.push(e[0], e[1], e[2]); }
          if (U) { U.getElement(k, e); uv.push(e[0], e[1]); }
        }
        if (I) { const ia = I.getArray(); for (let k = 0; k < ia.length; k++) idx.push(vbase + ia[k]); }
        else { for (let k = 0; k < n; k++) idx.push(vbase + k); }
        groups.push({ start: gStart, count: idx.length - gStart, role });
        vbase += n;
      }
    }
    if (!pos.length) continue;
    // ACACIA SPLIT: tree_05's single 'Acacia_Mat' covers BOTH trunk and canopy and is tagged
    // 'leaf', so it would render all-green incl the trunk. Re-tag the LOWEST ~20% of each
    // leaf group's TRIANGLES (by centroid height) as 'bark' so the trunk reads brown. Done by
    // splitting a group's index range into bark/leaf sub-ranges (a triangle is below the cut if
    // its centroid Y is under ymin + 0.20*(ymax-ymin)).
    const needsSplit = entry.id === 'tree_05' || /acacia/i.test(entry.file || '') || groups.every(g => g.role === 'leaf');
    let finalGroups = groups;
    if (needsSplit && ymax > ymin) {
      const cut = ymin + 0.20 * (ymax - ymin);
      const triY = (t) => (pos[idx[t] * 3 + 1] + pos[idx[t + 1] * 3 + 1] + pos[idx[t + 2] * 3 + 1]) / 3;
      finalGroups = [];
      for (const gr of groups) {
        if (gr.role !== 'leaf') { finalGroups.push(gr); continue; }
        // walk this group's triangles, emitting contiguous runs of same sub-role
        let runStart = gr.start, runRole = null;
        for (let t = gr.start; t < gr.start + gr.count; t += 3) {
          const sub = triY(t) < cut ? 'bark' : 'leaf';
          if (runRole === null) runRole = sub;
          else if (sub !== runRole) { finalGroups.push({ start: runStart, count: t - runStart, role: runRole }); runStart = t; runRole = sub; }
        }
        if (runRole !== null) finalGroups.push({ start: runStart, count: gr.start + gr.count - runStart, role: runRole });
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (nor.length === pos.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    if (uv.length === (pos.length / 3) * 2) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    if (nor.length !== pos.length) g.computeVertexNormals();
    // Geometry GROUPS map to material SLOTS by their per-group role: slot 0 = leaf, slot 1 = bark.
    // A variant material-ARRAY is then [leafMat, barkMat]; group i uses slot 0 or 1 by role.
    const SLOT = { leaf: 0, bark: 1 };
    for (const gr of finalGroups) g.addGroup(gr.start, gr.count, SLOT[gr.role]);
    // Build the variant material-ARRAYS up front: every (leaf hue x bark hue) combo, REUSED
    // across instances so the build folds (geom, variantArray) into one instance batch each.
    const variants = [];
    for (let li = 0; li < LEAF_HUES.length; li++) for (let bi = 0; bi < BARK_HUES.length; bi++) {
      variants.push([
        new THREE.MeshStandardMaterial({ name: `Tree_${entry.id}_leaf_${li}`, color: LEAF_HUES[li].clone(), roughness: 0.92, metalness: 0, side: THREE.DoubleSide }),
        new THREE.MeshStandardMaterial({ name: `Tree_${entry.id}_bark_${bi}`, color: BARK_HUES[bi].clone(), roughness: 0.95, metalness: 0, side: THREE.DoubleSide }),
      ]);
    }
    templates.push({ id: entry.id, geom: g, variants, mat: variants[0], height_m: entry.height_m || 6, feature: !!entry.feature });
  }
  return templates.length ? templates : null;
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const S = JSON.parse(readFileSync(path.join(ROOT, 'src/assets/scene.json'), 'utf8'));
// School/place exports (canyon, stanton) carry meta.kind === 'school-region-export'.
// Their scene.json may still mark one footprint house:true, but it's a SCHOOL — so the
// residential owner-house cues (front door/garage, bi===0 garage door) must NOT fire on
// them. Dahill is the residential export (no meta) and keeps every cue.
const IS_SCHOOL_EXPORT = S.meta?.kind === 'school-region-export';

function sceneFingerprint(scene) {
  const r2 = v => (Number(v) || 0).toFixed(2);
  const r6 = v => (Number(v) || 0).toFixed(6);
  const pt = p => [r2(p[0]), r2(p[1])];
  const payload = {
    origin: [r6(scene.origin?.lat), r6(scene.origin?.lon)],
    center: Array.isArray(scene.center) ? pt(scene.center) : null,
    buildings: (scene.buildings || []).map(b => ({
      house: !!b.house,
      h: r2(b.h),
      p: (b.p || []).map(pt),
    })),
    roads: (scene.roads || []).map(r => ({
      k: r.k || '',
      w: r.w == null ? null : r2(r.w),
      p: (r.p || []).map(pt),
    })),
  };
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}
const SCENE_FINGERPRINT = sceneFingerprint(S);
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
const ORIGIN = S.origin || {};
const LAT0 = Number.isFinite(+ORIGIN.lat) ? +ORIGIN.lat : 37.6835313;
const LON0 = Number.isFinite(+ORIGIN.lon) ? +ORIGIN.lon : -122.0686199;
const COSLAT = Math.cos(LAT0 * Math.PI / 180);
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
  // planarUV: <metresPerTile> -> derive a WORLD-PLANAR uv from each vertex's X/Z so a
  // tiled texture repeats at a real-world scale (these are flat XZ ground/roof ribbons).
  // Only used when no explicit uvs are supplied. uv = [worldX/tile, worldZ/tile].
  if (!opts.uvs && opts.planarUV) {
    const t = opts.planarUV, uv = [];
    for (let i = 0; i < positions.length; i += 3) uv.push(positions[i] / t, positions[i + 2] / t);
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  }
  if (opts.uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(opts.uvs, 2));
  if (opts.colors) g.setAttribute('color', new THREE.Float32BufferAttribute(opts.colors, 3));
  if (indices) g.setIndex(indices);
  g.computeVertexNormals();
  const opacity = opts.opacity ?? 1;
  const m = new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.95, metalness: opts.metal ?? 0, name: name + '_mat', transparent: opacity < 1, opacity });
  if (opts.emissive) {
    const e = color instanceof THREE.Color ? color.clone() : new THREE.Color(color);
    m.emissive = e.multiplyScalar(opts.emissive);
  }
  if (opts.colors) m.vertexColors = true;
  if (opts.flat) m.flatShading = true;
  // opacity 0 = an invisible collision/LOD PROXY. Export it as alpha-MASK (cutoff 0.5) with a
  // zero base alpha, so EVERY glTF viewer DISCARDS its fragments (no blend, no depth write) and it
  // can never z-fight the visual terrain/roads it shadows. The engines hide these by NAME and bake
  // colliders straight from the geometry, so this material change is purely for raw-viewer fidelity.
  if (opacity === 0) { m.transparent = false; m.alphaTest = 0.5; m.depthWrite = true; }
  else if (opacity < 1) m.depthWrite = false;
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
  // DEM grid is linear in lat/lon (4326). Sample by world -> lat/lon in the same
  // flat ENU frame used by scene.json, road/building geometry, and aerial UVs.
  terrainAt = (X, Z) => {
    const [lat, lon] = enToLL(X + C[0], C[1] - Z);
    let fi = (lon - D.lonW) / dLon * cols - 0.5, fj = (D.latN - lat) / dLat * rows - 0.5;
    fi = Math.max(0, Math.min(cols - 1.001, fi)); fj = Math.max(0, Math.min(rows - 1.001, fj));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
    const a = h[j * cols + i], b = h[j * cols + i + 1], c = h[(j + 1) * cols + i], d = h[(j + 1) * cols + i + 1];
    // EXACT terrain-MESH height (not bilinear). The terrain mesh triangulates each grid cell as
    // (a,c,b)+(b,c,d) [a=(i,j) b=(i+1,j) c=(i,j+1) d=(i+1,j+1)], so sampling the SAME triangle the
    // point falls in (split by the c-b diagonal u+v=1) makes terrainAt return the identical surface
    // the terrain renders. Every paved ribbon draped on terrainAt + a tiny lift then sits flush on
    // the real full-res DEM surface -> no bilinear-vs-mesh mismatch, no z-fighting -> curbs/sidewalks
    // can be thin (the lift is the only separation needed).
    return (u + v <= 1) ? a * (1 - u - v) + b * u + c * v : d * (u + v - 1) + b * (1 - v) + c * (1 - u);
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
// Decode the SAME aerial JPEG used for the Terrain/roofs_photo texture so per-vertex roof
// colour (Step 5) can sample the real satellite roof tint. aerialUV(X,Z) already maps a
// world XZ to this image's [0,1] UV (v=0 at the top), so we just read the pixel there.
// Falls back to null when the image isn't decodable -> roofColor() palette is used.
const { default: _sharpAerial } = await import('sharp');
let AERIAL_PX = null, AERIAL_W = 0, AERIAL_H = 0, AERIAL_CH = 3;
try {
  const _aerialPath = existsSync(path.join(ROOT, 'exports/google_aerial.jpg'))
    ? path.join(ROOT, 'exports/google_aerial.jpg') : path.join(ROOT, 'src/assets/aerial_opt.jpg');
  if (existsSync(_aerialPath)) {
    const { data, info } = await _sharpAerial(_aerialPath).raw().toBuffer({ resolveWithObject: true });
    AERIAL_PX = data; AERIAL_W = info.width; AERIAL_H = info.height; AERIAL_CH = info.channels;
  }
} catch { AERIAL_PX = null; }
const _s2l = s => { const c = s / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
// aerialColorAt(worldX, worldZ) -> linear-rgb [r,g,b] sampled from the decoded aerial at
// the vertex's aerial UV, or null when the image is missing / the UV is out of bounds.
const aerialColorAt = (worldX, worldZ) => {
  if (!AERIAL_PX) return null;
  const [u, v] = aerialUV(worldX, worldZ);
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
  const px = Math.min(AERIAL_W - 1, Math.max(0, Math.round(u * (AERIAL_W - 1))));
  const py = Math.min(AERIAL_H - 1, Math.max(0, Math.round(v * (AERIAL_H - 1))));
  const k = (py * AERIAL_W + px) * AERIAL_CH;
  return [_s2l(AERIAL_PX[k]), _s2l(AERIAL_PX[k + 1]), _s2l(AERIAL_PX[k + 2])];
};
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
// Deterministic VARIED fallback for the buildings Street View has no colour for —
// real house paints (warm white, tan, sage, slate-blue, grey, buff) so the colourless
// buildings still read as a mixed block instead of all-tan.
const WALL_PALETTE = [
  [0.86, 0.82, 0.74], [0.80, 0.72, 0.60], [0.74, 0.78, 0.80], [0.82, 0.79, 0.72],
  [0.70, 0.74, 0.66], [0.86, 0.80, 0.70], [0.66, 0.70, 0.74], [0.82, 0.74, 0.64],
  [0.78, 0.70, 0.62], [0.72, 0.76, 0.74], [0.62, 0.66, 0.70], [0.84, 0.78, 0.66],
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
// Hue-preserving luma remap: lift only the DARK (shadow/occluded) samples and softly
// compress the very bright ones, but LEAVE THE MIDS ALONE so each house keeps its real
// Street-View lightness. The old wallColor() instead lifted+mixed every sample toward one
// stucco tan (luma collapsed to ~0.63, stddev ~0.03) so the whole block read flat tan with
// facades off. This keeps the SV variation (luma spread ~0.09, range ~0.38-0.80).
const remapLuma = L => {
  if (L < 0.55) return 0.55 - (0.55 - L) * 0.25;   // lift the DARK half to believable paint
  if (L > 0.84) return 0.84 + (L - 0.84) * 0.60;   // soft ceiling on blown-out samples
  return L;                                         // mids untouched -> real per-house lightness
};
// Street-View facade crops bleed green/olive from foreground foliage AND top-down aerial
// sampling; pull any green OR olive cast back toward neutral paint without touching real hues.
const deGreen = c => {
  let [r, g, b] = c;
  // green/olive cast = green co-dominant over blue (foliage bleed, olive aerial sample).
  if (g > b + 0.035 && g >= r - 0.03) { const avg = (r + b) / 2; g = avg + (g - avg) * 0.30; }
  return [r, g, b];
};
// A sampled colour is only believable house PAINT if it isn't vegetation-green and isn't a
// near-black shadow void. Olive/green/too-dark samples (bad top-down aerial sampling, common
// where Street View has no real wall crop) are rejected so a wall never renders green/olive.
const isPlausiblePaint = c => {
  const [r, g, b] = c;
  if (luma(c) < 0.24) return false;                 // shadow void / too dark to be paint
  if (g > r + 0.02 && g > b + 0.02) return false;   // green-dominant -> vegetation, not a wall
  return true;
};
// WALL BASE COLOUR baked per building (material baseColorFactor -> shows in EVERY viewer with
// the photo facades OFF). Source = the building's real Street-View facade colour
// (exports/buildings_color.json) WHEN it reads as plausible paint; otherwise a derived roof
// tint or a deterministic VARIED warm paint so the block is realistic and never green/olive.
const wallColor = ib => {
  let src = COL[ib];
  if (!src || !isPlausiblePaint(src)) src = RCOL[ib] ? lighten(RCOL[ib]) : seededColor(WALL_PALETTE, ib);
  const L = Math.max(0.02, luma(src));
  let c = src.map(v => v * (remapLuma(L) / L));    // hue-preserving lightness remap
  c = deGreen(c);
  const m = luma(c);
  c = c.map(v => m + (v - m) * 1.12);              // gentle chroma boost so it reads as paint
  return c.map(clamp01);
};
// roofs: real sampled colour, but lift deep satellite shadows so they read as roof
// material instead of black voids in review renders. When fetch_roof_colors gave us a real
// per-roof colour (RCOL[ib]), use it DIRECTLY (only the shadow lift) — the old 40% mix toward a
// random ROOF_PALETTE colour diluted every real terracotta/grey toward the same muddy average.
// The palette stays ONLY as the no-sample fallback for roofs the fetch missed.
const roofColor = ib => {
  if (RCOL[ib]) return liftLuma(RCOL[ib], 0.48);
  const src = ROOFP[(Math.imul((ib | 0) + 1, 2654435761) >>> 0) % ROOFP.length];
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
    // SCHOOL/commercial storefront: a long, tall, non-residential wall gets a CONTINUOUS
    // ground-floor glass band with vertical mullions instead of the punched window grid.
    // Storefront glass bands are for SCHOOLS/commercial only — on a residential block (dahill,
    // meemaw) a large house wall would get a dark glass storefront that reads as a black panel.
    const commercial = IS_SCHOOL_EXPORT && !opts.house && L >= 9 && wallH >= 4;
    if (commercial) {
      const gy0 = base + 0.85, gy1 = base + Math.min(3.2, wallH - 1.4);   // ground-floor band
      if (gy1 - gy0 > 0.6) {
        // base sill + head trim spanning the wall, the glass band between, and mullions
        pushWallRect(D.trim, ax, az, ex, ez, nx, nz, 0.45, L - 0.45, gy0 - 0.18, gy0, 0.10);          // sill
        pushWallRect(D.trim, ax, az, ex, ez, nx, nz, 0.45, L - 0.45, gy1, gy1 + 0.16, 0.10);          // head
        pushWallRect(D.glass, ax, az, ex, ez, nx, nz, 0.5, L - 0.5, gy0, gy1, 0.085);                 // continuous glass band
        const mull = Math.max(2, Math.round((L - 1.0) / 2.0));
        for (let mI = 0; mI <= mull; mI++) {
          const ms = 0.5 + (L - 1.0) * mI / mull;
          pushWallRect(D.trim, ax, az, ex, ez, nx, nz, ms - 0.05, ms + 0.05, gy0, gy1, 0.10);         // vertical mullion
        }
      }
    }
    for (let f = 0; f < floors; f++) {
      if (commercial && f === 0) continue;     // ground floor is the storefront band above
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

// push a roof triangle with upward-facing winding. Colour rides per-vertex COLOR_0: each vertex
// is the building's roof median (col, no longer palette-diluted) blended 60% toward the real
// aerial pixel sampled at that vertex — so a roof keeps its terracotta/grey identity while
// picking up the satellite's lights/shadows/streaks instead of one flat fill. The sample point
// is nudged 25% toward the triangle centroid so eave/edge vertices don't bleed neighbour pixels.
// Missing/out-of-bounds aerial -> the flat roof colour.
function pushUpTri(Rf, col, a, b, c) {
  const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
  const tri = (uz * vx - ux * vz) < 0 ? [a, c, b] : [a, b, c];
  const ctx = (a[0] + b[0] + c[0]) / 3, ctz = (a[2] + b[2] + c[2]) / 3;
  for (const v of tri) {
    const sx = v[0] + (ctx - v[0]) * 0.25, sz = v[2] + (ctz - v[2]) * 0.25;
    const samp = aerialColorAt(sx, sz);
    const cv = samp ? mix3(col, samp, 0.6) : col;
    // Store a per-vertex MULTIPLIER (cv / roofMedian), clamped, so baseColorFactor (= roofMedian,
    // group colour) stays unchanged and COLOR_0 only carries the aerial light/shadow deviation —
    // renderers that ignore COLOR_0 still get the flat roof colour, no double-darkening.
    Rf.pos.push(v[0], v[1], v[2]);
    Rf.col.push(
      Math.min(2, cv[0] / Math.max(1e-3, col[0])),
      Math.min(2, cv[1] / Math.max(1e-3, col[1])),
      Math.min(2, cv[2] / Math.max(1e-3, col[2])),
    );
  }
}
// push a roof-PHOTO triangle (upward winding) with nadir aerial UV -> real satellite
// roof imagery. Used only on flat roofs (nadir on pitched roofs smears), as a separate
// toggleable 'Roofs_photo' layer lifted just above the solid cap.
function pushPhotoTri(RfP, a, b, c) {
  const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
  const tri = (uz * vx - ux * vz) < 0 ? [a, c, b] : [a, b, c];
  for (const v of tri) { RfP.pos.push(v[0], v[1], v[2]); const w = aerialUV(v[0], v[2]); RfP.uv.push(w[0], w[1]); }
}
const WALL_EMBED = 0.4;   // wall bottoms drop to per-corner terrain - EMBED so they touch ground on slopes
function pushWallFace(W, wallC, xi, zi, xj, zj, yb, yt, u0, u1, vt, cen) {
  // Wall TOP stays flat at yt (= base + wallH); each BOTTOM corner drops to its own terrain
  // minus a small embed, so a facade on a slope is watertight (adjacent walls share endpoint
  // samples) and never floats at one corner. Per-corner UV-V = (top - thatBottom)/TILE keeps
  // the stucco/window texture from stretching where the wall is taller on the downhill side.
  const ybi = Math.min(yt - 0.1, terrainAt(xi, zi) - WALL_EMBED);
  const ybj = Math.min(yt - 0.1, terrainAt(xj, zj) - WALL_EMBED);
  const vi = (yt - ybi) / TILE, vj = (yt - ybj) / TILE;
  const A = [xi, ybi, zi], B = [xj, ybj, zj], Cc = [xj, yt, zj], Dd = [xi, yt, zi];
  const L = Math.max(0.001, Math.hypot(xj - xi, zj - zi));
  const nx = -(zj - zi) / L, nz = (xj - xi) / L;
  const out = (((xi + xj) * 0.5 - cen[0]) * nx + ((zi + zj) * 0.5 - cen[1]) * nz) >= 0;
  const verts = out ? [A, B, Cc, A, Cc, Dd] : [A, Cc, B, A, Dd, Cc];
  // V=0 at each corner's bottom row; V rises to the per-corner height at the (shared, flat) top.
  const uvs = out
    ? [u0, 0, u1, 0, u1, vj, u0, 0, u1, vj, u0, vi]
    : [u0, 0, u1, vj, u1, 0, u0, 0, u0, vi, u1, vj];
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
  // EAVE OVERHANG: push the cap edge ~0.35 m outward as a flat lip ring at the eave height,
  // plus a ~0.18 m vertical fascia band hanging under that lip — so the roof reads as a real
  // overhanging eave instead of a wall-flush slab. Emitted into Rf (Buildings_roofs); the
  // collision proxy keeps the UN-offset ring so the overhang never blocks the player.
  {
    const OVER_MAX = 0.35, FASCIA = 0.18, yf = yt - FASCIA;
    for (let i = 0; i < ring.length; i++) {
      const [xi, zi] = ring[i], [xj, zj] = ring[(i + 1) % ring.length];
      const L = Math.hypot(xj - xi, zj - zi); if (L < 1e-4) continue;
      let nx = -(zj - zi) / L, nz = (xj - xi) / L;          // outward edge normal (away from centroid)
      if (((xi + xj) * 0.5 - cen[0]) * nx + ((zi + zj) * 0.5 - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
      // PER-EDGE OVERHANG CLAMP: on tight footprints the 0.35 m lip pokes through an adjacent
      // building. If the edge midpoint pushed out by OVER_MAX lands inside ANOTHER (already
      // emitted) building ring, clamp this edge's overhang toward 0 so it can't poke through.
      const mxe = (xi + xj) * 0.5, mze = (zi + zj) * 0.5;
      let OVER = OVER_MAX;
      if (buildingPolys.some(r => r !== ring && inPoly(mxe + nx * OVER_MAX, mze + nz * OVER_MAX, r))) OVER = 0;
      if (OVER < 1e-4) continue;                            // no lip on this edge (would poke a neighbour)
      const oi = [xi + nx * OVER, zi + nz * OVER], oj = [xj + nx * OVER, zj + nz * OVER];
      // overhang lip (horizontal, faces up): inner edge -> outer edge at the eave
      pushUpTri(Rf, roofC, [xi, yt, zi], [xj, yt, zj], [oj[0], yt, oj[1]]);
      pushUpTri(Rf, roofC, [xi, yt, zi], [oj[0], yt, oj[1]], [oi[0], yt, oi[1]]);
      // fascia band (vertical, faces out): hangs from the lip edge down FASCIA metres
      pushUpTri(Rf, roofC, [oi[0], yt, oi[1]], [oj[0], yt, oj[1]], [oj[0], yf, oj[1]]);
      pushUpTri(Rf, roofC, [oi[0], yt, oi[1]], [oj[0], yf, oj[1]], [oi[0], yf, oi[1]]);
    }
  }
  // satellite roof-photo cap: ONLY flat roofs (no gable), lifted just above the solid cap
  if (RfP && !(roofRects && roofRects.length)) {
    const yp = yt + 0.14;   // clearly ABOVE the solid cap so the photo roof never z-fights it
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
// SHARED foundation level for one footprint. ANCHORED HIGH: the old MIN(terrain) - 0.5 m
// pinned the flat eave wall-top to the LOWEST corner, so on a sloped footprint the wall
// barely cleared grade on the HIGH side and buildings read as buried (the rest of the
// floor sat below ground). Instead anchor to a HIGH percentile of densely-sampled footprint
// terrain (corners + edge midpoints + a coarse interior grid), minus a small 0.15 m embed.
// The 85th percentile is robust to a single noisy DEM spike (a lone tall sample can't drag
// the base up), while still placing the floor near the high side so wall tops clear grade
// everywhere. Per-corner wall bottoms (pushWallFace) still drop to real terrain - WALL_EMBED
// so nothing floats; the graded apron (buildingApron) raises the low-side ground to meet the
// floor. Every consumer of a building's base (walls, SV overlay, collision, apron) MUST use
// this same value so the photo facades stay coplanar with the extruded walls.
function footprintTerrainSamples(ringW) {
  const ys = [];
  const xs = ringW.map(p => p[0]), zs = ringW.map(p => p[1]);
  for (const [x, z] of ringW) ys.push(terrainAt(x, z));                     // corners
  for (let i = 0; i < ringW.length; i++) {                                  // edge midpoints
    const [ax, az] = ringW[i], [bx, bz] = ringW[(i + 1) % ringW.length];
    ys.push(terrainAt((ax + bx) / 2, (az + bz) / 2));
  }
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const N = 4;                                                              // 5x5 interior grid (point-in-poly tested)
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const x = x0 + (x1 - x0) * i / N, z = z0 + (z1 - z0) * j / N;
    if (inPoly(x, z, ringW)) ys.push(terrainAt(x, z));
  }
  return ys;
}
const buildingBase = ringW => {
  const ys = footprintTerrainSamples(ringW).sort((a, b) => a - b);
  // GROUND the floor near the LOW grade of the footprint so each house sits ON its lot like
  // real life — NOT on a raised podium. The old 85th-percentile placed the floor at the HIGH
  // grade, which on any slope lifts the whole building up and exposes a tall bare downhill wall.
  // 20th-percentile is spike-robust (ignores a lone DEM pit) but still low → grounded. The
  // downhill wall foot is hidden a touch by terrain; the uphill side is a shallow natural cut.
  const lo = ys[Math.min(ys.length - 1, Math.floor(0.10 * (ys.length - 1)))];  // 10th-percentile ≈ low grade (spike-robust; ignores a lone DEM pit)
  return lo - 0.12;                                                            // seat the floor AT/just-below the low grade so walls go INTO the ground — no raised skirt/podium
};
const houseIdx = S.buildings.findIndex(b => b.house);
// GRADED APRON / PAD around each footprint: a ring of quads from the footprint edge outward
// ~2.5 m, height smoothstepping from the building floor (base) at the inner edge DOWN to
// terrainAt at the outer edge. This raises the low-side ground up to meet the floor so a
// building reads as sitting ON a graded pad instead of buried — and hides the now-taller
// downhill wall. Emitted into its own 'Ground_Pads' mesh with aerial UVs so it textures like
// ground. Robust on all levels (residential + flat-roofed school footprints). The outer ring
// vertex height blends toward base near the inner edge so the pad never undercuts the wall
// foot; the apron does NOT change collision (terrain + building colliders already cover it).
const padPos = [], padIdx = [], padUv = [];
const APRON_W = 2.5;                                          // metres of graded pad outward from the edge
function buildingApron(ringW, base) {
  if (!ringW || ringW.length < 3) return;
  // centroid for outward-normal orientation
  const cen = ringW.reduce((a, [x, z]) => [a[0] + x / ringW.length, a[1] + z / ringW.length], [0, 0]);
  for (let i = 0; i < ringW.length; i++) {
    const [ax, az] = ringW[i], [bx, bz] = ringW[(i + 1) % ringW.length];
    const L = Math.hypot(bx - ax, bz - az); if (L < 1e-3) continue;
    let nx = -(bz - az) / L, nz = (bx - ax) / L;            // outward edge normal (away from centroid)
    if (((ax + bx) * 0.5 - cen[0]) * nx + ((az + bz) * 0.5 - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
    // inner edge AT the building floor (base); outer edge APRON_W out, height smoothstepped
    // from base toward the real terrain there so the low side rises to meet the floor.
    const aoX = ax + nx * APRON_W, aoZ = az + nz * APRON_W;
    const boX = bx + nx * APRON_W, boZ = bz + nz * APRON_W;
    // outer ring meets real terrain; inner ring is the floor. The quad interpolates between
    // them so the low side rises smoothly to the floor (a graded pad, not a cliff).
    const yAo = terrainAt(aoX, aoZ), yBo = terrainAt(boX, boZ);
    const o = padPos.length / 3;
    // inner-A, inner-B at base (floor); outer-A, outer-B at graded terrain
    padPos.push(ax, base, az, bx, base, bz, boX, yBo, boZ, aoX, yAo, aoZ);
    for (const [px, pz] of [[ax, az], [bx, bz], [boX, boZ], [aoX, aoZ]]) {
      const w = aerialUV(px, pz); padUv.push(w[0], w[1]);
    }
    padIdx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
}
const buildingPolys = [];                       // world-space rings for tree avoidance
const buildingCollision = [];
const svFacadeTextures = new Map();
const hW = { pos: [], uv: [], col: [] }, hRf = { pos: [], col: [] };
const hD = { glass: [], trim: [], siding: [] };
let houseRing = null, houseWallH = 0;
const RfP = { pos: [], uv: [] };   // satellite roof-photo caps (flat roofs) -> toggle layer
if (houseIdx >= 0) {
  const houseB = S.buildings[houseIdx];
  const base = buildingBase(houseB.p.map(([e, n]) => w2(e, n)));   // min terrain under the footprint - 0.5 (slope-safe)
  houseWallH = wallHeight(houseB, houseIdx);
  houseRing = emitBuilding(houseB, houseIdx, base, houseWallH, hW, hRf, RfP, hD, { house: true, autoWindows: false });
  // apron removed: per-corner wall bottoms already reach grade and the 85th-pct base keeps the
  // top clear; a coplanar ground pad caused catastrophic z-fighting with the terrain on dense blocks.
  buildingPolys.push(houseRing);
  buildingCollision.push({ ring: houseRing, base, h: houseWallH });
  // base colour = the building's own SV (walls) / satellite (roof) colour, so it renders
  // in EVERY viewer (Quick Look + many glTF viewers ignore per-vertex COLOR_0).
  // NO baked emissive on walls/roofs: Unity does NOT zero exported emissive (the web runtime
  // does), so a baked emissive = baseColor*0.4 makes Unity walls/roofs self-illuminate ~40%
  // and read flat. Leave them lit only by the scene.
  scene.add(mkMesh(hW.pos, null, new THREE.Color(...wallColor(houseIdx)), 'House_walls', { uvs: hW.uv }));
  scene.add(mkMesh(hRf.pos, null, new THREE.Color(...roofColor(houseIdx)), 'House_roof', { planarUV: 1.6, rough: 0.85, colors: hRf.col.length === hRf.pos.length ? hRf.col : undefined }));
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
  ? (JSON.parse(readFileSync(path.join(ROOT, 'exports/parcels.json'), 'utf8')).parcels || []).filter(p => p.mine && p.skipBuildings !== false).map(p => p.ring) : [];
const inMine = (x, z) => MINE.some(r => pip(x, z, r));
let nBld = 0, nSkip = 0;
S.buildings.forEach((b, ib) => {
  if (b.house) return;
  const cen = centroidEN(b.p); const cw = w2(cen[0], cen[1]);
  // whole footprint must sit on the terrain patch (a centroid-only test let edge buildings extrude
  // ~20m past the DEM into the void). Skip any building with a corner off the terrain.
  if (!b.p.map(([e, n]) => w2(e, n)).every(([x, z]) => inPatch(x, z))) return;
  if (inMine(cw[0], cw[1])) { nSkip++; return; }     // never put others' buildings on the owner's lots
  const base = buildingBase(b.p.map(([e, n]) => w2(e, n)));   // min terrain under the footprint - 0.5 (slope-safe)
  const h = wallHeight(b, ib);
  const ws = bW.pos.length / 3, rs = bRf.pos.length / 3;
  const ring = emitBuilding(b, ib, base, h, bW, bRf, RfP, bD, {});
  // apron removed (see house note above): coplanar ground pad z-fought the terrain.
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
function groupedMesh(buf, groups, name, withUV, planarUV) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  if (withUV) g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
  // grouped roofs carry no facade UVs: derive a world-planar XZ uv so the shingle
  // texture tiles (pitched roofs read fine under a nadir projection at distance).
  else if (planarUV) {
    const t = planarUV, uv = [];
    for (let i = 0; i < buf.pos.length; i += 3) uv.push(buf.pos[i] / t, buf.pos[i + 2] / t);
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  }
  g.computeVertexNormals();
  const isRoof = /roofs/i.test(name);
  // roofs carry a per-vertex COLOR_0 multiplier (aerial light/shadow over the flat roof colour);
  // attach it and enable vertexColors on the roof materials. Walls deliberately do NOT (they
  // rely on the per-building baseColorFactor only, so colour renders in every viewer).
  const hasVColor = isRoof && buf.col && buf.col.length === buf.pos.length;
  if (hasVColor) g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  const mats = groups.map(([start, count, col], i) => {
    g.addGroup(start, count, i);
    const base = new THREE.Color(col[0], col[1], col[2]);
    // roofs get a slightly lower roughness (0.85) so the shingle texture reads;
    // walls keep 0.95. metalness stays 0.
    const m = new THREE.MeshStandardMaterial({ color: base, roughness: isRoof ? 0.85 : 0.95, metalness: 0, name: `${name}_${i}`, side: THREE.DoubleSide });   // DoubleSide: some footprint windings invert the wall normal -> a FrontSide wall renders unlit/black; DoubleSide lights the visible face (matches mkMesh)
    // NO baked emissive: Unity does NOT zero exported emissive (web does), so baking
    // emissive = baseColor*0.4 made Unity walls/roofs self-illuminate ~40% and look flat.
    if (hasVColor) m.vertexColors = true;
    m.side = THREE.DoubleSide; return m;
  });
  const mesh = new THREE.Mesh(g, mats); mesh.name = name; return mesh;
}
if (bW.pos.length) {
  scene.add(groupedMesh(bW, wallGroups, 'Buildings_walls', true));
  // roofs: world-planar XZ uv at ~1.6 m/tile so the shingle-course texture tiles
  scene.add(groupedMesh(bRf, roofGroups, 'Buildings_roofs', false, 1.6));
  if (bD.siding.length) scene.add(mkMesh(bD.siding, null, 0xb6ad9f, 'Buildings_siding_lines', { emissive: 0.18 }));
  if (bD.trim.length) scene.add(mkMesh(bD.trim, null, 0xd2c9b8, 'Buildings_window_trim'));
  if (bD.glass.length) scene.add(mkMesh(bD.glass, null, 0x203342, 'Buildings_windows'));
}
// Satellite roof-photo layer (flat roofs): real aerial imagery, lifted just above the
// solid roof. A separate node so it can be toggled on/off (hide it -> solid colours).
if (RfP.pos.length) scene.add(mkMesh(RfP.pos, null, 0xffffff, 'Roofs_photo', { uvs: RfP.uv }));
// Graded ground PADS around each building footprint (raise the low side up to the floor so
// buildings sit ON a pad, not buried). White base + aerial UVs -> textured like the terrain
// by the downstream aerial mapping (matches /ground_pads/ in the texturing loop).
// Ground_Pads apron removed — it z-fought the terrain. (padPos/padIdx left unused/empty.)
function addStreetViewFacadeOverlays() {
  const manifest = path.join(ROOT, 'exports/sv_facades.json');
  if (!existsSync(manifest)) return 0;
  const data = JSON.parse(readFileSync(manifest, 'utf8'));
  const fp = data.scene_fingerprint || data.sceneFingerprint || '';
  if (!fp) {
    if (process.env.ALLOW_UNSTAMPED_SV_FACADES !== '1') {
      console.warn('Skipping Street View facades: manifest has no scene fingerprint. Re-run scripts/fetch_sv_facades.py for this scene.');
      return 0;
    }
  } else if (fp !== SCENE_FINGERPRINT) {
    console.warn(`Skipping Street View facades: manifest scene fingerprint ${fp.slice(0, 12)} does not match current scene ${SCENE_FINGERPRINT.slice(0, 12)}.`);
    return 0;
  }
  let count = 0;
  for (const wall of data.walls || []) {
    const img = path.join(ROOT, 'exports', wall.image || '');
    const b = S.buildings[wall.building];
    if (!b || !existsSync(img) || !wall.A || !wall.B) continue;
    // CLIP facades to the terrain patch. fetch_sv_facades targets buildings across the whole road
    // network (many BEYOND the DEM); those buildings are skipped on emit, so a facade there would
    // float in the void. Require the whole footprint on the terrain — same filter as the building emit.
    if (!b.p.map(([e, n]) => w2(e, n)).every(([x, z]) => inPatch(x, z))) continue;
    const A0 = w2(...wall.A), B0 = w2(...wall.B);
    const L = Math.hypot(B0[0] - A0[0], B0[1] - A0[1]);
    if (L < 1.5) continue;
    let ex = (B0[0] - A0[0]) / L, ez = (B0[1] - A0[1]) / L;
    let nx = -ez, nz = ex;
    const ring = b.p.map(([e, n]) => w2(e, n));
    const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
    const mx = (A0[0] + B0[0]) / 2, mz = (A0[1] + B0[1]) / 2;
    if ((mx - cen[0]) * nx + (mz - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
    // Base MUST match the extruded wall this overlays, or the panel floats above /
    // sinks below it on a slope. The wall now anchors at buildingBase(ring) = min terrain
    // under the footprint - 0.5 (slope-safe), so the overlay uses the SAME shared helper.
    const base = buildingBase(ring);   // SAME slope-safe groundMin as the extruded wall -> coplanar
    const wallH = wallHeight(b);
    // The SV JPEG (fetch_sv_facades.py crop_to_wall) is cropped to the band
    // ground..eave+0.6 m under a pinhole model: image V=0 (top row) is the eave+pad,
    // V=1 (bottom row) is the ground. Earlier this script just mapped that whole photo
    // 0..1 onto a quad of height wallH — so the eave+0.6 m roof pad landed ON the wall
    // ("roof on the side"), and for walls whose ground fell below the photo (crop_v
    // clamped to 1.0) the bottom mapped to a height ABOVE ground, stretching the photo
    // down and pulling the roof onto the wall too. Fix: recover the photo's true world-Y
    // band from crop_v + fov + dist (inverse of vrow()), build the quad to span the
    // captured band, and clip the TOP to the wall eave (base+wallH) so the 0.6 m roof
    // pad is cropped off via the UV-V — leaving only the wall region of the photo.
    // The fetched crop (fetch_sv_facades.crop_to_wall) is now EXACTLY the wall rectangle —
    // eave->ground vertically, wall-width horizontally, no roof/sky/neighbours — so map it 1:1
    // onto the wall quad: quad spans the full wall (ground=base .. eave=base+wallH) and the whole
    // crop (U 0..1 = wall left..right, V 0=eave .. 1=ground). No roof-pad recovery needed.
    const bottomY = base, topY = base + wallH, vBottom = 1, vTop = 0, u0 = 0, u1 = 1;
    // Inset: the panel must sit JUST proud of the wall and all its surface details
    // (window trim/glass/garage push out to ~0.145 m), so 0.16 m keeps the photo in front
    // of them without a visible floating gap. Kept consistent across every facade.
    const off = 0.16;
    const A = [A0[0] + nx * off, bottomY, A0[1] + nz * off];
    const B = [B0[0] + nx * off, bottomY, B0[1] + nz * off];
    const Cc = [B0[0] + nx * off, topY, B0[1] + nz * off];
    const Dd = [A0[0] + nx * off, topY, A0[1] + nz * off];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...A, ...B, ...Cc, ...A, ...Cc, ...Dd], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, vBottom, u1, vBottom, u1, vTop, u0, vBottom, u1, vTop, u0, vTop], 2));
    g.computeVertexNormals();
    const matName = `SVFacade_${wall.building}_${wall.edge}`;
    // Low emissive: the SV JPEG is already a fully-lit photo, so a high emissive (was 0.16)
    // washed it out into a pale floating decal that let the stucco wall read through it.
    // A small lift keeps it from going muddy in shade while it still reads as the real face.
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, name: matName, emissive: new THREE.Color(1, 1, 1).multiplyScalar(0.05) });
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
  emitGroundRibbon(lineW, width, lift, terrainAt, posArr, idxArr);
}
// Flat water: real creeks don't climb hillsides. The centerline rises across the
// neighborhood, so one giant flat plane is wrong, but draping every vertex on the
// DEM makes "water" climb banks and streets. Densify the creek and split it into
// short elevation-bounded runs; each run gets one flat water surface at its local
// channel floor. Result: the whole creek path remains visible, but water reads as
// level pools/steps instead of a road-like terrain ribbon.
function flatWaterRibbon(lineW, width, lift, posArr, idxArr) {
  const hw = width / 2;
  // densify so a flat run still hugs the channel laterally and step boundaries are fine
  const dense = [lineW[0]];
  for (let k = 1; k < lineW.length; k++) {
    const a = lineW[k - 1], b = lineW[k], seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(seg / 2.0));
    for (let s = 1; s <= steps; s++) dense.push([a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps]);
  }
  const elev = dense.map(([x, z]) => terrainAt(x, z));
  const MAX_RUN_ELEV_RANGE = 0.9;             // m, flatness budget per visible water run
  const runs = [];
  let cur = [0], lo = elev[0], hi = elev[0];
  for (let k = 1; k < dense.length; k++) {
    const nlo = Math.min(lo, elev[k]);
    const nhi = Math.max(hi, elev[k]);
    if (cur.length >= 2 && nhi - nlo > MAX_RUN_ELEV_RANGE) {
      runs.push(cur);
      cur = [k - 1, k];
      lo = Math.min(elev[k - 1], elev[k]);
      hi = Math.max(elev[k - 1], elev[k]);
    } else {
      cur.push(k);
      lo = nlo;
      hi = nhi;
    }
  }
  if (cur.length) runs.push(cur);
  for (const run of runs) {
    if (run.length < 2) continue;
    const ys = run.map(k => elev[k]).sort((a, b) => a - b);
    const runFloor = ys[Math.floor(0.15 * (ys.length - 1))];
    const surfaceY = runFloor - lift;         // ONE flat surface for this whole run (lift = depth below floor)
    let prevOff = null;
    for (const k of run) {
      const [x, z] = dense[k], p = dense[Math.max(0, k - 1)], q = dense[Math.min(dense.length - 1, k + 1)];
      let dx = q[0] - p[0], dz = q[1] - p[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const nx = -dz, nz = dx, lx = x + nx * hw, lz = z + nz * hw, rx = x - nx * hw, rz = z - nz * hw;
      const off = posArr.length / 3;
      posArr.push(lx, surfaceY, lz, rx, surfaceY, rz);   // dead-level water, both banks same Y
      if (prevOff !== null) { const a = prevOff, b = a + 1, c = off, d = off + 1; idxArr.push(a, c, b, b, c, d); }
      prevOff = off;
    }
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
// Path-aligned UVs for the concrete ribbons (sidewalks + curbs). Anchoring the score-line
// grid to the ribbon direction (not the world axes) keeps the joints as classic SQUARES on
// diagonal runs instead of rotated DIAMONDS. CONCRETE_TILE sets the joint cell size: lines
// fall at u=0.25,0.75 within each tile (half-tile spacing), so a 2.5 m tile → ~1.25 m cells.
const swUv = [], cuUv = [], swSrcUv = [];
const CONCRETE_TILE = 2.5;
// Layer stack (m above terrain). The GAME TARGET IS UNITY, which has NO runtime
// polygonOffset (the web Level.jsx tuneMaterial bias does NOT exist there), so the
// ORDERED GEOMETRIC LIFT is the primary z-fight defence: each paved layer must win the
// depth test against the terrain (and against the layer below it) by GEOMETRY alone.
// Kept cm-scale and terrain-draped so surfaces still hug the ground (never the old
// 0.22-0.6 m floating values), but with each layer clearly separated by >=2 cm and
// ORDERED bottom->top: asphalt < driveway < dash < sidewalk < curb (curb highest).
// TINY realistic lifts. Now that terrainAt returns the EXACT terrain-mesh height (above), each paved
// ribbon sits exactly `lift` above the real surface everywhere, so z-fighting is gone WITHOUT a big
// geometric lift. These are real-world curb/slab thicknesses (curb ~9cm, sidewalk ~6cm) so the skirt
// edges read correctly instead of as chunky slabs. Order: curb > dash > sidewalk > driveway > asphalt
// where layers overlap.
const LIFT_ASPHALT = 0.09, LIFT_DRIVEWAY = 0.10, LIFT_DASH = 0.11, LIFT_SIDEWALK = 0.12, LIFT_CURB = 0.15;
// Asphalt PADS (cul-de-sac bulbs, junction blend fillets, dead-end caps) are coincident
// with the road ribbon in the SAME 'Roads' mesh -> z-fight at the same Y. Lift them just
// above the ribbon (still below the dash) so they win cleanly without floating.
const LIFT_ASPHALT_PAD = LIFT_ASPHALT + 0.01;
// Skirt = vertical edge wall dropped from a raised slab's outer edges down to the lawn so the
// slab MEETS the ground instead of hovering. Sidewalks/curbs sit 26-34 cm up; without a skirt
// you see a floating gap at eye level. Drop the wall the full lift (minus a hair so its foot
// tucks just into the grass, no z-fight). The asphalt road keeps no skirt (it's the lowest
// layer and the curb already walls its edge).
const SKIRT_SIDEWALK = LIFT_SIDEWALK - 0.02, SKIRT_CURB = LIFT_CURB - 0.02;
const SW_WIDTH = 1.8, SW_GAP = 2.2;         // road edge -> sidewalk centre spacing
const CURB_WIDTH = 0.55;                     // curb ribbon width (top score lines tile across this)
// Gap-fill DIRT strip between the curb's outer edge and the sidewalk's inner edge. Sits a
// hair (5 mm) above the asphalt and clearly BELOW both concrete tops (sidewalk 0.12, curb
// 0.16); built wide enough (+0.3 m) to tuck UNDER the curb + sidewalk edges so there is no
// open vertical trench to fall into and no coincidence with the concrete layers. Matte
// brown 'GapDirt' material; collider copies these buffers so collision stays consistent.
const LIFT_GAPFILL = LIFT_SIDEWALK - 0.01;   // concrete gutter just below the sidewalk (was ~road level → grazing-angle z-fight)
const gfPos = [], gfIdx = [];
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
function curbRibbon(lineW, width, lift, posArr, idxArr, skip, skirt, uvArr) {
  // skirt = slab thickness to drop a vertical edge wall to grade (no floating gap);
  // pass the layer's lift so the slab visibly meets the lawn instead of hovering.
  // uvArr (optional): path-aligned concrete UVs (square joints on diagonal runs).
  emitGroundRibbon(lineW, width, lift, terrainAt, posArr, idxArr,
    { skip, skirt: skirt || 0, uvArr: uvArr || null, uvTile: CONCRETE_TILE });
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
function sourceRibbon(lines, width, lift, posArr, idxArr, skip = null, skirt = 0, uvArr = null) {
  for (const src of lines || []) {
    const pl = src.p || src;
    if (!Array.isArray(pl) || pl.length < 2) continue;
    for (let piece of clipPolylineToBox(pl, ROAD_HALF)) {
      piece = smoothLine(piece);
      if (piece.length < 2) continue;
      curbRibbon(piece, width, lift, posArr, idxArr, skip, skirt, uvArr);
      roadLines.push(piece);
    }
  }
}

// shared junction/dead-end vertex map and rank lookup
const vertHit = buildVertHit(S.roads || [], w2);
const roadJunctions = buildRoadJunctions(S.roads || [], w2, { includeService: true });
const junctionPts = roadJunctions.map(j => [j.x, j.z]);       // shared + geometric road junctions
const R_TRIM_FOR = w => w / 2 + 0.5;
// at a junction vertex, the widest road meeting there (drives trim distance + pad size)
const junctionWidth = new Map(roadJunctions.map(j => [vkey(j.x, j.z), j.width || 7]));
const junctionMaxRank = new Map(roadJunctions.map(j => [vkey(j.x, j.z), j.maxRank || 0]));
const streetSegs = roadSegmentsWorld(S.roads || [], w2, { includeService: false });
const mappedLineSegs = (lines, width) => {
  const segs = [];
  for (const src of lines || []) {
    const pl = src.p || src;
    if (!Array.isArray(pl) || pl.length < 2) continue;
    for (let i = 1; i < pl.length; i++) segs.push({ a: pl[i - 1], b: pl[i], width });
  }
  return segs;
};
const mappedWalkSegs = mappedLineSegs(mapSurfaces.sidewalks || [], SW_WIDTH);
const mappedCrossingSegs = mappedLineSegs(mapSurfaces.crossings || [], 2.4);
const nearSegs = (x, z, segs, margin) => segs.some(s => distPointSeg(x, z, s.a[0], s.a[1], s.b[0], s.b[1]).d < s.width / 2 + margin);
// MUTUAL EXCLUSION (no two concrete sets at different lifts overlapping -> seam z-fight in
// Unity): the GENERATED sidewalk skips wherever its OWN footprint would touch a MAPPED
// ribbon's footprint. The mapped ribbon's real drawn half-width (s.width/2, the SINGLE
// source of truth) plus the generated ribbon's own half-width plus a small seam guard is
// exactly the band the generated walk must vacate so the two never double-cover.
const SEAM_GUARD = 0.25;
const GEN_SW_HALF = SW_WIDTH / 2;
const nearMappedWalk = (x, z) => nearSegs(x, z, mappedWalkSegs, GEN_SW_HALF + SEAM_GUARD) || nearSegs(x, z, mappedCrossingSegs, GEN_SW_HALF + SEAM_GUARD);
const insideStreetSurface = (x, z) => streetSegs.some(s => distPointSeg(x, z, s.a[0], s.a[1], s.b[0], s.b[1]).d < s.spec.width / 2 + 0.6);
// MAPPED sidewalk skips inside the street surface (where the asphalt ribbon already paves)
// AND wherever a GENERATED road-edge sidewalk is drawn, so mapped vs generated stay mutually
// exclusive. Generated road-edge sidewalk centre sits at road_half + SW_GAP from the
// centreline; its footprint reaches road_half + SW_GAP ± GEN_SW_HALF. The mapped ribbon's
// own half-width plus that band is where the two would double-cover -> skip the mapped there.
const nearGeneratedSidewalk = (x, z) => streetSegs.some(s => {
  const d = distPointSeg(x, z, s.a[0], s.a[1], s.b[0], s.b[1]).d;
  const c = s.spec.width / 2 + SW_GAP;                       // generated walk centre offset
  return Math.abs(d - c) < GEN_SW_HALF + GEN_SW_HALF + SEAM_GUARD;
});
const skipMappedSidewalk = (x, z) => insideStreetSurface(x, z) || nearGeneratedSidewalk(x, z);
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
const skipGeneratedSidewalk = (x, z) => skipNearJunction(x, z) || nearMappedWalk(x, z);

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
    curbRibbon(offsetLine(piece, spec.width / 2 + 0.3), CURB_WIDTH, LIFT_CURB, cuPos, cuIdx, skipNearJunction, SKIRT_CURB, cuUv);
    curbRibbon(offsetLine(piece, -(spec.width / 2 + 0.3)), CURB_WIDTH, LIFT_CURB, cuPos, cuIdx, skipNearJunction, SKIRT_CURB, cuUv);
    if (spec.lanes >= 2) centreDashes(piece, 0.14, LIFT_DASH, skipNearJunction);
    if (!spec.isService) {
      const swDist = spec.width / 2 + SW_GAP;
      curbRibbon(offsetLine(piece, swDist), SW_WIDTH, LIFT_SIDEWALK, swPos, swIdx, skipGeneratedSidewalk, SKIRT_SIDEWALK, swUv);
      curbRibbon(offsetLine(piece, -swDist), SW_WIDTH, LIFT_SIDEWALK, swPos, swIdx, skipGeneratedSidewalk, SKIRT_SIDEWALK, swUv);
      // GAP FILLER: a thin DIRT/ground strip bridging the open vertical gap between the
      // sidewalk's road-side edge and the curb (sidewalk inner edge ≈ road+1.3 m, curb outer
      // edge ≈ road+0.575 m → ~0.7 m of open trench you could fall into). Build a flat brown
      // ribbon centred in that band so there is no hole and the player can't fall through.
      const gapInner = spec.width / 2 + 0.3 + CURB_WIDTH / 2;       // curb outer edge
      const gapOuter = swDist - SW_WIDTH / 2;                       // sidewalk inner edge
      const gapMid = (gapInner + gapOuter) / 2, gapW = Math.max(0.25, gapOuter - gapInner + 0.3);
      curbRibbon(offsetLine(piece, gapMid), gapW, LIFT_GAPFILL, gfPos, gfIdx, skipNearJunction, 0);
      curbRibbon(offsetLine(piece, -gapMid), gapW, LIFT_GAPFILL, gfPos, gfIdx, skipNearJunction, 0);
    }
  }
}
// Road-edge sidewalks: actual pedestrian paths run parallel to the carriageway,
// then meet through rounded connector arcs around intersection curb returns.
for (const run of buildSidewalkConnectors(S.roads || [], w2, {
  sideGap: SW_GAP,
  step: 1.2,
  maxRunLen: 30,
  inPatch: (x, z) => inTerrain(x, z, 6),
  avoid: nearMappedWalk,
  junctions: roadJunctions,
  roadSegments: streetSegs,
})) curbRibbon(run, SW_WIDTH, LIFT_SIDEWALK, swPos, swIdx, null, SKIRT_SIDEWALK, swUv);
for (const run of buildSidewalkEndCaps(S.roads || [], w2, {
  sideGap: SW_GAP,
  inPatch: (x, z) => inTerrain(x, z, 6),
  avoid: nearMappedWalk,
  isCourt,
  roadSegments: streetSegs,
})) curbRibbon(run, SW_WIDTH, LIFT_SIDEWALK, swPos, swIdx, null, SKIRT_SIDEWALK, swUv);
// cul-de-sac bulbs / service end-caps at true dead-ends inside ROAD_HALF.
// Court bulbs were precomputed above (reused here so dashes/curbs avoided them);
// service stubs just get a small rounded end-cap (no fake roundabout).
// emitAsphalt feeds ONLY the cul-de-sac bulbs, junction blend pads and dead-end caps —
// not the through-road ribbon (that uses ribbon() at LIFT_ASPHALT). These pads are
// coincident with the ribbon in the same 'Roads' mesh, so lift them to LIFT_ASPHALT_PAD
// (just above the ribbon, still below the dash) to kill the z-fight in Unity.
const emitAsphalt = (x, z) => { const o = rPos.length / 3; rPos.push(x, terrainAt(x, z) + LIFT_ASPHALT_PAD, z); return o; };
const emitDriveway = (x, z) => { const o = drvPos.length / 3; drvPos.push(x, terrainAt(x, z) + LIFT_DRIVEWAY, z); return o; };
// Bulb rings are circular (no diagonal run), so a world-planar concrete UV reads fine here;
// we still push a uv per vert so the merged mesh's uv attribute count matches its positions.
const emitCurb = (x, z) => { const o = cuPos.length / 3; cuPos.push(x, terrainAt(x, z) + LIFT_CURB, z); cuUv.push(x / CONCRETE_TILE, z / CONCRETE_TILE); return o; };
const emitSidewalk = (x, z) => { const o = swPos.length / 3; swPos.push(x, terrainAt(x, z) + LIFT_SIDEWALK, z); swUv.push(x / CONCRETE_TILE, z / CONCRETE_TILE); return o; };
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
sourceRibbon(mapSurfaces.sidewalks || [], SW_WIDTH, LIFT_SIDEWALK + 0.03, swSrcPos, swSrcIdx, skipMappedSidewalk, SKIRT_SIDEWALK, swSrcUv);
// ZEBRA crosswalk: instead of one solid concrete ribbon, lay painted bars ALONG each crossing
// path (parallel to traffic), each bar spanning the crossing width — the classic zebra look.
// Reuses the dash-walk cadence (centreDashes) but emits full-width quads. Kept in xwalkPos/Idx
// so it stays the Crosswalks_Mapped node (same material/UV treatment downstream).
function zebraCrosswalk(lines, width, lift, posArr, idxArr) {
  const hw = width / 2, BAR = 0.6, GAP = 0.6;        // 0.6 m painted bar / 0.6 m gap
  for (const src of lines || []) {
    const pl = src.p || src;
    if (!Array.isArray(pl) || pl.length < 2) continue;
    for (let piece of clipPolylineToBox(pl, ROAD_HALF)) {
      piece = smoothLine(piece);
      if (piece.length < 2) continue;
      let draw = true, acc = 0;
      for (let k = 1; k < piece.length; k++) {
        const a = piece[k - 1], b = piece[k];
        let dx = b[0] - a[0], dz = b[1] - a[1];
        const seg = Math.hypot(dx, dz) || 1; dx /= seg; dz /= seg;
        const nx = -dz, nz = dx;                       // across-path = crossing width direction
        let t = 0;
        while (t < seg - 1e-6) {
          const len = Math.min((draw ? BAR : GAP) - acc, seg - t);
          if (draw) {
            const x0 = a[0] + dx * t, z0 = a[1] + dz * t, x1 = a[0] + dx * (t + len), z1 = a[1] + dz * (t + len);
            const o = posArr.length / 3;
            posArr.push(x0 + nx * hw, terrainAt(x0 + nx * hw, z0 + nz * hw) + lift, z0 + nz * hw,
                        x0 - nx * hw, terrainAt(x0 - nx * hw, z0 - nz * hw) + lift, z0 - nz * hw,
                        x1 - nx * hw, terrainAt(x1 - nx * hw, z1 - nz * hw) + lift, z1 - nz * hw,
                        x1 + nx * hw, terrainAt(x1 + nx * hw, z1 + nz * hw) + lift, z1 + nz * hw);
            idxArr.push(o, o + 1, o + 2, o, o + 2, o + 3);
          }
          t += len; acc += len;
          if (acc >= (draw ? BAR : GAP) - 1e-6) { draw = !draw; acc = 0; }
        }
      }
    }
  }
}
zebraCrosswalk(mapSurfaces.crossings || [], 2.4, LIFT_SIDEWALK + 0.04, xwalkPos, xwalkIdx);
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
// Flat paved ground gets WORLD-PLANAR UVs (planarUV = metres/tile) so the procedural
// asphalt/concrete textures attached downstream tile at a real-world scale: asphalt ~5 m,
// concrete (sidewalk/curb) ~2.5 m. Roughness: asphalt 0.95, concrete 0.9.
if (rIdx.length) scene.add(mkMesh(rPos, rIdx, 0x2f2f33, 'Roads', { planarUV: 5.0, rough: 0.95 }));
if (drvIdx.length) scene.add(mkMesh(drvPos, drvIdx, 0x77787a, 'Driveways', { planarUV: 4.5, rough: 0.95 }));
if (drvSrcIdx.length) scene.add(mkMesh(drvSrcPos, drvSrcIdx, 0x7d7f80, 'Driveways_Mapped', { planarUV: 4.5, rough: 0.95 }));
if (parkSrcIdx.length) scene.add(mkMesh(parkSrcPos, parkSrcIdx, 0x6f7272, 'ParkingAreas_Mapped', { planarUV: 5.0, rough: 0.95 }));
// Sidewalks/curbs use PATH-ALIGNED uvs (built alongside their geometry) so the concrete
// score-line grid reads as classic SQUARES along the walk instead of world-axis diamonds.
if (swIdx.length) scene.add(mkMesh(swPos, swIdx, 0xb9b6ae, 'Sidewalks', { uvs: swUv, rough: 0.9 }));   // light concrete, road-edge derived
if (swSrcIdx.length) scene.add(mkMesh(swSrcPos, swSrcIdx, 0xc4c0b6, 'Sidewalks_Mapped', { uvs: swSrcUv, rough: 0.9 }));
if (xwalkIdx.length) scene.add(mkMesh(xwalkPos, xwalkIdx, 0xd9d5ca, 'Crosswalks_Mapped', { planarUV: 3.0, rough: 0.95 }));
// Curb tops now carry the SAME path-aligned concrete score lines the sidewalks have (they
// were blank before): the concrete material keys off /curb/i and these uvs tile the joints.
if (cuIdx.length) scene.add(mkMesh(cuPos, cuIdx, 0xcacaca, 'RoadCurbs', { uvs: cuUv, rough: 0.9 }));
// Gap-fill dirt strip bridging sidewalk edge → curb (matte brown, no score texture).
if (gfIdx.length) scene.add(mkMesh(gfPos, gfIdx, 0xb4b1a8, 'GapDirt', { rough: 1.0 }));   // concrete-gray gutter (blends with sidewalk; was brown -> ugly chevron at grazing angles)
if (dPos.length) scene.add(mkMesh(dPos, null, 0xf2c81e, 'RoadLines'));

// creek ribbon
let creekW = null;
// Creek geometry constants — defined BEFORE the snap so the building-avoidance margin
// can keep the centreline far enough out that the FULL ribbon (water + banks) clears
// houses, not just the centreline (the old 1.2 m margin let the 6 m water cut through).
const CREEK_WIDTH = Number.isFinite(+process.env.CREEK_WIDTH_M) ? +process.env.CREEK_WIDTH_M : 7.5;
const CREEK_DEPTH = Number.isFinite(+process.env.CREEK_DEPTH_M) ? +process.env.CREEK_DEPTH_M : 0.05;
const CREEK_BUILDING_MARGIN = CREEK_WIDTH / 2 + 1.75;   // halfwidth + bank lip + slack
if (S.creek && S.creek.p) {
  creekW = S.creek.p.map(([e, n]) => w2(e, n)).filter(([x, z]) => Math.abs(x) <= cropHalf + 3 && Math.abs(z) <= cropHalf + 3);
  creekW = snapCreekToChannel(creekW, terrainAt, {
    radius: 18,
    step: 1.5,
    strength: 0.9,
    smoothPasses: 2,
    avoidSegments: roadSegmentsWorld(S.roads || [], w2, { includeService: true }),
    avoidMargin: 2.0,
    avoidPolygons: buildingPolys,
    avoidPolygonMargin: CREEK_BUILDING_MARGIN,
  });
  if (creekW.length >= 2) {
    const cPos = [], cIdx = []; flatWaterRibbon(creekW, CREEK_WIDTH, CREEK_DEPTH, cPos, cIdx);
    // Bright, glossy, slightly reflective water so it reads as WET in Blender/USDZ/Unity
    // (all honour metallic/roughness) — not a dark matte navy strip that looks like asphalt.
    const cr = mkMesh(cPos, cIdx, 0x2f8fd8, 'Creek_SanLorenzo', { rough: 0.18, metal: 0.15 });
    cr.material.name = 'Creek_mat'; scene.add(cr);
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
// Owner-house cues (front door/garage window placement) are RESIDENTIAL — on a school/place
// export the house:true footprint is actually a SCHOOL, so skip these cues there.
const houseCue = { glass: [], trim: [] };
if (!IS_SCHOOL_EXPORT) emitOwnerHouseFacadeCues(houseRing, houseWallH, houseCue);
if (houseCue.trim.length) scene.add(mkMesh(houseCue.trim, null, 0xd8d0bd, 'House_window_trim'));
if (houseCue.glass.length) scene.add(mkMesh(houseCue.glass, null, 0x223647, 'House_windows'));

const dwPos = [], dwCol = [], garagePos = [], garageTrim = [], DOORCOL = [0.26, 0.18, 0.12];
// Door FRAME (jambs + lintel) and a TRANSOM glass panel above each door. Coloured to match the
// building window trim/windows so they fold visually into that family. Kept in their own meshes
// because bD.trim/bD.glass are already consumed into Buildings_window_trim/Buildings_windows above.
const doorTrim = [], doorGlass = [];
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
  // DOOR FRAME + TRANSOM: a trim surround (left/right jambs + a head lintel) just proud of the
  // slab, plus a glass transom panel above the head. `sd` = door centre distance along the edge,
  // `base` here is the door slab base (terrainAt - 0.1). pushWallRect measures s from (ax,az).
  const sd = t * L, jw = 0.10, head = 0.10;
  pushWallRect(doorTrim, ax, az, ex, ez, nx, nz, sd - hw - jw, sd - hw, base, base + H + head, 0.10);          // left jamb
  pushWallRect(doorTrim, ax, az, ex, ez, nx, nz, sd + hw, sd + hw + jw, base, base + H + head, 0.10);          // right jamb
  pushWallRect(doorTrim, ax, az, ex, ez, nx, nz, sd - hw - jw, sd + hw + jw, base + H, base + H + head, 0.10); // head lintel
  pushWallRect(doorGlass, ax, az, ex, ez, nx, nz, sd - hw + 0.04, sd + hw - 0.04, base + H + head, base + H + head + 0.42, 0.112); // transom
  if (bi === 0 && !IS_SCHOOL_EXPORT) {     // residential owner-house garage; never on a SCHOOL export
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
// door frame trim / transom glass — same colours as Buildings_window_trim / Buildings_windows
if (doorTrim.length) scene.add(mkMesh(doorTrim, null, 0xd2c9b8, 'Doors_trim'));
if (doorGlass.length) scene.add(mkMesh(doorGlass, null, 0x203342, 'Doors_transom'));
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
    const creekWidth = CREEK_WIDTH;   // shared with the water emit so banks hug the water edge
    const bankPos = [], bankIdx = [], rockPos = [], rockIdx = [], reedPos = [];
    // Thin vegetated bank lip snug to the (wider) water edge — a narrow grassy/silty rim,
    // not the old wide flat brown strip that read as a dirt road flanking the channel.
    ribbon(offsetLine(creekW, creekWidth / 2 + 0.35), 0.45, 0.055, bankPos, bankIdx);
    ribbon(offsetLine(creekW, -(creekWidth / 2 + 0.35)), 0.45, 0.055, bankPos, bankIdx);
    // No authored flow-line strips: in the raw GLB they read as road/lane markings.
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
    if (bankIdx.length) scene.add(mkMesh(bankPos, bankIdx, 0x5a6b46, 'Creek_Banks', { rough: 1.0 }));
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
    if (creekW && creekW.length >= 2 && rand() < 0.55) {
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
  for (let i = 0; i < srcPos.length; i++) dstPos.push(srcPos[i]);
  for (const i of srcIdx) dstIdx.push(base + i);
}
function pushExtrudedRing(pos, idx, ring, base, h) {
  if (!ring || ring.length < 3) return;
  const off = pos.length / 3;
  // PER-CORNER bottoms drop to terrainAt(corner) - WALL_EMBED so the collision envelope
  // matches the visible wall silhouette on slopes (the walls in pushWallFace bottom at the
  // same per-corner terrain - WALL_EMBED). A single flat min-based base used to under/over-
  // shoot the wall foot on a slope, leaving a collision lip or gap below the downhill wall.
  for (const [x, z] of ring) pos.push(x, Math.min(base + h - 0.1, terrainAt(x, z) - WALL_EMBED), z);
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

  // Include the GapDirt filler (gfPos/gfIdx) in the road collider so the player walks across
  // the sidewalk→curb bridge instead of falling into the gap it closes (collision consistent).
  const roadColPos = [], roadColIdx = [];
  for (const [p, ix] of [[rPos, rIdx], [drvPos, drvIdx], [drvSrcPos, drvSrcIdx], [parkSrcPos, parkSrcIdx], [swPos, swIdx], [swSrcPos, swSrcIdx], [xwalkPos, xwalkIdx], [gfPos, gfIdx]]) appendIndexed(p, ix, roadColPos, roadColIdx);
  if (roadColIdx.length) scene.add(mkMesh(roadColPos, roadColIdx, 0x00ffff, 'Collision_Roads', { opacity: 0 }));

  const bPos = [], bIdx = [];
  for (const b of buildingCollision) pushExtrudedRing(bPos, bIdx, b.ring, b.base, b.h);
  if (bIdx.length) {
    scene.add(mkMesh(bPos, bIdx, 0xff00ff, 'Collision_Buildings', { opacity: 0 }));
    scene.add(mkMesh(bPos, bIdx, 0x808080, 'LOD_Buildings_Low', { opacity: 0 }));
  }

  // NOTE: the visual 'Trees' group + the 'Collision_Trees' trunk-box collider are emitted by
  // emitTreeLayers() below, driven by exports/trees_placed.json (so an orchestrator can swap in
  // canyon/stanton's placements). pushTreeCylinder stays available for that path's fallback.
}
addGameLevelLayers();

// ---- Trees: self-contained, Blender-free emission ------------------------
// Reads exports/trees_placed.json (written above for dahill; an orchestrator swaps the file
// for canyon/stanton) and adds TWO nodes:
//   'Trees'           — a Group of per-placement instanced tree meshes. Each placed tree picks
//                       the library template whose height_m is closest to its target height,
//                       scales s = height / template.height_m, yaws by a DETERMINISTIC angle
//                       from the tree index (stable across re-runs, no Math.random), and REUSES
//                       the SAME 6 shared geom+mat objects so the downstream build folds them
//                       into EXT_mesh_gpu_instancing (do NOT bake per-tree transformed geometry).
//   'Collision_Trees' — one merged mesh of thin trunk boxes (0.35 m square, 2.2 m tall) so the
//                       player bumps trunks without the canopy blocking. The build pipeline
//                       ASSERTS a node named Collision_Trees exists.
// Missing trees_placed.json or tree_lib -> trees are skipped gracefully (still emits an empty
// Collision_Trees so the downstream assertion holds).
let nTreeInstances = 0, treeLayerSrc = 'none';
async function emitTreeLayers() {
  const placedPath = path.join(ROOT, 'exports/trees_placed.json');
  // thin trunk-box collider, baked into plain arrays (one ~0.35 m x 2.2 m box per tree).
  const trPos = [], trIdx = [];
  const pushTrunkBox = (x, z, half = 0.175, h = 2.2) => {
    const base = trPos.length / 3, y0 = terrainAt(x, z), y1 = y0 + h;
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [sx, sz] of c) trPos.push(x + sx * half, y0, z + sz * half, x + sx * half, y1, z + sz * half);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      trIdx.push(base + k * 2, base + j * 2, base + j * 2 + 1, base + k * 2, base + j * 2 + 1, base + k * 2 + 1);
    }
    // cap top so the collider is a closed box (floor sits on terrain; top closes the prism)
    trIdx.push(base + 1, base + 3, base + 5, base + 1, base + 5, base + 7);
  };

  if (existsSync(placedPath)) {
    const placed = (JSON.parse(readFileSync(placedPath, 'utf8')).trees) || [];
    const templates = await loadTreeTemplates();
    if (templates && templates.length && placed.length) {
      const treesGroup = new THREE.Group(); treesGroup.name = 'Trees';
      // deterministic per-index 32-bit hash (stable across runs; no Math.random)
      const hashOf = (i) => Math.imul((i | 0) + 0x9e3779b9, 2654435761) >>> 0;
      const yawOf = (i) => (hashOf(i) / 4294967296) * Math.PI * 2;
      // NON-feature templates (Acacia kept as the rare feature tree only), sorted by height so
      // the closest-height candidates are easy to pick. Feature templates are placed only on a
      // rare hash bucket so neighbours don't all become acacias.
      const normalTpls = templates.filter(t => !t.feature);
      const featureTpls = templates.filter(t => t.feature);
      const pool = normalTpls.length ? normalTpls : templates;
      // Template selection: among the 2-3 templates CLOSEST in height to the target, pick one by
      // an index hash so similar-height NEIGHBOURS get DIFFERENT templates (no rows of clones)
      // while staying height-appropriate. ~1-in-9 trees becomes the rare Acacia feature tree.
      const pickTemplate = (height, h) => {
        if (featureTpls.length && (h % 9) === 0) return featureTpls[(h >>> 8) % featureTpls.length];
        const ranked = [...pool].sort((a, b) => Math.abs((a.height_m || 6) - height) - Math.abs((b.height_m || 6) - height));
        const k = Math.min(3, ranked.length);
        return ranked[(h >>> 4) % k];
      };
      for (const t of placed) {
        const x = +t.x, z = +t.z, height = +t.height || 7;
        const base = Number.isFinite(+t.base) ? +t.base : terrainAt(x, z);
        if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(base)) continue;
        const idxKey = t.i ?? nTreeInstances;
        const h = hashOf(idxKey);
        const tmpl = pickTemplate(height, h);
        const s = Math.max(0.1, height / (tmpl.height_m || 6));
        // per-instance (leaf hue x bark hue) variant; REUSE the same variant array per template
        // so the build folds (geom, variantArray) into one GPU-instanced batch per variant.
        const variantArr = tmpl.variants[(h >>> 12) % tmpl.variants.length];
        const m = new THREE.Mesh(tmpl.geom, variantArr);   // SHARE geom + variant array by reference
        m.position.set(x, base, z);
        m.scale.setScalar(s);
        m.rotation.y = yawOf(idxKey);
        m.name = 'Tree_' + idxKey;
        treesGroup.add(m);
        pushTrunkBox(x, z);
        nTreeInstances++;
      }
      scene.add(treesGroup);
      treeLayerSrc = `trees_placed.json (${nTreeInstances} instances, ${templates.length} templates)`;
    } else {
      treeLayerSrc = templates ? 'trees_placed.json empty' : 'tree_lib missing (visual trees skipped)';
    }
  } else {
    treeLayerSrc = 'no trees_placed.json (trees skipped)';
  }
  // Always emit Collision_Trees (the downstream build asserts the node exists). If no trees were
  // placed, drop ONE tiny throwaway box at the patch corner so the node carries valid (finite,
  // non-empty) geometry instead of a degenerate index into an empty buffer.
  if (!trIdx.length) pushTrunkBox(tXmin + 1, tZmin + 1, 0.05, 0.1);
  scene.add(mkMesh(trPos, trIdx, 0x00ff00, 'Collision_Trees', { opacity: 0 }));
}
await emitTreeLayers();

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
  const SHOW_LOTLINES = process.env.SHOW_LOTLINES === 'true';
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

// ---- procedural paved/roof detail textures -------------------------------
// Tiny (256^2), TILEABLE, very SUBTLE procedural textures so roads/sidewalks/curbs/
// driveways/roofs read as real material instead of flat plastic from eye height. Built
// with sharp from raw RGB so they're a few KB and compress well downstream (KTX2).
// Wrap-safety: low-frequency mottle uses integer-frequency sines (perfectly periodic
// over the tile) and grain uses a periodic hash, so opposite edges always match.
const { default: sharp } = await import('sharp');
const TEX_N = 256;
const hash2 = (x, y) => {                                   // periodic value hash in [0,1)
  let h = Math.sin((x * 127.1 + y * 311.7)) * 43758.5453;
  return h - Math.floor(h);
};
// build one tileable texture. `shade(u,v)->[r,g,b]` returns 0..255 per channel for the
// normalised tile coords u,v in [0,1). All randomness must be periodic in u,v.
async function makeTileTex(name, shade) {
  const buf = Buffer.alloc(TEX_N * TEX_N * 3);
  for (let j = 0; j < TEX_N; j++) for (let i = 0; i < TEX_N; i++) {
    const [r, g, b] = shade(i / TEX_N, j / TEX_N);
    const k = (j * TEX_N + i) * 3;
    buf[k] = Math.max(0, Math.min(255, r | 0));
    buf[k + 1] = Math.max(0, Math.min(255, g | 0));
    buf[k + 2] = Math.max(0, Math.min(255, b | 0));
  }
  const png = await sharp(buf, { raw: { width: TEX_N, height: TEX_N, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();
  return { name, png };
}
const TAU = Math.PI * 2;
// periodic fine grain: hash the wrapped integer cell so left/right + top/bottom match.
const grain = (u, v, scale) => {
  const x = Math.floor(u * scale) % scale, y = Math.floor(v * scale) % scale;
  return hash2(x, y) - 0.5;                                 // [-0.5,0.5)
};
// periodic low-frequency mottle from a couple of integer-frequency sines (wrap-safe).
const mottle = (u, v) =>
  0.5 * Math.sin(TAU * (u * 2 + v)) + 0.35 * Math.sin(TAU * (u - v * 3)) + 0.25 * Math.sin(TAU * (u * 5 + v * 2));
// asphalt: near-white-grey carrier so it MODULATES the dark base colour (kept on the
// material); subtle speckle + faint mottle. Centred ~200 so it darkens/lightens gently.
const asphaltTex = await makeTileTex('asphalt', (u, v) => {
  const n = 200 + grain(u, v, 128) * 34 + mottle(u, v) * 6;
  return [n, n, n + 1];
});
// concrete: light warm-grey carrier, soft mottling + faint aggregate speckle + a very
// faint scoreline grid (sidewalk control joints) every ~half tile. Modulates the base.
const concreteTex = await makeTileTex('concrete', (u, v) => {
  let n = 210 + mottle(u, v) * 9 + grain(u, v, 96) * 16;
  const joint = (Math.abs(((u + 0.5) % 0.5) - 0.25) < 0.012 || Math.abs(((v + 0.5) % 0.5) - 0.25) < 0.012);
  if (joint) n -= 16;                                       // faint darker control joint
  return [n + 4, n + 2, n - 2];                             // warm tint
});
// shingle/roof: neutral grey carrier with soft horizontal COURSES (rows) + slight
// per-row value variation + fine grain. Stays grey so the per-building roofColor (kept
// on the material) tints it -> each roof keeps its sampled colour, just textured.
const shingleTex = await makeTileTex('shingle', (u, v) => {
  const rows = 8;                                           // 8 shingle courses per tile
  const row = Math.floor(v * rows) % rows;
  const within = (v * rows) % 1;                            // 0..1 down a course
  const courseShade = within < 0.10 ? -22 : (within > 0.92 ? 10 : 0);  // shadow line + lit lip
  const rowVar = (hash2(row, 0) - 0.5) * 26;                // per-row value variation
  const n = 200 + courseShade + rowVar + grain(u, v, 110) * 18 + mottle(u, v * 0.5) * 4;
  return [n, n, n];
});

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
// procedural detail textures (generated above) -> tiled REPEAT over the planar UVs
const asphaltGTex = doc.createTexture('asphalt_detail').setImage(new Uint8Array(asphaltTex.png)).setMimeType('image/png');
const concreteGTex = doc.createTexture('concrete_detail').setImage(new Uint8Array(concreteTex.png)).setMimeType('image/png');
const shingleGTex = doc.createTexture('shingle_detail').setImage(new Uint8Array(shingleTex.png)).setMimeType('image/png');
const REPEAT = 10497, CLAMP = 33071;
let textured = 0;
for (const m of doc.getRoot().listMaterials()) {
  const n = m.getName() || '';
  // never texture the invisible collision/LOD proxies (opacity 0) — e.g. Collision_Roads
  // matches /roads/i. Skip them so they stay untouched.
  const isProxy = /^(Collision_|LOD_)/i.test(n);
  if (aerialTex && !isProxy && /terrain|roofs_photo|ground_pads/i.test(n)) {   // !isProxy: never texture Collision_Terrain (it matches /terrain/) — it must stay an invisible alpha-MASK proxy
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
  } else if (!isProxy && /roads|driveway|parking|crosswalk/i.test(n)) {
    // asphalt detail tiles over the world-planar UVs. The texture is a near-white grey
    // carrier so it MODULATES the dark base colour kept on the material (subtle grain).
    m.setBaseColorTexture(asphaltGTex);
    m.getBaseColorTextureInfo().setWrapS(REPEAT).setWrapT(REPEAT); textured++;
  } else if (!isProxy && /sidewalk|curb/i.test(n)) {
    // concrete detail (mottle + faint scorelines) modulating the light-grey base colour.
    m.setBaseColorTexture(concreteGTex);
    m.getBaseColorTextureInfo().setWrapS(REPEAT).setWrapT(REPEAT); textured++;
  } else if (!isProxy && /roof/i.test(n)) {
    // solid roofs only (roofs_photo already took the aerial above). KEEP the per-building
    // sampled roofColor as the base factor and let the neutral-grey shingle texture
    // modulate it -> each roof stays its own colour, just with shingle courses + grain.
    m.setBaseColorTexture(shingleGTex);
    m.getBaseColorTextureInfo().setWrapS(REPEAT).setWrapT(REPEAT); textured++;
  }
}
writeFileSync(out, Buffer.from(await io.writeBinary(doc)));

const objs = [];
scene.traverse(o => { if (o.isMesh) objs.push(`  ${o.name.padEnd(18)} ${o.geometry.attributes.position.count} verts`); });
console.log(`terrain: ${terrSrc}`);
console.log(`crop half: ${cropHalf.toFixed(0)} m   buildings: ${nBld} (${nSkip} skipped on owner lots)   trees: ${trees.length} (${treeSrc})`);
console.log(`tree layer: ${nTreeInstances} visual instances -> 'Trees' group + 'Collision_Trees' trunk boxes  [${treeLayerSrc}]`);
console.log('layers:\n' + objs.join('\n'));
console.log(`street-view facade overlays: ${nSVFacades}`);
console.log(`textured materials: ${textured} (aerial->terrain/roofs_photo, facade->walls, asphalt->roads/driveways/parking/crosswalks, concrete->sidewalks/curbs, shingle->solid roofs)`);
console.log(`wrote ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
