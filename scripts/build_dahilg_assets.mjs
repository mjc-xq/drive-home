// Build script for the "Da Hilg" greenfield R3F game assets.
//
// Produces TRACKED, MESHOPT-compressed, OFFLINE-DECODABLE GLBs in public/da-hilg/
// from the read-only sources (the level export + the 4 character GLBs + Drew's
// external anim-only GLBs).
//
//   - OUTPUTS use EXT_meshopt_compression (NOT Draco) so drei/three decode them
//     with their built-in MeshoptDecoder — no external decoder file to ship.
//   - INPUT characters are Draco/mixed-compressed, so the NodeIO registers the
//     Draco DECODER purely to READ them; nothing Draco is ever written back out.
//
// Run:  node scripts/build_dahilg_assets.mjs   (or: npm run build:dahilg-assets)
// Idempotent — safe to re-run; outputs are regenerated from the sources each time.
import { NodeIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, textureCompress, reorder, quantize, meshopt, getBounds,
  simplify, sortPrimitiveWeights,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { ktx2CompressDoc } from './lib/ktx2_pass.mjs';
import { atlasFacades } from './atlas_facades.mjs';
import { mkdirSync, statSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = (...p) => path.join(ROOT, ...p);
const OUT_DIR = SRC('public', 'da-hilg');
const ANIM_DIR = path.join(OUT_DIR, 'anims');
const OUT = (...p) => path.join(OUT_DIR, ...p);

// ---- IO: register BOTH meshopt + draco so we can READ draco sources and WRITE meshopt ----
// ERROR-level logger: quantize emits a "Skipping TEXCOORD_0; out of [0,1] range" warning
// per tiled-UV primitive (the level's facade/aerial UVs are intentionally out of range)
// and reorder warns on the mesh-free anim docs — both are expected, so we mute warnings.
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

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(ANIM_DIR, { recursive: true });

const mb = (bytes) => (bytes / 1e6).toFixed(2) + ' MB';
const written = [];          // { path, bytes } for the final summary
const DRACO_EXT = 'KHR_draco_mesh_compression';

// ---- LEVELS: the shippable levels, each built from its own SINGLE-SURFACE export ----
// The new exporter (export_property_single_surface.mjs) welds the whole property into ONE
// textured terrain — roads/sidewalks/curbs/lane-paint are PAINTED into the ground texture, and
// the Street-View facades are baked into the building-wall UVs (FacadeAtlas_page{N}/Stucco_*
// materials). So the *-single.glb has NO Roads/Sidewalks/SVFacade_* meshes and NO
// Collision_Roads node — only the welded surface + its Collision_Terrain twin, plus the same
// Buildings/House/Trees/Creek/Shrubs node names the runtime keys off (so the level/meta passes
// below run essentially unchanged). dahill keeps the legacy level.glb/level.meta.json names.
//   - src:        the single-surface export filename in exports/
//   - out:        output basename → OUT(`${out}.glb`) + OUT(`${out}.meta.json`)
//   - metaSource: the `source` string recorded in the .meta.json (the single-surface GLB)
//   - pavedMaskSrc: the exporter's grass-occlusion sidecar (top-down paved/built mask over the
//                   DEM rect). dahill's _ground sits at exports/_ground; the others nest under
//                   their place dir (exports/<dir>/_ground). Copied to OUT(`${out}.paved_mask.png`)
//                   and referenced from the .meta.json (the web grass occlusion samples it — the
//                   old paved mask was rendered from Roads/Sidewalks meshes that no longer exist).
const LEVELS = [
  { src: 'dahill-single.glb',   out: 'level',   metaSource: 'dahill-single.glb',   pavedMaskSrc: '_ground/paved_mask.png' },
  { src: 'canyon-single.glb',   out: 'canyon',  metaSource: 'canyon-single.glb',   pavedMaskSrc: 'canyon-middle-school/_ground/paved_mask.png' },
  { src: 'stanton-single.glb',  out: 'stanton', metaSource: 'stanton-single.glb',  pavedMaskSrc: 'stanton-elementary/_ground/paved_mask.png' },
  { src: 'meemaw-single.glb',   out: 'meemaw',  metaSource: 'meemaw-single.glb',   pavedMaskSrc: 'meemaw/_ground/paved_mask.png' },
  { src: 'xq-single.glb',       out: 'xq',      metaSource: 'xq-single.glb',       pavedMaskSrc: 'xq/_ground/paved_mask.png' },
];

// ---- texture compression step (webp, per-class cap, q80) with a graceful fallback ----
// textureCompress can throw if sharp can't decode an image; per the spec we WARN and
// continue (skip texture compression) rather than failing the whole build.
// `maxSize` is the per-asset-class cap: 1024 for the landscape, 512 for characters
// (a 1.7 m rig never needs more) — see ASSET_PIPELINE.md.
const warnings = [];
async function compressTextures(doc, label, maxSize = 1024) {
  try {
    await doc.transform(textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [maxSize, maxSize],
      quality: 80,
    }));
  } catch (err) {
    const w = `sharp texture compression skipped for ${label}: ${err.message}`;
    warnings.push(w);
    console.warn('  ! ' + w);
  }
}

// ---- drop the Draco extension declaration ----
// The Draco DECODER runs on read, so geometry is already plain accessors in-memory; the
// KHR_draco_mesh_compression extension object lingers in the document only as a dangling
// extensionsUsed/Required entry. Disposing it removes that declaration so the meshopt
// output is truly Draco-free (protects offline decode — see assertion A).
function stripDraco(doc) {
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === DRACO_EXT) ext.dispose();
  }
}

// ---- drop dangling extension declarations ----
// After stripping meshes/skins/textures from the anim docs, material/texture extensions
// (KHR_materials_specular, EXT_texture_webp, KHR_mesh_quantization) can survive as empty
// extensionsUsed entries with no referencing objects. Dispose any extension whose only
// remaining parent is the Root, so the channel-only anim GLBs stay minimal and honest.
const KEEP_EXT = new Set(['EXT_meshopt_compression']);   // added by meshopt() after this
function stripDanglingExtensions(doc) {
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (KEEP_EXT.has(ext.extensionName)) continue;
    // An extension with no attached properties (e.g. after its materials/textures were
    // disposed) is a dead extensionsUsed entry — drop it.
    if (ext.listProperties().length === 0) ext.dispose();
  }
}

