// updateNibblers(ctx) — the single ordered nibblers pass, called from the one
// GameSystems useFrame (step 6) in nibblers mode, after stepMotion (player has its
// post-collision feet pos + velY this frame) and after flushZones (zone membership
// reconciled), before commitReactive.
//
// Zone feedback is NOT gated on poolReady(): safe discovery and danger marking must be
// immediate even while the real-NPC pool is still mounting. The horde-only work returns
// early until at least one Cece/Drew body is ready.
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

import { poolReady, publishToNpcPool } from '../render/npcPool.js';
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
  updateNibblerZones(ctx);

  // No mounted NPCs -> no horde yet. Still commit the zone-facing HUD state above
  // (marked/safe/timer=0), but skip spawn/sim/attachment work.
  if (!poolReady()) {
    commitNibblers(ctx);
    return;
  }

  spawnPolicy(ctx);
  updateSwarm(ctx);
  updateAttachment(ctx);
  updatePenalty(ctx);
  updateHealthDrain(ctx);
  updateStomp(ctx);
  // Publish to the real-NPC pool LAST — after every system that moves or retires a
  // nibbler (esp. updateAttachment, which positions the attached orbit shell) — so the
  // pooled NPCs (position/face/scale/clip + mixer tick) reflect THIS frame, not last.
  publishToNpcPool(ctx.dt);
  commitNibblers(ctx);
}
