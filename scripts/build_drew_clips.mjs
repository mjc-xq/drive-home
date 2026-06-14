// Strip the (redundant) 15 MB mesh out of each Meshy animation GLB, leaving just
// the armature + the single AnimationClip. The runtime binds these clips to the
// one shared skeleton in drew.glb (bone names match across all exports), so we
// ship one mesh + N tiny clip files instead of N copies of the mesh.
//   node scripts/build_drew_clips.mjs
import { NodeIO } from '@gltf-transform/core';
import { prune, dedup } from '@gltf-transform/functions';
import { mkdirSync } from 'node:fs';

const SRC = '/Users/mcohen/Downloads/Meshy_AI_Spider_Man_T_Pose_biped';
const FILE = n => `${SRC}/Meshy_AI_Spider_Man_T_Pose_biped_Animation_${n}_withSkin.glb`;

// gameplay key -> Meshy animation name
const CLIPS = {
  walk: 'Walking',
  run: 'Running',
  idle: 'Boxing_Warmup',
  dance: 'All_Night_Dance',
  cheer: 'Angry_Ground_Stomp_1'
};

mkdirSync('src/assets/anim', { recursive: true });
const io = new NodeIO();

for (const [key, name] of Object.entries(CLIPS)) {
  const doc = await io.read(FILE(name));
  const root = doc.getRoot();
  // drop geometry + skinning; the bone node hierarchy + animation channels stay
  for (const node of root.listNodes()) { node.setMesh(null); node.setSkin(null); }
  for (const mesh of root.listMeshes()) mesh.dispose();
  for (const skin of root.listSkins()) skin.dispose();
  await doc.transform(prune(), dedup());
  const out = `src/assets/anim/drew-${key}.glb`;
  await io.write(out, doc);
  const clip = root.listAnimations()[0];
  console.log(`${out.padEnd(34)}  clip="${clip ? clip.getName() : '?'}"`);
}
