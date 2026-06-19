// GLB asset inventory for the R3F game.
//
// Reads animation names/durations, skin/bone info, node+mesh names, file sizes,
// and TRUE world-space bounding boxes. We register KHR_draco_mesh_compression +
// meshopt + ALL_EXTENSIONS purely so the reader passes validation; geometry is
// only decoded where needed.
//
// IMPORTANT measurement notes (verified empirically against these files):
//  * These character rigs use KHR_mesh_quantization, so POSITION accessor
//    min/max are RAW quantized integers (e.g. +/-32767), NOT meters. Reading
//    them directly reports a bogus ~655m "height".
//  * The meshes are SkinnedMeshes whose mesh-node transform is effectively
//    ignored at render; the real scale lives in the skeleton (an "Armature"
//    node scaled 0.01). So for CHARACTERS we measure the world-space extent of
//    the SKELETON JOINT ORIGINS (rest pose) — this yields the correct ~1.7m
//    humanoid height without needing to skin every vertex.
//  * LEVEL exports are static meshes; we decode POSITION via getElement()
//    (which dequantizes) and transform sampled vertices by node world matrices.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder } from 'meshoptimizer';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = '/Users/mcohen/dev/home';

const CHARACTERS = [
  ['Mike', 'src/assets/dad.glb'],
  ['Kelli', 'src/assets/mom.glb'],
  ['Cece', 'src/assets/cece.glb'],
  ['Drew', 'src/assets/drew.glb'],
];
const DREW_ANIMS = [
  ['drew-idle', 'src/assets/anim/drew-idle.glb'],
  ['drew-walk', 'src/assets/anim/drew-walk.glb'],
  ['drew-run', 'src/assets/anim/drew-run.glb'],
  ['drew-dance', 'src/assets/anim/drew-dance.glb'],
  ['drew-cheer', 'src/assets/anim/drew-cheer.glb'],
];
const LEVELS = [
  ['property', 'exports/1840-dahill-property.glb'],
  ['property-trees', 'exports/1840-dahill-property-trees.glb'],
  ['stylized', 'exports/1840-dahill-stylized.glb'],
];

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'meshopt.decoder': MeshoptDecoder,
  });

// --- tiny column-major mat4 helpers (no extra dep) ---
function mul(a, b) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}
function tp(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}
const ID = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const f = (n) => (Number.isFinite(n) ? n.toFixed(3) : String(n));
const sizeMB = (b) => (b / 1048576).toFixed(2) + ' MB';

function worldMatrices(root) {
  const wm = new Map();
  const visit = (n, pm) => {
    const w = mul(pm, n.getMatrix());
    wm.set(n, w);
    for (const c of n.listChildren()) visit(c, w);
  };
  for (const sc of root.listScenes()) for (const c of sc.listChildren()) visit(c, ID);
  return wm;
}

function emptyBox() { return { min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity] }; }
function grow(box, p) { for (let k = 0; k < 3; k++) { if (p[k] < box.min[k]) box.min[k] = p[k]; if (p[k] > box.max[k]) box.max[k] = p[k]; } }
function boxSize(box) { return box.min[0] === Infinity ? null : [box.max[0]-box.min[0], box.max[1]-box.min[1], box.max[2]-box.min[2]]; }
function boxCenter(box) { return box.min[0] === Infinity ? null : [(box.min[0]+box.max[0])/2,(box.min[1]+box.max[1])/2,(box.min[2]+box.max[2])/2]; }

function analyze(doc, kind) {
  const root = doc.getRoot();
  const asset = root.getAsset();
  const wm = worldMatrices(root);

  const anims = root.listAnimations().map((a) => {
    let maxT = 0;
    for (const s of a.listSamplers()) {
      const input = s.getInput();
      if (input) { const mx = input.getMax([]); if (mx && mx[0] > maxT) maxT = mx[0]; }
    }
    return { name: a.getName() || '(unnamed)', dur: maxT };
  });

  const skins = root.listSkins();
  const boneCount = skins.reduce((n, s) => n + s.listJoints().length, 0);
  const hasSkinnedMesh = root.listNodes().some((n) => n.getSkin() && n.getMesh());

  const nodeNames = root.listNodes().map((n) => n.getName() || '(unnamed)');
  const meshNames = root.listMeshes().map((m) => m.getName() || '(unnamed)');

  // --- bounding box ---
  let box = emptyBox();
  let method = '';
  if (kind === 'character' && skins.length) {
    // rest-pose skeleton extent: world positions of joint origins
    method = 'skeleton-joint-origins (rest pose, true meters)';
    for (const skin of skins) for (const j of skin.listJoints()) {
      const w = wm.get(j); if (!w) continue;
      grow(box, [w[12], w[13], w[14]]);
    }
  } else {
    // static mesh: decode (dequantize) sampled vertices, transform by world matrix
    method = 'decoded vertices x node world matrix';
    for (const n of root.listNodes()) {
      const mesh = n.getMesh(); if (!mesh) continue;
      const w = wm.get(n);
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION'); if (!pos) continue;
        const N = pos.getCount();
        const step = Math.max(1, Math.floor(N / 4000));
        const el = [];
        for (let i = 0; i < N; i += step) { pos.getElement(i, el); grow(box, tp(w, el)); }
      }
    }
  }

  return {
    anims, skins: skins.length, boneCount, hasSkinnedMesh, nodeNames, meshNames,
    generator: asset.generator || '', method,
    size: boxSize(box), center: boxCenter(box), min: box.min, max: box.max,
  };
}

