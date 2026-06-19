// updatePenalty(ctx) — turn the attached-nibbler count into the player's movement
// penalties. Pure function of swarm.attachedCount via the constants curves; writes
// the plain nibblerPenalty ref (mode.js) that stepMotion reads at the speed/jump
// sites and the HUD reads for the visibility vignette. NO atoms here — that's
// commitNibblers' job (it mirrors visibility into an atom in 0.05 steps).
//
// Curves (a = attachedCount), anchored to the spec:
//   speedMul   = clamp( 1 / (1 + a/SPEED_MUL_K),        SPEED_MUL_MIN, 1 )
//   jumpMul    = clamp( 1 / (1 + a/JUMP_MUL_K)^1.3,     JUMP_MUL_MIN,  1 )
//   visibility = clamp( 1 - (a/VIS_K)^VIS_POW,          VIS_MIN,       1 )
// All monotone-decreasing in a, =1 at a=0 (so greet mode / no attachments is an
// exact no-op). Recomputed only when attachedCount changes (cached last value).

import { nibblerPenalty } from '../mode.js';
import { swarm } from '../swarm/swarmState.js';
import {
  SPEED_MUL_K,
  SPEED_MUL_MIN,
  JUMP_MUL_K,
  JUMP_MUL_MIN,
  VIS_K,
  VIS_POW,
  VIS_MIN,
} from '../constants.js';

/** Last attachedCount we computed penalties for; -1 forces a recompute on first call. */
let lastAttached = -1;

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Recompute the movement/visibility penalties from swarm.attachedCount (only when
 * the count changed) and write them into the shared nibblerPenalty ref.
 * @param {object} _ctx the per-frame ctx (unused — reads swarm SoA directly)
 */
export function updatePenalty(_ctx) {
  const a = swarm.attachedCount;
  if (a === lastAttached) return;
  lastAttached = a;

  nibblerPenalty.speedMul = clamp(1 / (1 + a / SPEED_MUL_K), SPEED_MUL_MIN, 1);
  nibblerPenalty.jumpMul = clamp(
    1 / Math.pow(1 + a / JUMP_MUL_K, 1.3),
    JUMP_MUL_MIN,
    1,
  );
  nibblerPenalty.visibility = clamp(
    1 - Math.pow(a / VIS_K, VIS_POW),
    VIS_MIN,
    1,
  );
}