// ---- count triangles across all primitives in a document --------------------------
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

// ---- SKINNED-MESH SIMPLIFY (triangle-budget decimation) -----------------------------
// The two adult bodies (mike ~220k tris, kelli ~285k tris) ship un-decimated; meshopt
// shrinks BYTES but not TRIANGLES, so every frame they're skinned + shadow-rasterized at
// full detail — ~85% of the character triangle load for a 1.7 m rig that never needs it.
//
// gltf-transform's simplify() wraps meshoptimizer's MeshoptSimplifier: it welds (overwrite
// off) then edge-collapses INDICES, carrying every per-vertex attribute — POSITION, NORMAL,
// JOINTS_0, WEIGHTS_0 — along by index, so skinning survives the collapse. We then re-sort +
// re-normalize the surviving skin weights (collapse can leave weights summing slightly off)
// so each vertex keeps a clean <=4-influence, sum=1 weight set.
//
// `ratio` is the target fraction of triangles to KEEP. Rather than a fixed ratio (mike and
// kelli differ ~30% in tri count), we compute the ratio from a TARGET TRIANGLE BUDGET so both
// land near the same ~28-32k budget. `error` is the max deviation as a fraction of mesh radius
// — we give it generous headroom (0.02) so the collapse can actually REACH the budget instead
// of quitting early at the tight 0.01% default, but not so loose it caves the face in.
async function simplifyToTarget(doc, label, { targetTris, error = 0.02, minRatio = 0.06 }) {
  const before = countTris(doc);
  // ratio of TRIANGLES to keep to hit the budget; clamp so we never request an absurdly low
  // ratio that would dissolve fine features (face/hands). 1.0 => skip (already under budget).
  const ratio = Math.min(1, Math.max(minRatio, targetTris / before.tris));
  if (ratio >= 1) {
    console.log(`    simplify: ${label} already ${before.tris} tris <= target ${targetTris} — skipped`);
    return;
  }
  await doc.transform(simplify({
    simplifier: MeshoptSimplifier,
    ratio,
    error,
    lockBorder: false,
  }));
  // Re-sort high->low and re-normalize skin weights to a clean 4-influence, sum=1 set; edge
  // collapse can perturb the surviving weights. Keeps the skin-safe runtime happy.
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getAttribute('WEIGHTS_0')) sortPrimitiveWeights(prim, 4);
    }
  }
  const after = countTris(doc);
  console.log(`    simplify: ${label} ratio=${ratio.toFixed(3)} error<=${error} -> ` +
    `${before.verts}/${before.tris} verts/tris -> ${after.verts}/${after.tris} ` +
    `(${(100 * (1 - after.tris / before.tris)).toFixed(1)}% fewer tris)`);
}

// ---- meshopt geometry pipeline (shared by level + the 4 characters) ----
// Order per spec: dedup -> prune(keepLeaves) -> weld -> [simplify] -> [KTX2|webp textures]
//   -> reorder -> quantize(flags) -> meshopt(setRequired) -> write.
// quantizeFlags differ: characters use skinned-safe values so the 1.7 m rig keeps
// tight feet (no over-quantized sliding); the level uses gltf-transform defaults.
// texCap is the DEFAULT per-class texture size cap (1024 landscape / 512 characters).
// texCapFor (optional) is a per-texture override passed straight to ktx2CompressDoc — the
// level uses it to give the big ground albedo + facade atlas pages a 4096 cap (so the painted
// lane/curb + photo facades stay crisp) while ORM/others keep the default.
// simplifyOpts (optional, characters only): { targetTris, error, minRatio } — runs the
// skinned-mesh decimation AFTER weld (welded topology = better collapses) and BEFORE
// quantize/meshopt (decimate the float mesh, then compress the smaller result).
// Textures become GPU-compressed KTX2 when an encoder is on PATH, else webp.
async function meshoptPipeline(doc, label, quantizeFlags, texCap = 1024, simplifyOpts = null, texCapFor = null) {
  await doc.transform(dedup());
  await doc.transform(prune({ keepLeaves: true }));
  await doc.transform(weld());
  if (simplifyOpts) await simplifyToTarget(doc, label, simplifyOpts);
  stripDraco(doc);          // geometry is already decoded on read; drop the dangling ext decl
  const ktx = await ktx2CompressDoc(doc, { maxSize: texCap, label, capFor: texCapFor });
  if (ktx.encoder) {
    console.log(`    textures: KTX2/${ktx.encoder} x${ktx.count} @cap ${texCap}` +
      (ktx.skipped ? ` (${ktx.skipped} skipped)` : ''));
  } else {
    await compressTextures(doc, label, texCap);
    console.log(`    textures: webp @cap ${texCap}  (install basis_universal/toktx for KTX2)`);
  }
  await doc.transform(reorder({ encoder: MeshoptEncoder }));
  await doc.transform(quantize(quantizeFlags));
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
}

// Re-read a freshly written GLB and assert it carries NO Draco extension. Protects the
// offline-decode guarantee: every output must be meshopt-only.
async function assertNoDraco(file) {
  const doc = await io.read(file);
  const root = doc.getRoot();
  const used = root.listExtensionsUsed().map((e) => e.extensionName);
  const req = root.listExtensionsRequired().map((e) => e.extensionName);
  if (used.includes(DRACO_EXT) || req.includes(DRACO_EXT)) {
    throw new Error(
      `ASSERTION (A) FAILED: ${path.basename(file)} still declares ${DRACO_EXT} ` +
      `(used=[${used}] required=[${req}]). Outputs must be meshopt-only for offline decode.`,
    );
  }
  return { used, req };
}

async function writeAndVerify(doc, file, { label } = {}) {
  await io.write(file, doc);
  const { used } = await assertNoDraco(file);
  const bytes = statSync(file).size;
  written.push({ path: file, bytes });
  const meshopt = used.includes('EXT_meshopt_compression');
  console.log(`  wrote ${path.relative(ROOT, file)}  ${mb(bytes)}  ` +
    `[meshopt=${meshopt ? 'yes' : 'NO'}, ext=${used.join(',') || 'none'}]`);
}

