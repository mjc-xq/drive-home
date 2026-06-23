// Build script for GAME-READY, mobile-web level sets ("build:level-game").
//
// A NEW, ADDITIVE post-export pass. It does NOT touch the current
// build_dahilg_assets.mjs / public/da-hilg/level.glb integration. It consumes the
// uncompressed editable master (exports/<slug>/<slug>.level.glb) and emits a
// SEPARABLE, STREAMABLE, mobile-web game set under exports/<slug>/game/:
//
//   terrain.glb roads.glb buildings.glb trees.glb creek.glb fences.glb
//   collision.glb heightfield.bin manifest.json
//
// Each visual layer is split off by node-name regex (see LAYERS below), then run
// through the SAME meshopt/KTX2 pipeline as build_dahilg_assets.mjs (reused
// verbatim: meshoptPipeline order = dedup->prune->weld->[simplify]->stripDraco->
// KTX2/webp->reorder->quantize->meshopt high; ktx2CompressDoc with per-layer cap;
// simplifyToTarget; instanceStaticRepeats; assertNoDraco/writeAndVerify patterns).
//
// Trees are the headline (7.6M of 10.7M tris): they are GPU-instanced FIRST
// (EXT_mesh_gpu_instancing folds 1055 Tree_# placement nodes down to the handful of
// unique tree meshes), then the UNIQUE meshes are simplified. Terrain collision is
// emitted as a 16-bit heightfield.bin (Rapier HeightfieldCollider, no trimesh bake);
// building collision is rebuilt as one AABB box proxy per building (materials
// stripped). manifest.json carries the layer file list + world bounds + suggested
// load order + per-file byte sizes + the heightfield header.
//
// Run:  node scripts/build_level_game.mjs <slug>        (one level)
//       node scripts/build_level_game.mjs               (all LEVELS; honors DAHILG_ONLY)
//       node scripts/build_level_game.mjs path/to.level.glb   (explicit master path)
//
// The 219 MB dahill master needs headroom: run with
//   node --max-old-space-size=8192 scripts/build_level_game.mjs dahill
import { NodeIO, Logger, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, textureCompress, reorder, quantize, meshopt, getBounds, simplify,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { ktx2CompressDoc } from './lib/ktx2_pass.mjs';
import { mkdirSync, statSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = (...p) => path.join(ROOT, ...p);
const mb = (bytes) => (bytes / 1e6).toFixed(2) + ' MB';
const DRACO_EXT = 'KHR_draco_mesh_compression';

// ---- IO: register BOTH meshopt + draco so we can READ draco-or-mixed masters and WRITE
// meshopt (same as build_dahilg_assets.mjs). The master is a plain GLB but registering
// draco is harmless and matches the sibling script. ERROR-level logger to mute the
// expected out-of-[0,1] TEXCOORD quantize warnings on the tiled facade/aerial UVs.
const io = new NodeIO()
  .setLogger(new Logger(Logger.Verbosity.ERROR))
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
await MeshoptSimplifier.ready;

// =====================================================================================
// LEVELS: same set + DAHILG_ONLY gating as build_dahilg_assets.mjs. Each level's master
// lives at exports/<slug>/<slug>.level.glb; the runtime `offset` is sourced from the
// level's .meta.json in public/da-hilg (dahill keeps the legacy `level.meta.json` name).
// -------------------------------------------------------------------------------------
const LEVELS = [
  { slug: 'dahill',  meta: 'level.meta.json' },
  { slug: 'canyon',  meta: 'canyon.meta.json' },
  { slug: 'stanton', meta: 'stanton.meta.json' },
  { slug: 'meemaw',  meta: 'meemaw.meta.json' },
  { slug: 'xq',      meta: 'xq.meta.json' },
].filter((lv) => {
  const only = process.env.DAHILG_ONLY;
  return !only || only.split(',').map((s) => s.trim()).includes(lv.slug);
});

// =====================================================================================
// LAYER TABLE: node-name -> file. First matching layer wins. A mesh-bearing node that
// matches NOTHING (and is not a reserved Collision_Terrain) is logged UNGROUPED + dropped.
// `optional` layers emit only if they captured at least one mesh.
//   - terrain: the welded visual ground (collider is the heightfield, not this).
//   - roads:   the RoadLayer subtree (draped asphalt/curb/markings/etc.).
//   - buildings: 1600 Building_# + House_* + shared Buildings_* detail + Doors* + the
//                8 facade atlas pages (reachable via materials, ride along).
//   - trees:   the Trees group / Tree_# / Shrubs (GPU-instanced before simplify).
//   - creek/fences: optional decoration.
// Collision_* are handled specially (NOT here): Collision_Terrain -> heightfield (dropped
// from all GLBs); Collision_Buildings -> rebuilt as box proxies in collision.glb;
// Collision_Trees -> dropped (player capsule handles thin trunks).
// -------------------------------------------------------------------------------------
const LAYERS = [
  {
    name: 'terrain', file: 'terrain.glb', required: true, priority: 0, toggleable: false,
    match: (nm) => /^Terrain$/.test(nm),
    simplify: { targetTris: 250000, error: 0.015, minRatio: 0.15 },
    quantizePosition: 16,
    texCap: 2048,
    capFor: (tex) => {
      const n = tex.getName() || '';
      if (/orm|_mr\b|metalrough/i.test(n)) return { maxSize: 1024, hq: false };
      if (/albedo/i.test(n)) return { maxSize: 2048, hq: true };
      return null;
    },
  },
  {
    name: 'roads', file: 'roads.glb', required: false, priority: 2, toggleable: true, optional: true,
    match: (nm) => /^RoadLayer$/.test(nm)
      || /^Roads_(asphalt|sidewalk|curb|crosswalk|driveway|markings_white|markings_yellow)$/.test(nm),
    // Road meshes are unwelded (unique vert per tri) + carry only POSITION+NORMAL. Drop
    // NORMAL so weld can merge coincident positions, THEN simplify reaches ~300k. Error
    // headroom 0.08; markings/curbs tolerate the deviation.
    simplify: { targetTris: 300000, error: 0.08, minRatio: 0.1 },
    dropNormals: true,
    quantizePosition: 14,
    texCap: 1024,
    capFor: () => null,
  },
  {
    name: 'buildings', file: 'buildings.glb', required: true, priority: 1, toggleable: false,
    match: (nm) => /^Building_\d+(_walls|_roof)?$/.test(nm)
      || /^House_(walls|roof|siding_lines|window_trim|windows)$/.test(nm)
      || /^Buildings_(windows|window_trim|siding_lines)$/.test(nm)
      || /^Buildings_facade_page\d+$/.test(nm)
      || /^Doors(_trim|_transom)?$/.test(nm),
    simplify: { targetTris: 180000, error: 0.02, minRatio: 0.1 },
    quantizePosition: 14,
    texCap: 1024,
    capFor: (tex) => {
      const n = tex.getName() || '';
      if (/orm|_mr\b|metalrough/i.test(n)) return { maxSize: 512, hq: false };
      // 8 facade atlas pages dominate the byte budget. UASTC at 1024-hq blew past the
      // ~10 MB cap; 512 with RDO keeps the set under budget and stays legible at the
      // gameplay camera distance (the player rarely presses a wall).
      if (/facade|_atlas/i.test(n)) return { maxSize: 512, hq: false };
      return null;
    },
  },
  {
    name: 'trees', file: 'trees.glb', required: false, priority: 3, toggleable: true, optional: true,
    instanced: true,
    match: (nm) => /^Trees$/.test(nm) || /^Tree_\d+$/.test(nm) || /^Shrubs$/.test(nm),
    // Tree simplify runs on the UNIQUE meshes only, AFTER instancing (see buildTrees).
    treeSimplify: { error: 0.03, ratio: 0.05 },
    quantizePosition: 12,
    texCap: 512,
    capFor: () => null,
  },
  {
    name: 'creek', file: 'creek.glb', required: false, priority: 3, toggleable: true, optional: true,
    match: (nm) => /^Creek_/.test(nm),
    simplify: null,
    quantizePosition: 12,
    texCap: 512,
    capFor: () => null,
  },
  {
    name: 'fences', file: 'fences.glb', required: false, priority: 3, toggleable: true, optional: true,
    match: (nm) => /^Fences$/.test(nm) || /^FenceGreen_\d+$/.test(nm) || /^FencePink_\d+$/.test(nm),
    simplify: { targetTris: 8000, error: 0.03, minRatio: 0.1 },
    quantizePosition: 12,
    texCap: 512,
    capFor: () => null,
  },
];

// Collision_Terrain is reserved for the heightfield: neither emitted as a GLB layer nor
// flagged UNGROUPED. Collision_Trees is intentionally dropped (no tree colliders).
const COLLISION_TERRAIN = 'Collision_Terrain';
const COLLISION_BUILDINGS = 'Collision_Buildings';
const COLLISION_TREES = 'Collision_Trees';

// ---- triangle counter (verbatim shape from build_dahilg_assets.mjs) ------------------
function countTris(doc) {
  let tris = 0, verts = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      tris += idx ? idx.getCount() / 3 : (pos ? pos.getCount() / 3 : 0);
      if (pos) verts += pos.getCount();
    }
  }
  return { tris: Math.round(tris), verts };
}

