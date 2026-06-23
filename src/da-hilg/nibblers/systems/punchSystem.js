// playerPunch(ctx) — the player's melee swing. Reuses the existing detach/free
// mechanics rather than adding new physics:
//   • attached clingers are flung off via markedSystem.shedAttached (the same
//     S_ATTACHED → S_FALL impulse the overwhelm "struggle" uses);
//   • close FREE (chasing/wandering) nibblers in a forward cone are removed via
//     swarmState.free (the same retire stomp uses).
//
// Called imperatively from the input edge path (input/useEdgeKeys.js) on left-click
// or F — NOT from a useFrame. It reads the swarm SoA + the active player's current
// motion (feet pos + facing). Self-limiting: it only clears what's in front, so a
// heavy pile still needs jumps / safe zones (keeps "safe zones, not combat").
//
// Cheap: a single forward-cone scan over the live slots (the swarm is small — capped
// at MAX_NIBBLERS real NPCs), no extra broadphase, no per-frame allocation.

import { isNibblersMode } from '../mode.js';
import { swarm, state, scale, px, pz, free } from '../swarm/swarmState.js';
import { shedAttached } from './markedSystem.js';
import {
  S_WANDER,
  S_NOTICE,
  S_RUN,
  S_JUMP,
  S_CIRCLE,
  PUNCH_RANGE,
  PUNCH_HALF_ANGLE,
  PUNCH_SHED_N,
  PUNCH_COOLDOWN_MS,
  PUNCH_CRUSH_RADIUS,
  PUNT_SPEED,
  PUNT_UP,
  PUNT_COUNT,
} from '../constants.js';
import { puntNibbler } from '../swarm/nibblerFSM.js';
import { emit } from '../../hud/hudEvents.js';

// Last landed-punch time so a held / rapid trigger can't farm hits every frame.
let _lastPunchT = -1;

/** Reset on a fresh run / mode re-enter. */
export function resetPunch() {
  _lastPunchT = -1;
}

/**
 * Resolve a player punch this instant: knock attached clingers off the body and free
 * close chasing nibblers in the forward cone. No-op outside nibblers mode or on
 * cooldown. Returns the number of nibblers affected (shed + freed).
 * @param {object} ctx lite ctx — needs { registry, activePlayerId }
 * @returns {number}
 */
export function playerPunch(ctx) {
  if (!isNibblersMode() || !swarm.marked) return 0;

  const player = ctx.registry.get(ctx.activePlayerId);
  if (!player) return 0;

  const now = performance.now();
  if (_lastPunchT >= 0 && now - _lastPunchT < PUNCH_COOLDOWN_MS) return 0;
  _lastPunchT = now;

  const m = player.motion;
  const fx = m.pos.x;
  const fz = m.pos.z;
  // World-forward from facing (matches stepMotion's facing convention used elsewhere).
  const fwdX = -Math.sin(m.facing);
  const fwdZ = -Math.cos(m.facing);

  // 1) Knock attached clingers off the front of the body. shedAttached flings the
  //    first batch outward+up (S_ATTACHED → S_FALL) from the player center — reusing
  //    the overwhelm struggle's exact detach so the pile thins on a hit.
  const shed = shedAttached(m.pos, PUNCH_SHED_N);

  // 2) Resolve the swing against FREE (un-attached) nibblers. A standard punch CRUSHES anyone
  //    massed right at the feet (no cone, no gate) and FREES the forward cone; a KICK / FINISHER
  //    (attack4/attack5) instead PUNTS the front nibblers FLYING. The crush pass is what finally
  //    makes the swarm piled at your feet react to a punch.
  const isBigHit = ctx.attackKey === 'attack4' || ctx.attackKey === 'attack5';
  const cosHalf = Math.cos(PUNCH_HALF_ANGLE);
  const r2 = PUNCH_RANGE * PUNCH_RANGE;
  const crush2 = PUNCH_CRUSH_RADIUS * PUNCH_CRUSH_RADIUS;
  let freed = 0;
  let crushed = 0;
  let punted = 0;
  for (let i = 0; i < scale.length; i++) {
    if (scale[i] <= 0) continue;
    const s = state[i];
    if (s !== S_WANDER && s !== S_NOTICE && s !== S_RUN && s !== S_JUMP && s !== S_CIRCLE) continue;
    const dx = px[i] - fx;
    const dz = pz[i] - fz;
    const d2 = dx * dx + dz * dz;
    // CRUSH: anyone right under/around the feet — no cone, no fall-velocity gate.
    if (d2 <= crush2) {
      free(i);
      crushed++;
      continue;
    }
    if (d2 > r2) continue;
    const d = Math.sqrt(d2) + 1e-5;
    if ((dx * fwdX + dz * fwdZ) / d < cosHalf) continue; // forward cone
    if (isBigHit && punted < PUNT_COUNT) {
      puntNibbler(i, fwdX, fwdZ, PUNT_SPEED, PUNT_UP); // send it flying with a reaction
      punted++;
    } else {
      free(i);
      freed++;
    }
  }

  const hit = shed + freed + crushed + punted;
  if (crushed > 0) emit('nibblerStomp', { count: crushed });
  if (hit > 0) emit('nibblerPunch', { count: hit, shed, freed, crushed, punted });
  return hit;
}
