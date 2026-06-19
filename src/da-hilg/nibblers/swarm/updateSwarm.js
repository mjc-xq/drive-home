// The swarm sim core: one pass over every live nibbler running the per-state FSM,
// then the GPU upload to the InstancedMesh. This is a plain function called from
// updateNibblers(ctx) inside the single GameSystems useFrame — NO useFrame of its own.
//
// Order each frame:
//   1. read the active player's feet pos (post-stepMotion this frame)
//   2. build the spatial grid from live slots
//   3. per nibbler: dispatch on state → seek/drift/separate/integrate/transition
//   4. advance emote phase + pick the clip band
//   5. recompute swarm.activeCount
//   6. upload instanceMatrix + aPhase/aClip/aTint to swarmGpu (if mounted)

import {
  MAX_NIBBLERS,
  NOTICE_RADIUS,
  NIBBLER_RUN_SPEED,
  NIBBLER_WANDER_SPEED,
  EMOTE_RATE,
  SCATTER_TIME,
  NIBBLER_TINTS,
  S_DESPAWN,
  S_SPAWN,
  S_WANDER,
  S_NOTICE,
  S_RUN,
  S_JUMP,
  S_ATTACHED,
  S_FALL,
  S_SCATTER,
  CLIP_IDLE,
  CLIP_RUN,
  CLIP_JUMP,
  CLIP_EMOTE,
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
  seed,
  state,
  charIx,
  clip,
  swarm,
} from './swarmState.js';
import { free } from './swarmState.js';
import { buildGrid } from './grid.js';
import { seekTo, separate, integrate, tryJumpAndAttach } from './nibblerFSM.js';
import { swarmGpu } from '../render/swarmGpu.js';

const NOTICE_R2 = NOTICE_RADIUS * NOTICE_RADIUS;
const SPAWN_SETTLE_T = 0.3; // seconds of pop-in before WANDER
const NOTICE_DWELL_T = 0.25; // "spotted you" beat before RUN

/**
 * Advance the whole swarm one step and upload to the GPU.
 * @param {object} ctx sim ctx — needs registry, activePlayerId, dt
 */
export function updateSwarm(ctx) {
  const player = ctx.registry.get(ctx.activePlayerId);
  if (!player) return;
  const P = player.motion.pos;
  const groundY = P.y; // flat local ground reference (see design §5 / ground-follow)
  const dt = ctx.dt;
  const now = ctx.now;

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
        // Bleed off momentum.
        vx[i] *= Math.max(0, 1 - 8 * dt);
        // (vz handled in fallthrough integrate)
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
        // Jump trigger + attach test (may flip state to JUMP or ATTACHED).
        tryJumpAndAttach(i, ctx, P);
        // Lost interest if the player ran far away while unmarked.
        if (!swarm.marked && dist2 > NOTICE_R2 * 4) {
          state[i] = S_WANDER;
          stateT[i] = 0;
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

    if (st === S_RUN || st === S_NOTICE) clip[i] = CLIP_RUN;
    else if (st === S_JUMP || st === S_FALL) clip[i] = CLIP_JUMP;
    else if (st === S_WANDER || st === S_SPAWN) clip[i] = CLIP_EMOTE;
    else clip[i] = CLIP_IDLE;
  }

  swarm.activeCount = active;

  // 4) Upload to the GPU (skip entirely if the renderer hasn't mounted).
  uploadToGpu();
}

/**
 * Write every slot's instance matrix (translate + yaw + uniform scale, 16 floats
 * direct) and the per-instance aPhase/aClip/aTint attributes from the SoA. Dead slots
 * carry scale 0 (degenerate → GPU discards them). Flags needsUpdate on each buffer.
 */
function uploadToGpu() {
  const mesh = swarmGpu.mesh;
  if (!mesh) return;
  const m = mesh.instanceMatrix.array;
  const aPhase = swarmGpu.aPhase;
  const aClip = swarmGpu.aClip;
  const aTint = swarmGpu.aTint;

  for (let i = 0; i < MAX_NIBBLERS; i++) {
    const o = i * 16;
    const s = scale[i];
    if (s <= 0) {
      // Degenerate: zero the linear block (collapses to a point), keep translation 0.
      m[o + 0] = 0; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = 0; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = 0; m[o + 11] = 0;
      m[o + 12] = 0; m[o + 13] = 0; m[o + 14] = 0; m[o + 15] = 1;
    } else {
      const yaw = heading[i];
      const c = Math.cos(yaw) * s;
      const sn = Math.sin(yaw) * s;
      // Column-major; rotation about Y, uniform scale s.
      m[o + 0] = c;   m[o + 1] = 0; m[o + 2] = -sn; m[o + 3] = 0;
      m[o + 4] = 0;   m[o + 5] = s; m[o + 6] = 0;   m[o + 7] = 0;
      m[o + 8] = sn;  m[o + 9] = 0; m[o + 10] = c;  m[o + 11] = 0;
      m[o + 12] = px[i]; m[o + 13] = py[i]; m[o + 14] = pz[i]; m[o + 15] = 1;
    }

    if (aPhase) aPhase.array[i] = phase[i];
    if (aClip) aClip.array[i] = clip[i];
    if (aTint) {
      const t = NIBBLER_TINTS[charIx[i]] || NIBBLER_TINTS[0];
      const j = i * 3;
      aTint.array[j] = t[0];
      aTint.array[j + 1] = t[1];
      aTint.array[j + 2] = t[2];
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (aPhase) aPhase.needsUpdate = true;
  if (aClip) aClip.needsUpdate = true;
  if (aTint) aTint.needsUpdate = true;
  mesh.count = MAX_NIBBLERS;
}