// ---- GPU-instance repeated static nodes (trees/fences) ------------------------------
// WHY a custom pass instead of gltf-transform's instance(): instance() refuses to run
// on ANY document that contains an animation ("Instancing is not currently supported for
// animated models") — and the level carries the GrassWind node animation. But the trees
// and fences are NOT animation targets (only GrassClump_* nodes are), and the tree-lib /
// fence GLBs are reused 100s of times sharing the SAME mesh after dedup(). So we emit
// EXT_mesh_gpu_instancing ourselves for the reused, non-animated, leaf mesh-nodes:
// one node per shared mesh carrying per-instance TRANSLATION/ROTATION/SCALE. three.js'
// GLTFLoader turns each such node into an InstancedMesh (one draw call per primitive),
// collapsing ~900 tree/fence draw calls into a handful. Frustum culling stays on.
//
// Safe because every ancestor wrapper empty from organize_layers.py has an IDENTITY
// transform (verified), so each leaf node's LOCAL TRS already equals its WORLD TRS — no
// matrix baking needed. We only instance nodes that (a) reference a mesh, (b) have no
// children, (c) are NOT targeted by any animation channel, and (d) share their mesh with
// at least `min` other such nodes.
function instanceStaticRepeats(doc, { min = 4 } = {}) {
  const root = doc.getRoot();
  const instExt = doc.createExtension(EXTMeshGPUInstancing);

  // Nodes touched by ANY animation channel must keep their own node (don't fold them).
  const animated = new Set();
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      const t = ch.getTargetNode();
      if (t) animated.add(t);
    }
  }

  // We bake each node's LOCAL TRS as the instance transform, which only equals the WORLD
  // TRS when every ancestor is identity. Guard that assumption: skip any node whose chain
  // of parents carries a non-identity transform (rather than silently misplacing a tree).
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

  // Group eligible leaf mesh-nodes by the mesh they reference.
  const byMesh = new Map();
  for (const node of root.listNodes()) {
    if (animated.has(node)) continue;
    if (node.listChildren().length > 0) continue;
    if (!ancestorsIdentity(node)) continue;   // would need world-matrix baking — leave as-is
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (!byMesh.has(mesh)) byMesh.set(mesh, []);
    byMesh.get(mesh).push(node);
  }

  let instancedMeshes = 0;
  let foldedNodes = 0;
  let totalInstances = 0;
  const scene = root.listScenes()[0];

  for (const [mesh, nodes] of byMesh) {
    if (nodes.length < min) continue;

    // Per-instance TRS, read straight from each node's local transform (== world here).
    const n = nodes.length;
    const T = new Float32Array(n * 3);
    const R = new Float32Array(n * 4);
    const S = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = nodes[i].getTranslation(), r = nodes[i].getRotation(), s = nodes[i].getScale();
      T.set(t, i * 3); R.set(r, i * 4); S.set(s, i * 3);
    }
    const aT = doc.createAccessor().setType('VEC3').setArray(T);
    const aR = doc.createAccessor().setType('VEC4').setArray(R);
    const aS = doc.createAccessor().setType('VEC3').setArray(S);

    const instancing = instExt.createInstancedMesh()
      .setAttribute('TRANSLATION', aT)
      .setAttribute('ROTATION', aR)
      .setAttribute('SCALE', aS);

    // One holder node (at the origin) carrying the shared mesh + the instance attributes.
    const holder = doc.createNode(`${mesh.getName() || 'Mesh'}_instances`)
      .setMesh(mesh)
      .setExtension('EXT_mesh_gpu_instancing', instancing);
    scene.addChild(holder);

    // Drop the now-folded per-item nodes (their geometry lives in the instanced holder).
    for (const node of nodes) node.dispose();

    instancedMeshes++;
    foldedNodes += n;
    totalInstances += n;
  }

  console.log(`  GPU-instanced ${foldedNodes} static nodes -> ${instancedMeshes} ` +
    `EXT_mesh_gpu_instancing node(s) (${totalInstances} instances; ${animated.size} animated nodes left alone)`);
  return { instancedMeshes, foldedNodes };
}

// ---- per-texture KTX2 cap resolver for a single-surface level -----------------------
// The single-surface export names its textures consistently: ground_core_albedo /
// ground_far_albedo (the big aerial+painted-roads ground bed, up to 6144px), ground_core_orm
// (the ORM packing), and facade.png / facade_atlas_* (the baked Street-View wall photos). The
// ground albedo + facade pages carry the fine PAINTED detail (lane lines, curbs, photo facades)
// that RDO smears and a 2048 cap blurs — give them a 4096 NO-RDO/high-quality encode. ORM and
// everything else keep the document default (2048, RDO on). Returns a capFor(tex) for
// ktx2CompressDoc. Heuristic is by texture NAME (survives the pipeline) with an ORM guard.
function makeLevelTexCapFor() {
  const BIG = /albedo|facade|_atlas/i;   // crisp photographic/painted maps → 4096 hq
  const ORM = /orm|_mr\b|metalrough/i;   // ORM packing → never bump (no fine detail to keep)
  return (tex) => {
    const name = tex.getName() || '';
    if (ORM.test(name)) return null;     // default cap, RDO on
    if (BIG.test(name)) return { maxSize: 4096, hq: true };
    return null;                         // default cap
  };
}