// ---- drop the Draco extension declaration (copied from build_dahilg_assets.mjs) ------
function stripDraco(doc) {
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === DRACO_EXT) ext.dispose();
  }
}

// ---- triangle-budget decimation (ported from build_dahilg_assets.mjs simplifyToTarget,
// minus the skin-weight re-sort: these are static level meshes with no JOINTS/WEIGHTS) --
async function simplifyToTarget(doc, label, { targetTris, error = 0.02, minRatio = 0.06 }) {
  const before = countTris(doc);
  if (before.tris === 0) return;
  const ratio = Math.min(1, Math.max(minRatio, targetTris / before.tris));
  if (ratio >= 1) {
    console.log(`    simplify: ${label} already ${before.tris} tris <= target ${targetTris} — skipped`);
    return;
  }
  await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: false }));
  const after = countTris(doc);
  console.log(`    simplify: ${label} ratio=${ratio.toFixed(3)} error<=${error} -> ` +
    `${before.tris} -> ${after.tris} tris (${(100 * (1 - after.tris / before.tris)).toFixed(1)}% fewer)`);
}

// ---- texture webp fallback (copied from build_dahilg_assets.mjs compressTextures) ----
async function compressTextures(doc, label, maxSize = 1024) {
  try {
    await doc.transform(textureCompress({
      encoder: sharp, targetFormat: 'webp', resize: [maxSize, maxSize], quality: 80,
    }));
  } catch (err) {
    console.warn(`  ! sharp texture compression skipped for ${label}: ${err.message}`);
  }
}

