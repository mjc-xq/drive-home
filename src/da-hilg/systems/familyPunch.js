// playerPunchFamily(ctx) — the player's punch as it lands on the full-size FAMILY
// NPCs (not the player, not the nibbler swarm). A punch now shoves any family member
// caught in the player's forward cone:
//   • a brief outward KNOCKBACK impulse added straight onto the NPC's motion velocity
//     (decays naturally as stepMotion re-accelerates it), and
//   • a short STAGGER window (ai.staggerUntil) the NPC's AI honors — during it the NPC
//     stops chasing/greeting and keeps reeling away from the punch source, then resumes
//     wandering. A one-shot 'hit' flinch clip fires for the recoil read.
//
// Reach + cone mirror the nibbler punch (range/half-angle) so the swing feels the same
// against people and the swarm. Called imperatively from the input edge path
// (input/useEdgeKeys.js doPunch) on left-click / F — NOT from a useFrame. It reads the
// active player's motion (feet pos + facing) and the registry. Playful + non-lethal:
// nobody takes damage; they pop back, stumble, and carry on.

import {
  NPC_PUNCH_RANGE,
  NPC_PUNCH_HALF_ANGLE,
  NPC_PUNCH_KNOCKBACK,
  NPC_PUNCH_STAGGER_MS,
} from '../constants.js';
import { requestEmote } from './animationSystem.js';
import { emit } from '../hud/hudEvents.js';

/**
 * Resolve a player punch against the family NPCs this instant: shove every OTHER actor
 * in the forward cone outward (knockback impulse + stagger) and flinch them. Skips the
 * active player and any actor without physics yet. Returns the number of NPCs hit.
 * @param {object} ctx lite ctx — needs { registry, activePlayerId }
 * @returns {number}
 */
export function playerPunchFamily(ctx) {
  const player = ctx.registry.get(ctx.activePlayerId);
  if (!player) return 0;

  const now = performance.now();
  const m = player.motion;
  const fx = m.pos.x;
  const fz = m.pos.z;
  // World-forward from facing — same convention as the nibbler punch / stepMotion:
  // a facing angle F maps to the world direction (-sin F, -cos F).
  const fwdX = -Math.sin(m.facing);
  const fwdZ = -Math.cos(m.facing);

  const cosHalf = Math.cos(NPC_PUNCH_HALF_ANGLE);
  const r2 = NPC_PUNCH_RANGE * NPC_PUNCH_RANGE;
  let hit = 0;

  ctx.registry.forEach((actor) => {
    if (actor.id === ctx.activePlayerId) return; // never punch yourself
    if (actor.role === 'player') return;         // only NPCs
    const am = actor.motion;
    const dx = am.pos.x - fx;
    const dz = am.pos.z - fz;
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) return;
    const d = Math.sqrt(d2) + 1e-5;
    // Forward-cone test: the swing only connects with whoever is in front of the player.
    if ((dx * fwdX + dz * fwdZ) / d < cosHalf) return;

    // Outward direction from the player toward the NPC (so the shove is "away from the
    // punch"). Fall back to the player's forward if they're standing dead-on.
    let ox = dx / d;
    let oz = dz / d;
    if (d2 < 1e-4) {
      ox = fwdX;
      oz = fwdZ;
    }

    // 1) Knockback IMPULSE: add straight onto the NPC's horizontal velocity. stepMotion
    //    re-accelerates velX/velZ toward the AI's target each frame, so this lurch decays
    //    on its own over a few hundred ms — a brief visible shove, no new physics.
    am.velX += ox * NPC_PUNCH_KNOCKBACK;
    am.velZ += oz * NPC_PUNCH_KNOCKBACK;

    // 2) STAGGER: mark a recoil window the AI honors (no chase/greet; keep reeling away
    //    from the punch source). npcAi reads ai.staggerUntil + ai.staggerFrom.
    const ai = actor.ai;
    ai.staggerUntil = now + NPC_PUNCH_STAGGER_MS;
    ai.staggerFromX = fx;
    ai.staggerFromZ = fz;

    // 3) Recoil flinch: the one-shot 'hit' clip clears itself on finish (CLIP_LOOP.hit
    //    === 'once'), so it doesn't strand the NPC out of locomotion.
    requestEmote(actor, 'hit');

    hit++;
  });

  if (hit > 0) emit('greetHit'); // reuse the crosshair punch pulse for hit feedback
  return hit;
}

export default playerPunchFamily;
