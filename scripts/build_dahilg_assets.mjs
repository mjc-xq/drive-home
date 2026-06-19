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
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, textureCompress, reorder, quantize, meshopt, getBounds,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { ktx2CompressDoc } from './lib/ktx2_pass.mjs';
import { mkdirSync, statSync, existsSync } from 'node:fs';
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

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(ANIM_DIR, { recursive: true });

const mb = (bytes) => (bytes / 1e6).toFixed(2) + ' MB';
const written = [];          // { path, bytes } for the final summary
const DRACO_EXT = 'KHR_draco_mesh_compression';

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

// ---- meshopt geometry pipeline (shared by level + the 4 characters) ----
// Order per spec: dedup -> prune(keepLeaves) -> weld -> [KTX2|webp textures] -> reorder
//   -> quantize(flags) -> meshopt(setRequired) -> write.
// quantizeFlags differ: characters use skinned-safe values so the 1.7 m rig keeps
// tight feet (no over-quantized sliding); the level uses gltf-transform defaults.
// texCap is the per-class texture size cap (1024 landscape / 512 characters).
// Textures become GPU-compressed KTX2 when an encoder is on PATH, else webp.
async function meshoptPipeline(doc, label, quantizeFlags, texCap = 1024) {
  await doc.transform(dedup());
  await doc.transform(prune({ keepLeaves: true }));
  await doc.transform(weld());
  stripDraco(doc);          // geometry is already decoded on read; drop the dangling ext decl
  const ktx = await ktx2CompressDoc(doc, { maxSize: texCap, label });
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

// =====================================================================================
console.log('\n=== Da Hilg asset build ===');

// -------------------------------------------------------------------------------------
// 1) LEVEL: meshopt + webp. Keep geometry as-is (no recenter of verts). Preserve the
//    named collision/helper nodes. Drop the hidden LOD_Buildings_Low duplicate.
// -------------------------------------------------------------------------------------
console.log('\n[1/4] level.glb');
// The full, textured, tree+fence-rich neighborhood export (always grab the freshest
// from exports/ when re-importing — see docs/dahilg-neighborhood-export.md).
const LEVEL_SRC = SRC('exports', '1840-dahill-property-trees.glb');
const levelSrcBytes = statSync(LEVEL_SRC).size;
const levelDoc = await io.read(LEVEL_SRC);
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

  // Sanity: the collision/helper nodes the game relies on must still exist.
  const KEEP = ['Collision_Terrain', 'Collision_Roads', 'Collision_Buildings', 'Collision_Trees'];
  for (const nm of KEEP) {
    if (!root.listNodes().some((n) => n.getName() === nm)) {
      throw new Error(`level.glb: required collision node "${nm}" is missing before write.`);
    }
  }
  console.log('  preserved collision nodes: ' + KEEP.join(', '));

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

  // NOTE: prune(keepLeaves:true) keeps childless empty nodes, so the (now empty after
  // their mesh is disposed) collision helpers survive even if their mesh were dropped —
  // but here the collision meshes are real geometry and stay intact.
  await meshoptPipeline(levelDoc, 'level.glb', { quantizationVolume: 'scene' }, 1024);
}
await writeAndVerify(levelDoc, OUT('level.glb'), { label: 'level' });

// Round-trip / render check: re-read the written level + recompute bounds (proves the
// meshopt geometry decodes back cleanly with the registered MeshoptDecoder).
const levelOut = await io.read(OUT('level.glb'));
{
  const outRoot = levelOut.getRoot();
  const scene = outRoot.listScenes()[0];
  const b = getBounds(scene);
  if (!b || b.min.some(Number.isNaN) || b.max.some(Number.isNaN)) {
    throw new Error('level.glb round-trip FAILED: scene bounds are NaN (geometry did not decode).');
  }
  console.log(`  round-trip OK: ${outRoot.listMeshes().length} meshes, ` +
    `bounds min=[${b.min.map((v) => v.toFixed(1))}] max=[${b.max.map((v) => v.toFixed(1))}]`);
}