// =====================================================================================
// LEVEL builder: meshopt + KTX2 for ONE single-surface level. Keep geometry as-is (no
// recenter of verts). Preserve the named collision/helper nodes. Drop the hidden
// LOD_Buildings_Low duplicate if present (the single-surface export no longer emits it).
// Generic over `src` (single-surface export filename) and `out` (output basename) — every
// Da Hilg single-surface export shares the same node structure, so this runs per source.
// Returns the source byte size (the dahill call stashes it for the summary).
// -------------------------------------------------------------------------------------
async function buildLevelGlb({ src, out, pavedMaskSrc }) {
  console.log(`\n[1/4] ${out}.glb  <- exports/${src}`);
  // The full, textured, tree-rich single-surface export (always grab the freshest from
  // exports/ when re-importing — see docs/dahilg-neighborhood-export.md).
  const levelSrc = SRC('exports', src);
  const srcBytes = statSync(levelSrc).size;
  const levelDoc = await io.read(levelSrc);
  {
    const root = levelDoc.getRoot();

    // Drop LOD_Buildings_Low (don't ship a hidden duplicate LOD).
    const lod = root.listNodes().find((n) => n.getName() === 'LOD_Buildings_Low');
    if (lod) {
      const mesh = lod.getMesh();
      lod.dispose();
      // Dispose the now-orphaned mesh too so prune doesn't keep it reachable.
      if (mesh && mesh.listParents().filter((p) => p.propertyType === 'Node').length === 0) {
        mesh.dispose();
      }
      console.log('  dropped node LOD_Buildings_Low');
    } else {
      console.log('  (LOD_Buildings_Low not present — nothing to drop)');
    }

    // Sanity: the collision/helper nodes the game relies on must still exist. Collision_Roads
    // is OPTIONAL now — the single-surface export folds the roads into the welded terrain
    // (roads are texture on Collision_Terrain), so there is no separate road collider. The
    // terrain/buildings/trees colliders + House_walls are still required.
    const KEEP = ['Collision_Terrain', 'Collision_Buildings', 'Collision_Trees', 'House_walls'];
    for (const nm of KEEP) {
      if (!root.listNodes().some((n) => n.getName() === nm)) {
        throw new Error(`${out}.glb: required collision node "${nm}" is missing before write.`);
      }
    }
    console.log('  preserved required nodes: ' + KEEP.join(', ') + ' (Collision_Roads optional — roads are on the terrain now)');

    // Capture the SOURCE (un-quantized) Terrain vs Collision_Terrain min-Y so the assert below
    // runs on exact float coords (the welded surface must be its own collider — visual==collision
    // by construction; this guards a regression where they drift apart).
    {
      const tNode = root.listNodes().find((n) => n.getName() === 'Terrain');
      const ctNode = root.listNodes().find((n) => n.getName() === 'Collision_Terrain');
      const tMinY = tNode ? getBounds(tNode).min[1] : NaN;
      const ctMinY = ctNode ? getBounds(ctNode).min[1] : NaN;
      const dy = Math.abs(ctMinY - tMinY);
      if (!(dy < 0.05)) {
        throw new Error(`${out}.glb: Collision_Terrain.minY (${ctMinY}) and Terrain.minY (${tMinY}) ` +
          `differ by ${dy} (>= 0.05 m) — the welded collider no longer matches the visual surface.`);
      }
      console.log(`  collision==visual: |Collision_Terrain.minY - Terrain.minY| = ${dy.toFixed(4)} m (< 0.05)`);
    }

    // Visual/collision separation: the Collision_* meshes are physics-only (the runtime
    // bakes a trimesh collider from them and hides them). Strip their materials so the
    // shipped GLB carries no texture/material payload for geometry the player never sees.
    let strippedPrims = 0;
    for (const node of root.listNodes()) {
      if (!node.getName().startsWith('Collision_')) continue;
      const mesh = node.getMesh();
      if (!mesh) continue;
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMaterial()) { prim.setMaterial(null); strippedPrims++; }
      }
    }
    console.log(`  stripped material from ${strippedPrims} collision primitive(s)`);

    // GPU-instance the repeated trees/fences: the tree-lib is reused across hundreds of
    // nodes. dedup() first collapses identical placed meshes to ONE shared mesh each, then
    // our instanceStaticRepeats() emits EXT_mesh_gpu_instancing per reused mesh → three
    // renders each as an InstancedMesh (a handful of draw calls instead of ~900). We can't
    // use gltf-transform's instance() here because it aborts on the GrassWind animation;
    // our pass folds only the non-animated tree/fence nodes and leaves the grass alone.
    await levelDoc.transform(dedup());
    instanceStaticRepeats(levelDoc, { min: 4 });

    // FACADE ATLAS: SKIPPED for single-surface inputs. The new exporter already bakes the
    // Street-View facades into the building-wall UVs (FacadeAtlas_page{N}_mat / Stucco_*
    // materials), so there are no per-wall SVFacade_* textures to pack — atlasFacades() would
    // find zero facade materials and no-op anyway. Bypass it explicitly (and keep the import
    // referenced so lint/`node --check` stay happy) rather than relying on the no-op.
    void atlasFacades;

    // NOTE: prune(keepLeaves:true) keeps childless empty nodes, so the (now empty after
    // their mesh is disposed) collision helpers survive even if their mesh were dropped —
    // but here the collision meshes are real geometry and stay intact.
    //
    // Quantize POSITION at 16-bit (was the gltf-transform 14-bit default over the whole scene
    // volume): the welded terrain carries fine micro-relief that 14-bit over a ±600 m scene
    // collapses to a stair-stepped surface (feet/wheels jitter). 16-bit keeps it smooth.
    //
    // Per-texture KTX2 cap: the big ground albedo (~6144 core) + facade atlas pages get a 4096
    // cap with NO-RDO/high-quality encode so the painted lane/curb + photo facades stay crisp;
    // ORM/other maps keep the 2048 default. Resolve by texture/material/image-size heuristic.
    const texCapFor = makeLevelTexCapFor();
    await meshoptPipeline(
      levelDoc, `${out}.glb`,
      { quantizationVolume: 'scene', quantizePosition: 16 },
      2048, null, texCapFor,
    );
  }
  await writeAndVerify(levelDoc, OUT(`${out}.glb`), { label: out });

  // Round-trip / render check: re-read the written level + recompute bounds (proves the
  // meshopt geometry decodes back cleanly with the registered MeshoptDecoder).
  const levelOut = await io.read(OUT(`${out}.glb`));
  {
    const outRoot = levelOut.getRoot();
    const scene = outRoot.listScenes()[0];
    const b = getBounds(scene);
    if (!b || b.min.some(Number.isNaN) || b.max.some(Number.isNaN)) {
      throw new Error(`${out}.glb round-trip FAILED: scene bounds are NaN (geometry did not decode).`);
    }
    console.log(`  round-trip OK: ${outRoot.listMeshes().length} meshes, ` +
      `bounds min=[${b.min.map((v) => v.toFixed(1))}] max=[${b.max.map((v) => v.toFixed(1))}]`);
  }

  // Copy the exporter's paved-mask sidecar next to the GLB (OUT(`${out}.paved_mask.png`)). The web
  // grass occlusion samples this top-down paved/built mask over the DEM rect to cull blades on
  // roads/walks/driveways — the old level RENDERED that mask from Roads/Sidewalks meshes that the
  // single-surface export no longer carries (roads are texture now), so the sidecar is the source
  // of truth. Returns whether the mask landed (the meta pass references it via `pavedMask`).
  let pavedMaskOut = null;
  if (pavedMaskSrc) {
    const maskSrc = SRC('exports', pavedMaskSrc);
    if (existsSync(maskSrc)) {
      const maskDst = OUT(`${out}.paved_mask.png`);
      copyFileSync(maskSrc, maskDst);
      written.push({ path: maskDst, bytes: statSync(maskDst).size });
      pavedMaskOut = `${out}.paved_mask.png`;
      console.log(`  copied paved mask -> ${path.relative(ROOT, maskDst)} (${mb(statSync(maskDst).size)})`);
    } else {
      console.warn(`  ! paved mask sidecar missing: ${pavedMaskSrc} (web grass occlusion will fall back to off)`);
    }
  }
  return { srcBytes, pavedMask: pavedMaskOut };
}

