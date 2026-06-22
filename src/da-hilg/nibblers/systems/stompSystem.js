// updateStomp(ctx) — the player kills nibblers by jumping into the pile and coming
// down on them. Risky and self-limiting by design: to stomp you must dive into the
// densest part of the swarm (where the attach test fires every frame, so you usually
// gain riders), and once you're loaded up jumpMul collapse means you can't get
// airborne enough to stomp at all. Stomping only frees UN-attached nibblers — it
// can't remove what's already clinging — reinforcing "safe zones, not combat".
//
// Cheap: reuses the uniform spatial-hash grid that updateSwarm built THIS frame
// (forNibblersNear from swarm/grid.js), so there's no extra broadphase.

import { swarm, state, free } from '../swarm/swarmState.js';
import { forNibblersNear } from '../swarm/grid.js';
import { emit } from '../../hud/hudEvents.js';
import {
  S_WANDER,
  S_NOTICE,
  S_RUN,
  S_JUMP,
  S_CIRCLE,
  STOMP_DESCEND_VEL,
  STOMP_RADIUS,
  STOMP_BOUNCE,
} from '../constants.js';

/**
 * Kill free nibblers under the player's feet on a fast descent, then bounce.
 * Only runs while marked (no swarm to stomp otherwise). Reads the player's
 * post-stepMotion velY/pos this frame.
 * @param {object} ctx per-frame ctx { registry, activePlayerId }
 */
export function updateStomp(ctx) {
  if (!swarm.marked) return;

  const player = ctx.registry.get(ctx.activePlayerId);
  if (!player) return;

  // Must be falling faster than the threshold (more negative than STOMP_DESCEND_VEL).
  if (player.motion.velY >= STOMP_DESCEND_VEL) return;

  const fx = player.motion.pos.x;
  const fz = player.motion.pos.z;

  let killed = 0;
  forNibblersNear(fx, fz, STOMP_RADIUS, (i) => {
    const s = state[i];
    // Only free (un-attached) chasing/wandering nibblers can be stomped.
    if (s === S_WANDER || s === S_NOTICE || s === S_RUN || s === S_JUMP || s === S_CIRCLE) {
      free(i);
      killed++;
    }
  });

  if (killed > 0) {
    // Small bounce — plain-ref write to the player's motion, allowed here (the
    // same plain-ref discipline greetSystem uses).
    player.motion.velY = STOMP_BOUNCE;
    emit('nibblerStomp', { count: killed });
  }
}
