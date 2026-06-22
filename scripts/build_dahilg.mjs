#!/usr/bin/env node
/**
 * build_dahilg.mjs — the single, re-runnable Da Hilg build pipeline.
 *
 * Chains every stage that turns raw geo data into the deployable Unity WebGL game, so an
 * improved GLB export or a brand-new level is ONE command, not a pile of manual scripts.
 *
 *   STAGES (run in this order):
 *     export     per-level THREE->GLB master meshes      -> exports/<region>-property.glb
 *     assets     atlas facades + meshopt + KTX2          -> public/da-hilg/<glb>.glb
 *     unitysrc   decode meshopt for editor import        -> unity/.../Library/DaHilgUnitySource
 *     unitybuild Unity batchmode WebGL build             -> public/unity/da-hilg/{Build,StreamingAssets}
 *
 * USAGE
 *   node scripts/build_dahilg.mjs                      # full pipeline, all levels
 *   node scripts/build_dahilg.mjs --from=assets        # start at a stage (reuse earlier outputs)
 *   node scripts/build_dahilg.mjs --to=assets          # stop after a stage
 *   node scripts/build_dahilg.mjs --stages=export,assets   # only these stages
 *   node scripts/build_dahilg.mjs --levels=dahill,canyon   # export only these levels
 *   node scripts/build_dahilg.mjs --skip-unity         # alias for --to=unitysrc
 *   node scripts/build_dahilg.mjs --fetch-facades      # re-fetch Street View facades first (needs network)
 *   node scripts/build_dahilg.mjs --convert            # force Mixamo FBX -> body/clip GLBs before assets
 *                                                      # (otherwise auto-runs only when a body GLB is stale)
 *   node scripts/build_dahilg.mjs --dry-run            # print the plan, run nothing
 *
 * TO ADD A NEW LEVEL
 *   1. Get its data: geocode + fetch sidecars into exports/<region>/ (see scripts/export_meemaw.py
 *      for the meemaw example) and, for facades, run scripts/fetch_sv_facades.py for that scene.
 *   2. Add a LEVELS entry below: { slug, glb, region|working, streamed }.
 *   3. Mirror the slug in the consumers that still hard-code the set:
 *        - scripts/reexport_schools_from_sidecars.py  REGIONS  (school-style sidecar export)
 *        - DaHilgProjectBuilder.cs  BuildLevelProfiles + s_StreamedLevelSlugs + SyncSourceAssets CopyFiles
 *      (These are the remaining hard-coded lists; this registry is the canonical source the JS
 *       pipeline reads, and the place to look first.)
 *   4. Re-run: node scripts/build_dahilg.mjs
 */
