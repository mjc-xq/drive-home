// Build per-character Vertex Animation Textures (VATs) for the "nibblers" — tiny
// decimated clones of the four family characters (Mike, Kelli, Cece, Drew) — so a
// swarm of hundreds renders as FOUR InstancedMeshes (one per character) that animate
// entirely on the GPU (sample a position/normal texture by vertexId + frame row) and
// show the REAL character baseColor texture (the proxy keeps its UVs).
//
// PIPELINE (run once PER CHARACTER):
//   1) DECIMATE  the character GLB (57k-166k-vert SkinnedMesh, 24-bone Mixamo rig) down
//      to a ~512-vert low-poly proxy, KEEPING skin weights (JOINTS_0/WEIGHTS_0) + the
//      skeleton AND the UVs, via gltf-transform weld() then
//      simplify({ simplifier: MeshoptSimplifier }, ['Permissive']).
//   2) CPU-SKIN every frame, HEADLESS (Approach A: three.js GLTFLoader.parse + AnimationMixer).
//      Clip bands in order [idle, run, jump, emote(=dance)], 24 frames each (t = dur*f/24).
//      Per vertex: applyBoneTransform (4-bone LBS) -> skinned LOCAL pos, then * matrixWorld
//      (the rig's 0.01 scale) -> world METERS (a ~1.6 m humanoid). Normal = blended-bone
//      rotation applied to the base normal, derived from (skin(pos+n) - skin(pos)).
//   3) PACK  to RGBA8 PNGs with a per-axis BOUNDS REMAP so float positions survive 8-bit:
//      store (val-min)/(max-min) in 0..255. width = vertCount, height = 4 clips * 24 = 96.
//      POSITION -> nibbler.<key>.vat.pos.png, NORMAL -> nibbler.<key>.vat.nrm.png.
//   3b) EMIT the character's baseColor texture, downscaled to <=512 PNG -> nibbler.<key>.tex.png,
//      so the runtime VAT material samples the REAL texture (the proxy carries the matching UVs).
//   4) EMIT   public/da-hilg/nibblers/{nibbler.<key>.proxy.glb, nibbler.<key>.vat.pos.png,
//      nibbler.<key>.vat.nrm.png, nibbler.<key>.tex.png} + a single nibbler.vat.json manifest
//      mapping each character key to its assets+meta. The proxy carries position+normal+uv + a
//      baked FLOAT attribute "aVertexId" (0..vertCount-1) and is meshopt-compressed.
//   5) ASSERTS (fail loudly), PER CHARACTER: vertCount in [200,1024]; texture dims < 4096; no
//      NaN; idle loops (seamless wrap); each band fully written + frames DIFFER; aVertexId is a
//      clean permutation of 0..N-1.
//
// Run:  node scripts/build_nibbler_vat.mjs   (or: npm run build:nibbler-vat)
import { NodeIO, Logger, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, prune, dedup, dequantize, meshopt } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { mkdirSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// three.js headless (Approach A) needs a `self` global; GLTFLoader.parse of geometry+skin
// +animations never touches WebGL, so no canvas/GL shim is required.
globalThis.self = globalThis;
const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = (...p) => path.join(ROOT, ...p);
const OUT_DIR = SRC('public', 'da-hilg', 'nibblers');
const OUT = (...p) => path.join(OUT_DIR, ...p);
mkdirSync(OUT_DIR, { recursive: true });

// The four family characters. charIx 0..3 = mike/kelli/cece/drew (mike=dad, kelli=mom).
const CHARACTERS = [
  { key: 'mike', src: 'src/assets/dad.glb' },
  { key: 'kelli', src: 'src/assets/mom.glb' },
  // Cece + Drew now decimate from the NEW low-poly Meshy bodies (same 24-bone rig).
  { key: 'cece', src: 'src/assets/cece-meshy.glb' },
  { key: 'drew', src: 'src/assets/drew-meshy.glb' },
];

// The shared Mixamo source: a 24-bone biped whose rig is byte-name-IDENTICAL to the
// four family characters, so its clips bind to every proxy skeleton by bone NAME with
// zero remapping (verified). The new low-poly cece-meshy.glb carries no usable clips, so
// EVERY character now sources its animation bands from here (not its embedded clips).
const FAMILY_ANIMS = SRC('src/assets/anim/family-anims.glb');
const DREW_IDLE = SRC('src/assets/anim/drew-idle.glb');
// Clip bands, in this exact order — the runtime indexes the BANDS by position:
//   0 idle, 1 run, 2 attack, 3 dance  (matches CLIP_* in nibblers/constants.js).
// idle is the calm Boxing_Warmup standing pose (family-anims has no calm idle — its
// "Catching_Breath" walks 5+ m forward). attack = Charged_Ground_Slam (a downward slam,
// authored in-place). dance = Love_You_Pop_Dance. Each `clip` is selected by NAME from
// the multi-clip source GLB (family-anims.glb holds 19 clips).
const BANDS = [
  { key: 'idle',   src: DREW_IDLE,    clip: 'Armature|Boxing_Warmup|baselayer' },
  { key: 'run',    src: FAMILY_ANIMS, clip: 'Running' },
  { key: 'attack', src: FAMILY_ANIMS, clip: 'Charged_Ground_Slam' },
  { key: 'dance',  src: FAMILY_ANIMS, clip: 'Love_You_Pop_Dance' },
];
const FRAMES = 24;
const TEX_MAX = 512;                  // downscale baseColor to <= this on the long edge
const kb = (b) => (b / 1024).toFixed(1) + ' KB';

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;

const io = new NodeIO()
  .setLogger(new Logger(Logger.Verbosity.ERROR))
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });

