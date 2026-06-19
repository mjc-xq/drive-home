// Controller contract. A Controller is a pure strategy object:
//   { id, produce(actor, ctx, dt) -> Intent }
// It ONLY computes intent; it never touches Rapier. Exactly one place applies
// motion (systems/stepMotion.js). Player vs NPC vs Idle differ only here.
//
// Intent = {
//   move:  { x, z },     // desired horizontal direction in WORLD space, magnitude 0..1
//                        // (camera-relative mapping is done by the controller, not stepMotion)
//   run:   boolean,      // sprint
//   jump:  boolean,      // edge-triggered desire to jump this frame
//   action: 'dance'|'wave'|'cheer'|null,  // emote request (consumed by animation/emote system)
// }
//
// ctx is the per-frame context built once in GameSystems (see CONTRACTS.md):
//   { store, world, rapier, registry, input, cameraRig, levelMeta, now, dt, activePlayerId }

import { PlayerController } from './PlayerController.js';
import { NpcController } from './NpcController.js';
import { IdleController } from './IdleController.js';

/** @typedef {{move:{x:number,z:number}, run:boolean, jump:boolean, action:?string}} Intent */

export const EMPTY_INTENT = Object.freeze({
  move: { x: 0, z: 0 },
  run: false,
  jump: false,
  action: null,
});

/** Strategy registry, keyed by controller kind. */
export const CONTROLLERS = {
  player: PlayerController,
  npc: NpcController,
  idle: IdleController,
};
