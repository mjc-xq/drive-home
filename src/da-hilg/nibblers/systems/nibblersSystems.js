// updateNibblers(ctx) — the single ordered nibblers pass, called from the one
// GameSystems useFrame (step 6) in nibblers mode, after stepMotion (player has its
// post-collision feet pos + velY this frame) and after flushZones (zone membership
// reconciled), before commitReactive.
//
// The whole pass is gated on poolReady(): until the real-NPC pool has mounted at least
// one Cece/Drew body there is nothing to drive, so we return early (the swarm SoA stays
// empty, penalties stay {1,1,1}). This replaced the old assetsReady() VAT-texture gate.
//
// Order (each step is a plain function; no per-nibbler React, no second useFrame):
//   updateNibblerZones  marked / discovered / scatter from the reconciled zone set
//   spawnPolicy         attraction curve → target active → ring spawn / cull
//   updateSwarm         FSM over the SoA + spatial grid + integrate + GPU upload
//   updateAttachment    resolve contacts → attached orbit shell; swarm.attachedCount
//   updatePenalty       attachedCount → nibblerPenalty ref (consumed by stepMotion)
//   updateHealthDrain   attachedCount → active player's health
//   updateStomp         descending + grid query under feet → kill free nibblers + bounce
//   commitNibblers      change-gated / bucketed atom writes (the React-facing surface)

import { poolReady } from '../render/npcPool.js';
import { updateNibblerZones } from './nibblerZones.js';
import { spawnPolicy } from '../swarm/spawner.js';
import { updateSwarm } from '../swarm/updateSwarm.js';
import { updateAttachment } from '../swarm/attachment.js';
import { updatePenalty } from './penaltySystem.js';
import { updateHealthDrain } from './healthDrain.js';
import { updateStomp } from './stompSystem.js';
import { commitNibblers } from './commitNibblers.js';

/**
 * Run the full nibblers simulation pass for this frame.
 * @param {object} ctx per-frame ctx { store, world, rapier, registry, input,
 *   cameraRig, levelMeta, now, dt, activePlayerId }
 */
export function updateNibblers(ctx) {
  // No mounted NPCs → no horde yet. Skip the whole pass (keeps penalties at {1,1,1}).
  if (!poolReady()) return;

  updateNibblerZones(ctx);
  spawnPolicy(ctx);
  updateSwarm(ctx);
  updateAttachment(ctx);
  updatePenalty(ctx);
  updateHealthDrain(ctx);
  updateStomp(ctx);
  commitNibblers(ctx);
}
