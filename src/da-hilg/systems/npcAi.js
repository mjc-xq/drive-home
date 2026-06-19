// NPC AI — the family's brain when you aren't driving them. One pure step per
// frame returns an Intent (world-XZ move + run/jump/action) that the shared
// stepMotion applies; this module never touches Rapier. The FSM is exactly the
// spec's: idle → wander → chase → touch → retreat → cooldown, with a SafeZone
// override checked FIRST so the house is always a refuge.
//
// Movement is navmesh-free: we hand stepMotion a unit direction toward (chase/
// wander) or away from (retreat) a target and let the KCC wall-slide. A cheap
// stuck-escape adds a perpendicular nudge when realized motion stalls, enough to
// round corners in the open neighborhood without a path graph.

import * as THREE from 'three';
import { EMPTY_INTENT } from '../controllers/Controller.js';
import {
  NOTICE_RADIUS,
  TOUCH_DIST,
  RETREAT_MS,
  COOLDOWN_MS,
  WALK_SPEED,
  RUN_SPEED,
  NPC_SCAN_INTERVAL,
  WANDER_DWELL_MIN,
  WANDER_DWELL_MAX,
  STUCK_TIME,
} from '../constants.js';
import { playerIsSafe, playerNoticeGroups } from '../zones/zoneRegistry.js';
import { pickWander } from './pointsOfInterest.js';
import { onNpcTouch } from './greetSystem.js';

// Reused scratch so the hot loop never allocates.
const _intent = { move: { x: 0, z: 0 }, run: false, jump: false, action: null };
const _away = new THREE.Vector3();
const WANDER_REACH = 1.2; // within this of the POI counts as "arrived"
const COOLDOWN_DRIFT = 0.3; // tiny idle drift fraction during cooldown

/**
 * Is the active player a valid target for this NPC right now?
 * Safe-zoned player is never targetable. A zone-bound NPC (ai.group set) only
 * notices the player when the player is inside its notice group; a free roamer
 * notices anyone within NOTICE_RADIUS.
 * @param {any} actor
 * @param {any} ctx
 * @param {number} dist  planar distance NPC→active player (passed in to avoid recompute)
 */
function targetable(actor, ctx, dist) {
  if (playerIsSafe()) return false;
  const group = actor.ai && actor.ai.group;
  if (group) return playerNoticeGroups().has(group);
  return dist <= NOTICE_RADIUS;
}