import { execSync } from 'node:child_process';
import { statSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- LEVEL REGISTRY -------------------------------------------------------
// slug    : in-game id (matches DaHilgLevelProfile.Slug + StreamingAssets/<slug>.glb)
// glb     : basename under public/da-hilg/ and exports/ output naming
// working : true => exported straight from the live src/assets/scene.json (the Dahill home)
// region  : sidecar dir under exports/ => exported via reexport_schools_from_sidecars.py
// streamed: true => shipped to StreamingAssets + loaded at runtime (NOT baked into data.unityweb)
const LEVELS = [
  { slug: 'dahill',  glb: 'level',   working: true,                    streamed: true },
  { slug: 'canyon',  glb: 'canyon',  region: 'canyon-middle-school',   streamed: true },
  { slug: 'stanton', glb: 'stanton', region: 'stanton-elementary',     streamed: true },
  { slug: 'meemaw',  glb: 'meemaw',  region: 'meemaw',                 streamed: true },
  // 'xq' (807 Broadway, Oakland): its single-surface master (exports/xq-single.glb) is produced
  // out-of-band, so it has NO working/region export step here — the `assets` stage reads it
  // straight from exports/ (see build_dahilg_assets.mjs LEVELS) and `unitysrc` streams it.
  { slug: 'xq',      glb: 'xq',                                        streamed: true },
  // 'house' (interior) is baked, comes from a static GLB; not part of the geo export.
];

const STAGES = ['export', 'assets', 'unitysrc', 'unitybuild'];
const UNITY = '/Applications/Unity/Hub/Editor/6000.5.0f1/Unity.app/Contents/MacOS/Unity';

// ---- MIXAMO FBX CONVERT (optional, before the `assets` stage) ---------------------
// All three characters share ONE canonical Mixamo skeleton, so each character's Mixamo
// FBX dump (one @-clip per file + an @T-Pose mesh) converts to a body GLB + a clip-only
// GLB that join the shared motion library. The converter is the Blender-owned headless
// script; we just invoke it once per roster character. This step is OPT-IN — it runs only
// with --convert OR when a character's body GLB is stale/missing (freshness check) — so a
// normal `node scripts/build_dahilg.mjs` never reconverts.
const BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender';
const MIXAMO_CONVERTER = path.join(ROOT, 'scripts', 'convert_mixamo_fbx.py');
// Source Mixamo FBX folders per character id (the @-clip dumps). Shared-contract paths.
const MIXAMO_FBX_DIRS = {
  cece: path.join(os.homedir(), 'Downloads', 'Cece mixamo'),
  drew: path.join(os.homedir(), 'Downloads', 'drew-animations'),
  mike: path.join(os.homedir(), 'Downloads', 'dad'),
  kelli: path.join(os.homedir(), 'Downloads', 'kelli'),
};
// Roster manifest = single source of truth for the character set (id + body GLB path).
const ROSTER = JSON.parse(readFileSync(path.join(ROOT, 'config', 'dahilg-roster.json'), 'utf8'));

// ---- flags ----------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => { const a = argv.find(x => x === `--${name}` || x.startsWith(`--${name}=`)); return a === undefined ? undefined : (a.includes('=') ? a.split('=').slice(1).join('=') : true); };
const dryRun = !!flag('dry-run');
const fetchFacades = !!flag('fetch-facades');
const forceConvert = !!flag('convert');   // force the Mixamo FBX -> GLB convert step
let stages = STAGES.slice();
if (flag('stages')) stages = String(flag('stages')).split(',').map(s => s.trim()).filter(Boolean);
if (flag('from')) { const i = STAGES.indexOf(String(flag('from'))); if (i < 0) die(`unknown --from stage`); stages = STAGES.slice(i); }
if (flag('to')) { const i = STAGES.indexOf(String(flag('to'))); if (i < 0) die(`unknown --to stage`); stages = stages.filter(s => STAGES.indexOf(s) <= i); }
if (flag('skip-unity')) stages = stages.filter(s => s !== 'unitybuild');
// Secondary, local target: build a macOS .app instead of the WebGL bundle for the unitybuild stage.
const macTarget = !!flag('mac');
const levelFilter = flag('levels') ? String(flag('levels')).split(',').map(s => s.trim()) : null;
const levels = levelFilter ? LEVELS.filter(l => levelFilter.includes(l.slug)) : LEVELS;

function die(msg) { console.error('✗ ' + msg); process.exit(1); }
function sh(cmd, env) {
  console.log('  $ ' + cmd);
  if (dryRun) return;
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
}
function mb(p) { try { return (statSync(path.join(ROOT, p)).size / 1e6).toFixed(1) + ' MB'; } catch { return 'missing'; } }
function banner(s) { console.log(`\n${'='.repeat(70)}\n▶ ${s}\n${'='.repeat(70)}`); }

function splitUnityDataBundle() {
  const buildDir = path.join(ROOT, 'public/unity/da-hilg/Build');
  const dataName = 'da-hilg.data.unityweb';
  const dataPath = path.join(buildDir, dataName);
  if (!existsSync(dataPath)) return;

  for (const file of readdirSync(buildDir)) {
    if (file.startsWith(dataName + '.part')) unlinkSync(path.join(buildDir, file));
  }

  const data = readFileSync(dataPath);
  const chunkSize = 4 * 1024 * 1024;
  const chunks = [];
  for (let offset = 0, index = 0; offset < data.length; offset += chunkSize, index++) {
    const file = `${dataName}.part${index}`;
    writeFileSync(path.join(buildDir, file), data.subarray(offset, Math.min(offset + chunkSize, data.length)));
    chunks.push(file);
  }
  unlinkSync(dataPath);

  const indexPath = path.join(ROOT, 'public/unity/da-hilg/index.html');
  let html = readFileSync(indexPath, 'utf8');
  const version = html.match(/dataUrl:\s*'Build\/da-hilg\.data\.unityweb\?v=([^']+)'/)?.[1] || Date.now().toString(36);
  const partUrls = chunks.map(file => `Build/${file}?v=${version}`);
  html = html.replace(
    /dataUrl:\s*'Build\/da-hilg\.data\.unityweb\?v=[^']+'/,
    `dataUrl: '',\n        dataParts: ${JSON.stringify(partUrls)}`
  );
  html = html.replace(
    "      const script = document.createElement('script');",
    `      async function assembleUnityDataUrl(partUrls) {\n        const blobs = [];\n        for (const partUrl of partUrls) {\n          const response = await fetch(partUrl, { cache: 'no-store' });\n          if (!response.ok) throw new Error('Failed to load Unity data chunk ' + partUrl + ' (' + response.status + ')');\n          blobs.push(await response.blob());\n        }\n        const blobUrl = URL.createObjectURL(new Blob(blobs, { type: 'application/octet-stream' }));\n        window.__dahilg.dataBlobUrl = blobUrl;\n        return blobUrl;\n      }\n\n      const script = document.createElement('script');`
  );
  html = html.replace(
    "      script.onload = () => {\n        createUnityInstance(canvas, config, (progress) => {",
    "      script.onload = async () => {\n        try {\n          config.dataUrl = await assembleUnityDataUrl(config.dataParts);\n        } catch (dataErr) {\n          rememberHudError(dataErr);\n          alert(dataErr.message || dataErr);\n          return;\n        }\n        createUnityInstance(canvas, config, (progress) => {"
  );
  html = html.replace(
    "          window.__dahilg.unityReady = true;\n          document.querySelector('#unity-loading-bar').style.display = 'none';",
    "          window.__dahilg.unityReady = true;\n          if (window.__dahilg.dataBlobUrl) { URL.revokeObjectURL(window.__dahilg.dataBlobUrl); window.__dahilg.dataBlobUrl = null; }\n          document.querySelector('#unity-loading-bar').style.display = 'none';"
  );
  writeFileSync(indexPath, html);
  console.log(`  split data.unityweb into ${chunks.length} chunks (${(data.length / 1e6).toFixed(1)} MB total).`);
}