// =====================================================================================
console.log('\n=== Da Hilg asset build ===');

// -------------------------------------------------------------------------------------
// 1) LEVELS: build the meshopt level GLB for all three properties. dahill's source bytes
//    feed the summary's "level + 4 chars" reduction figure.
// -------------------------------------------------------------------------------------
let levelSrcBytes = 0;
const levelPavedMask = {};   // out -> "<out>.paved_mask.png" (or undefined) for the meta pass
for (const lv of LEVELS) {
  if (!existsSync(SRC('exports', lv.src))) {
    console.warn(`  ! skip missing level source: ${lv.src}`);
    continue;
  }
  const { srcBytes, pavedMask } = await buildLevelGlb(lv);
  levelPavedMask[lv.out] = pavedMask;
  if (lv.out === 'level') levelSrcBytes = srcBytes;   // dahill drives the summary comparison
}

// -------------------------------------------------------------------------------------
// 2) ANIMS: tiny clip-only GLBs (channels + bone hierarchy only, no mesh payload).
//    Done BEFORE characters so the clip-bind sanity (B) runs against dad's rig early.
// -------------------------------------------------------------------------------------
console.log('\n[2/4] anims (clip-only GLBs)');

// Canonical clip table: key -> { src, clip, stripRootXZ }
// Most clips now come from the shared family-anims.glb. The four character rigs share
// these 24 Mixamo-style bone NAMES, but their Meshy/local rest transforms are not all
// identical; runtime binding retargets rotations by rest-pose delta before creating
// AnimationActions. Build-time still strips unsafe foreign translations/scale.
const FAMILY_ANIMS = 'src/assets/anim/family-anims.glb';
// jack-hartmann.glb shares the SAME 24 bone names as family-anims/dad, so its clips bind
// to the shared rig with no remap — we source the cleaner locomotion + the new
// climb/crawl/stumble/hit/knockdown set from it.
const JACK_ANIMS = 'src/assets/jack-hartmann.glb';
const ANIMS = [
  { key: 'idle',  src: 'src/assets/anim/drew-idle.glb', clip: 'Armature|Boxing_Warmup|baselayer' },
  // walk/run now come from jack-hartmann (cleaner gait than the old Flirty_Strut). Both
  // travel forward, so stripRootXZ pins them in place — the capsule drives world position.
  { key: 'walk',  src: JACK_ANIMS,                      clip: 'Walking',                  stripRootXZ: true },
  { key: 'run',   src: JACK_ANIMS,                      clip: 'Running',                  stripRootXZ: true },
  { key: 'jump',  src: 'src/assets/dad.glb',            clip: '360_Power_Spin_Jump' },
  { key: 'dance', src: FAMILY_ANIMS,                    clip: 'Love_You_Pop_Dance' },
  { key: 'wave',  src: FAMILY_ANIMS,                    clip: 'Agree_Gesture' },
  { key: 'cheer', src: FAMILY_ANIMS,                    clip: 'Cheer_with_Both_Hands_Up' },
  // Aggressive clip the Nibbler swarm rides while clinging — a downward ground slam.
  { key: 'attack', src: FAMILY_ANIMS,                   clip: 'Charged_Ground_Slam' },
  // --- jack-hartmann gameplay clips (nibblers / downed player) ---
  // climb: the player scaling a wall with nibblers clinging — authored in-place, loops.
  { key: 'climb',     src: JACK_ANIMS, clip: 'Climb_Left_with_Both_Limbs_inplace' },
  // crawl: the downed player crawling forward — loops; pin XZ so the capsule drives position.
  { key: 'crawl',     src: JACK_ANIMS, clip: 'Climb_Right_with_Both_Limbs',        stripRootXZ: true },
  // stumble: an off-balance walk — loops; pin XZ so the capsule drives position.
  { key: 'stumble',   src: JACK_ANIMS, clip: 'Stumble_Walk',                       stripRootXZ: true },
  // hit: a one-shot flinch — played anchored, keep its (in-place) authored motion.
  { key: 'hit',       src: JACK_ANIMS, clip: 'Hit_Reaction' },
  // knockdown: a one-shot fall — played anchored, keep its authored fall motion.
  { key: 'knockdown', src: JACK_ANIMS, clip: 'Knock_Down' },
];

// Load dad's skeleton bone names once — assertion (B) checks every clip channel binds
// to one of these (the shared rig means clips retarget to any character with no remap).
const dadDoc = await io.read(SRC('src/assets/dad.glb'));
const dadBones = new Set(dadDoc.getRoot().listSkins()[0].listJoints().map((j) => j.getName()));
console.log(`  dad rig: ${dadBones.size} bones`);

