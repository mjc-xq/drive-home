// Build Unity-importable copies of the current Da Hilg web pipeline outputs.
//
// public/da-hilg is optimized for three.js/WebGL and uses EXT_meshopt_compression,
// which Unity's editor importer does not currently accept reliably. This bridge
// decodes Meshopt and writes uncompressed GLBs while preserving the current level,
// character, animation, minimap, and metadata outputs from the updated pipeline.

import { NodeIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, reorder, weld } from '@gltf-transform/functions';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = (...p) => path.join(ROOT, 'public', 'da-hilg', ...p);
const EXPORT = (...p) => path.join(ROOT, 'exports', ...p);
const OUT_DIR = path.join(ROOT, 'unity', 'DaHilgUnity', 'Library', 'DaHilgUnitySource');
const OUT = (...p) => path.join(OUT_DIR, ...p);
const useRawUnityLevelSources = process.env.DAHILG_UNITY_RAW_LEVELS === '1';

const io = new NodeIO()
  .setLogger(new Logger(Logger.Verbosity.ERROR))
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(OUT('anims'), { recursive: true });

const glbs = [
  'level.glb',
  'canyon.glb',
  'stanton.glb',
  'cece.glb',
  'drew.glb',
  'kelli.glb',
  'mike.glb',
  'meemaw.glb',
  'xq.glb',
  'sun3d.glb',
  'anims/attack.glb',
  'anims/cheer.glb',
  'anims/climb.glb',
  'anims/crawl.glb',
  'anims/dance.glb',
  'anims/hit.glb',
  'anims/idle.glb',
  'anims/jump.glb',
  'anims/knockdown.glb',
  'anims/run.glb',
  'anims/stumble.glb',
  'anims/walk.glb',
  'anims/wave.glb',
];

const sourceOverrides = useRawUnityLevelSources
  ? new Map([
    ['level.glb', EXPORT('1840-dahill-property.glb')],
    ['canyon.glb', EXPORT('canyon-middle-school-property.glb')],
    ['stanton.glb', EXPORT('stanton-elementary-property.glb')],
  ])
  : new Map();

const passthrough = [
  'level.meta.json',
  'canyon.meta.json',
  'stanton.meta.json',
  'minimap.json',
  'canyon.minimap.json',
  'stanton.minimap.json',
  'meemaw.meta.json',
  'meemaw.minimap.json',
  'xq.meta.json',
  'xq.minimap.json',
  'sun.png',
];

function stripMeshopt(doc) {
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'EXT_meshopt_compression') ext.dispose();
  }
}

function hasTreeMaterial(node) {
  const mesh = node.getMesh();
  if (!mesh) return false;
  for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial();
    if (mat && /tree/i.test(mat.getName() || '')) return true;
  }
  return false;
}

function isTreeVisualNode(node) {
  const name = node.getName() || '';
  if (/collision/i.test(name)) return false;
  if (!node.getMesh()) return false;
  if (/tree/i.test(name)) return true;
  return hasTreeMaterial(node);
}

function hashInstance(holderIndex, x, z) {
  // Deterministic spatial hash from this instance's own [x,z] (not the holder origin).
  let h = Math.imul(holderIndex + 0x9e3779b9, 2654435761) >>> 0;
  h ^= Math.round((x || 0) * 100) + 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
  h ^= Math.round((z || 0) * 100) + 0xc2b2ae35;
  return Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
}

// Filter the rows of an EXT_mesh_gpu_instancing attribute accessor in place,
// keeping only the indices in `keepRows` (in order). Works for VEC3/VEC4 floats.
function filterInstanceAttribute(accessor, keepRows) {
  const elementSize = accessor.getElementSize();
  const src = accessor.getArray();
  const out = new src.constructor(keepRows.length * elementSize);
  for (let row = 0; row < keepRows.length; row++) {
    const from = keepRows[row] * elementSize;
    out.set(src.subarray(from, from + elementSize), row * elementSize);
  }
  accessor.setArray(out);
}

