// The swarm — a Structure-of-Arrays of up to MAX_NIBBLERS nibblers in flat typed
// arrays, allocated once. This is the per-frame truth of the horde; it is a PLAIN
// module, never React/Jotai. Systems mutate it in place; the renderer reads it to
// fill the InstancedMesh buffers. Dead slots keep scale=0 (degenerate → the GPU
// discards them), so we always upload all MAX instances cheaply and never shift
// arrays — a free-list hands out and reclaims slots.

import {
  MAX_NIBBLERS,
  S_DESPAWN,
  S_SPAWN,
  CLIP_IDLE,
} from '../constants.js';

const MAX = MAX_NIBBLERS;

// ── Per-nibbler arrays (SoA) ────────────────────────────────────────────────
export const px = new Float32Array(MAX);
export const py = new Float32Array(MAX);
export const pz = new Float32Array(MAX);
export const vx = new Float32Array(MAX);
export const vy = new Float32Array(MAX);
export const vz = new Float32Array(MAX);
export const heading = new Float32Array(MAX); // yaw (radians)
export const scale = new Float32Array(MAX);   // 0 = dead/degenerate
export const phase = new Float32Array(MAX);   // VAT clip phase 0..1
export const stateT = new Float32Array(MAX);  // seconds in current state
export const jumpCD = new Float32Array(MAX);  // jump cooldown timer
export const circleDur = new Float32Array(MAX); // S_CIRCLE orbit duration (s) this pass
export const seed = new Float32Array(MAX);    // per-nibbler random 0..1

export const state = new Uint8Array(MAX);     // S_* enum
export const charIx = new Uint8Array(MAX);    // 0..3 which family member
export const clip = new Uint8Array(MAX);      // CLIP_* band currently playing
export const attachSlot = new Int16Array(MAX); // orbit slot when attached, -1 free

// ── Free-list ───────────────────────────────────────────────────────────────
const freeList = new Int32Array(MAX);
let freeTop = 0; // number of free slots in freeList[0..freeTop)

// ── Swarm-wide scratch (read/written by the systems) ────────────────────────
export const swarm = {
  liveCount: 0,      // alive nibblers (stats / spawn deficit)
  activeCount: 0,    // chasing/attaching (notice/run/jump) — drives HUD + spawner
  attachedCount: 0,  // currently attached to the player
  marked: false,
  markedT: 0,        // seconds since first marked (persists until safe)
  targetActive: 0,   // attraction-curve goal for active count
  spawnAccum: 0,     // fractional spawn accumulator
  panic: false,      // safe-zone scatter window (suppresses spawns)
  panicUntil: 0,
  attachNext: 0,     // monotonic attach-slot counter
};

/** Reset the whole swarm to empty (all slots free, all dead). Call on mode enter. */
export function resetSwarm() {
  for (let i = 0; i < MAX; i++) {
    state[i] = S_DESPAWN;
    scale[i] = 0;
    attachSlot[i] = -1;
    freeList[i] = MAX - 1 - i; // hand out low indices first
  }
  freeTop = MAX;
  swarm.liveCount = 0;
  swarm.activeCount = 0;
  swarm.attachedCount = 0;
  swarm.marked = false;
  swarm.markedT = 0;
  swarm.targetActive = 0;
  swarm.spawnAccum = 0;
  swarm.panic = false;
  swarm.panicUntil = 0;
  swarm.attachNext = 0;
}

/**
 * Allocate a nibbler slot, or -1 if full. Caller initializes the slot's fields.
 * @returns {number} index, or -1
 */
export function alloc() {
  if (freeTop === 0) return -1;
  const i = freeList[--freeTop];
  swarm.liveCount++;
  state[i] = S_SPAWN;
  clip[i] = CLIP_IDLE;
  attachSlot[i] = -1;
  return i;
}

/** Return a slot to the free-list (degenerate it so the GPU drops it). */
export function free(i) {
  if (state[i] === S_DESPAWN) return;
  state[i] = S_DESPAWN;
  scale[i] = 0;
  attachSlot[i] = -1;
  freeList[freeTop++] = i;
  if (swarm.liveCount > 0) swarm.liveCount--;
}

// resetSwarm must run before first use.
resetSwarm();