// Build one clip-only GLB. Strategy: read the source fresh, drop every animation except
// the chosen one, rename it to the canonical key, then strip ALL meshes/skins so only the
// node hierarchy that the channels target remains, then prune + meshopt + write.
async function buildAnim({ key, src, clip, stripRootXZ }) {
  const doc = await io.read(SRC(src));
  const root = doc.getRoot();

  const target = root.listAnimations().find((a) => a.getName() === clip);
  if (!target) {
    const have = root.listAnimations().map((a) => a.getName());
    throw new Error(`anim "${key}": clip "${clip}" not found in ${src}. Have: [${have.join(', ')}]`);
  }

  // Drop the other clips.
  for (const a of root.listAnimations()) if (a !== target) a.dispose();
  target.setName(key);

  // -------- SKIN-SAFE RETARGET: drop unsafe translation + scale channels --------
  // The clips are shared across all 4 characters by bone NAME (no remap). A Mixamo clip
  // bakes a `translation` channel for EVERY bone holding the SOURCE character's skeleton
  // rest offsets. Bone offsets (limb/torso lengths) are a property of each character's
  // OWN bind, not the animation — so applying a foreign bone's translation TEARS the mesh
  // wherever the source and target bind poses differ. Concretely, the drew-sourced `idle`
  // forces dad/mike's torso-root bone (Spine02) ~0.20 m off its hip attachment → the
  // "floating torso / waist gap" bug. Bone ROTATIONS carry the actual motion and are
  // retargetable after runtime rest-pose correction, so we keep those (+ the Hips
  // translation, which is true root motion / the vertical bob). Scale channels are
  // likewise source-rig baggage for this project:
  // our character bind poses already carry the intended limb proportions, and animated
  // bone scale is a waist/limb distortion footgun. We strip scale everywhere and strip
  // translation on every bone EXCEPT Hips. This must run BEFORE stripRootXZ (which then
  // operates on the surviving Hips translation track).
  let droppedT = 0;
  let droppedS = 0;
  for (const ch of target.listChannels()) {
    const node = ch.getTargetNode();
    const targetPath = ch.getTargetPath();
    if (targetPath !== 'translation' && targetPath !== 'scale') continue;
    if (targetPath === 'translation' && node && node.getName() === 'Hips') continue;   // keep root motion
    const sampler = ch.getSampler();
    ch.dispose();
    // Dispose the channel's now-orphaned sampler input/output accessors via prune later;
    // disposing the channel detaches it from the animation so the bone keeps its bind pos.
    if (sampler && sampler.listParents().filter((p) => p.propertyType !== 'Root').length === 0) {
      sampler.dispose();
    }
    if (targetPath === 'translation') droppedT++;
    else droppedS++;
  }
  console.log(`    ${key}: dropped ${droppedT} non-Hips translation + ${droppedS} scale channel(s) (skin-safe retarget)`);

  // stripRootXZ: zero X+Z (keep Y) on the Hips translation track so the capsule drives
  // world position (in-place locomotion). Build-time only.
  if (stripRootXZ) {
    let zeroed = 0;
    for (const ch of target.listChannels()) {
      const node = ch.getTargetNode();
      if (!node || node.getName() !== 'Hips' || ch.getTargetPath() !== 'translation') continue;
      const sampler = ch.getSampler();
      const out = sampler.getOutput();
      const arr = Array.from(out.getArray());     // flat [x,y,z, x,y,z, ...]
      for (let i = 0; i < arr.length; i += 3) { arr[i] = 0; arr[i + 2] = 0; }
      out.setArray(new Float32Array(arr));
      zeroed++;
    }
    if (!zeroed) throw new Error(`anim "${key}": stripRootXZ found no Hips translation track.`);
    console.log(`    ${key}: stripRootXZ zeroed Hips X/Z on ${zeroed} track(s)`);
  }

  // Strip mesh payload: detach meshes + skins from nodes, dispose them. The bone nodes
  // the channels target stay (they're plain transform nodes), so the clip still binds.
  for (const node of root.listNodes()) {
    if (node.getMesh()) node.setMesh(null);
    if (node.getSkin()) node.setSkin(null);
  }
  for (const mesh of root.listMeshes()) mesh.dispose();
  for (const skin of root.listSkins()) skin.dispose();

  // prune everything unreachable EXCEPT keep the bone-node leaves the channels need.
  await doc.transform(prune({ keepLeaves: true }));
  stripDraco(doc);              // walk/run/etc. come from Draco character GLBs — drop the decl
  stripDanglingExtensions(doc); // drop now-empty material/texture extension declarations

  // meshopt the (tiny, mesh-free) doc so it carries EXT_meshopt_compression like the rest.
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));

  // Assertion (B): every channel target node name must exist in dad's bone set.
  let unmatched = 0;
  const channels = target.listChannels();
  for (const ch of channels) {
    const node = ch.getTargetNode();
    const nm = node ? node.getName() : '(null)';
    if (!dadBones.has(nm)) unmatched++;
  }
  if (unmatched !== 0) {
    throw new Error(`ASSERTION (B) FAILED: anim "${key}" has ${unmatched} channel(s) ` +
      `targeting nodes outside dad's rig — named-bone retarget would break.`);
  }

  // Assertion (C): NO bone but Hips may keep a translation channel, and NO scale channel
  // may ship. Foreign bone translations and animated scale tear the named-bone retarget
  // at the waist (the floating-torso bug).
  const strayT = channels.filter((ch) => {
    const node = ch.getTargetNode();
    return ch.getTargetPath() === 'translation' && !(node && node.getName() === 'Hips');
  });
  const strayS = channels.filter((ch) => ch.getTargetPath() === 'scale');
  if (strayT.length !== 0) {
    const names = strayT.map((ch) => ch.getTargetNode()?.getName()).join(', ');
    throw new Error(`ASSERTION (C) FAILED: anim "${key}" still has non-Hips translation ` +
      `channel(s) on [${names}] — these would tear the mesh on other characters.`);
  }
  if (strayS.length !== 0) {
    const names = strayS.map((ch) => ch.getTargetNode()?.getName()).join(', ');
    throw new Error(`ASSERTION (C) FAILED: anim "${key}" still has scale ` +
      `channel(s) on [${names}] — these would distort character proportions.`);
  }
  console.log(`    ${key}: ${channels.length} channels, 0 unmatched, only Hips translates, no scale (skin-safe)`);

  await writeAndVerify(doc, path.join(ANIM_DIR, `${key}.glb`), { label: `anim:${key}` });
}

for (const a of ANIMS) await buildAnim(a);

