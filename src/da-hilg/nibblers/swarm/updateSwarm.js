// The swarm sim core: one pass over every live nibbler running the per-state FSM,
// then a publish to the real-NPC pool. This is a plain function called from
// updateNibblers(ctx) inside the single GameSystems useFrame — NO useFrame of its own.
//
// Order each frame:
//   1. read the active player's feet pos (post-stepMotion this frame)
//   2. build the spatial grid from live slots
//   3. per nibbler: dispatch on state → seek/drift/separate/integrate/transition
//   4. advance emote phase + pick the clip band
//   5. recompute swarm.activeCount
// (the pooled NPCs are published by nibblersSystems AFTER updateAttachment, so attached
//  nibblers render with this frame's anchor — not from this function.)

import {
  MAX_NIBBLERS,
  NOTICE_RADIUS,
  NIBBLER_RUN_SPEED,
  NIBBLER_WANDER_SPEED,
  EMOTE_RATE,
  SCATTER_TIME,
  S_DESPAWN,
  S_SPAWN,
  S_WANDER,
  S_NOTICE,
  S_RUN,
  S_JUMP,
  S_ATTACHED,
  S_FALL,
  S_SCATTER,
  S_CIRCLE,
  CLIP_IDLE,
  CLIP_RUN,
  CLIP_ATTACK,
  CLIP_DANCE,
  CIRCLE_RADIUS,
  CIRCLE_T_MIN,
  CIRCLE_T_MAX,
  CIRCLE_BOB_RATE,
  CIRCLE_BOB_HEIGHT,
  JUMP_COOLDOWN,
} from '../constants.js';
import {
  px,
  py,
  pz,
  vx,
  vz,
  heading,
  scale,
  phase,
  stateT,
  jumpCD,
  circleDur,
  seed,
  state,
  clip,
  swarm,
} from './swarmState.js';
import { free } from './swarmState.js';
import { buildGrid } from './grid.js';
import { seekTo, separate, integrate, tryJumpAndAttach, circleOrbit } from './nibblerFSM.js';

const NOTICE_R2 = NOTICE_RADIUS * NOTICE_RADIUS;
const CIRCLE_R2 = CIRCLE_RADIUS * CIRCLE_RADIUS;
const SPAWN_SETTLE_T = 0.3; // seconds of pop-in before WANDER
const NOTICE_DWELL_T = 0.25; // "spotted you" beat before RUN

// Player's last-grounded feet Y — the ground reference free nibblers track. We hold
// this while the player is AIRBORNE (jumping/falling/knocked) so grounded nibblers
// stay on the real ground level instead of teleporting up/down with the airborne
// player (the fall-follow bug). It updates to the live feet Y whenever the player is
// grounded. Initialized lazily on the first grounded frame.
let _groundRefY = null;

/**
 * Advance the whole swarm one step and upload to the GPU.
 * @param {object} ctx sim ctx — needs registry, activePlayerId, dt
 */