// three loader reused across characters (geometry+skin+anim parse only — no WebGL).
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const parseGLB = (buf) => new Promise((res, rej) =>
  loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));

// SKIN-SAFE RETARGET (the waist bug): a Mixamo clip bakes a `.position` (translation)
// track for EVERY bone holding the SOURCE rig's rest offsets. Bound onto a character with
// a different bind, those non-root translations yank the torso off the hips (floating-torso
// / waist gap). Bone ROTATIONS carry the real motion and are bind-agnostic, so we keep
// those + the Hips translation (true root motion) and DROP every non-Hips `.position`
// track. This is the three.js-side twin of the gltf-transform strip the hero anim pipeline
// runs — required now that we bake from the raw family-anims.glb (not the pre-stripped
// public/da-hilg/anims/*.glb). It also drops `.scale` tracks (a constant unit scale that
// only adds rows; the rig scale lives on matrixWorld).
function isHipsPositionTrack(trackName) {
  if (!trackName.endsWith('.position')) return false;
  const target = trackName.slice(0, -'.position'.length);
  return target === 'Hips' || target.endsWith('/Hips');
}

function skinSafeClip(clip) {
  clip.tracks = clip.tracks.filter((t) => {
    if (t.name.endsWith('.scale')) return false;
    if (t.name.endsWith('.position') && !isHipsPositionTrack(t.name)) return false;
    return true;
  });

  const strayPosition = clip.tracks.find((t) => t.name.endsWith('.position') && !isHipsPositionTrack(t.name));
  const strayScale = clip.tracks.find((t) => t.name.endsWith('.scale'));
  if (strayPosition || strayScale) {
    throw new Error(`bake: skin-safe clip strip failed (${strayPosition?.name || strayScale?.name})`);
  }

  return clip;
}

// Animation clips are character-independent (same Mixamo rig) — parse them ONCE, by NAME
// (the family-anims.glb source holds 19 clips, so animations[0] would be the wrong one).
const CLIPS = [];
for (const band of BANDS) {
  const gltf = await parseGLB(readFileSync(band.src));
  const clip = gltf.animations.find((a) => a.name === band.clip);
  if (!clip) {
    const have = gltf.animations.map((a) => a.name);
    throw new Error(`bake: band "${band.key}" clip "${band.clip}" not found in ${path.relative(ROOT, band.src)}. Have: [${have.join(', ')}]`);
  }
  const before = clip.tracks.length;
  skinSafeClip(clip);
  console.log(`  band ${band.key.padEnd(6)} <- ${band.clip}  (${before}→${clip.tracks.length} tracks, skin-safe)`);
  CLIPS.push(clip);
}

console.log('\n=== Nibbler per-character VAT build ===');

