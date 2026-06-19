// Plain-mutable singletons — the per-frame truth of the simulation. These are
// NEVER React state and NEVER Jotai atoms: they are read and written every frame
// by the one simulation loop (scene/GameSystems.jsx) and by the camera. Putting
// 60-144 fps data in React would thrash re-renders; discrete UI state lives in
// state/atoms.js instead and is written change-gated at event boundaries.
//
// Modules import these by reference and mutate them in place. Do not reassign the
// bindings (mutate their fields).

import * as THREE from 'three';

/** @type {Map<string, import('../actors/actorRegistry.js').Actor>} */
export const registry = new Map(); // id -> Actor (built once at load in actorRegistry.buildRegistry)

// Merged input each frame from every source (keyboard, joystick, touch-look).
// Only the active player's controller consumes this.
export const input = {
  moveX: 0,        // strafe intent  [-1..1]  (right +)
  moveY: 0,        // forward intent [-1..1]  (forward +)
  run: false,
  jumpQueued: false,
  jumpQueuedT: -1, // performance.now ms when jump was pressed (jump buffer)
  // look deltas are applied straight to cameraRig.yaw/pitch by the look sources
};

// Camera state. targetId is the active player; FollowCamera/FPCamera read this.
export const cameraRig = {
  targetId: null,
  mode: 'first',   // 'first' | 'third'
  yaw: 0,          // radians, world
  pitch: 0,        // radians, clamped ±PITCH_MAX
  tpDistance: 4.5, // smoothed boom length
  // scratch vectors reused each frame to avoid GC
  _eye: new THREE.Vector3(),
  _pivot: new THREE.Vector3(),
  _dir: new THREE.Vector3(),
  _desired: new THREE.Vector3(),
};

// Level metadata loaded from public/da-hilg/level.meta.json (computed at build).
export const levelMeta = {
  loaded: false,
  offset: [0, 0, 0],         // subtract to recenter the level to origin/ground≈0
  groundY: 0,                // recentered ground height (≈0)
  houseCenter: [0, 0, 0],
  houseBox: { min: [0, 0, 0], max: [0, 0, 0] },
  spawns: [[0, 0.1, 0]],     // player spawn points (recentered)
  npcSpawns: [],             // NPC spawn points (recentered)
};

export const clock = { now: 0, dt: 0 };

/** Convenience: the active player's Actor (or undefined before load). */
export function activePlayer() {
  return cameraRig.targetId ? registry.get(cameraRig.targetId) : undefined;
}
