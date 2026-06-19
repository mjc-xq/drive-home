// The spawner servos the swarm toward a target "active" count derived from how long
// the player has been marked (the attraction timeline). While marked and not in a
// safe-zone panic window, it spawns the deficit on a ring around the player, biased
// away from the camera's forward so nibblers appear from the edges/behind. Over
// target it culls idle wanderers that have drifted too far. One down-raycast per
// spawn seats the spawn Y on the real hill (the only per-spawn world query).

import {
  MAX_NIBBLERS,
  ATTRACTION,
  ATTRACTION_GROWTH,
  ACTIVE_RESERVE,
  SPAWN_RING_MIN,
  SPAWN_RING_MAX,
  SPAWN_RATE_MAX,
  SPAWN_BEHIND_BIAS,
  DESPAWN_RADIUS,
  NIBBLER_SCALE_MIN,
  NIBBLER_SCALE_MAX,
  S_SPAWN,
  S_WANDER,
} from '../constants.js';
import { CAPSULE_CENTER_Y } from '../../constants.js';
import {
  px,
  py,
  pz,
  vx,
  vy,
  vz,
  heading,
  scale,
  phase,
  stateT,
  jumpCD,
  seed,
  state,
  charIx,
  swarm,
} from './swarmState.js';
import { alloc, free } from './swarmState.js';

const RAY_ORIGIN_OFFSET = 50; // cast from this far above the candidate XZ
const RAY_MAX_TOI = 120;

/**
 * The attraction timeline: marked seconds → target active count. Lerps smoothly
 * within each spec band, then grows past the last band, capped to leave ACTIVE_RESERVE
 * slots free for fall/scatter/attached.
 * @param {number} t seconds since first marked
 * @returns {number} target active count (not yet rounded)
 */
export function targetActiveFor(t) {
  let prevT = 0;
  for (let b = 0; b < ATTRACTION.length; b++) {
    const band = ATTRACTION[b];
    if (t < band.t) {
      const f = (t - prevT) / (band.t - prevT);
      return band.lo + (band.hi - band.lo) * f;
    }
    prevT = band.t;
  }
  // Past the final band — keep growing, capped.
  const last = ATTRACTION[ATTRACTION.length - 1];
  const grown = last.hi + (t - last.t) * ATTRACTION_GROWTH;
  const cap = MAX_NIBBLERS - ACTIVE_RESERVE;
  return grown < cap ? grown : cap;
}

/** Cheap deterministic hash of a 0..1 seed into another 0..1 value. */
function hash01(s) {
  const x = Math.sin(s * 91.13 + 47.29) * 24634.6345;
  return x - Math.floor(x);
}

/**
 * Seat a candidate XZ on the real terrain via one down-raycast (excludes character
 * capsules + zone sensors so it lands on the solid level). Falls back to the player's
 * feet Y if the ray misses (e.g. trimesh not ready).
 */
function groundYAt(ctx, x, z, fallbackY) {
  const { world, rapier } = ctx;
  const ray = new rapier.Ray({ x, y: fallbackY + RAY_ORIGIN_OFFSET, z }, { x: 0, y: -1, z: 0 });
  const hit = world.castRay(
    ray,
    RAY_MAX_TOI,
    true,
    rapier.QueryFilterFlags.EXCLUDE_SENSORS | rapier.QueryFilterFlags.EXCLUDE_KINEMATIC,
  );
  if (!hit) return fallbackY;
  return fallbackY + RAY_ORIGIN_OFFSET - hit.timeOfImpact;
}

/**
 * Spawn one nibbler on the ring around the player, biased away from camera-forward.
 * @returns {boolean} true if a slot was allocated
 */
