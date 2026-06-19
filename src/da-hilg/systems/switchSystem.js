// Switch system — Tab / HUD tap changes which family member you drive. The whole
// trick: reassign two strategy objects (prev→npc, next→player) and re-point the
// camera. Because every controller feeds the same stepMotion, the swapped-in body
// keeps its exact position/velocity and just starts taking input — no remount,
// no movement code moves, one reactive write for the HUD.

import { CHARACTERS, SWITCH_GRACE_MS } from '../constants.js';
import { activePlayerIdAtom } from '../state/atoms.js';
import { attachController } from '../controllers/assign.js';

/**
 * Hand control to `nextId`. No-op if it's already the active player or unknown.
 * @param {string} nextId
 * @param {any} ctx  per-frame context ({ store, registry, cameraRig, now, activePlayerId })
 */
export function switchTo(nextId, ctx) {
  const { registry, cameraRig, store, now } = ctx;
  const prevId = ctx.activePlayerId;
  if (!nextId || nextId === prevId) return;

  const next = registry.get(nextId);
  if (!next) return;
  const prev = registry.get(prevId);

  // Previous player becomes an NPC (starts in cooldown so it won't pounce on the
  // new player); next becomes the player.
  if (prev) attachController(prev, 'npc');
  attachController(next, 'player');

  // Spawn-in grace: the freshly-controlled actor can't be tagged for a moment.
  next.ai.cooldownUntil = now + SWITCH_GRACE_MS;

  // Drop any inherited NPC momentum so control feels crisp from frame one.
  next.motion.velX = 0;
  next.motion.velZ = 0;

  // Re-point the camera and adopt the new body's facing for visual continuity.
  cameraRig.targetId = nextId;
  cameraRig.yaw = next.motion.facing;

  // Single reactive write — the HUD and CameraRig mirror read from here.
  store.set(activePlayerIdAtom, nextId);
}

/**
 * Cycle control to the next character id after the active one (wraps around).
 * @param {any} ctx
 * @param {number} [dir=1]  +1 forward, -1 backward
 */
export function cycleSwitch(ctx, dir = 1) {
  const cur = ctx.activePlayerId;
  const i = CHARACTERS.indexOf(cur);
  const n = CHARACTERS.length;
  // Modulo that stays positive for negative dir.
  const nextIdx = ((i + dir) % n + n) % n;
  switchTo(CHARACTERS[nextIdx], ctx);
}
