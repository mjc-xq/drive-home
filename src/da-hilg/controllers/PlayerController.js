// PlayerController — turns the merged input snapshot + camera yaw into an Intent
// for the actor the human is currently driving. It ONLY computes intent; the
// single KCC apply site (systems/stepMotion.js) consumes it. Emotes are routed
// through animationSystem.requestEmote on the edge keys (input/useEdgeKeys.js),
// so this controller leaves `action` null — locomotion is all it speaks.

import { EMPTY_INTENT } from './Controller.js';
import { JUMP_BUFFER } from '../constants.js';

// Scratch intent reused every frame for the active player so we never allocate
// in the hot loop. stepMotion reads it synchronously within the same frame.
const intent = { move: { x: 0, z: 0 }, run: false, jump: false, action: null };

/**
 * Camera-relative movement strategy for the active player.
 * @type {{ id:'player', produce(actor:any, ctx:any, dt:number):any }}
 */
export const PlayerController = {
  id: 'player',

  produce(actor, ctx) {
    // Only the active player consumes input; everyone else is silent here.
    if (actor.role !== 'player') return EMPTY_INTENT;

    const { input, cameraRig, now } = ctx;
    const yaw = cameraRig.yaw;

    // Camera basis on the XZ plane (yaw only — pitch never tilts the ground move).
    // forward at yaw matches cameraRig.forwardFromYaw: looking down -Z at yaw 0.
    const fx = -Math.sin(yaw); // forward.x
    const fz = -Math.cos(yaw); // forward.z
    // right = forward rotated -90° about +Y → (-cos, +sin)... derived so strafing
    // right at yaw 0 moves toward +X.
    const rx = Math.cos(yaw); // right.x
    const rz = -Math.sin(yaw); // right.z

    // moveY = forward intent (W +), moveX = strafe intent (D +).
    let mx = fx * input.moveY + rx * input.moveX;
    let mz = fz * input.moveY + rz * input.moveX;

    // Clamp magnitude to 1 so diagonal input isn't faster than cardinal.
    const mag = Math.hypot(mx, mz);
    if (mag > 1) {
      const inv = 1 / mag;
      mx *= inv;
      mz *= inv;
    }

    intent.move.x = mx;
    intent.move.z = mz;
    intent.run = !!input.run;

    // Jump is edge-triggered through a small buffer: a press stays valid for
    // JUMP_BUFFER seconds so a slightly-early tap still fires on landing.
    let jump = false;
    if (input.jumpQueued && input.jumpQueuedT >= 0) {
      const ageSec = (now - input.jumpQueuedT) / 1000;
      if (ageSec <= JUMP_BUFFER) jump = true;
      // Consume the queued jump so it fires at most once.
      if (jump) {
        input.jumpQueued = false;
        input.jumpQueuedT = -1;
      }
    }
    intent.jump = jump;

    // Emotes are applied via animationSystem.requestEmote on the edge keys, not
    // here — leave action null so we never fight the emote system.
    intent.action = null;

    return intent;
  },
};