function spawnOne(ctx, P, camYaw) {
  const i = alloc();
  if (i < 0) return false;

  // Camera forward on XZ from yaw (matches CameraRig: forward = (-sin, -cos)).
  const fx = -Math.sin(camYaw);
  const fz = -Math.cos(camYaw);

  // Pick an angle biased away from camera forward: reject up to 2 tries that face the
  // camera (dot with forward too positive), so most spawns pop in behind/at the edges.
  let ang = Math.random() * Math.PI * 2;
  for (let tries = 0; tries < 2; tries++) {
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    if (dx * fx + dz * fz < SPAWN_BEHIND_BIAS) break; // pointing away from forward enough
    ang = Math.random() * Math.PI * 2;
  }

  const r = SPAWN_RING_MIN + Math.random() * (SPAWN_RING_MAX - SPAWN_RING_MIN);
  const x = P.x + Math.cos(ang) * r;
  const z = P.z + Math.sin(ang) * r;
  const gy = groundYAt(ctx, x, z, P.y);

  px[i] = x;
  py[i] = gy;
  pz[i] = z;
  vx[i] = 0;
  vy[i] = 0;
  vz[i] = 0;
  heading[i] = ang + Math.PI; // roughly face the player
  scale[i] = NIBBLER_SCALE_MIN + Math.random() * (NIBBLER_SCALE_MAX - NIBBLER_SCALE_MIN);
  const sd = Math.random();
  seed[i] = sd;
  phase[i] = hash01(sd);
  stateT[i] = 0;
  jumpCD[i] = 0;
  charIx[i] = (Math.random() * 4) | 0; // 0..3
  state[i] = S_SPAWN;
  return true;
}

/**
 * Cull up to `n` WANDER nibblers that have drifted beyond DESPAWN_RADIUS from the
 * player (never touches chasing/attached/falling ones — those stay under the player).
 */
function cullFarWanderers(P, n) {
  let culled = 0;
  const r2 = DESPAWN_RADIUS * DESPAWN_RADIUS;
  for (let i = 0; i < scale.length && culled < n; i++) {
    if (state[i] !== S_WANDER) continue;
    const dx = px[i] - P.x;
    const dz = pz[i] - P.z;
    if (dx * dx + dz * dz > r2) {
      free(i);
      culled++;
    }
  }
}

/**
 * Per-frame spawn policy. Advances the marked clock, computes targetActive, and
 * spawns the deficit (rate-limited) toward it while marked and not panicking; culls
 * the excess otherwise. activeCount is recomputed by updateSwarm — read here as the
 * servo input from the previous frame.
 * @param {object} ctx sim ctx
 */
export function spawnPolicy(ctx) {
  const player = ctx.registry.get(ctx.activePlayerId);
  if (!player) return;
  const P = player.motion.pos;
  const dt = ctx.dt;

  // Tick the marked clock + refresh the target.
  if (swarm.marked) swarm.markedT += dt;

  // Clear the panic window once it expires.
  if (swarm.panic && ctx.now >= swarm.panicUntil) swarm.panic = false;

  if (!swarm.marked || swarm.panic) {
    swarm.targetActive = 0;
    return;
  }

  const target = Math.round(targetActiveFor(swarm.markedT));
  swarm.targetActive = target;

  const deficit = target - swarm.activeCount;
  if (deficit > 0) {
    // Rate-limited spawn accumulator (fractional carry between frames).
    swarm.spawnAccum += Math.min(deficit, SPAWN_RATE_MAX * dt);
    let n = Math.floor(swarm.spawnAccum);
    swarm.spawnAccum -= n;
    const camYaw = ctx.cameraRig ? ctx.cameraRig.yaw : 0;
    while (n > 0) {
      if (!spawnOne(ctx, P, camYaw)) break; // pool full
      n--;
    }
  } else if (deficit < 0) {
    // Over target — let attrition handle it; only cull far idle wanderers.
    cullFarWanderers(P, -deficit);
  }
}

// CAPSULE_CENTER_Y is imported for parity with the framework spawn-snap (spawn Y is
// the feet surface; nibblers are positioned at feet, no capsule offset needed) — kept
// referenced so the intent is documented without an unused-import lint.
void CAPSULE_CENTER_Y;