function flagLevelNodes(names) {
  const pat = {
    ground: /ground|terrain|floor|grass|lawn|dirt|soil/i,
    collision: /coll?i?s?i?o?n?|collider|nav ?mesh|navmesh|walkable|blockout|invis|helper|proxy|bound/i,
    building: /house|building|garage|shed|barn|structure|wall|roof|facade|interior|porch/i,
    trees: /tree|foliage|veg|plant|bush|shrub|leaf|canopy|forest/i,
    road: /road|street|path|driveway|sidewalk|pavement|asphalt|curb/i,
    water: /water|creek|pond|river|stream|lake|pool/i,
    fence: /fence|gate|hedge|wall/i,
  };
  const hits = {};
  for (const [tag, re] of Object.entries(pat)) {
    const m = names.filter((n) => re.test(n));
    if (m.length) hits[tag] = m;
  }
  return hits;
}

function printChar(label, rel, bytes, r) {
  console.log('\n================================================================');
  console.log(`CHARACTER: ${label}  (${rel})   ${sizeMB(bytes)}`);
  console.log(`  generator: ${r.generator}`);
  console.log(`  rigged: skinnedMesh=${r.hasSkinnedMesh} skins=${r.skins} bones~${r.boneCount}`);
  if (r.size) {
    console.log(`  HEIGHT ~${f(r.max[1])} m  (skeleton Y extent ${f(r.size[1])} m; feet y=${f(r.min[1])}, top y=${f(r.max[1])})`);
    console.log(`  footprint x,z: ${f(r.size[0])} x ${f(r.size[2])} m   center xz: ${f(r.center[0])}, ${f(r.center[2])}`);
    console.log(`  [bbox method: ${r.method}]`);
  }
  console.log(`  animations (${r.anims.length}):`);
  for (const a of r.anims) console.log(`    "${a.name}"  ~${f(a.dur)}s`);
}

function printAnim(label, rel, bytes, r) {
  console.log(`\n--- ${label} (${rel})  ${sizeMB(bytes)} ---`);
  console.log(`  skins=${r.skins} bones~${r.boneCount} skinnedMesh=${r.hasSkinnedMesh} meshes=${r.meshNames.length}`);
  console.log(`  animations (${r.anims.length}):`);
  if (!r.anims.length) console.log('    (none)');
  for (const a of r.anims) console.log(`    "${a.name}"  ~${f(a.dur)}s`);
}

function printLevel(label, rel, bytes, r) {
  console.log('\n================================================================');
  console.log(`LEVEL: ${label}  (${rel})   ${sizeMB(bytes)}`);
  console.log(`  generator: ${r.generator}`);
  if (r.size) {
    console.log(`  EXTENT (x,y,z m): ${f(r.size[0])} x ${f(r.size[1])} x ${f(r.size[2])}`);
    console.log(`  min: ${r.min.map(f).join(', ')}   max: ${r.max.map(f).join(', ')}`);
    console.log(`  center: ${r.center.map(f).join(', ')}   [${r.method}]`);
  }
  console.log(`  animations: ${r.anims.length ? r.anims.map(a=>`"${a.name}"`).join(', ') : '(none)'}`);
  console.log(`  total nodes: ${r.nodeNames.length}   total meshes: ${r.meshNames.length}`);
  const flags = flagLevelNodes([...r.nodeNames, ...r.meshNames]);
  console.log('  FLAGGED node/mesh names:');
  if (!Object.keys(flags).length) console.log('    (none matched ground/collision/trees/roads/water/buildings patterns)');
  for (const [tag, names] of Object.entries(flags)) {
    const uniq = [...new Set(names)];
    console.log(`    ${tag} (${uniq.length}): ${uniq.slice(0, 25).join(' | ')}${uniq.length > 25 ? ' | ...' : ''}`);
  }
  console.log(`  ALL node names (${r.nodeNames.length}): ${r.nodeNames.slice(0, 80).join(' | ')}${r.nodeNames.length > 80 ? ' | ...(' + (r.nodeNames.length-80) + ' more)' : ''}`);
}

const out = { characters: [], drewAnims: [], levels: [] };

console.log('\n##################### CHARACTERS #####################');
for (const [label, rel] of CHARACTERS) {
  const abs = resolve(ROOT, rel); const bytes = statSync(abs).size;
  const r = analyze(await io.read(abs), 'character');
  out.characters.push({ label, rel, bytes, ...r });
  printChar(label, rel, bytes, r);
}

console.log('\n\n##################### DREW EXTERNAL ANIMATION CLIPS #####################');
for (const [label, rel] of DREW_ANIMS) {
  const abs = resolve(ROOT, rel); const bytes = statSync(abs).size;
  const r = analyze(await io.read(abs), 'anim');
  out.drewAnims.push({ label, rel, bytes, ...r });
  printAnim(label, rel, bytes, r);
}

console.log('\n\n##################### LEVEL EXPORTS #####################');
for (const [label, rel] of LEVELS) {
  const abs = resolve(ROOT, rel); const bytes = statSync(abs).size;
  const r = analyze(await io.read(abs), 'level');
  out.levels.push({ label, rel, bytes, ...r });
  printLevel(label, rel, bytes, r);
}

console.log('\n\n@@@JSON@@@');
console.log(JSON.stringify(out, (k, v) =>
  (k === 'nodeNames' || k === 'meshNames') && Array.isArray(v) && v.length > 400 ? v.slice(0, 400) : v));
process.exit(0);