// ---- meshopt geometry pipeline (same order/functions as build_dahilg_assets.mjs) -----
// dedup -> prune(keepLeaves) -> [dropNormals] -> weld -> [simplify] -> stripDraco -> KTX2/
// webp -> reorder -> quantize(flags) -> meshopt(high).
//
// `dropNormals`: the road meshes are emitted FULLY UNWELDED (verts == 3*tris, a unique
// vertex per triangle) and carry only POSITION+NORMAL (no UVs). gltf-transform 4.x weld()
// is bit-exact (no tolerance option), so the per-face NORMAL keeps every vertex distinct
// and simplify can collapse almost nothing (1.1%). Dropping NORMAL first lets weld merge
// the coincident positions (974k verts -> 186k) so simplify actually reaches its target;
// the near-flat draped road surface is fine with runtime-computed flat normals.
async function meshoptPipeline(doc, label, { quantizePosition = 14, texCap = 1024, simplifyOpts = null, capFor = null, dropNormals = false } = {}) {
  await doc.transform(dedup());
  await doc.transform(prune({ keepLeaves: true }));
  if (dropNormals) {
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        if (prim.getAttribute('NORMAL')) prim.setAttribute('NORMAL', null);
      }
    }
  }
  await doc.transform(weld());
  if (simplifyOpts) await simplifyToTarget(doc, label, simplifyOpts);
  stripDraco(doc);
  const ktx = await ktx2CompressDoc(doc, { maxSize: texCap, label, capFor });
  if (ktx.encoder) {
    console.log(`    textures: KTX2/${ktx.encoder} x${ktx.count} @cap ${texCap}` +
      (ktx.skipped ? ` (${ktx.skipped} skipped)` : ''));
  } else if (doc.getRoot().listTextures().length) {
    await compressTextures(doc, label, texCap);
    console.log(`    textures: webp @cap ${texCap}  (install basis_universal/toktx for KTX2)`);
  }
  await doc.transform(reorder({ encoder: MeshoptEncoder }));
  await doc.transform(quantize({ quantizationVolume: 'scene', quantizePosition }));
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
}

// ---- assertNoDraco (copied from build_dahilg_assets.mjs) -----------------------------
async function assertNoDraco(file) {
  const doc = await io.read(file);
  const root = doc.getRoot();
  const used = root.listExtensionsUsed().map((e) => e.extensionName);
  const req = root.listExtensionsRequired().map((e) => e.extensionName);
  if (used.includes(DRACO_EXT) || req.includes(DRACO_EXT)) {
    throw new Error(`ASSERTION FAILED: ${path.basename(file)} still declares ${DRACO_EXT} ` +
      `(used=[${used}] required=[${req}]). Outputs must be meshopt-only for offline decode.`);
  }
  return { used };
}

