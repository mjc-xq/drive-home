// Pure, index-based steering + integration helpers over the swarm SoA. No allocation,
// no React, no atoms — just math on the typed arrays for one nibbler at a time. These
// are the verbs updateSwarm composes per state. All are frame-rate-independent.

import {
  NIBBLER_ACCEL,
  SEP_RADIUS,
  SEP_STRENGTH,
  NIBBLER_GRAVITY,
  JUMP_RADIUS,
  NIBBLER_JUMP_VEL,
  NIBBLER_LUNGE,
  JUMP_COOLDOWN,
  S_RUN,
  S_JUMP,
  ATTACH_PAD,
  ATTACH_HEIGHT_BAND,
} from '../constants.js';
import { CAPSULE_RADIUS, CAPSULE_CENTER_Y } from '../../constants.js';
import { px, py, pz, vx, vy, vz, heading, jumpCD, state } from './swarmState.js';
import { forNeighbors } from './grid.js';
import { attachNibbler } from './attachment.js';

const SEP_R2 = SEP_RADIUS * SEP_RADIUS;

/**
 * Accelerate nibbler `i` toward a desired horizontal velocity aimed at (tx,tz) at
 * `speed`, using a critically-damped approach (NIBBLER_ACCEL). Only sets vx/vz; the
 * caller integrates position in `integrate`.
 * @param {number} i
 * @param {number} tx target X
 * @param {number} tz target Z
 * @param {number} speed desired speed (m/s)
 * @param {number} dt
 */
export function seekTo(i, tx, tz, speed, dt) {
  const dx = tx - px[i];
  const dz = tz - pz[i];
  const d = Math.sqrt(dx * dx + dz * dz) + 1e-5;
  const desVX = (dx / d) * speed;
  const desVZ = (dz / d) * speed;
  const k = 1 - Math.exp(-NIBBLER_ACCEL * dt);
  vx[i] += (desVX - vx[i]) * k;
  vz[i] += (desVZ - vz[i]) * k;
}

/**
 * Push nibbler `i` away from its grid neighbors so the horde spreads instead of
 * fully overlapping. Soft falloff weighted by SEP_STRENGTH; applied directly to
 * vx/vz (added on top of whatever seek/drift set them this frame). The grid must be
 * built for this frame before calling.
 * @param {number} i
 * @param {number} dt
 */
// One persistent callback + module accumulators, reused for every separate() call,
// so the 512×/frame neighbor walk allocates ZERO closures (the previous inline
// arrow was a real GC hazard at 60 fps).
let _sepI = 0;
let _sepX = 0;
let _sepZ = 0;
function _sepNeighbor(j) {
  if (j === _sepI) return;
  const ddx = px[_sepI] - px[j];
  const ddz = pz[_sepI] - pz[j];
  const dd = ddx * ddx + ddz * ddz;
  if (dd < SEP_R2 && dd > 1e-6) {
    const w = 1 - dd / SEP_R2; // soft falloff 0..1
    const inv = w / Math.sqrt(dd);
    _sepX += ddx * inv;
    _sepZ += ddz * inv;
  }
}

export function separate(i, dt) {
  _sepI = i;
  _sepX = 0;
  _sepZ = 0;
  forNeighbors(i, _sepNeighbor);
  vx[i] += _sepX * SEP_STRENGTH * dt * NIBBLER_ACCEL;
  vz[i] += _sepZ * SEP_STRENGTH * dt * NIBBLER_ACCEL;
}

/**
 * Integrate one nibbler: apply gravity when airborne (or snap to the ground plane
 * when grounded), advance position from velocity, and face travel. `groundY` is the
 * flat local ground reference (the player's feet Y — see updateSwarm). `airborne`
 * tells whether this state arcs (JUMP/FALL) vs. tracks the ground.
 * @param {number} i
 * @param {number} dt
 * @param {number} groundY
 * @param {boolean} airborne true for JUMP/FALL (gravity + landing test), false = grounded snap
 * @returns {boolean} landed — true on the frame an airborne nibbler touches groundY
 */
export function integrate(i, dt, groundY, airborne) {
  let landed = false;
  if (airborne) {
    vy[i] += NIBBLER_GRAVITY * dt;
    px[i] += vx[i] * dt;
    py[i] += vy[i] * dt;
    pz[i] += vz[i] * dt;
    if (py[i] <= groundY && vy[i] <= 0) {
      py[i] = groundY;
      vy[i] = 0;
      landed = true;
    }
  } else {
    // Grounded kinds: snap to the ground plane, no vertical integration.
    vy[i] = 0;
    px[i] += vx[i] * dt;
    pz[i] += vz[i] * dt;
    py[i] = groundY;
  }
  // Face travel direction (matches stepMotion's atan2(velX, velZ) convention).
  const sp2 = vx[i] * vx[i] + vz[i] * vz[i];
  if (sp2 > 1e-4) heading[i] = Math.atan2(vx[i], vz[i]);
  return landed;
}

/**
 * For a RUNNING, grounded nibbler in range, kick off a lunge-jump arc toward the
 * player and test for attachment. Also runs the cheap capsule-vs-point attach test
 * every frame (RUN and JUMP) so contact attaches even without a fresh jump.
 *
 *   - jump trigger: grounded + within JUMP_RADIUS + cooldown elapsed → set vy + lunge.
 *   - attach test:  capsule (feet+CAPSULE_CENTER_Y, radius CAPSULE_RADIUS) vs the
 *                   nibbler point, within ATTACH_HEIGHT_BAND vertically and
 *                   CAPSULE_RADIUS+ATTACH_PAD horizontally → attachNibbler → true.
 *
 * @param {number} i
 * @param {object} ctx sim ctx (for attachNibbler)
 * @param {{x:number,y:number,z:number}} playerPos player feet pos
 * @returns {boolean} true if the nibbler attached this frame (caller stops stepping it)
 */
export function tryJumpAndAttach(i, ctx, playerPos) {
  const dx = playerPos.x - px[i];
  const dz = playerPos.z - pz[i];
  const dPlayer = Math.sqrt(dx * dx + dz * dz) + 1e-5;
  const ux = dx / dPlayer;
  const uz = dz / dPlayer;

  // Jump trigger (RUN only, grounded, off cooldown, in lunge range).
  const grounded = state[i] === S_RUN; // RUN nibblers track ground; JUMP already airborne
  if (grounded && jumpCD[i] <= 0 && dPlayer < JUMP_RADIUS) {
    state[i] = S_JUMP;
    jumpCD[i] = JUMP_COOLDOWN;
    vy[i] = NIBBLER_JUMP_VEL;
    vx[i] = ux * NIBBLER_LUNGE;
    vz[i] = uz * NIBBLER_LUNGE;
  }

  // Attach test — capsule-vs-point against the player (runs in RUN and JUMP).
  const dyFeet = py[i] - playerPos.y;
  const withinHeight = dyFeet > -0.2 && dyFeet < CAPSULE_CENTER_Y + ATTACH_HEIGHT_BAND;
  if (withinHeight && dPlayer < CAPSULE_RADIUS + ATTACH_PAD) {
    attachNibbler(i, ctx);
    return true;
  }
  return false;
}
