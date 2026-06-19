// The sim ↔ render bridge — a plain mutable module the renderer fills on mount
// and the sim writes every frame. This is deliberately NOT React/atoms: the horde
// is the typed-array SoA (swarm/swarmState.js), and the GPU upload is folded into
// the tail of updateSwarm(ctx).
//
// SwarmRenderer.jsx sets these fields on mount (the single InstancedMesh plus its
// three InstancedBufferAttributes) and nulls them on unmount. swarm/updateSwarm.js
// reads `swarmGpu.mesh` (skipping the upload entirely if it's null), then writes:
//   mesh.instanceMatrix (yaw + uniform-scale per slot from px/py/pz/heading/scale),
//   aPhase.array[i]   = phase[i],
//   aClip.array[i]    = clip[i],
//   aTint.array[3i..] = NIBBLER_TINTS[charIx[i]],
// flips `.needsUpdate = true` on each attribute + instanceMatrix, and leaves
// mesh.count = MAX_NIBBLERS (dead slots ride at scale 0 → the GPU discards them).

/**
 * @typedef {Object} SwarmGpu
 * @property {import('three').InstancedMesh|null} mesh
 * @property {import('three').InstancedBufferAttribute|null} aPhase float[MAX]
 * @property {import('three').InstancedBufferAttribute|null} aClip  float[MAX]
 * @property {import('three').InstancedBufferAttribute|null} aTint  vec3[MAX]
 */

/** @type {SwarmGpu} */
export const swarmGpu = {
  mesh: null,
  aPhase: null,
  aClip: null,
  aTint: null,
};