// ---- stages ---------------------------------------------------------------
function stageExport() {
  banner('EXPORT — per-level master GLBs');
  const working = levels.filter(l => l.working);
  const regions = levels.filter(l => l.region);
  if (fetchFacades) {
    banner('FETCH FACADES (network)');
    sh('scripts/.venv/bin/python scripts/fetch_sv_facades.py');
  }
  for (const l of working) {
    console.log(`\n· ${l.slug} (working scene)`);
    sh('node scripts/export_property_glb.mjs');
  }
  if (regions.length) {
    console.log(`\n· regions: ${regions.map(r => r.slug).join(', ')}`);
    // reexport_schools_from_sidecars.py snapshots+restores the Dahill working files, so it is
    // safe to run AFTER the Dahill export. ALLOW_UNSTAMPED lets cached (pre-fingerprint) school
    // facade manifests through.
    sh(`scripts/.venv/bin/python scripts/reexport_schools_from_sidecars.py ${regions.map(r => r.slug).join(' ')}`,
       { ALLOW_UNSTAMPED_SV_FACADES: '1' });
  }
}
// True if the character's body GLB (src/assets/<id>-mx.glb) is missing or OLDER than the
// newest .fbx in its source folder — i.e. the convert output is stale and should rebuild.
function mixamoConvertStale(id, body) {
  const out = path.join(ROOT, body);
  const dir = MIXAMO_FBX_DIRS[id];
  if (!dir || !existsSync(dir)) return false;     // no source folder => can't (re)convert
  if (!existsSync(out)) return true;              // never converted
  const outM = statSync(out).mtimeMs;
  const newest = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.fbx'))
    .reduce((m, f) => Math.max(m, statSync(path.join(dir, f)).mtimeMs), 0);
  return newest > outM;
}

