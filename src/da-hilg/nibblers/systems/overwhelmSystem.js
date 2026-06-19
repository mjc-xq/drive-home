// updateOverwhelm(ctx) — the "getting buried" arc. As nibblers pile onto the player,
// a buried-time accumulator fills (faster the heavier the load) and bleeds off when
// they thin out, crossing tiers that progressively pin the player:
//
//   tier 0  normal
//   tier 1  stagger        (≥ OVERWHELM_STAGGER attached) — readable drag, still mobile
//   tier 2  downed         (buried ≥ OVERWHELM_FALL_T)    — knocked down, crawl-only
//   tier 3  pinned         (buried ≥ OVERWHELM_STOP_T)    — can't move until you shed them
//
// Reaching a safe zone scatters the horde (attachedCount → 0) which snaps the load to 0
// (instant recovery). Writes the plain nibblerPenalty ref (moveCap + canJump) that
// stepMotion reads, and exposes the tier for the animation/HUD. No atoms here.

import { nibblerPenalty } from '../mode.js';
import { swarm } from '../swarm/swarmState.js';
import {
  OVERWHELM_STAGGER,
  OVERWHELM_DOWN,
  OVERWHELM_STOP,
  OVERWHELM_FALL_T,
  OVERWHELM_STOP_T,
  OVERWHELM_RECOVER,
  OVERWHELM_CRAWL_SPEED,
} from '../constants.js';

/** Accumulated "buried" time (seconds). */
let load = 0;

/** Reset on a fresh run / mode re-enter. */
export function resetOverwhelm() {
  load = 0;
  nibblerPenalty.overwhelm = 0;
  nibblerPenalty.moveCap = Infinity;
  nibblerPenalty.canJump = true;
}

/**
 * Advance the overwhelm accumulator from the attached count and publish the tier +
 * movement caps onto nibblerPenalty.
 * @param {object} ctx per-frame ctx { dt }
 */
export function updateOverwhelm(ctx) {
  const a = swarm.attachedCount;
  const dt = ctx.dt;

  if (a === 0) {
    load = 0; // scattered / safe → pop back up immediately
  } else if (a >= OVERWHELM_STOP) {
    load += dt * 2.2; // pile-on fills fast
  } else if (a >= OVERWHELM_DOWN) {
    load += dt;
  } else if (a >= OVERWHELM_STAGGER) {
    load += dt * 0.35;
  } else {
    load = Math.max(0, load - dt * OVERWHELM_RECOVER);
  }

  let tier;
  if (load >= OVERWHELM_STOP_T) tier = 3;
  else if (load >= OVERWHELM_FALL_T) tier = 2;
  else if (a >= OVERWHELM_STAGGER) tier = 1;
  else tier = 0;

  nibblerPenalty.overwhelm = tier;
  nibblerPenalty.moveCap = tier >= 3 ? 0 : tier >= 2 ? OVERWHELM_CRAWL_SPEED : Infinity;
  nibblerPenalty.canJump = tier < 2;
}
