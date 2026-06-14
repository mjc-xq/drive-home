// Verify the Drew rig pipeline: the base mesh's skeleton bone names must match
// the clip track targets, or the clips won't drive the shared skeleton.
//   node scripts/verify_drew.mjs
import { readFileSync } from 'node:fs';
globalThis.self = globalThis;
const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

const loader = new GLTFLoader();
const parse = buf => new Promise((res, rej) =>
  loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));

const base = await parse(readFileSync('src/assets/drew.glb'));
let skinned = null;
base.scene.traverse(o => { if (o.isSkinnedMesh && !skinned) skinned = o; });
const box = new THREE.Box3().setFromObject(base.scene), size = new THREE.Vector3(); box.getSize(size);
const boneNames = new Set(skinned ? skinned.skeleton.bones.map(b => b.name) : []);
console.log('BASE  skinnedMesh:', !!skinned, ' bones:', boneNames.size);
console.log('BASE  bbox size:', size.toArray().map(v => +v.toFixed(4)), ' -> scale x100 =', (size.y * 100).toFixed(2), 'm');
console.log('BASE  sample bones:', skinned.skeleton.bones.slice(0, 6).map(b => b.name));

for (const key of ['walk', 'run', 'idle', 'dance', 'cheer']) {
  const g = await parse(readFileSync(`src/assets/anim/drew-${key}.glb`));
  const clip = g.animations[0];
  const trackBones = new Set(clip.tracks.map(t => t.name.split('.')[0]));
  let hit = 0; for (const n of trackBones) if (boneNames.has(n)) hit++;
  console.log(`CLIP ${key.padEnd(6)} dur=${clip.duration.toFixed(2)}s tracks=${clip.tracks.length} boneMatch=${hit}/${trackBones.size}`);
}