// -------------------------------------------------------------------------------------
// 2) ANIMS: 7 tiny clip-only GLBs (channels + bone hierarchy only, no mesh payload).
//    Done BEFORE characters so the clip-bind sanity (B) runs against dad's rig early.
// -------------------------------------------------------------------------------------
console.log('\n[2/4] anims (7 clip-only GLBs)');

// Canonical clip table: key -> { src, clip, stripRootXZ }
// Most clips now come from the shared family-anims.glb (a Mixamo biped whose 24-bone rig
// is byte-name-IDENTICAL to dad/mom/cece/drew — verified), so they bind to all four
// characters with zero remapping. idle + jump have no good family equivalent and stay on
// their original sources.
const FAMILY_ANIMS = 'src/assets/anim/family-anims.glb';
const ANIMS = [
  { key: 'idle',  src: 'src/assets/anim/drew-idle.glb', clip: 'Armature|Boxing_Warmup|baselayer' },
  // Flirty_Strut_inplace is authored IN-PLACE (Hips XZ travel ~0.085 m / ~0.025 m over the
  // whole clip — negligible) so we do NOT stripRootXZ; the small residual bob stays put.
  { key: 'walk',  src: FAMILY_ANIMS,                    clip: 'Flirty_Strut_inplace' },
  { key: 'run',   src: FAMILY_ANIMS,                    clip: 'Running',                  stripRootXZ: true },
  { key: 'jump',  src: 'src/assets/dad.glb',            clip: '360_Power_Spin_Jump' },
  { key: 'dance', src: FAMILY_ANIMS,                    clip: 'Love_You_Pop_Dance' },
  { key: 'wave',  src: FAMILY_ANIMS,                    clip: 'Agree_Gesture' },
  { key: 'cheer', src: FAMILY_ANIMS,                    clip: 'Cheer_with_Both_Hands_Up' },
  // Aggressive clip the Nibbler swarm rides while clinging — a downward ground slam.
  { key: 'attack', src: FAMILY_ANIMS,                   clip: 'Charged_Ground_Slam' },
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

  // -------- SKIN-SAFE RETARGET: drop non-root bone TRANSLATION channels --------
  // The clips are shared across all 4 characters by bone NAME (no remap). A Mixamo clip
  // bakes a `translation` channel for EVERY bone holding the SOURCE character's skeleton
  // rest offsets. Bone offsets (limb/torso lengths) are a property of each character's
  // OWN bind, not the animation — so applying a foreign bone's translation TEARS the mesh
  // wherever the source and target bind poses differ. Concretely, the drew-sourced `idle`
  // forces dad/mike's torso-root bone (Spine02) ~0.20 m off its hip attachment → the
  // "floating torso / waist gap" bug. Bone ROTATIONS carry the actual motion and are
  // bind-agnostic, so we keep those (+ the Hips translation, which is true root motion /
  // the vertical bob). We strip translation on every bone EXCEPT Hips. This must run
  // BEFORE stripRootXZ (which then operates on the surviving Hips translation track).
  let droppedT = 0;
  for (const ch of target.listChannels()) {
    const node = ch.getTargetNode();
    if (ch.getTargetPath() !== 'translation') continue;
    if (node && node.getName() === 'Hips') continue;   // keep root motion
    const sampler = ch.getSampler();
    ch.dispose();
    // Dispose the channel's now-orphaned sampler input/output accessors via prune later;
    // disposing the channel detaches it from the animation so the bone keeps its bind pos.
    if (sampler && sampler.listParents().filter((p) => p.propertyType !== 'Root').length === 0) {
      sampler.dispose();
    }
    droppedT++;
  }
  console.log(`    ${key}: dropped ${droppedT} non-Hips translation channel(s) (skin-safe retarget)`);

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
      `targeting nodes outside dad's rig — shared-rig retarget would break.`);
  }

  // Assertion (C): NO bone but Hips may keep a translation channel — a foreign bone's
  // translation tears the shared-rig retarget at the waist (the floating-torso bug).
  const strayT = channels.filter((ch) => {
    const node = ch.getTargetNode();
    return ch.getTargetPath() === 'translation' && !(node && node.getName() === 'Hips');
  });
  if (strayT.length !== 0) {
    const names = strayT.map((ch) => ch.getTargetNode()?.getName()).join(', ');
    throw new Error(`ASSERTION (C) FAILED: anim "${key}" still has non-Hips translation ` +
      `channel(s) on [${names}] — these would tear the mesh on other characters.`);
  }
  console.log(`    ${key}: ${channels.length} channels, 0 unmatched, only Hips translates (skin-safe)`);

  await writeAndVerify(doc, path.join(ANIM_DIR, `${key}.glb`), { label: `anim:${key}` });
}

