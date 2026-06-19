// Spawn-snap. The property is a HILL ("Da Hilg"): level.meta.json's groundY is the
// GLOBAL terrain minimum (the creek bed), so the recentered spawn points sit at
// y≈0 while the house terrain is ~10 m higher. Dropping a capsule onto y≈0 near the
// house buries it inside the ground (KCC snap-to-ground only reaches 0.3 m).
//
// So before an actor takes its first sim step, we raycast straight DOWN from high
// above its spawn XZ onto the fixed level collider and place its feet on the real
// surface. Each actor is snapped once; the sim skips an actor until it's snapped.

import { CAPSULE_CENTER_Y } from '../constants.js';

const RAY_ORIGIN_Y = 90; // safely above all recentered geometry
const RAY_MAX_TOI = 220;

/**
 * Try to drop one actor onto the terrain under its spawn XZ. Returns true once the
 * actor is snapped (or already was). Returns false while the collider/body isn't
 * ready or the ray missed (e.g. the trimesh is still baking) — caller retries.
 * @param {import('../actors/actorRegistry.js').Actor} actor
 * @param {object} ctx per-frame ctx (needs world + rapier)
 * @returns {boolean}
 */
export function trySnapActor(actor, ctx) {
  const ref = actor.ref;
  if (ref._snapped) return true;
  if (!ref.rigid || !ref.collider) return false;

  const { world, rapier } = ctx;
  const p = actor.motion.pos;
  const ray = new rapier.Ray({ x: p.x, y: RAY_ORIGIN_Y, z: p.z }, { x: 0, y: -1, z: 0 });
  // Ignore every character capsule (EXCLUDE_KINEMATIC) and the invisible zone
  // sensors (EXCLUDE_SENSORS) so the ray only lands on the solid level terrain.
  const hit = world.castRay(
    ray,
    RAY_MAX_TOI,
    true,
    rapier.QueryFilterFlags.EXCLUDE_KINEMATIC | rapier.QueryFilterFlags.EXCLUDE_SENSORS,
  );
  if (!hit) return false;

  const feetY = RAY_ORIGIN_Y - hit.timeOfImpact + 0.02; // recentered ground + a sliver
  ref.rigid.setTranslation({ x: p.x, y: feetY + CAPSULE_CENTER_Y, z: p.z }, true);
  p.set(p.x, feetY, p.z);
  actor.ai.home.copy(p); // re-anchor NPC wander to the true spawn height
  ref._snapped = true;
  return true;
}