// -------------------------------------------------------------------------------------
// 3) CHARACTERS: 4 meshes, meshopt + webp, ALL embedded animation clips REMOVED
//    (we ship anims separately). Skinned-safe quantization.
// -------------------------------------------------------------------------------------
console.log('\n[3/4] characters (mike, kelli, cece, drew)');
const CHARS = [
  // Mike now uses the NEW jack-hartmann body (~11.6k verts vs dad's ~128k), SAME 24 bone
  // names — a clean small rig that fixes the floating-torso/waist break. It is under the
  // 40k-vert SIMPLIFY_VERT_THRESHOLD so decimation is skipped; the shared clips still bind.
  { out: 'mike.glb',  src: 'src/assets/jack-hartmann.glb' },
  { out: 'kelli.glb', src: 'src/assets/mom.glb' },
  // Cece now uses the NEW low-poly Meshy body (~5.6k verts vs the old ~128k), same 24 bone names.
  { out: 'cece.glb',  src: 'src/assets/cece-meshy.glb' },
  { out: 'drew.glb',  src: 'src/assets/drew-meshy.glb' },
];
// Skinned-safe quantization: do NOT over-quantize the 1.7 m rig (feet slide otherwise).
const CHAR_QUANT = {
  quantizePosition: 14,
  quantizeNormal: 10,
  quantizeTexcoord: 12,
  quantizeColor: 8,
  quantizeWeight: 8,
  quantizeGeneric: 12,
};
// TRIANGLE-BUDGET DECIMATION (skinned-mesh simplify):
//   - mike (~128k v / 220k t) and kelli (~166k v / 285k t) ship un-decimated; meshopt
//     compresses bytes, NOT triangles, so they skin + cast shadows at full detail every
//     frame (~85% of the character triangle load). A 1.7 m rig at gameplay distance does
//     not need that — target a ~30k-triangle budget for the heavy bodies.
//   - cece (~5.6k v) and drew (~13k v) are already light; we GATE simplify behind a vertex
//     threshold (SIMPLIFY_VERT_THRESHOLD) so they pass through essentially untouched.
//   - error=0.02 gives the collapse headroom to reach the budget; minRatio=0.10 floors the
//     ratio so the FACE/HANDS can't be dissolved if the budget math ever asks for too few
//     tris. The skin-safe + clip-bind assertions still run against the decimated result.
const SIMPLIFY_VERT_THRESHOLD = 40000;     // only decimate bodies heavier than this
const CHAR_SIMPLIFY = { targetTris: 30000, error: 0.02, minRatio: 0.10 };
const charSrcBytes = {};
for (const { out, src } of CHARS) {
  console.log(`  ${out} <- ${src}`);
  charSrcBytes[out] = statSync(SRC(src)).size;
  const doc = await io.read(SRC(src));
  // Remove ALL animation clips — shipped separately.
  for (const a of doc.getRoot().listAnimations()) a.dispose();
  // Gate decimation by source vertex count: only the heavy adult bodies cross the threshold;
  // cece/drew stay untouched. Simplify runs INSIDE meshoptPipeline (after weld, before quantize).
  const { verts: srcVerts } = countTris(doc);
  const simplifyOpts = srcVerts > SIMPLIFY_VERT_THRESHOLD ? CHAR_SIMPLIFY : null;
  if (!simplifyOpts) console.log(`    simplify: ${out} ${srcVerts} verts <= ${SIMPLIFY_VERT_THRESHOLD} threshold — left untouched`);
  // Characters cap textures at 512 — a 1.7 m rig never needs more (per-class cap).
  await meshoptPipeline(doc, out, CHAR_QUANT, 512, simplifyOpts);
  await writeAndVerify(doc, OUT(out), { label: out });
}