/** Planar distance between two Vector3 (ignores Y). */
function planarDist(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

/**
 * Build the move intent that seeks toward (sign +1) or away from (sign -1) a
 * world point, as a unit XZ direction scaled by `frac`. Applies the stuck-escape
 * nudge when realized speed has stalled below desired for STUCK_TIME.
 * @returns {void} mutates _intent.move
 */
function seek(actor, toX, toZ, sign, frac, dt) {
  const pos = actor.motion.pos;
  let dx = (toX - pos.x) * sign;
  let dz = (toZ - pos.z) * sign;
  const len = Math.hypot(dx, dz);
  if (len > 1e-4) {
    dx /= len;
    dz /= len;
  } else {
    dx = 0;
    dz = 0;
  }

  // Stuck-escape: if the actor wants to move but realized speed is a fraction of
  // desired for a while, it's wedged on a corner — rotate the heading 90° for a
  // few frames to slide around it.
  const ai = actor.ai;
  const wantsToMove = len > 1e-4 && frac > 0;
  if (wantsToMove) {
    const desiredSpeed = (actor.ai._npcRun ? RUN_SPEED : WALK_SPEED) * frac;
    if (actor.motion.speed < 0.3 * desiredSpeed) {
      ai.stuckT = (ai.stuckT || 0) + dt;
    } else {
      ai.stuckT = 0;
    }
    if (ai.stuckT > STUCK_TIME) {
      // Perpendicular nudge (rotate +90° about Y): (x,z) -> (z,-x).
      const nx = dz;
      const nz = -dx;
      dx = nx;
      dz = nz;
    }
  } else {
    ai.stuckT = 0;
  }

  _intent.move.x = dx * frac;
  _intent.move.z = dz * frac;
}

/** Resolve a fresh wander destination into ai scratch. */
function enterWander(actor, ctx) {
  const w = pickWander(actor, ctx);
  actor.ai.wanderTo = w.pos;
  // Stash the look/emote hints for arrival; faceTarget is applied on reach.
  actor.ai._wanderLookAt = w.lookAt || null;
  actor.ai._wanderEmote = w.emote || null;
  actor.fsm = 'wander';
}

/**
 * One frame of NPC behavior. Returns the Intent stepMotion will apply.
 * @param {any} actor
 * @param {any} ctx
 * @param {number} dt
 * @returns {{move:{x:number,z:number},run:boolean,jump:boolean,action:?string}}
 */
export function npcStep(actor, ctx, dt) {
  const { registry, activePlayerId, now } = ctx;
  const player = registry.get(activePlayerId);

  // No player yet (pre-load) — stand still.
  if (!player || actor.id === activePlayerId) return EMPTY_INTENT;

  // Reset scratch each call.
  _intent.move.x = 0;
  _intent.move.z = 0;
  _intent.run = false;
  _intent.jump = false;
  _intent.action = null;

  const pos = actor.motion.pos;
  const ppos = player.motion.pos;
  const dist = planarDist(pos, ppos);
  const ai = actor.ai;

  // SafeZone override — checked FIRST. If the player ducked into the house, any
  // aggressive state collapses straight to retreat (and cooldown→idle), so the
  // family never crowds a safe player.
  const playerSafe = playerIsSafe();
  if (playerSafe && (actor.fsm === 'chase' || actor.fsm === 'touch')) {
    // Aggressive states bail straight to retreat. (cooldown already resolves to
    // idle below since a safe player is never targetable — no special-case here.)
    actor.fsm = 'retreat';
    ai.retreatUntil = now + RETREAT_MS;
  }

  switch (actor.fsm) {
    // ── idle: stand, scan periodically, then either give chase or wander ──────
    case 'idle': {
      if (now >= (ai.scanAt || 0)) {
        ai.scanAt = now + NPC_SCAN_INTERVAL * 1000;
        if (!playerSafe && targetable(actor, ctx, dist)) {
          actor.fsm = 'chase';
          break;
        }
      }
      // Hold the dwell, then go for a stroll.
      if (now >= (ai.dwellUntil || 0)) {
        enterWander(actor, ctx);
      }
      // Face the look hint while loitering, if any.
      if (ai._wanderLookAt) ai.faceTarget = ai._wanderLookAt;
      break;
    }

    // ── wander: walk to the chosen POI; arrival → idle dwell + maybe emote ────
    case 'wander': {
      // Chase always preempts a stroll.
      if (!playerSafe && targetable(actor, ctx, dist)) {
        actor.fsm = 'chase';
        break;
      }
      const dest = ai.wanderTo;
      if (!dest) {
        enterWander(actor, ctx);
        break;
      }
      const dToDest = planarDist(pos, dest);
      if (dToDest <= WANDER_REACH) {
        // Arrived: settle, look at the thing, rarely react.
        actor.fsm = 'idle';
        ai.dwellUntil =
          now + (WANDER_DWELL_MIN + Math.random() * (WANDER_DWELL_MAX - WANDER_DWELL_MIN)) * 1000;
        ai.faceTarget = ai._wanderLookAt || null;
        if (ai._wanderEmote && Math.random() < 0.25) {
          // Lazy import avoided: animationSystem.requestEmote is the canonical
          // path, but greetSystem already owns the emote helper import graph.
          // We set action on the intent so the animation system picks it up.
          _intent.action = ai._wanderEmote;
        }
        break;
      }
      actor.ai._npcRun = false;
      seek(actor, dest.x, dest.z, 1, 1, dt); // unit dir at walk speed
      // While travelling, face travel direction (stepMotion handles NPC facing);
      // clear any stale faceTarget so we don't lock toward an old landmark.
      ai.faceTarget = null;
      break;
    }

    // ── chase: run at the active player until close enough to touch ───────────
    case 'chase': {
      if (playerSafe || !targetable(actor, ctx, dist)) {
        actor.fsm = 'retreat';
        ai.retreatUntil = now + RETREAT_MS;
        break;
      }
      if (dist <= TOUCH_DIST) {
        actor.fsm = 'touch';
        break;
      }
      actor.ai._npcRun = true;
      _intent.run = true;
      seek(actor, ppos.x, ppos.z, 1, 1, dt);
      ai.faceTarget = null;
      break;
    }

    // ── touch: friendly tag — fire the greet hook, then peel away ─────────────
    case 'touch': {
      onNpcTouch(actor, ctx);
      actor.fsm = 'retreat';
      ai.retreatUntil = now + RETREAT_MS;
      // Stand still this single frame; movement resumes next tick in retreat.
      break;
    }

    // ── retreat: back away from the player for RETREAT_MS, then cool down ──────
    case 'retreat': {
      if (now >= (ai.retreatUntil || 0)) {
        actor.fsm = 'cooldown';
        ai.cooldownUntil = now + COOLDOWN_MS;
        break;
      }
      // Aim for a point well behind us relative to the player so we keep backing
      // away even if the player follows: pos + (pos - player) * 8.
      _away.set(pos.x - ppos.x, 0, pos.z - ppos.z);
      const fleeX = pos.x + _away.x * 8;
      const fleeZ = pos.z + _away.z * 8;
      actor.ai._npcRun = true;
      _intent.run = true;
      seek(actor, fleeX, fleeZ, 1, 1, dt);
      ai.faceTarget = null;
      break;
    }

    // ── cooldown: drift idly until the timer lapses, then re-decide ───────────
    case 'cooldown': {
      if (now >= (ai.cooldownUntil || 0)) {
        if (!playerSafe && targetable(actor, ctx, dist)) {
          actor.fsm = 'chase';
        } else {
          actor.fsm = 'idle';
          ai.dwellUntil = now; // allow an immediate stroll decision next tick
        }
        break;
      }
      // Tiny idle wander toward the wander anchor (home) so they don't freeze.
      const home = ai.home || pos;
      const dHome = planarDist(pos, home);
      if (dHome > 1.5) {
        actor.ai._npcRun = false;
        seek(actor, home.x, home.z, 1, COOLDOWN_DRIFT, dt);
      }
      ai.faceTarget = null;
      break;
    }

    // ── controlled / unknown: shouldn't reach here for an NPC; idle out ───────
    default: {
      actor.fsm = 'idle';
      ai.dwellUntil = now;
      break;
    }
  }

  return _intent;
}