// Each Da Hilg level folds ~700-900 placed trees into ~6 EXT_mesh_gpu_instancing
// "holder" nodes anchored at world origin. Trimming therefore has to happen
// PER INSTANCE using each instance's own translation, not the holder's origin.
// We uniformly thin (keep ~1 in N everywhere to preserve coverage) and only clear
// a small radius around the house/origin so the player isn't standing inside a trunk.
async function trimUnityLevelVegetation(doc, rel) {
  // Only the tree-rich neighborhood/school levels get GPU-instance thinning. xq (807 Broadway,
  // an urban building plot) may carry no instanced trees — and trimUnityLevelVegetation throws
  // on 0 surviving instances — so it is intentionally excluded (its editor-import copy keeps
  // whatever vegetation it has; the STREAMED runtime copy is the untouched public/da-hilg GLB).
  if (!['level.glb', 'canyon.glb', 'stanton.glb', 'meemaw.glb'].includes(rel)) return;

  // Uniform spatial thinning factor: keep ~1 in keepEvery instances. Tuned so the
  // home level lands at a few hundred trees (lush but Unity-friendly, ~300-400).
  const keepEvery = 2;
  // Small no-tree bubble around origin (house / player spawn) so no trunk-clipping.
  const clearRadius = 10;

  const holders = doc.getRoot().listNodes().filter((node) => {
    const inst = node.getExtension('EXT_mesh_gpu_instancing');
    return inst && (isTreeVisualNode(node) || hasTreeMaterial(node));
  });

  let sourceInstances = 0;
  let keptInstances = 0;

  for (let hi = 0; hi < holders.length; hi++) {
    const node = holders[hi];
    const inst = node.getExtension('EXT_mesh_gpu_instancing');
    const translation = inst.getAttribute('TRANSLATION');
    if (!translation) continue;

    const count = translation.getCount();
    sourceInstances += count;

    const keepRows = [];
    const el = [];
    for (let i = 0; i < count; i++) {
      translation.getElement(i, el);
      const x = el[0] || 0;
      const z = el[2] || 0;
      const flatDistance = Math.hypot(x, z);
      if (flatDistance <= clearRadius) continue; // clear bubble around house/origin
      if (hashInstance(hi, x, z) % keepEvery !== 0) continue; // uniform thinning
      keepRows.push(i);
    }

    if (keepRows.length === 0) {
      node.dispose();
      continue;
    }

    for (const semantic of inst.listSemantics()) {
      filterInstanceAttribute(inst.getAttribute(semantic), keepRows);
    }
    keptInstances += keepRows.length;
  }

  await doc.transform(prune({ keepLeaves: false }));

  // Fail loudly: a future regression that strips all trees must break the build
  // instead of silently shipping a bare level.
  if (keptInstances <= 0) {
    throw new Error(
      `unity vegetation ${rel}: 0 surviving tree instances (source ${sourceInstances}) — refusing to ship a treeless level`,
    );
  }

  console.log(`unity vegetation ${rel}: kept ${keptInstances}/${sourceInstances} tree instances`);
}