// Write + verify (no Draco, non-NaN bounds, meshopt present). Returns { bytes, tris, used, bounds }.
async function writeAndVerify(doc, file, label) {
  await io.write(file, doc);
  const { used } = await assertNoDraco(file);
  const bytes = statSync(file).size;
  // round-trip decode: re-read, recompute scene bounds (proves the meshopt geometry decodes).
  const back = await io.read(file);
  const scene = back.getRoot().listScenes()[0];
  const b = scene ? getBounds(scene) : null;
  if (!b || b.min.some(Number.isNaN) || b.max.some(Number.isNaN)) {
    throw new Error(`${label}: round-trip FAILED — scene bounds are NaN (geometry did not decode).`);
  }
  const { tris } = countTris(back);
  const meshopt = used.includes('EXT_meshopt_compression');
  console.log(`  wrote ${path.relative(ROOT, file)}  ${mb(bytes)}  ` +
    `[tris=${tris}, meshopt=${meshopt ? 'yes' : 'NO'}, ext=${used.join(',') || 'none'}]`);
  return { bytes, tris, used, bounds: { min: b.min, max: b.max } };
}

// ---- GPU-instance repeated static nodes (ported from build_dahilg_assets.mjs) --------
// Folds reused, non-animated, childless leaf mesh-nodes that share a mesh with >= `min`
// peers into one EXT_mesh_gpu_instancing holder (1 mesh + N transforms). The master has
// NO animations, so the animation guard is a no-op here; the ancestor-identity guard is
// kept (skips any node whose parent chain is non-identity rather than misplacing it).
function instanceStaticRepeats(doc, { min = 4 } = {}) {
  const root = doc.getRoot();
  const instExt = doc.createExtension(EXTMeshGPUInstancing);

  const animated = new Set();
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      const t = ch.getTargetNode();
      if (t) animated.add(t);
    }
  }

  const ID_T = [0, 0, 0], ID_R = [0, 0, 0, 1], ID_S = [1, 1, 1];
  const approx = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-5);
  const ancestorsIdentity = (node) => {
    for (let p = node.getParentNode(); p; p = p.getParentNode()) {
      if (!approx(p.getTranslation(), ID_T) || !approx(p.getRotation(), ID_R) || !approx(p.getScale(), ID_S)) {
        return false;
      }
    }
    return true;
  };

  const byMesh = new Map();
  for (const node of root.listNodes()) {
    if (animated.has(node)) continue;
    if (node.listChildren().length > 0) continue;
    if (!ancestorsIdentity(node)) continue;
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (!byMesh.has(mesh)) byMesh.set(mesh, []);
    byMesh.get(mesh).push(node);
  }

  let instancedMeshes = 0, foldedNodes = 0, totalInstances = 0;
  const scene = root.listScenes()[0];
  for (const [mesh, nodes] of byMesh) {
    if (nodes.length < min) continue;
    const n = nodes.length;
    const T = new Float32Array(n * 3), R = new Float32Array(n * 4), S = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      T.set(nodes[i].getTranslation(), i * 3);
      R.set(nodes[i].getRotation(), i * 4);
      S.set(nodes[i].getScale(), i * 3);
    }
    const instancing = instExt.createInstancedMesh()
      .setAttribute('TRANSLATION', doc.createAccessor().setType('VEC3').setArray(T))
      .setAttribute('ROTATION', doc.createAccessor().setType('VEC4').setArray(R))
      .setAttribute('SCALE', doc.createAccessor().setType('VEC3').setArray(S));
    const holder = doc.createNode(`${mesh.getName() || 'Mesh'}_instances`)
      .setMesh(mesh)
      .setExtension('EXT_mesh_gpu_instancing', instancing);
    scene.addChild(holder);
    for (const node of nodes) node.dispose();
    instancedMeshes++; foldedNodes += n; totalInstances += n;
  }
  console.log(`  GPU-instanced ${foldedNodes} nodes -> ${instancedMeshes} ` +
    `EXT_mesh_gpu_instancing holder(s) (${totalInstances} instances)`);
  return { instancedMeshes, foldedNodes };
}