for (const a of ANIMS) await buildAnim(a);

// -------------------------------------------------------------------------------------
// 3) CHARACTERS: 4 meshes, meshopt + webp, ALL embedded animation clips REMOVED
//    (we ship anims separately). Skinned-safe quantization.
// -------------------------------------------------------------------------------------
console.log('\n[3/4] characters (mike, kelli, cece, drew)');
const CHARS = [
  { out: 'mike.glb',  src: 'src/assets/dad.glb' },
  { out: 'kelli.glb', src: 'src/assets/mom.glb' },
  // Cece now uses the NEW low-poly Meshy body (~5.6k verts vs the old ~128k), same 24-bone rig.
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
const charSrcBytes = {};
for (const { out, src } of CHARS) {
  console.log(`  ${out} <- ${src}`);
  charSrcBytes[out] = statSync(SRC(src)).size;
  const doc = await io.read(SRC(src));
  // Remove ALL animation clips — shipped separately.
  for (const a of doc.getRoot().listAnimations()) a.dispose();
  // Characters cap textures at 512 — a 1.7 m rig never needs more (per-class cap).
  await meshoptPipeline(doc, out, CHAR_QUANT, 512);
  await writeAndVerify(doc, OUT(out), { label: out });
}

// -------------------------------------------------------------------------------------
// 4) META: compute recenter offset, ground, house bounds, spawns. From the ORIGINAL
//    (uncompressed source) level geometry so the numbers are exact.
// -------------------------------------------------------------------------------------
console.log('\n[4/4] level.meta.json');
const metaDoc = await io.read(LEVEL_SRC);
const metaRoot = metaDoc.getRoot();
const nodeByName = (nm) => metaRoot.listNodes().find((n) => n.getName() === nm);

const terrainNode = nodeByName('Collision_Terrain');
const houseNode = nodeByName('House_walls');
if (!terrainNode) throw new Error('meta: Collision_Terrain node missing — cannot compute groundY.');
if (!houseNode) throw new Error('meta: House_walls node missing — cannot compute houseCenter.');

const terrainBounds = getBounds(terrainNode);   // world-space AABB
const houseBounds = getBounds(houseNode);

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

const meta = {
  source: '1840-dahill-property.glb',
  note: 'Recenter: subtract `offset` from level world coords to center XZ at origin and put ground at y≈0. Level GLB geometry is UNMODIFIED — apply offset at runtime.',
  offset: offset.map(r3),
  groundY: r3(groundY),
  houseCenter: houseCenter.map(r3),
  houseBox,
  spawns,
  npcSpawns,
};

const { writeFileSync } = await import('node:fs');
writeFileSync(OUT('level.meta.json'), JSON.stringify(meta, null, 2) + '\n');
written.push({ path: OUT('level.meta.json'), bytes: statSync(OUT('level.meta.json')).size });

console.log('  computed meta:');
console.log(`    offset      = [${meta.offset.join(', ')}]   (subtract from level world coords)`);
console.log(`    groundY     = ${meta.groundY}   (Collision_Terrain min Y, original coords)`);
console.log(`    houseCenter = [${meta.houseCenter.join(', ')}]   (House_walls center, original coords)`);
console.log(`    houseBox    = min[${houseBox.min.join(', ')}] max[${houseBox.max.join(', ')}]   (recentered)`);
console.log(`    spawns      = ${spawns.length} pts, e.g. [${spawns[0].join(', ')}]   (recentered)`);
console.log(`    npcSpawns   = ${npcSpawns.length} pts within ~25 m of origin (recentered)`);

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