for (const rel of glbs) {
  const source = sourceOverrides.get(rel) || SRC(rel);
  const dest = OUT(rel);
  if (!existsSync(source)) {
    console.warn(`skip missing source: ${path.relative(ROOT, source)} (${rel})`);
    continue;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  const doc = await io.read(source);
  stripMeshopt(doc);
  await trimUnityLevelVegetation(doc, rel);
  await io.write(dest, doc);
  const written = statSync(dest).size;
  console.log(`unity glb ${rel} ${(written / 1e6).toFixed(2)} MB <- ${path.relative(ROOT, source)}`);
}

for (const rel of passthrough) {
  const source = SRC(rel);
  if (!existsSync(source)) continue;
  copyFileSync(source, OUT(rel));
}

console.log(`Unity Da Hilg assets written to ${path.relative(ROOT, OUT_DIR)}`);

// ---- StreamingAssets + Data staging for the STREAMED levels ----------------------------
// The outdoor Unity levels must NOT stream the public web GLBs directly. Those files are
// meshopt+KTX2, and when KTX2 transcoding fails or regresses in Unity/WebGL/iOS the roads,
// sidewalks, and photo facades disappear because they are texture-baked into the single surface.
// Instead, build a Unity-streaming GLB from exports/<slug>-single.glb: keep Meshopt geometry
// compression for download size, but preserve the ordinary JPEG/PNG textures that glTFast imports
// consistently. Stage that as StreamingAssets/<slug>.glb and copy its sidecar meta/minimap into
// DaHilg/Data. This mirrors DaHilgProjectBuilder.StageStreamingLevelGlb so a plain
// `node build_dahilg_unity_assets.mjs` (no Unity editor) already lands every streamed GLB + data in
// the project. The .paved_mask.png is web-grass-occlusion ONLY — Unity never reads it.
//
// slug : in-game id + StreamingAssets/<slug>.glb (DaHilgLevelRuntime keys off this)
// glb  : public/da-hilg/<glb>.glb basename (dahill's master is named "level")
// meta : public/da-hilg/<meta>.json + <meta>.minimap.json basename (dahill's is "level"/"minimap")
const STREAMED_LEVELS = [
  { slug: 'dahill',  glb: 'level',   meta: 'level',   minimap: 'minimap'         },
  { slug: 'canyon',  glb: 'canyon',  meta: 'canyon',  minimap: 'canyon.minimap'  },
  { slug: 'stanton', glb: 'stanton', meta: 'stanton', minimap: 'stanton.minimap' },
  { slug: 'meemaw',  glb: 'meemaw',  meta: 'meemaw',  minimap: 'meemaw.minimap'  },
  { slug: 'xq',      glb: 'xq',      meta: 'xq',      minimap: 'xq.minimap'      },
];
const STREAMING_DIR = path.join(ROOT, 'unity', 'DaHilgUnity', 'Assets', 'StreamingAssets');
const DATA_DIR = path.join(ROOT, 'unity', 'DaHilgUnity', 'Assets', 'DaHilg', 'Data');
const STREAM_BUILD_DIR = OUT('Streaming');
mkdirSync(STREAMING_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(STREAM_BUILD_DIR, { recursive: true });

function unityStreamSourceName(lv) {
  return lv.slug === 'dahill' ? 'dahill-single.glb' : `${lv.slug}-single.glb`;
}

async function buildUnityStreamingGlb(lv) {
  const rawSource = EXPORT(unityStreamSourceName(lv));
  if (!existsSync(rawSource)) {
    const webFallback = SRC(`${lv.glb}.glb`);
    if (existsSync(webFallback)) {
      console.warn(`stream: ${lv.slug} missing exports/${unityStreamSourceName(lv)}; falling back to public KTX2 web GLB`);
      return { path: webFallback, label: `public/da-hilg/${lv.glb}.glb` };
    }
    return null;
  }

  const out = path.join(STREAM_BUILD_DIR, `${lv.slug}.glb`);
  const doc = await io.read(rawSource);
  await doc.transform(
    dedup(),
    prune({ keepLeaves: true }),
    weld(),
    reorder({ encoder: MeshoptEncoder }),
    meshopt({ encoder: MeshoptEncoder, level: 'high' }),
  );
  await io.write(out, doc);
  return { path: out, label: `${path.relative(ROOT, rawSource)} (meshopt geometry + jpeg/png textures)` };
}

let stagedCount = 0;
for (const lv of STREAMED_LEVELS) {
  const streamSource = await buildUnityStreamingGlb(lv);
  if (!streamSource || !existsSync(streamSource.path)) {
    console.warn(`stream: skip ${lv.slug} — missing exports/${unityStreamSourceName(lv)} and public/da-hilg/${lv.glb}.glb`);
    continue;
  }
  const glbDst = path.join(STREAMING_DIR, `${lv.slug}.glb`);
  copyFileSync(streamSource.path, glbDst);
  stagedCount++;
  let extras = '';

  const overlaySrc = SRC(`${lv.glb}_overlay.glb`);
  if (existsSync(overlaySrc)) {
    copyFileSync(overlaySrc, path.join(STREAMING_DIR, `${lv.slug}_overlay.glb`));
    extras += ' +overlay';
  }

  // meta JSON -> DaHilg/Data/<meta>.json (BuildLevel reads offset/groundY/spawns from this)
  const metaSrc = SRC(`${lv.meta}.meta.json`);
  if (existsSync(metaSrc)) { copyFileSync(metaSrc, path.join(DATA_DIR, `${lv.meta}.meta.json`)); extras += ' +meta'; }
  // minimap JSON -> DaHilg/Data/<minimap>.json (optional; xq has none yet)
  const minimapSrc = SRC(`${lv.minimap}.json`);
  if (existsSync(minimapSrc)) { copyFileSync(minimapSrc, path.join(DATA_DIR, `${lv.minimap}.json`)); extras += ' +minimap'; }

  console.log(`stream: ${lv.slug}.glb ${(statSync(glbDst).size / 1e6).toFixed(2)} MB <- ${streamSource.label}${extras}`);
}
console.log(`StreamingAssets staged ${stagedCount}/${STREAMED_LEVELS.length} streamed level GLB(s) -> ${path.relative(ROOT, STREAMING_DIR)}`);