// =====================================================================================
// EXTRACTION: build a fresh single-layer Document containing only the nodes that match
// `layer.match`. Strategy: read the master fresh per layer (cheaper on memory than deep-
// cloning the 219 MB doc), then dispose every node whose name is not claimed by THIS
// layer. Ancestors of a kept node are themselves kept (so the hierarchy survives) but
// any STRAY mesh on a kept ancestor that belongs to another layer is nulled so geometry
// is never duplicated across files. Unreferenced meshes/materials/textures fall out via
// prune() inside meshoptPipeline.
// -------------------------------------------------------------------------------------
async function extractLayer(masterPath, layer) {
  const doc = await io.read(masterPath);
  const root = doc.getRoot();
  const nodes = root.listNodes();

  // Which nodes are claimed by THIS layer (by name).
  const claimed = new Set(nodes.filter((n) => layer.match(n.getName() || '')));
  if (claimed.size === 0) return { doc, kept: 0 };

  // Keep claimed nodes AND all their ancestors (hierarchy spine).
  const keep = new Set();
  for (const n of claimed) {
    keep.add(n);
    for (let p = n.getParentNode(); p; p = p.getParentNode()) keep.add(p);
  }

  // Dispose every node not in `keep`. Disposing a parent reparents/disposes its subtree;
  // collect names first, then dispose by walking the live list repeatedly is fragile —
  // instead dispose leaf-first by sorting deepest-first.
  const depth = (n) => { let d = 0; for (let p = n.getParentNode(); p; p = p.getParentNode()) d++; return d; };
  const toDrop = nodes.filter((n) => !keep.has(n)).sort((a, b) => depth(b) - depth(a));
  for (const n of toDrop) {
    if (n.isDisposed && n.isDisposed()) continue;
    n.dispose();
  }

  // Null any stray mesh on a KEPT ANCESTOR that is not itself claimed (an ancestor kept
  // only for the spine must not carry another layer's geometry into this file).
  for (const n of keep) {
    if (claimed.has(n)) continue;
    if (n.getMesh()) n.setMesh(null);
  }

  return { doc, kept: claimed.size };
}

// =====================================================================================
// TREES: instance FIRST (fold 1055 Tree_# into the few unique meshes), then simplify the
// UNIQUE meshes only. dedup() collapses identical placed tree meshes to one shared mesh
// each so instanceStaticRepeats can fold them; then a single simplify() over the (now
// small) unique mesh set decimates leaves (error 0.03 tolerates it). Returns counts.
// -------------------------------------------------------------------------------------
async function buildTrees(doc, layer) {
  await doc.transform(dedup());
  const before = countTris(doc);
  const inst = instanceStaticRepeats(doc, { min: 4 });
  // After folding, the unique tree meshes are few — simplify them hard.
  const uniqueMeshes = doc.getRoot().listMeshes().length;
  await doc.transform(simplify({
    simplifier: MeshoptSimplifier,
    ratio: layer.treeSimplify.ratio,
    error: layer.treeSimplify.error,
    lockBorder: false,
  }));
  const after = countTris(doc);
  console.log(`    trees: ${before.tris} -> ${after.tris} tris over ${uniqueMeshes} unique mesh(es) ` +
    `(${inst.instancedMeshes} instanced holders)`);
  return { uniqueMeshes };
}

