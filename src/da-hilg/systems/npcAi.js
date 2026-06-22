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
  NPC_NOTICE_RADIUS,
  NPC_GIVEUP_RADIUS,
  NPC_LEASH_RADIUS,
  NPC_LEASH_RETURN,
  NPC_LEASH_REACH,
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
import { requestEmote } from './animationSystem.js';
import { isNibblersMode } from '../nibblers/mode.js';

// Reused scratch so the hot loop never allocates.
const _intent = { move: { x: 0, z: 0 }, run: false, jump: false, action: null };
const _away = new THREE.Vector3();
const WANDER_REACH = 1.2; // within this of the POI counts as "arrived"
const COOLDOWN_DRIFT = 0.3; // tiny idle drift fraction during cooldown
const WANDER_TIMEOUT_MS = 7000; // abandon an unreachable stroll target after this

/**
 * Is the active player a valid target for this NPC right now?
 * Safe-zoned player is never targetable. A zone-bound NPC (ai.group set) only
 * notices the player when the player is inside its notice group; a free roamer
 * notices anyone within the notice radius.
 *
 * Detection is deliberately calm: an idle/wandering NPC only locks on inside the
 * tight NPC_NOTICE_RADIUS, but once it IS chasing it keeps the lock out to the
 * wider NPC_GIVEUP_RADIUS (hysteresis) so it doesn't flicker chase/idle at the
 * edge — yet the give-up bound is finite, so it stops trailing you forever.
 * Independently, an NPC never targets the player past NPC_LEASH_RADIUS from its
 * own home (territory bound) — the leash always wins over detection.
 * @param {any} actor
 * @param {any} ctx
 * @param {number} dist  planar distance NPC→active player (passed in to avoid recompute)
 * @param {boolean} [chasing]  true if the NPC is already in chase/touch (widens the radius)
 */
function targetable(actor, ctx, dist, chasing) {
  // In Nibblers mode the family never chases/tags you — the nibblers are the
  // threat; the family just strolls calmly in the background.
  if (isNibblersMode()) return false;
  if (playerIsSafe()) return false;
  // Territory leash: don't even consider the player if we've strayed (or the
  // player has lured us) too far from home — we want to head back, not pursue.
  const home = actor.ai && actor.ai.home;
  if (home && planarDist(actor.motion.pos, home) > NPC_LEASH_RADIUS) return false;
  // Hysteresis: a fresh lock needs the tight radius; holding a lock uses the wider one.
  const radius = chasing ? NPC_GIVEUP_RADIUS : NPC_NOTICE_RADIUS;
  const group = actor.ai && actor.ai.group;
  // A zone-bound NPC needs BOTH: the player inside its notice group AND within
  // the radius. (Without the distance gate, a map-sized notice zone makes every
  // NPC permanently target the player, so they never get to wander.)
  if (group) return playerNoticeGroups().has(group) && dist <= radius;
  return dist <= radius;
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
      // Perpendicular nudge to round the obstacle, alternating sides. Decay the
      // timer so the nudge is a brief burst, then we re-aim at the real goal —
      // otherwise a wedged NPC rotates 90° every frame forever and grinds in place.
      const sgn = ai._stuckSign || (ai._stuckSign = Math.random() < 0.5 ? 1 : -1);
      const nx = dz * sgn;
      const nz = -dx * sgn;
      dx = nx;
      dz = nz;
      ai.stuckT -= dt * 2; // burst, then re-seek
      if (ai.stuckT <= 0) {
        ai.stuckT = 0;
        ai._stuckSign = 0; // pick a fresh side next time we wedge
      }
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
  // Give up a stroll that takes too long (wedged on terrain) and re-decide.
  actor.ai.wanderUntil = (ctx && ctx.now ? ctx.now : 0) + WANDER_TIMEOUT_MS;
  actor.fsm = 'wander';
}

// ── Nibblers-mode "pester" behavior ──────────────────────────────────────────
const PESTER_NOTICE = 55;   // run up to the player from within this (m)
const DREW_NOTICE = 90;     // Drew is the eager one — notices from much farther
const DREW_DANCES = ['dance', 'cheer', 'wave']; // vary Drew's moves so he's not a loop

/** Pick this NPC's pester emote — Drew rotates several; others mostly dance. */
function pickPesterEmote(actor) {
  if (actor.character === 'drew') return DREW_DANCES[Math.floor(Math.random() * DREW_DANCES.length)];
  return Math.random() < 0.5 ? 'dance' : 'cheer';
}

/**
 * Nibblers-mode family behavior: the un-controlled family RUN UP to the player and
 * DANCE in their way (Drew most eagerly + with varied moves), following when the player
 * moves on. A playful obstacle, distinct from the nibbler swarm threat.
 * @returns {object} the shared _intent
 */