export function updateSwarm(ctx) {
  const player = ctx.registry.get(ctx.activePlayerId);
  if (!player) return;
  const P = player.motion.pos;
  const dt = ctx.dt;
  const now = ctx.now;

  // Ground reference for free (grounded) nibblers. While the player is GROUNDED this
  // tracks the live feet Y (ground-follow up/down the hill). While AIRBORNE we HOLD the
  // last grounded Y so grounded nibblers stay on the real ground instead of snapping
  // up/down with the jumping/falling player (the fall-follow bug). Attached nibblers
  // still ride the live player transform in updateAttachment regardless. Free nibblers
  // keep chasing the player's live X/Z via seekTo below, airborne or not.
  if (_groundRefY === null || player.motion.grounded) _groundRefY = P.y;
  const groundY = _groundRefY;

  // 1) Build the grid for separation + (later) stomp queries.
  buildGrid(MAX_NIBBLERS);

  let active = 0;

  // 2) Per-nibbler FSM.
  for (let i = 0; i < MAX_NIBBLERS; i++) {
    const st = state[i];
    if (st === S_DESPAWN || scale[i] <= 0) continue;

    stateT[i] += dt;
    if (jumpCD[i] > 0) jumpCD[i] -= dt;

    const dx = P.x - px[i];
    const dz = P.z - pz[i];
    const dist2 = dx * dx + dz * dz;

    switch (st) {
      case S_SPAWN: {
        // Pop-in settle: hold on the ground, no seek, then drop into WANDER.
        integrate(i, dt, groundY, false);
        if (stateT[i] >= SPAWN_SETTLE_T) {
          state[i] = S_WANDER;
          stateT[i] = 0;
        }
        break;
      }

      case S_WANDER: {
        // Low-speed curl/drift with a mild bias toward the player, plus separation.
        const wob = seed[i] * 6.283 + now * 0.0006;
        const driftX = Math.cos(wob);
        const driftZ = Math.sin(wob);
        // Bias target a little toward the player so the horde loosely gathers.
        const tx = px[i] + driftX * 4 + dx * 0.15;
        const tz = pz[i] + driftZ * 4 + dz * 0.15;
        seekTo(i, tx, tz, NIBBLER_WANDER_SPEED, dt);
        separate(i, dt);
        integrate(i, dt, groundY, false);
        if (swarm.marked && dist2 < NOTICE_R2) {
          state[i] = S_NOTICE;
          stateT[i] = 0;
        }
        break;
      }

      case S_NOTICE: {
        // Brief "spotted you" beat: face the player, hold position, then RUN. The
        // dwell staggers the swarm so they don't all snap to RUN on one frame.
        if (dist2 > 1e-4) heading[i] = Math.atan2(dx, dz);
        // Bleed off momentum — seekTo at speed 0 damps both vx AND vz toward zero.
        seekTo(i, px[i], pz[i], 0, dt);
        integrate(i, dt, groundY, false);
        active++;
        if (stateT[i] >= NOTICE_DWELL_T) {
          state[i] = S_RUN;
          stateT[i] = 0;
        }
        break;
      }

      case S_RUN: {
        seekTo(i, P.x, P.z, NIBBLER_RUN_SPEED, dt);
        separate(i, dt);
        integrate(i, dt, groundY, false);
        active++;
        // Playful stalking: once we close inside CIRCLE_RADIUS (but haven't just
        // circled — jumpCD gates re-entry), peel into a brief orbit/feint before
        // committing to the pounce, instead of bee-lining straight in.
        if (jumpCD[i] <= 0 && dist2 < CIRCLE_R2 && dist2 > 1e-4) {
          state[i] = S_CIRCLE;
          stateT[i] = 0;
          // Randomized circle duration per nibbler (stable-ish from seed + slot parity
          // so the swarm doesn't commit in lockstep).
          circleDur[i] = CIRCLE_T_MIN + seed[i] * (CIRCLE_T_MAX - CIRCLE_T_MIN);
          break;
        }
        // Jump trigger + attach test (may flip state to JUMP or ATTACHED).
        tryJumpAndAttach(i, ctx, P);
        // Lost interest if the player ran far away while unmarked.
        if (!swarm.marked && dist2 > NOTICE_R2 * 4) {
          state[i] = S_WANDER;
          stateT[i] = 0;
        }
        break;
      }

      case S_CIRCLE: {
        // Playful pre-lunge orbit: weave around the player on a ring with a little
        // bob, for a short randomized beat, THEN commit to the lunge. Orbit direction
        // is per-nibbler (seed parity) so they don't all sweep the same way. Still
        // separates so the ring doesn't bunch up.
        const dir = seed[i] < 0.5 ? 1 : -1;
        circleOrbit(i, P.x, P.z, dir, dt);
        separate(i, dt);
        integrate(i, dt, groundY, false);
        // Playful vertical bob on top of the ground snap (re-applied after integrate,
        // which sets py to groundY for grounded kinds).
        const bob = Math.sin(now * 0.001 * CIRCLE_BOB_RATE + seed[i] * 6.283);
        py[i] = groundY + Math.max(0, bob) * CIRCLE_BOB_HEIGHT;
        active++;
        // Commit to the pounce when the circle timer elapses, OR break off if the
        // player escaped well past the circle radius (chase again).
        if (stateT[i] >= circleDur[i] || dist2 > CIRCLE_R2 * 2.25) {
          state[i] = S_RUN;
          stateT[i] = 0;
          // Brief cooldown so RUN gets a window to lunge before re-circling.
          jumpCD[i] = JUMP_COOLDOWN * 0.5;
        }
        break;
      }

      case S_JUMP: {
        // Ballistic arc; keep a little horizontal seek so the lunge tracks. Attach
        // test fires mid-arc.
        seekTo(i, P.x, P.z, NIBBLER_RUN_SPEED, dt * 0.4);
        const landed = integrate(i, dt, groundY, true);
        active++;
        if (!tryJumpAndAttach(i, ctx, P)) {
          if (landed) {
            state[i] = S_RUN;
            stateT[i] = 0;
          }
        }
        break;
      }

      case S_ATTACHED: {
        // Positioned by updateAttachment; counted here so activeCount excludes it.
        // No integrate.
        break;
      }

      case S_FALL: {
        const landed = integrate(i, dt, groundY, true);
        if (landed) {
          state[i] = S_SCATTER;
          stateT[i] = 0;
        }
        break;
      }

      case S_SCATTER: {
        // Flee outward, decelerating; despawn when the window elapses.
        vx[i] *= Math.max(0, 1 - 3 * dt);
        integrate(i, dt, groundY, false);
        if (stateT[i] >= SCATTER_TIME) {
          free(i);
          continue;
        }
        break;
      }

      default:
        break;
    }

    // 3) Advance emote phase (loops) and pick the clip band from state.
    phase[i] += EMOTE_RATE * dt;
    phase[i] -= Math.floor(phase[i]);

    // Pick from the LIVE (post-transition) state, not the frame-start `st`, so a
    // WANDER→RUN this frame shows the run clip immediately (no 1-frame stale pose).
    // Band order is [idle, run, attack, dance]:
    //   converging (notice/run/jump) → RUN, wander/spawn → IDLE,
    //   ATTACHED → ATTACK with a small varied DANCE minority by seed,
    //   fall/scatter → IDLE (there is no jump band anymore).
    const cur = state[i];
    if (cur === S_RUN || cur === S_NOTICE || cur === S_JUMP || cur === S_CIRCLE) clip[i] = CLIP_RUN;
    else if (cur === S_ATTACHED) clip[i] = seed[i] < 0.22 ? CLIP_DANCE : CLIP_ATTACK;
    else if (cur === S_WANDER || cur === S_SPAWN) clip[i] = CLIP_IDLE;
    else clip[i] = CLIP_IDLE;
  }

  swarm.activeCount = active;
  // NOTE: the real-NPC pool is published by nibblersSystems AFTER updateAttachment, so
  // attached nibblers (positioned by updateAttachment, which runs after updateSwarm) are
  // rendered with THIS frame's anchor, not last frame's.
}