// Bake one character end-to-end. Returns the per-character manifest entry + asserts loudly.
async function bakeCharacter({ key, src }) {
  console.log(`\n────────────────────────────────────────────────────────`);
  console.log(`### Character: ${key}  (${src})`);
  const CHAR_SRC = SRC(src);

  // =====================================================================================
  // 1) DECIMATE -> ~512-vert skinned proxy (KEEP JOINTS_0/WEIGHTS_0 + skeleton + UVs).
  //    Source is int16-quantized: dequantize() first so the simplifier sees TRUE float
  //    positions. The 'Permissive' flag lifts the attribute-aware floor (UV/skin seams)
  //    so we reach a few hundred verts while each surviving vertex KEEPS its own skin
  //    weights AND its UV (we need the UV to sample the real baseColor texture).
  // =====================================================================================
  console.log(`\n[1/4] decimate ${path.basename(src)} -> skinned proxy (dequantize + Permissive simplify)`);
  const proxyDoc = await io.read(CHAR_SRC);
  for (const a of proxyDoc.getRoot().listAnimations()) a.dispose();   // no embedded anims anyway
  await proxyDoc.transform(dequantize(), dedup(), weld({ tolerance: 0.0001 }));
  // dad/mom ship Draco-compressed. After dequantize() the geometry is plain float, but the
  // KHR_draco_mesh_compression extension DECLARATION lingers as orphaned/used — dispose it so
  // the temp GLB we re-encode below is meshopt-only and the three GLTFLoader (Meshopt decoder
  // only, no DRACOLoader) can parse it for the CPU-skin bake.
  for (const ext of proxyDoc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_draco_mesh_compression') ext.dispose();
  }

  const wprim = proxyDoc.getRoot().listMeshes()[0].listPrimitives()[0];
  const wPos = Float32Array.from(wprim.getAttribute('POSITION').getArray());
  const wNrm = Float32Array.from(wprim.getAttribute('NORMAL').getArray());
  const wUv = Float32Array.from(wprim.getAttribute('TEXCOORD_0').getArray());
  const wJnt = wprim.getAttribute('JOINTS_0').getArray();         // Uint8/Uint16 (keep type)
  const wWgt = Float32Array.from(wprim.getAttribute('WEIGHTS_0').getArray());
  const wIdx = Uint32Array.from(wprim.getIndices().getArray());
  const weldedVerts = wPos.length / 3;
  console.log(`  welded source: ${weldedVerts} verts, ${wIdx.length / 3} tris`);

  // Target triangle budget. The surviving vert:tri ratio on this mesh is ~0.7, so a ~700-tri
  // budget lands ~500 verts. Permissive keeps error low (≈0.01).
  const targetTris = 700;
  const simRes = MeshoptSimplifier.simplify(wIdx, wPos, 3, targetTris * 3, 0.2, ['Permissive']);
  const newIdx = simRes[0];
  const [remap, newVcount] = MeshoptSimplifier.compactMesh(newIdx);   // remap[old]=new, 0xffffffff=dropped
  console.log(`  simplified: ${newIdx.length / 3} tris, ${newVcount} verts, error=${simRes[1].toFixed(4)}`);

  // Rebuild compacted attribute arrays (preserve per-vertex skin weights + UV), renormalize weights.
  const cPos = new Float32Array(newVcount * 3), cNrm = new Float32Array(newVcount * 3);
  const cUv = new Float32Array(newVcount * 2);
  const cJnt = new wJnt.constructor(newVcount * 4), cWgt = new Float32Array(newVcount * 4);
  for (let o = 0; o < weldedVerts; o++) {
    const n = remap[o];
    if (n === 0xffffffff) continue;
    for (let k = 0; k < 3; k++) { cPos[n * 3 + k] = wPos[o * 3 + k]; cNrm[n * 3 + k] = wNrm[o * 3 + k]; }
    cUv[n * 2] = wUv[o * 2]; cUv[n * 2 + 1] = wUv[o * 2 + 1];
    for (let k = 0; k < 4; k++) { cJnt[n * 4 + k] = wJnt[o * 4 + k]; cWgt[n * 4 + k] = wWgt[o * 4 + k]; }
  }
  for (let v = 0; v < newVcount; v++) {
    const s = cWgt[v * 4] + cWgt[v * 4 + 1] + cWgt[v * 4 + 2] + cWgt[v * 4 + 3] || 1;
    for (let k = 0; k < 4; k++) cWgt[v * 4 + k] /= s;
  }

  // Renormalize face normals length (dequantize may leave them un-normalized).
  for (let v = 0; v < newVcount; v++) {
    const x = cNrm[v * 3], y = cNrm[v * 3 + 1], z = cNrm[v * 3 + 2];
    const L = Math.hypot(x, y, z) || 1;
    cNrm[v * 3] = x / L; cNrm[v * 3 + 1] = y / L; cNrm[v * 3 + 2] = z / L;
  }

  // Mutate the welded primitive's accessors in place -> the skin + skeleton are untouched.
  wprim.getAttribute('POSITION').setArray(cPos);
  wprim.getAttribute('NORMAL').setArray(cNrm);
  wprim.getAttribute('TEXCOORD_0').setArray(cUv);
  wprim.getAttribute('JOINTS_0').setArray(cJnt);
  wprim.getAttribute('WEIGHTS_0').setArray(cWgt);
  wprim.getIndices().setArray(Uint32Array.from(newIdx));
  await proxyDoc.transform(prune({ keepLeaves: true }));

  if (!(newVcount >= 200 && newVcount <= 1024)) {
    throw new Error(`[${key}] decimation produced ${newVcount} verts, outside [200,1024]. Adjust targetTris.`);
  }

  // Persist the decimated+skinned proxy to a TEMP GLB, then load it in three for the bake.
  // Write it as PLAIN float (no meshopt/quantize): the Draco extension was disposed above so
  // the three GLTFLoader (Meshopt decoder only) can read it, and — critically — NO quantize
  // step runs, so the UVs stay EXACT 0..1 floats and the vertex order is preserved (meshopt
  // would reorder + quantize, corrupting the UVs we sample the baseColor texture with).
  const proxySkinnedTmp = OUT(`_proxy_skinned.${key}.tmp.glb`);
  await io.write(proxySkinnedTmp, proxyDoc);

  // =====================================================================================
  // 1b) EMIT baseColor texture (downscaled <= TEX_MAX) so the VAT material samples it.
  //     Read from the ORIGINAL char GLB (the decimate dropped no UVs, so it still maps).
  // =====================================================================================
  const origDoc = await io.read(CHAR_SRC);
  const baseTex = origDoc.getRoot().listMaterials()[0]?.getBaseColorTexture();
  if (!baseTex) throw new Error(`[${key}] source GLB has no baseColor texture.`);
  const texMeta = await sharp(Buffer.from(baseTex.getImage())).metadata();
  const texOut = OUT(`nibbler.${key}.tex.webp`);
  await sharp(Buffer.from(baseTex.getImage()))
    .resize({ width: TEX_MAX, height: TEX_MAX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90 })
    .toFile(texOut);
  const texOutMeta = await sharp(texOut).metadata();
  console.log(`  baseColor ${texMeta.format} ${texMeta.width}x${texMeta.height} -> ${path.relative(ROOT, texOut)} ${texOutMeta.width}x${texOutMeta.height} ${kb(statSync(texOut).size)}`);

  // =====================================================================================
  // 2) CPU-SKIN bake (headless). Load proxy + each clip via three; sample skinned world pos
  //    + normal per (vertex, frame). Output skinnedPos/skinnedNrm float arrays per band.
  // =====================================================================================
  console.log('\n[2/4] CPU-skin bake (headless three.js, Approach A)');
  const proxyGltf = await parseGLB(readFileSync(proxySkinnedTmp));
  let skinned = null;
  proxyGltf.scene.traverse((o) => { if (o.isSkinnedMesh && !skinned) skinned = o; });
  if (!skinned) throw new Error(`[${key}] bake: proxy GLB has no SkinnedMesh after decimation.`);
  const proxyRoot = proxyGltf.scene;
  proxyRoot.updateMatrixWorld(true);

  const geom = skinned.geometry;
  const vertCount = geom.attributes.position.count;
  console.log(`  proxy SkinnedMesh: ${vertCount} verts, ${skinned.skeleton.bones.length} bones`);
  if (!geom.attributes.skinIndex || !geom.attributes.skinWeight) {
    throw new Error(`[${key}] bake: proxy lost skin attributes (skinIndex/skinWeight).`);
  }

  // Base (rest) positions + normals + UVs as plain arrays (so the proxy.glb we emit later
  // matches the VAT vertex order exactly — we reuse THIS geometry for the emitted proxy).
  const basePos = geom.attributes.position.array;            // Float32 length vertCount*3
  const baseNrm = geom.attributes.normal
    ? geom.attributes.normal.array
    : (() => { geom.computeVertexNormals(); return geom.attributes.normal.array; })();
  const baseUV = geom.attributes.uv ? geom.attributes.uv.array : new Float32Array(vertCount * 2);

  const totalRows = BANDS.length * FRAMES;
  // Per-frame skinned outputs, row-major: row r (band*FRAMES + f), vertex v -> index (r*vertCount+v)*3
  const posData = new Float32Array(totalRows * vertCount * 3);
  const nrmData = new Float32Array(totalRows * vertCount * 3);

  const mw = skinned.matrixWorld;                            // rig 0.01 scale -> meters
  const nmat = new THREE.Matrix3().getNormalMatrix(mw);      // for transforming normals to world
  const vp = new THREE.Vector3();
  const vpn = new THREE.Vector3();
  const vn = new THREE.Vector3();

  // Track global bounds for the remap + a per-band "frames differ" check.
  const posMin = [Infinity, Infinity, Infinity], posMax = [-Infinity, -Infinity, -Infinity];
  const nrmMin = [Infinity, Infinity, Infinity], nrmMax = [-Infinity, -Infinity, -Infinity];
  let nanCount = 0;
  const bandFrameSig = [];   // per band: array of per-frame checksum to confirm motion

  for (let b = 0; b < BANDS.length; b++) {
    const band = BANDS[b];
    const clip = CLIPS[b];
    // Fresh mixer per band so actions don't accumulate weight.
    const mixer = new THREE.AnimationMixer(proxyRoot);
    const action = mixer.clipAction(clip, proxyRoot);
    action.reset();
    action.play();

    const sigs = [];
    for (let f = 0; f < FRAMES; f++) {
      const t = clip.duration * (f / FRAMES);
      mixer.setTime(t);
      proxyRoot.updateMatrixWorld(true);
      skinned.skeleton.update();

      const row = b * FRAMES + f;
      let sig = 0;
      for (let i = 0; i < vertCount; i++) {
        // skinned LOCAL position (4-bone LBS)
        vp.fromBufferAttribute(geom.attributes.position, i);
        skinned.applyBoneTransform(i, vp);
        vp.applyMatrix4(mw);                                 // -> world meters

        // skinned normal: skin(pos + n) - skin(pos), in the SAME local frame, then to world.
        vpn.set(basePos[i * 3] + baseNrm[i * 3], basePos[i * 3 + 1] + baseNrm[i * 3 + 1], basePos[i * 3 + 2] + baseNrm[i * 3 + 2]);
        skinned.applyBoneTransform(i, vpn);
        vp.set(basePos[i * 3], basePos[i * 3 + 1], basePos[i * 3 + 2]);
        skinned.applyBoneTransform(i, vp);                   // re-skin the pure pos (vp reused)
        vn.subVectors(vpn, vp).applyMatrix3(nmat);           // blended-bone-rotated normal, world
        if (vn.lengthSq() < 1e-12) vn.set(0, 1, 0); else vn.normalize();

        // re-skin the REAL position into vp for storage (we clobbered vp above)
        vp.fromBufferAttribute(geom.attributes.position, i);
        skinned.applyBoneTransform(i, vp);
        vp.applyMatrix4(mw);

        const o = (row * vertCount + i) * 3;
        const pxv = vp.x, pyv = vp.y, pzv = vp.z;
        if (Number.isNaN(pxv) || Number.isNaN(pyv) || Number.isNaN(pzv) ||
            Number.isNaN(vn.x) || Number.isNaN(vn.y) || Number.isNaN(vn.z)) nanCount++;
        posData[o] = pxv; posData[o + 1] = pyv; posData[o + 2] = pzv;
        nrmData[o] = vn.x; nrmData[o + 1] = vn.y; nrmData[o + 2] = vn.z;
        posMin[0] = Math.min(posMin[0], pxv); posMax[0] = Math.max(posMax[0], pxv);
        posMin[1] = Math.min(posMin[1], pyv); posMax[1] = Math.max(posMax[1], pyv);
        posMin[2] = Math.min(posMin[2], pzv); posMax[2] = Math.max(posMax[2], pzv);
        nrmMin[0] = Math.min(nrmMin[0], vn.x); nrmMax[0] = Math.max(nrmMax[0], vn.x);
        nrmMin[1] = Math.min(nrmMin[1], vn.y); nrmMax[1] = Math.max(nrmMax[1], vn.y);
        nrmMin[2] = Math.min(nrmMin[2], vn.z); nrmMax[2] = Math.max(nrmMax[2], vn.z);
        sig += pxv * 0.123 + pyv * 0.456 + pzv * 0.789;
      }
      sigs.push(sig);
    }
    bandFrameSig.push(sigs);
    // motion check: max abs diff between frame signatures within this band
    let maxSigDelta = 0;
    for (let f = 1; f < sigs.length; f++) maxSigDelta = Math.max(maxSigDelta, Math.abs(sigs[f] - sigs[0]));
    console.log(`  ${band.key.padEnd(6)} dur=${clip.duration.toFixed(2)}s rows ${b * FRAMES}..${b * FRAMES + FRAMES - 1}  frame-motion=${maxSigDelta.toFixed(2)} ${maxSigDelta > 1e-3 ? '(animating)' : 'STATIC!'}`);
  }

  console.log(`  baked ${totalRows} rows x ${vertCount} verts = ${totalRows * vertCount} samples`);
  console.log(`  pos bounds min=[${posMin.map((v) => v.toFixed(3))}] max=[${posMax.map((v) => v.toFixed(3))}]  (Y span ${(posMax[1] - posMin[1]).toFixed(3)} m)`);
  console.log(`  nrm bounds min=[${nrmMin.map((v) => v.toFixed(3))}] max=[${nrmMax.map((v) => v.toFixed(3))}]`);

  // =====================================================================================
  // 3) PACK to RGBA8 PNGs with per-axis bounds remap. width=vertCount, height=totalRows.
  //    Channel A is unused (255). NearestFilter intent — raw, no resize.
  // =====================================================================================
  console.log('\n[3/4] pack VAT textures (RGBA8, per-axis bounds remap)');
  const W = vertCount, H = totalRows;
  const span = (mn, mx) => mx - mn > 1e-9 ? mx - mn : 1;     // guard zero-span axes
  const posSpan = [span(posMin[0], posMax[0]), span(posMin[1], posMax[1]), span(posMin[2], posMax[2])];
  const nrmSpan = [span(nrmMin[0], nrmMax[0]), span(nrmMin[1], nrmMax[1]), span(nrmMin[2], nrmMax[2])];

  const posPx = Buffer.alloc(W * H * 4);
  const nrmPx = Buffer.alloc(W * H * 4);
  const enc = (val, mn, sp) => Math.max(0, Math.min(255, Math.round(((val - mn) / sp) * 255)));
  for (let r = 0; r < H; r++) {
    for (let v = 0; v < W; v++) {
      const o = (r * vertCount + v) * 3;
      const p = (r * W + v) * 4;
      posPx[p] = enc(posData[o], posMin[0], posSpan[0]);
      posPx[p + 1] = enc(posData[o + 1], posMin[1], posSpan[1]);
      posPx[p + 2] = enc(posData[o + 2], posMin[2], posSpan[2]);
      posPx[p + 3] = 255;
      nrmPx[p] = enc(nrmData[o], nrmMin[0], nrmSpan[0]);
      nrmPx[p + 1] = enc(nrmData[o + 1], nrmMin[1], nrmSpan[1]);
      nrmPx[p + 2] = enc(nrmData[o + 2], nrmMin[2], nrmSpan[2]);
      nrmPx[p + 3] = 255;
    }
  }
  const posPng = OUT(`nibbler.${key}.vat.pos.png`);
  const nrmPng = OUT(`nibbler.${key}.vat.nrm.png`);
  await sharp(posPx, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 9 }).toFile(posPng);
  await sharp(nrmPx, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 9 }).toFile(nrmPng);
  console.log(`  ${path.relative(ROOT, posPng)}  ${W}x${H}  ${kb(statSync(posPng).size)}`);
  console.log(`  ${path.relative(ROOT, nrmPng)}  ${W}x${H}  ${kb(statSync(nrmPng).size)}`);

  // =====================================================================================
  // 4) EMIT proxy.glb (geometry only: position+normal+uv + FLOAT aVertexId) + manifest entry.
  //    Build a fresh single-primitive glTF from the SAME arrays the bake used, so the runtime
  //    vertex order == the VAT column order. Strip skin/skeleton (not needed at runtime).
  //    KEEP the UV so the runtime can sample the emitted baseColor texture.
  // =====================================================================================
  console.log('\n[4/4] emit proxy.glb');
  const pdoc = new Document();
  const pbuf = pdoc.createBuffer();
  const acc = (arr, type) => pdoc.createAccessor().setType(type).setArray(arr).setBuffer(pbuf);
  const idxArr = geom.index ? Uint32Array.from(geom.index.array) : null;
  const aVertexId = new Float32Array(vertCount);
  for (let i = 0; i < vertCount; i++) aVertexId[i] = i;

  const prim = pdoc.createPrimitive()
    .setAttribute('POSITION', acc(Float32Array.from(basePos), 'VEC3'))
    .setAttribute('NORMAL', acc(Float32Array.from(baseNrm), 'VEC3'))
    .setAttribute('TEXCOORD_0', acc(Float32Array.from(baseUV), 'VEC2'))
    // aVertexId baked as a generic float attribute. Meshopt does NOT touch custom _* attrs'
    // values lossily here (no quantize step), so ids stay exact; runtime can also fall back
    // to gl_VertexID (vertCount is in json) if a toolchain ever rounds these.
    .setAttribute('_VERTEXID', acc(aVertexId, 'SCALAR'));
  if (idxArr) prim.setIndices(acc(idxArr, 'SCALAR'));
  const pmat = pdoc.createMaterial('nibbler').setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(0.9);
  prim.setMaterial(pmat);
  const pmesh = pdoc.createMesh('nibbler').addPrimitive(prim);
  const pnode = pdoc.createNode('nibbler').setMesh(pmesh);
  pdoc.createScene('nibbler').addChild(pnode);

  // meshopt-compress (handles the mixed-accessor GLB layout incl. the custom _VERTEXID
  // SCALAR; a plain-float write trips the interleaver). CRITICAL: meshopt's quantize step
  // would corrupt UVs that fall outside [0,1] (several characters' baseColor UVs tile past
  // the edge) — the texcoord quantizer then SKIPS normalization and leaves raw 0..65535
  // ints the runtime reads as garbage. So we WRAP the proxy UVs into [0,1] first (fract),
  // which is a no-op for in-range UVs and folds tiled UVs back onto the same texel the
  // RepeatWrapping sampler would have hit — keeping the real texture mapped correctly while
  // letting the quantizer store a clean NORMALIZED uint16 that three decodes back to 0..1.
  {
    const uvAccessor = prim.getAttribute('TEXCOORD_0');
    const uvArr = uvAccessor.getArray();
    for (let i = 0; i < uvArr.length; i++) {
      let f = uvArr[i] - Math.floor(uvArr[i]); // fract -> [0,1)
      if (!(f >= 0) || !(f <= 1)) f = 0;        // guard NaN/Inf
      uvArr[i] = f;
    }
    uvAccessor.setArray(uvArr);
  }
  await pdoc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  const proxyOut = OUT(`nibbler.${key}.proxy.glb`);
  await io.write(proxyOut, pdoc);

  // Verify aVertexId survived as EXACT ids and proxy has NO skin. NOTE: meshopt's vertex codec
  // REORDERS vertices (vertex-fetch optimization), so _VERTEXID values are a PERMUTATION of
  // 0..vertCount-1 — each value stays an exact integer id, it just no longer sits at array
  // index == its value. We verify the SET of values is exactly {0..vertCount-1}.
  let vertexIdExact;
  {
    const rd = await io.read(proxyOut);
    const rp = rd.getRoot().listMeshes()[0].listPrimitives()[0];
    const vid = rp.getAttribute('_VERTEXID').getArray();
    const seen = new Uint8Array(vertCount);
    let exact = vid.length === vertCount;
    for (let i = 0; i < vid.length && exact; i++) {
      const r = Math.round(vid[i]);
      if (Math.abs(vid[i] - r) > 1e-4 || r < 0 || r >= vertCount || seen[r]) exact = false;
      else seen[r] = 1;
    }
    if (!exact) {
      console.warn(`  ! [${key}] _VERTEXID not a clean 0..N permutation after meshopt — runtime should use gl_VertexID.`);
    } else {
      console.log(`  proxy _VERTEXID exact (permutation of 0..${vertCount - 1}; round() recovers id)`);
    }
    if (rd.getRoot().listSkins().length) console.warn(`  ! [${key}] proxy still has a skin (expected none).`);
    vertexIdExact = exact;
  }

  // Clean up the temp skinned proxy.
  rmSync(proxySkinnedTmp, { force: true });

  // ── per-character meta (same shape as the old single-character vat.json) ──
  const meta = {
    vertCount,
    rows: totalRows,
    frameCount: FRAMES,
    clips: Object.fromEntries(BANDS.map((band, b) => [band.key, { row: b * FRAMES, frames: FRAMES }])),
    posMin: posMin.map((v) => +v.toFixed(6)),
    posMax: posMax.map((v) => +v.toFixed(6)),
    nrmMin: nrmMin.map((v) => +v.toFixed(6)),
    nrmMax: nrmMax.map((v) => +v.toFixed(6)),
    layout: 'pos+nrm in separate pngs',
    posTexture: `nibbler.${key}.vat.pos.png`,
    nrmTexture: `nibbler.${key}.vat.nrm.png`,
    colorTexture: `nibbler.${key}.tex.webp`,
    proxy: `nibbler.${key}.proxy.glb`,
    aVertexId: vertexIdExact ? 'attribute' : 'glVertexID',
    attributeName: '_VERTEXID',
    textureWidth: W,
    textureHeight: H,
    filter: 'nearest',
    encoding: 'RGB = (val - min) / (max - min) in 0..255; A unused. Decode: val = min + (rgb/255)*(max-min).',
    note: 'Sample texel (x=vertexId, y=clip.row+frame). World-meters, feet at y~=0, rig faces +Z. colorTexture sampled by the proxy UV.',
  };

  // ── PER-CHARACTER ASSERTIONS (fail loudly) ──
  console.log('\n=== ASSERTIONS ===');
  const fail = (m) => { throw new Error(`ASSERTION FAILED [${key}]: ` + m); };

  if (!(vertCount >= 200 && vertCount <= 1024)) fail(`vertCount ${vertCount} not in [200,1024]`);
  console.log(`  [pass] vertCount=${vertCount} in [200,1024]`);

  if (W >= 4096 || H >= 4096) fail(`texture dims ${W}x${H} exceed 4096 budget`);
  console.log(`  [pass] texture ${W}x${H} within 4096 budget`);

  if (nanCount !== 0) fail(`${nanCount} NaN samples in skinned output`);
  console.log('  [pass] zero NaN in skinned positions/normals');

  if (!vertexIdExact) fail('_VERTEXID is not a clean permutation of 0..vertCount-1');
  console.log('  [pass] aVertexId is a clean permutation of 0..vertCount-1');

  // idle loopable: SEAMLESS WRAP. frame 24 == frame 0 (GPU wraps row 23 -> row 0).
  {
    const rowOf = (f) => (0 * FRAMES + f) * vertCount * 3;   // idle band = band 0
    const stepMax = (fa, fb) => {                            // max per-vertex displacement
      let m = 0; const a = rowOf(fa), b = rowOf(fb);
      for (let i = 0; i < vertCount; i++) {
        const dx = posData[a + i * 3] - posData[b + i * 3];
        const dy = posData[a + i * 3 + 1] - posData[b + i * 3 + 1];
        const dz = posData[a + i * 3 + 2] - posData[b + i * 3 + 2];
        m = Math.max(m, Math.hypot(dx, dy, dz));
      }
      return m;
    };
    const steps = [];
    for (let f = 0; f < FRAMES - 1; f++) steps.push(stepMax(f, f + 1));
    const wrapStep = stepMax(FRAMES - 1, 0);                 // f23 -> f0 (== f24 -> f0)
    const sorted = [...steps].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (wrapStep > Math.max(0.06, median * 3)) {
      fail(`idle not loopable: wrap step ${wrapStep.toFixed(4)} m >> median frame step ${median.toFixed(4)} m`);
    }
    console.log(`  [pass] idle loops seamlessly: wrap step ${wrapStep.toFixed(4)} m vs median ${median.toFixed(4)} m`);
  }

  // each band has motion (frames differ).
  for (let b = 0; b < BANDS.length; b++) {
    const sigs = bandFrameSig[b];
    let maxSigDelta = 0;
    for (let f = 1; f < sigs.length; f++) maxSigDelta = Math.max(maxSigDelta, Math.abs(sigs[f] - sigs[0]));
    if (!(maxSigDelta > 1e-3)) fail(`band ${BANDS[b].key} appears STATIC (no frame motion) — skinning broken`);
  }
  console.log('  [pass] all 4 bands animate (frames differ within each clip)');

  // humanoid range sanity (Y span ~1.7 m).
  {
    const ySpan = posMax[1] - posMin[1];
    if (!(ySpan > 1.2 && ySpan < 2.2)) fail(`pos Y span ${ySpan.toFixed(3)} m not a ~1.7 m humanoid`);
    console.log(`  [pass] humanoid Y span = ${ySpan.toFixed(3)} m`);
  }

  // each band fully written (all rows non-trivial).
  for (let r = 0; r < totalRows; r++) {
    let any = false;
    for (let i = 0; i < vertCount * 3 && !any; i++) if (posData[r * vertCount * 3 + i] !== 0) any = true;
    if (!any) fail(`row ${r} is all-zero (band not written)`);
  }
  console.log(`  [pass] all ${totalRows} rows written`);

  return {
    key,
    meta,
    files: [proxyOut, posPng, nrmPng, texOut],
  };
}