function nibblerPesterStep(actor, ctx, dt, dist, pos, ppos) {
  const ai = actor.ai;
  const now = ctx.now;
  const isDrew = actor.character === 'drew';
  const notice = isDrew ? DREW_NOTICE : PESTER_NOTICE;
  const danceDist = isDrew ? 3.6 : 2.8;

  if (dist > notice) {
    // Too far to bother — amble toward the player's area so they drift into range.
    ai._npcRun = false;
    seek(actor, ppos.x, ppos.z, 1, 0.55, dt);
    return _intent;
  }
  if (dist <= danceDist) {
    // In the player's face — plant + dance, re-picking a varied move each beat.
    if (!ai._pesterUntil || now >= ai._pesterUntil) {
      requestEmote(actor, pickPesterEmote(actor), { faceTarget: ppos });
      ai._pesterUntil = now + (isDrew ? 2200 : 2600) + Math.random() * 800;
    }
    return _intent; // move stays 0 — that's the "getting in the way"
  }
  // Noticed but not yet blocking — RUN up to the player.
  ai._npcRun = true;
  _intent.run = true;
  seek(actor, ppos.x, ppos.z, 1, 1, dt);
  return _intent;
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

  // Punch STAGGER override — checked FIRST (before any mode/FSM logic). A player
  // punch (systems/familyPunch.js) sets ai.staggerUntil + the punch source; while it
  // lasts the NPC ignores chase/greet/pester and keeps reeling AWAY from where it was
  // hit, so the knockback impulse reads as a shove + recoil rather than the AI
  // instantly steering back. The velocity impulse decays via stepMotion; here we just
  // bias the heading outward for the window, then fall through to normal behavior.
  if (ai.staggerUntil && now < ai.staggerUntil) {
    const sx = ai.staggerFromX ?? ppos.x;
    const sz = ai.staggerFromZ ?? ppos.z;
    // Seek a point well behind the NPC relative to the punch source so it backs off.
    let ax = pos.x - sx;
    let az = pos.z - sz;
    if (Math.hypot(ax, az) < 1e-3) {
      ax = Math.cos(now * 0.001);
      az = Math.sin(now * 0.001);
    }
    _away.set(ax, 0, az).normalize();
    ai._npcRun = false;
    seek(actor, pos.x + _away.x * 6, pos.z + _away.z * 6, 1, 0.7, dt);
    ai.faceTarget = null;
    return _intent;
  }

  // Nibblers mode: the un-controlled family don't run the greet FSM — they run up
  // and DANCE in your way (Drew most eagerly + with varied moves), a playful
  // obstacle that's separate from the nibbler swarm threat.
  if (isNibblersMode()) return nibblerPesterStep(actor, ctx, dt, dist, pos, ppos);

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

  // Leash override — checked next. If the NPC has strayed past the hard bound from
  // its home (chasing the player across the map, or a wander gone long), abandon
  // everything and walk back into its territory. returnHome resolves to idle once
  // it's home again. This confines each NPC to a radius around its spawn.
  const home = ai.home;
  if (home && actor.fsm !== 'returnHome' && planarDist(pos, home) > NPC_LEASH_RETURN) {
    actor.fsm = 'returnHome';
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
      // Stroll taking too long (wedged) — settle briefly, then pick a new target.
      if (now >= (ai.wanderUntil || 0)) {
        actor.fsm = 'idle';
        ai.dwellUntil = now + 600;
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
        // Rarely react at the landmark (wave at the mailbox, cheer at the creek).
        // Route through requestEmote — the canonical path that owns motion.action;
        // intent.action is never consumed for NPCs.
        // Rare landmark emote — but never in Nibblers mode (no dancing while you're
        // being swarmed) and only occasionally otherwise.
        if (ai._wanderEmote && !isNibblersMode() && Math.random() < 0.25) {
          requestEmote(actor, ai._wanderEmote, { faceTarget: ai._wanderLookAt || null });
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
      // Pass chasing=true so the lock holds out to the wider give-up radius
      // (hysteresis) and we don't drop the chase the instant the player edges out.
      if (playerSafe || !targetable(actor, ctx, dist, true)) {
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
      // away even if the player follows: pos + (pos - player) * 8. When we're
      // right on top of the player (the post-touch case) the away vector is ~0,
      // so pick a deterministic heading instead of standing still for 3 s.
      let ax = pos.x - ppos.x;
      let az = pos.z - ppos.z;
      if (Math.hypot(ax, az) < 1e-3) {
        ax = Math.cos(now * 0.001);
        az = Math.sin(now * 0.001);
      }
      _away.set(ax, 0, az).normalize();
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
      const cdHome = ai.home || pos;
      const dHome = planarDist(pos, cdHome);
      if (dHome > 1.5) {
        actor.ai._npcRun = false;
        seek(actor, cdHome.x, cdHome.z, 1, COOLDOWN_DRIFT, dt);
      }
      ai.faceTarget = null;
      break;
    }

    // ── returnHome: walked too far from territory — head back to spawn ─────────
    // Entered by the leash override above when the NPC strays past NPC_LEASH_RETURN.
    // It ignores the player entirely (no chase) until it's back inside its area,
    // then settles to idle so normal wander/scan resumes within bounds.
    case 'returnHome': {
      const rhHome = ai.home || pos;
      if (planarDist(pos, rhHome) <= NPC_LEASH_REACH) {
        actor.fsm = 'idle';
        ai.dwellUntil = now; // re-decide (wander within territory) next tick
        break;
      }
      // Walk (don't sprint) back so the return reads as ambling home, not fleeing.
      actor.ai._npcRun = false;
      seek(actor, rhHome.x, rhHome.z, 1, 1, dt);
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
