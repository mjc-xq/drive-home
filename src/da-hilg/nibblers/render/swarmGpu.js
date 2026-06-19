// The sim ↔ render bridge — a plain mutable module the renderer fills on mount
// and the sim writes every frame. This is deliberately NOT React/atoms: the horde
// is the typed-array SoA (swarm/swarmState.js), and the GPU upload is folded into
// the tail of updateSwarm(ctx).
//
// Per-character meshes. The swarm now renders as FOUR InstancedMeshes (one per family
// member, so each shows its own decimated proxy geometry + real baseColor texture).
// SwarmRenderer.jsx publishes one bucket per character into `swarmGpu.byChar` (indexed
// by charIx 0..3 = mike/kelli/cece/drew); each bucket carries that mesh + its OWN
// per-instance aPhase/aClip buffers (instanced attrs live on the geometry, so they must
// be per-mesh). updateSwarm's uploadToGpu routes each live nibbler into its character's
// bucket at that bucket's running index, then sets each mesh.count to its counter.
//
// Each bucket: { mesh, aPhase, aClip } (mesh is the InstancedMesh; aPhase/aClip are its
// InstancedBufferAttributes). swarmGpu.byChar is a fixed-length-4 array (null until the
// renderer mounts). The instance matrix (yaw + uniform-scale + pos) is written exactly
// as before — only the destination mesh + index changes.

/**
 * @typedef {Object} SwarmCharBucket
 * @property {import('three').InstancedMesh} mesh
 * @property {import('three').InstancedBufferAttribute} aPhase float[MAX]
 * @property {import('three').InstancedBufferAttribute} aClip  float[MAX]
 */

/**
 * @typedef {Object} SwarmGpu
 * @property {(SwarmCharBucket|null)[]} byChar  one bucket per charIx 0..3 (null until mounted)
 */

/** @type {SwarmGpu} */
export const swarmGpu = {
  byChar: [null, null, null, null],
};