// =====================================================================================
// HEIGHTFIELD: CPU-rasterize the Terrain mesh to a regular uint16 grid at `posting` m
// over its XZ bounds, by nearest-triangle-vertex max-Y per cell (cheap, robust). Writes
// heightfield.bin (raw little-endian Uint16Array, row-major rows*cols) and returns the
// manifest header. Y is quantized linearly across [minY,maxY]. Replaces Collision_Terrain.
// -------------------------------------------------------------------------------------
function buildHeightfield(masterDoc, posting = 2.0) {
  const root = masterDoc.getRoot();
  const terrain = root.listNodes().find((n) => /^Terrain$/.test(n.getName() || ''))
    || root.listNodes().find((n) => n.getName() === COLLISION_TERRAIN);
  if (!terrain || !terrain.getMesh()) return null;

  const b = getBounds(terrain);
  const [minX, minY, minZ] = b.min;
  const [maxX, maxY, maxZ] = b.max;
  const cols = Math.max(2, Math.ceil((maxX - minX) / posting) + 1);
  const rows = Math.max(2, Math.ceil((maxZ - minZ) / posting) + 1);
  // grid[r*cols + c] = max world-Y of any vertex falling in that cell (init to minY).
  const grid = new Float32Array(rows * cols).fill(minY);
  const seen = new Uint8Array(rows * cols);

  for (const prim of terrain.getMesh().listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const count = pos.getCount();
    const v = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      pos.getElement(i, v);
      const c = Math.min(cols - 1, Math.max(0, Math.round((v[0] - minX) / posting)));
      const r = Math.min(rows - 1, Math.max(0, Math.round((v[2] - minZ) / posting)));
      const idx = r * cols + c;
      if (!seen[idx] || v[1] > grid[idx]) { grid[idx] = v[1]; seen[idx] = 1; }
    }
  }
  // Fill empty cells from the nearest seen neighbor in row-major scan (forward then back).
  for (let i = 1; i < grid.length; i++) if (!seen[i] && seen[i - 1]) { grid[i] = grid[i - 1]; seen[i] = 1; }
  for (let i = grid.length - 2; i >= 0; i--) if (!seen[i] && seen[i + 1]) { grid[i] = grid[i + 1]; seen[i] = 1; }

  // Quantize to uint16 across [minY,maxY].
  const span = Math.max(1e-6, maxY - minY);
  const out = new Uint16Array(rows * cols);
  for (let i = 0; i < grid.length; i++) {
    out[i] = Math.round(((grid[i] - minY) / span) * 65535);
  }
  return {
    buffer: Buffer.from(out.buffer),
    header: {
      file: 'heightfield.bin', format: 'uint16',
      origin: [minX, minZ], posting,
      cols, rows,
      minY: Number(minY.toFixed(4)), maxY: Number(maxY.toFixed(4)),
      bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    },
  };
}

// =====================================================================================
// COLLISION: rebuild Collision_Buildings as one AABB box proxy per building. Source =
// each Building_# group's world bounds (and House_walls). Each box is 8 verts / 12 tris,
// material-free. ~1600 buildings -> ~19k tris. Quantized 12-bit, no textures.
// -------------------------------------------------------------------------------------
function addBox(doc, mesh, buffer, min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const p = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, // back
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, // front
  ]);
  // 12 tris (CCW-ish; orientation irrelevant for a physics trimesh).
  const idx = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, // back, front
    0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, // bottom, right
    2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0, // top, left
  ]);
  // Accessors must belong to a buffer before meshopt prewrite; assign explicitly.
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(p).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer));
  mesh.addPrimitive(prim);
}

function buildCollisionInto(masterNodes) {
  // Create a fresh document for the collision boxes.
  const colDoc = new Document();
  // A fresh Document has no Buffer; meshopt's prewrite requires every accessor to belong
  // to one, so create the single buffer all box accessors will be assigned to on write.
  const buffer = colDoc.createBuffer();
  const scene = colDoc.createScene('Collision');
  const mesh = colDoc.createMesh(COLLISION_BUILDINGS);
  const node = colDoc.createNode(COLLISION_BUILDINGS).setMesh(mesh);
  scene.addChild(node);

  // Source building groups: Building_# (the group, not _walls/_roof which are its children)
  // and House_walls. Use each group's world bounds for the box extent.
  let boxes = 0;
  for (const n of masterNodes) {
    const nm = n.getName() || '';
    const isGroup = /^Building_\d+$/.test(nm) || nm === 'House_walls';
    if (!isGroup) continue;
    const b = getBounds(n);
    if (!b || b.min.some(Number.isNaN) || b.max.some(Number.isNaN)) continue;
    // Degenerate guard: skip zero-extent groups.
    if (b.max[0] - b.min[0] < 0.05 && b.max[2] - b.min[2] < 0.05) continue;
    addBox(colDoc, mesh, buffer, b.min, b.max);
    boxes++;
  }

  return { colDoc, boxes };
}

// Run the collision document through a lightweight pipeline (no textures): weld -> quantize
// 12-bit -> meshopt. No simplify (boxes are already minimal); no KTX2 (material-free).
async function finalizeCollision(colDoc) {
  await colDoc.transform(dedup());
  await colDoc.transform(weld());
  await colDoc.transform(reorder({ encoder: MeshoptEncoder }));
  await colDoc.transform(quantize({ quantizationVolume: 'scene', quantizePosition: 12 }));
  await colDoc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
}