// OPTIONAL Mixamo FBX -> GLB convert: per roster character, run the Blender-owned headless
// converter (one body GLB + one clip-only GLB per id). Runs only on --convert or a freshness
// miss; the character id is passed EXPLICITLY (the converter ignores the folder prefix). Each
// character is independently guarded so a missing folder/converter just warns + skips.
function maybeConvertMixamo() {
  const targets = ROSTER.characters.filter((c) =>
    forceConvert || mixamoConvertStale(c.id, c.body));
  if (targets.length === 0) {
    console.log('  (mixamo convert: bodies fresh — skipped; pass --convert to force)');
    return;
  }
  banner('CONVERT — Mixamo FBX -> shared-skeleton GLBs');
  if (!existsSync(BLENDER)) { console.warn(`  ! Blender not found at ${BLENDER} — skipping convert`); return; }
  if (!existsSync(MIXAMO_CONVERTER)) { console.warn(`  ! converter not found at ${path.relative(ROOT, MIXAMO_CONVERTER)} — skipping convert`); return; }
  // The converter writes BOTH <id>-mx.glb and <id>-mx-anims.glb into ONE out_dir; the repo
  // wants the body in src/assets/ and the clip GLB in src/assets/anim/. So convert into a tmp
  // dir, then split-copy to the two destinations the roster/asset-builder expect.
  const tmpOut = path.join(os.tmpdir(), 'dahilg-char-out');
  mkdirSync(tmpOut, { recursive: true });
  const animDir = path.join(ROOT, 'src', 'assets', 'anim');
  for (const c of targets) {
    const dir = MIXAMO_FBX_DIRS[c.id];
    if (!dir || !existsSync(dir)) { console.warn(`  ! no FBX folder for ${c.id} (${dir}) — skipping`); continue; }
    console.log(`\n· convert ${c.id} <- ${dir}`);
    // Args after '--' must be exactly: <fbx_folder> <character_id> <out_dir> (the converter's order).
    sh(`"${BLENDER}" --background --python "${MIXAMO_CONVERTER}" -- "${dir}" ${c.id} "${tmpOut}"`);
    const body = path.join(tmpOut, `${c.id}-mx.glb`);
    const anims = path.join(tmpOut, `${c.id}-mx-anims.glb`);
    if (!existsSync(body) || !existsSync(anims)) { die(`convert ${c.id}: expected ${c.id}-mx.glb + ${c.id}-mx-anims.glb in ${tmpOut}`); }
    copyFileSync(body, path.join(ROOT, c.body));                       // -> src/assets/<id>-mx.glb (manifest body)
    copyFileSync(anims, path.join(animDir, `${c.id}-mx-anims.glb`));   // -> src/assets/anim/<id>-mx-anims.glb
    console.log(`  ✓ ${c.id}: ${path.relative(ROOT, c.body)} + anim/${c.id}-mx-anims.glb`);
  }
}

