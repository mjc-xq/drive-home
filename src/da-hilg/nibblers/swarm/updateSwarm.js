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
//   6. upload instanceMatrix + aPhase/aClip into each character's mesh (if mounted)

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
  CLIP_IDLE,
  CLIP_RUN,
  CLIP_ATTACK,
  CLIP_DANCE,
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

    // Pick from the LIVE (post-transition) state, not the frame-start `st`, so a
    // WANDER→RUN this frame shows the run clip immediately (no 1-frame stale pose).
    // Band order is [idle, run, attack, dance]:
    //   converging (notice/run/jump) → RUN, wander/spawn → IDLE,
    //   ATTACHED → ATTACK with ~1/3 varied to DANCE by seed (the partying minority),
    //   fall/scatter → IDLE (there is no jump band anymore).
    const cur = state[i];
    if (cur === S_RUN || cur === S_NOTICE || cur === S_JUMP) clip[i] = CLIP_RUN;
    else if (cur === S_ATTACHED) clip[i] = seed[i] < 0.34 ? CLIP_DANCE : CLIP_ATTACK;
    else if (cur === S_WANDER || cur === S_SPAWN) clip[i] = CLIP_IDLE;
    else clip[i] = CLIP_IDLE;
  }

  swarm.activeCount = active;

  // 4) Upload to the GPU (skip entirely if the renderer hasn't mounted).
  uploadToGpu();
}

// Per-character running write index, reset at the top of each upload. Plain primitives
// in a module-scope scratch (no per-frame allocation). Index 0..3 = mike/kelli/cece/drew.
const charCount = [0, 0, 0, 0];

/**
 * Write each LIVE nibbler's instance matrix + aPhase/aClip into ITS CHARACTER'S mesh
 * (swarmGpu.byChar[charIx]) at that mesh's running write index, then set each mesh's
 * count to its counter and flip needsUpdate. Dead slots (scale<=0) contribute to no
 * bucket. The instance matrix (translate + yaw + uniform scale, 16 floats direct) is
 * computed EXACTLY as before — only the destination mesh + the write index differ, so
 * grounding (the Y/position/scale math) is identical to the single-mesh upload.
 */
function uploadToGpu() {
  const byChar = swarmGpu.byChar;
  if (!byChar) return;
  // Skip entirely until at least one character mesh has mounted.
  let anyMesh = false;
  for (let k = 0; k < 4; k++) if (byChar[k]) anyMesh = true;
  if (!anyMesh) return;

  charCount[0] = 0; charCount[1] = 0; charCount[2] = 0; charCount[3] = 0;

  for (let i = 0; i < MAX_NIBBLERS; i++) {
    const s = scale[i];
    if (s <= 0) continue; // dead slot → no bucket

    const ci = charIx[i];
    const bucket = byChar[ci];
    if (!bucket) continue; // this character's mesh hasn't mounted; skip its instances

    const idx = charCount[ci]++;
    const o = idx * 16;
    const m = bucket.mesh.instanceMatrix.array;

    // ── IDENTICAL matrix math to the single-mesh upload — DO NOT CHANGE ──────
    const yaw = heading[i];
    const c = Math.cos(yaw) * s;
    const sn = Math.sin(yaw) * s;
    // Column-major; rotation about Y, uniform scale s.
    m[o + 0] = c;   m[o + 1] = 0; m[o + 2] = -sn; m[o + 3] = 0;
    m[o + 4] = 0;   m[o + 5] = s; m[o + 6] = 0;   m[o + 7] = 0;
    m[o + 8] = sn;  m[o + 9] = 0; m[o + 10] = c;  m[o + 11] = 0;
    m[o + 12] = px[i]; m[o + 13] = py[i]; m[o + 14] = pz[i]; m[o + 15] = 1;
    // ────────────────────────────────────────────────────────────────────────

    bucket.aPhase.array[idx] = phase[i];
    bucket.aClip.array[idx] = clip[i];
  }

  // Each mesh draws exactly its live count; flag the buffers it actually wrote.
  for (let k = 0; k < 4; k++) {
    const bucket = byChar[k];
    if (!bucket) continue;
    bucket.mesh.count = charCount[k];
    bucket.mesh.instanceMatrix.needsUpdate = true;
    bucket.aPhase.needsUpdate = true;
    bucket.aClip.needsUpdate = true;
  }
}