// -------------------------------------------------------------------------------------
// 4) META: compute recenter offset, ground, house bounds, spawns. From the ORIGINAL
//    (uncompressed source) level geometry so the numbers are exact. Generic over the
//    level: reads the SOURCE export `src` (the output GLB has stripped node names, so the
//    meta MUST come from the source), records `metaSource`, and writes OUT(`${out}.meta.json`).
// -------------------------------------------------------------------------------------
const { writeFileSync } = await import('node:fs');
async function buildLevelMeta({ src, out, metaSource }, pavedMask) {
  console.log(`\n[4/4] ${out}.meta.json  <- exports/${src}`);
  const metaDoc = await io.read(SRC('exports', src));
  const metaRoot = metaDoc.getRoot();
  const nodeByName = (nm) => metaRoot.listNodes().find((n) => n.getName() === nm);

  const terrainNode = nodeByName('Collision_Terrain');
  const visualTerrainNode = nodeByName('Terrain');
  const houseNode = nodeByName('House_walls');
  if (!terrainNode) throw new Error(`meta(${out}): Collision_Terrain node missing — cannot compute groundY.`);
  if (!houseNode) throw new Error(`meta(${out}): House_walls node missing — cannot compute houseCenter.`);

  const terrainBounds = getBounds(terrainNode);   // world-space AABB
  const houseBounds = getBounds(houseNode);
  // The visual Terrain bounds give the DEM rect the paved_mask covers (it's painted over the
  // same world rect). Fall back to the collider bounds if the visual node is somehow absent.
  const demBounds = visualTerrainNode ? getBounds(visualTerrainNode) : terrainBounds;

  // groundY: min Y of the walkable terrain (ORIGINAL coords).
  const groundY = terrainBounds.min[1];

  // houseCenter: center of House_walls bounds (ORIGINAL coords).
  const houseCenter = [
    (houseBounds.min[0] + houseBounds.max[0]) / 2,
    (houseBounds.min[1] + houseBounds.max[1]) / 2,
    (houseBounds.min[2] + houseBounds.max[2]) / 2,
  ];

  // offset = the translation to SUBTRACT so the property centers at XZ origin and ground
  // sits at y≈0. = [houseCenterX, groundY, houseCenterZ].
  const offset = [houseCenter[0], groundY, houseCenter[2]];
  const sub = (p) => [p[0] - offset[0], p[1] - offset[1], p[2] - offset[2]];
  const r3 = (n) => Math.round(n * 1000) / 1000;

  // houseBox in RECENTERED coords (subtract offset) — used to auto-fit the home SafeZone.
  const houseBox = {
    min: sub(houseBounds.min).map(r3),
    max: sub(houseBounds.max).map(r3),
  };

  // Recentered house footprint center (≈ origin in XZ) and a half-extent to scatter spawns.
  const hcR = sub(houseCenter);                 // recentered house center
  const hx = (houseBounds.max[0] - houseBounds.min[0]) / 2;
  const hz = (houseBounds.max[2] - houseBounds.min[2]) / 2;
  const groundYR = groundY - offset[1];         // ≈ 0 by construction
  const feetY = r3(groundYR + 0.05);            // feet just above ground

  // spawns: 2-3 player spawn points on the property near the house, feet ≈ groundY.
  // Placed just outside the house footprint on a few sides (front/side yard).
  const spawns = [
    [r3(hcR[0]),               feetY, r3(hcR[2] + hz + 3)],   // front yard
    [r3(hcR[0] + hx + 3),      feetY, r3(hcR[2])],            // side yard
    [r3(hcR[0] - hx - 3),      feetY, r3(hcR[2] - 2)],        // other side
  ];

  // npcSpawns: 4-6 NPC spawn points clustered within ~25 m of origin (near house/street,
  // NOT at the 220 m edges). Ring of points around the house at a modest radius.
  const npcSpawns = [
    [r3(hcR[0] + hx + 6),  feetY, r3(hcR[2] + hz + 6)],
    [r3(hcR[0] - hx - 6),  feetY, r3(hcR[2] + hz + 6)],
    [r3(hcR[0] + hx + 8),  feetY, r3(hcR[2] - hz - 4)],
    [r3(hcR[0] - hx - 8),  feetY, r3(hcR[2] - hz - 4)],
    [r3(hcR[0]),           feetY, r3(hcR[2] + hz + 14)],
    [r3(hcR[0] + 18),      feetY, r3(hcR[2] + 18)],
  ];

  // pavedMaskRect: the DEM/terrain rect the paved_mask covers, in RECENTERED world XZ. The web
  // grass occlusion loads <out>.paved_mask.png and maps a blade's recentered-world XZ into the
  // mask UV over this rect (min + size). The mask was painted with X→U (left→right) and Z→V; the
  // grass shader flips V for the default texture flipY, so { min:[x,z], size:[w,d] } maps cleanly.
  const demMinR = sub(demBounds.min);
  const demMaxR = sub(demBounds.max);
  const pavedMaskRect = {
    min: [r3(demMinR[0]), r3(demMinR[2])],
    size: [r3(demMaxR[0] - demMinR[0]), r3(demMaxR[2] - demMinR[2])],
  };

  const meta = {
    source: metaSource,
    note: 'Recenter: subtract `offset` from level world coords to center XZ at origin and put ground at y≈0. Level GLB geometry is UNMODIFIED — apply offset at runtime.',
    offset: offset.map(r3),
    groundY: r3(groundY),
    houseCenter: houseCenter.map(r3),
    houseBox,
    spawns,
    npcSpawns,
    // Grass occlusion: the top-down paved/built mask sidecar + the recentered DEM rect it covers.
    // null pavedMask => the sidecar was missing; the web grass occlusion then stays off (no mask).
    pavedMask: pavedMask || null,
    pavedMaskRect,
  };

  const metaPath = OUT(`${out}.meta.json`);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  written.push({ path: metaPath, bytes: statSync(metaPath).size });

  console.log('  computed meta:');
  console.log(`    offset      = [${meta.offset.join(', ')}]   (subtract from level world coords)`);
  console.log(`    groundY     = ${meta.groundY}   (Collision_Terrain min Y, original coords)`);
  console.log(`    houseCenter = [${meta.houseCenter.join(', ')}]   (House_walls center, original coords)`);
  console.log(`    houseBox    = min[${houseBox.min.join(', ')}] max[${houseBox.max.join(', ')}]   (recentered)`);
  console.log(`    spawns      = ${spawns.length} pts, e.g. [${spawns[0].join(', ')}]   (recentered)`);
  console.log(`    npcSpawns   = ${npcSpawns.length} pts within ~25 m of origin (recentered)`);
  console.log(`    pavedMask   = ${meta.pavedMask || '(none)'}   rect min[${pavedMaskRect.min.join(', ')}] size[${pavedMaskRect.size.join(', ')}] (recentered)`);
  return meta;
}

// Build meta for all levels; keep dahill's for the final summary line.
let meta;
for (const lv of LEVELS) {
  if (!existsSync(SRC('exports', lv.src))) {
    console.warn(`  ! skip missing level source: ${lv.src}`);
    continue;
  }
  const m = await buildLevelMeta(lv, levelPavedMask[lv.out]);
  if (lv.out === 'level') meta = m;   // dahill drives the summary
}

// =====================================================================================
// FINAL SUMMARY
// =====================================================================================
console.log('\n=== SUMMARY ===');
let totalOut = 0;
for (const { path: p, bytes } of written) {
  totalOut += bytes;
  console.log(`  ${path.relative(ROOT, p).padEnd(34)} ${mb(bytes).padStart(10)}`);
}

const totalSrc =
  levelSrcBytes +
  Object.values(charSrcBytes).reduce((a, b) => a + b, 0) +
  ANIMS.reduce((a, x) => a + statSync(SRC(x.src)).size, 0);
// (anim sources double-count dad/cece reads, but that's fine — it's a coarse "vs sources"
//  figure; the meaningful reduction is level + 4 chars which dominate.)
const heroSrc = levelSrcBytes + Object.values(charSrcBytes).reduce((a, b) => a + b, 0);
const heroOut = written
  .filter((w) => /level\.glb$|mike|kelli|cece|drew/.test(path.basename(w.path)))
  .reduce((a, w) => a + w.bytes, 0);

console.log(`\n  total output (incl. anims + meta): ${mb(totalOut)}`);
console.log(`  level + 4 chars:  sources ${mb(heroSrc)} -> outputs ${mb(heroOut)}  ` +
  `(${(100 * (1 - heroOut / heroSrc)).toFixed(1)}% smaller)`);

console.log('\n  meta: offset=[' + meta.offset.join(', ') + '] groundY=' + meta.groundY +
  ' houseCenter=[' + meta.houseCenter.join(', ') + ']');

console.log('\nALL ASSERTIONS PASSED');