function stageAssets() {
  banner('ASSETS — atlas + meshopt + KTX2 + minimaps');
  maybeConvertMixamo();   // optional FBX convert (runs BEFORE build:dahilg-assets)
  sh('npm run build:dahilg-assets');
  for (const l of levels.filter(x => x.streamed)) {
    sh(`node scripts/build_minimap.mjs ${l.slug}`);
  }
  sh('node scripts/build_dahilg_overlay.mjs');
}
function stageUnitySrc() { banner('UNITY SOURCE — decode meshopt for editor import'); sh('node scripts/build_dahilg_unity_assets.mjs'); }
function stageUnityBuild() {
  if (macTarget) {
    banner('UNITY BUILD — macOS standalone (local, secondary)');
    if (!existsSync(UNITY)) die(`Unity not found at ${UNITY}`);
    try {
      sh(`"${UNITY}" -batchmode -quit -projectPath unity/DaHilgUnity -executeMethod DaHilg.Editor.DaHilgProjectBuilder.BuildMacStandalone -logFile unity-build-mac.log`);
    } catch {
      console.log('  (Unity returned non-zero — verifying build output instead of trusting exit code)');
    }
    if (dryRun) return;
    const macLog = existsSync(path.join(ROOT, 'unity-build-mac.log')) ? readFileSync(path.join(ROOT, 'unity-build-mac.log'), 'utf8') : '';
    const app = path.join(ROOT, 'build/DaHilg-Mac/DaHilg.app');
    if (!macLog.includes('Exiting batchmode successfully') || !existsSync(app)) {
      die('Mac build failed (no success marker or missing DaHilg.app — see unity-build-mac.log)');
    }
    console.log('  Mac build verified at build/DaHilg-Mac/DaHilg.app');
    return;
  }
  banner('UNITY BUILD — WebGL (streaming + atlas + menus)');
  if (!existsSync(UNITY)) die(`Unity not found at ${UNITY}`);
  // Unity batchmode can exit non-zero over benign shutdown warnings (TagManager parse,
  // debugger-agent, leak detector) even when the build SUCCEEDS, so don't trust the exit
  // code alone — verify via the success marker + a fresh data file.
  try {
    sh(`"${UNITY}" -batchmode -quit -projectPath unity/DaHilgUnity -executeMethod DaHilg.Editor.DaHilgProjectBuilder.BuildWebGLExport -logFile unity-build.log`);
  } catch {
    console.log('  (Unity returned non-zero — verifying build output instead of trusting exit code)');
  }
  if (dryRun) return;
  const log = existsSync(path.join(ROOT, 'unity-build.log')) ? readFileSync(path.join(ROOT, 'unity-build.log'), 'utf8') : '';
  const data = path.join(ROOT, 'public/unity/da-hilg/Build/da-hilg.data.unityweb');
  if (!log.includes('Exiting batchmode successfully') || !existsSync(data)) {
    die('Unity build failed (no success marker or missing data.unityweb — see unity-build.log)');
  }
  splitUnityDataBundle();
  console.log('  Unity build verified (success marker present; data.unityweb split for deploy upload).');
}

// ---- run ------------------------------------------------------------------
console.log(`Da Hilg pipeline | stages: ${stages.join(' -> ')} | levels: ${levels.map(l => l.slug).join(', ')}${dryRun ? ' | DRY RUN' : ''}`);
const t0 = Date.now();
const run = { export: stageExport, assets: stageAssets, unitysrc: stageUnitySrc, unitybuild: stageUnityBuild };
for (const s of stages) { if (!run[s]) die(`unknown stage: ${s}`); run[s](); }

banner('DONE');
console.log(`elapsed: ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
if (stages.includes('assets')) for (const l of levels) console.log(`  public/da-hilg/${l.glb}.glb  ${mb(`public/da-hilg/${l.glb}.glb`)}`);
if (stages.includes('unitybuild')) {
  console.log(`  data.unityweb parts  ${mb('public/unity/da-hilg/Build/da-hilg.data.unityweb.part0')} first chunk`);
  for (const l of levels.filter(x => x.streamed)) console.log(`  StreamingAssets/${l.slug}.glb  ${mb(`public/unity/da-hilg/StreamingAssets/${l.slug}.glb`)}`);
}