// =====================================================================================
// Drive all four characters, then emit the single combined manifest.
// =====================================================================================
const results = [];
for (const c of CHARACTERS) results.push(await bakeCharacter(c));

// Combined manifest: a per-character map keyed by character key, with an ordered
// `order` array (charIx 0..3 = mike/kelli/cece/drew) the runtime iterates.
const manifest = {
  version: 2,
  order: CHARACTERS.map((c) => c.key),
  characters: Object.fromEntries(results.map((r) => [r.key, r.meta])),
};
const jsonPath = OUT('nibbler.vat.json');
writeFileSync(jsonPath, JSON.stringify(manifest, null, 2) + '\n');

// =====================================================================================
// SUMMARY
// =====================================================================================
console.log('\n========================================================');
console.log('=== SUMMARY ===');
for (const r of results) {
  console.log(`  [${r.key}]`);
  for (const f of r.files) console.log(`    ${path.relative(ROOT, f).padEnd(42)} ${kb(statSync(f).size).padStart(10)}`);
}
console.log(`  ${path.relative(ROOT, jsonPath).padEnd(44)} ${kb(statSync(jsonPath).size).padStart(10)}`);
console.log('\n  manifest order:', manifest.order.join(', '));
console.log('\nALL ASSERTIONS PASSED (4/4 characters)');