// =====================================================================================
// Per-level build.
// -------------------------------------------------------------------------------------
async function buildGameLevel({ slug, meta, masterPath }) {
  const master = masterPath || SRC('exports', slug, `${slug}.level.glb`);
  if (!existsSync(master)) {
    console.warn(`  ! skip ${slug}: master not found at ${path.relative(ROOT, master)}`);
    return null;
  }
  const outDir = path.join(path.dirname(master), 'game');
  mkdirSync(outDir, { recursive: true });
  const masterBytes = statSync(master).size;
  console.log(`\n=== build:level-game  ${slug} ===`);
  console.log(`  master: ${path.relative(ROOT, master)}  ${mb(masterBytes)}`);

  // Offset from the level's .meta.json (best-effort; recorded in the manifest).
  let offset = null;
  if (meta) {
    const metaPath = SRC('public', 'da-hilg', meta);
    if (existsSync(metaPath)) {
      try { offset = JSON.parse(readFileSync(metaPath, 'utf8')).offset || null; } catch { /* ignore */ }
    }
  }

  // ---- a single read to (1) total master tris, (2) UNGROUPED audit, (3) heightfield + collision.
  console.log('  reading master for audit + collision + heightfield…');
  const auditDoc = await io.read(master);
  const masterTris = countTris(auditDoc).tris;
  // UNGROUPED audit: mesh-bearing nodes claimed by no layer (and not a reserved collision node).
  const ungrouped = [];
  for (const n of auditDoc.getRoot().listNodes()) {
    const nm = n.getName() || '';
    if (!n.getMesh()) continue;
    if (nm === COLLISION_TERRAIN || nm === COLLISION_BUILDINGS || nm === COLLISION_TREES) continue;
    if (LAYERS.some((L) => L.match(nm))) continue;
    ungrouped.push(nm);
  }
  console.log(`  UNGROUPED: [${[...new Set(ungrouped)].join(', ')}]  (${ungrouped.length} node(s))`);

  // Heightfield (replaces Collision_Terrain).
  const hf = buildHeightfield(auditDoc, 2.0);
  let heightfield = null;
  if (hf) {
    const hfPath = path.join(outDir, 'heightfield.bin');
    writeFileSync(hfPath, hf.buffer);
    const bytes = statSync(hfPath).size;
    heightfield = { ...hf.header, bytes };
    console.log(`  wrote ${path.relative(ROOT, hfPath)}  ${mb(bytes)}  ` +
      `[${hf.header.cols}x${hf.header.rows} @${hf.header.posting}m, Y ${hf.header.minY}..${hf.header.maxY}]`);
  } else {
    console.warn('  ! no Terrain mesh — heightfield skipped');
  }

  // Collision boxes (from building-group world bounds).
  const { colDoc, boxes } = buildCollisionInto(auditDoc.getRoot().listNodes());

  const layersOut = [];
  const collisionTrisGuess = boxes * 12;

  // Finalize + write collision.glb.
  await finalizeCollision(colDoc);
  {
    const file = path.join(outDir, 'collision.glb');
    const res = await writeAndVerify(colDoc, file, 'collision.glb');
    const texCount = (await io.read(file)).getRoot().listTextures().length;
    if (texCount !== 0) console.warn(`  ! collision.glb carries ${texCount} texture(s) (expected 0)`);
    layersOut.push({
      name: 'collision', file: 'collision.glb', bytes: res.bytes, tris: res.tris,
      required: true, priority: 0, toggleable: false, noTextures: true,
      boxes, bounds: res.bounds,
    });
    console.log(`    collision: ${boxes} box proxies (~${collisionTrisGuess} tris pre-weld)`);
  }

  // ---- per visual layer: extract -> (trees special) -> meshoptPipeline -> write.
  for (const layer of LAYERS) {
    console.log(`\n  [layer] ${layer.name} -> ${layer.file}`);
    const { doc, kept } = await extractLayer(master, layer);
    if (kept === 0) {
      if (layer.optional) { console.log(`    (no nodes matched — optional layer skipped)`); continue; }
      console.warn(`    ! required layer "${layer.name}" matched 0 nodes`);
      continue;
    }
    console.log(`    matched ${kept} node(s)`);

    if (layer.instanced) {
      await buildTrees(doc, layer);
      // After instancing+simplify, run the shared compress tail WITHOUT a second simplify.
      await meshoptPipeline(doc, layer.file, {
        quantizePosition: layer.quantizePosition, texCap: layer.texCap, simplifyOpts: null, capFor: layer.capFor,
      });
    } else {
      await meshoptPipeline(doc, layer.file, {
        quantizePosition: layer.quantizePosition, texCap: layer.texCap,
        simplifyOpts: layer.simplify, capFor: layer.capFor, dropNormals: !!layer.dropNormals,
      });
    }

    const file = path.join(outDir, layer.file);
    const res = await writeAndVerify(doc, file, layer.file);
    const entry = {
      name: layer.name, file: layer.file, bytes: res.bytes, tris: res.tris,
      required: !!layer.required, priority: layer.priority, toggleable: !!layer.toggleable,
      bounds: res.bounds,
    };
    if (layer.instanced) entry.instanced = true;
    layersOut.push(entry);
  }

  // ---- manifest.json --------------------------------------------------------------
  // World bounds = union of all layer bounds (pre-offset, same frame as the master).
  const worldMin = [Infinity, Infinity, Infinity], worldMax = [-Infinity, -Infinity, -Infinity];
  for (const l of layersOut) {
    if (!l.bounds) continue;
    for (let i = 0; i < 3; i++) {
      worldMin[i] = Math.min(worldMin[i], l.bounds.min[i]);
      worldMax[i] = Math.max(worldMax[i], l.bounds.max[i]);
    }
  }

  // Suggested load order grouped by priority.
  const byPriority = new Map();
  for (const l of layersOut) {
    if (!byPriority.has(l.priority)) byPriority.set(l.priority, []);
    byPriority.get(l.priority).push(l.name);
  }
  const loadOrder = [...byPriority.keys()].sort((a, b) => a - b).map((p) => byPriority.get(p));

  const totalBytes = layersOut.reduce((s, l) => s + l.bytes, 0) + (heightfield ? heightfield.bytes : 0);
  const requiredBytes = layersOut.filter((l) => l.required).reduce((s, l) => s + l.bytes, 0)
    + (heightfield ? heightfield.bytes : 0);

  const manifest = {
    version: '1.0',
    level: slug,
    master: path.basename(master),
    masterBytes,
    masterTris,
    exportDate: new Date().toISOString(),
    offset,
    worldBounds: { min: worldMin, max: worldMax },
    heightfield,
    layers: layersOut,
    loadOrder,
    totalBytes,
    requiredBytes,
    reductionPercent: Number((100 * (1 - totalBytes / masterBytes)).toFixed(1)),
    ungrouped: [...new Set(ungrouped)],
  };
  const manifestPath = path.join(outDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n  wrote ${path.relative(ROOT, manifestPath)}`);

  // ---- summary ---------------------------------------------------------------------
  const totalTris = layersOut.reduce((s, l) => s + (l.tris || 0), 0);
  console.log(`\n  --- ${slug} game set ---`);
  for (const l of layersOut) console.log(`    ${l.name.padEnd(10)} ${mb(l.bytes).padStart(9)}  ${(l.tris || 0).toLocaleString().padStart(11)} tris`);
  if (heightfield) console.log(`    ${'heightfield'.padEnd(10)} ${mb(heightfield.bytes).padStart(9)}`);
  console.log(`    ${'TOTAL'.padEnd(10)} ${mb(totalBytes).padStart(9)}  ${totalTris.toLocaleString().padStart(11)} tris`);
  console.log(`    required set: ${mb(requiredBytes)}   reduction: ${manifest.reductionPercent}%  (master ${mb(masterBytes)}, ${masterTris.toLocaleString()} tris)`);
  return manifest;
}

// =====================================================================================
// Entry: arg is a slug, an explicit master path, or empty (all LEVELS w/ DAHILG_ONLY).
// -------------------------------------------------------------------------------------
const arg = process.argv[2];
const summaries = [];
if (arg && (arg.endsWith('.glb') || arg.includes('/'))) {
  const masterPath = path.isAbsolute(arg) ? arg : SRC(arg);
  const slug = path.basename(masterPath).replace(/\.level\.glb$|\.glb$/, '');
  const m = await buildGameLevel({ slug, meta: null, masterPath });
  if (m) summaries.push(m);
} else if (arg) {
  const lv = LEVELS.find((l) => l.slug === arg) || { slug: arg, meta: `${arg}.meta.json` };
  const m = await buildGameLevel(lv);
  if (m) summaries.push(m);
} else {
  for (const lv of LEVELS) {
    const m = await buildGameLevel(lv);
    if (m) summaries.push(m);
  }
}

if (summaries.length > 1) {
  const sum = summaries.reduce((s, m) => s + m.totalBytes, 0);
  console.log(`\n=== ALL LEVELS: ${summaries.length} game sets, ${mb(sum)} total ===`);
}
