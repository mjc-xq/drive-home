// Attachment: once a nibbler passes the attach test it CLINGS to the player's body
// surface and attacks it — the player's body is its ground. We anchor each attached
// nibbler to a fixed point on the capsule surface (feet→head, distributed by
// attachSlot), recompute that anchor in world space from the player's CURRENT
// pos+facing every frame (so the cling rides the body as it moves), and face it
// INWARD toward the body center (attacking). When the player jumps we run a short
// swarm-wide eject window that flings every clinger OUTWARD+up for a beat, then
// decays back to its anchor so they fall back and re-cling — a visual eject, not a
// real detach (slots stay owned, attachedCount unchanged). There is no independent
// sim, no seek, and no per-frame allocation here.

import {
  S_ATTACHED,
  CLIP_ATTACK,
  CLIP_DANCE,
  EMOTE_RATE,
  CLING_ANGULAR_SLOTS,
  CLING_NIBBLER_HALF,
  CLING_LAYER_STEP,
  CLING_Y_BOTTOM,
  CLING_Y_TOP,
  EJECT_WINDOW,
  EJECT_OUT,
  EJECT_UP,
  EJECT_VELY_TRIGGER,
  PRONE_HEAP_FWD,
} from '../constants.js';
import { CAPSULE_RADIUS } from '../../constants.js';
import { nibblerPenalty } from '../mode.js';
import { emit } from '../../hud/hudEvents.js';
import {
  px,
  py,
  pz,
  heading,
  phase,
  stateT,
  scale,
  seed,
  state,
  clip,
  attachSlot,
  swarm,
} from './swarmState.js';

const TWO_PI = Math.PI * 2;

// Attached count last frame — emit a single HUD 'nibblerAttach' pulse when the
// pile grows (drives the SwarmCount pop), bounded to one emit per frame.
let _lastAttached = 0;

// ── Jump-eject window state (swarm-wide, plain module scratch) ───────────────
// _ejectT counts DOWN from EJECT_WINDOW; while >0 every clinger is shoved off the
// body and eased back. _wasGrounded tracks the player's grounded flag so we can
// edge-detect a fresh jump (grounded→airborne) this frame.
let _ejectT = 0;
let _wasGrounded = true;

/** Cheap deterministic hash of a 0..1 seed into another 0..1 value. */
function hash01(s) {
  const x = Math.sin(s * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The clip an ATTACHED nibbler rides: most ground-slam ATTACK on the player, a ~1/3
 * minority DANCE. Keyed by the nibbler's stable seed so the same nibbler always reads the
 * same mood (matches the band selection in updateSwarm so there's no per-frame flicker).
 */
function attachedClip(i) {
  // Most attached nibblers slam/attack the body; a small minority dance for visual
  // variety so the pile is not a perfectly synced chorus line.
  return seed[i] < 0.22 ? CLIP_DANCE : CLIP_ATTACK;
}

/**
 * Promote nibbler `i` to ATTACHED. Assigns a monotonic attach slot (drives the
 * body-surface anchor so two attaching on the same frame don't stack), and flips it to
 * the emote clip. Increments swarm.attachedCount.
 * @param {number} i
 * @param {object} _ctx (unused; kept for signature symmetry / future capsule reads)
 */
export function attachNibbler(i, _ctx) {
  if (state[i] === S_ATTACHED) return;
  state[i] = S_ATTACHED;
  stateT[i] = 0;
  attachSlot[i] = swarm.attachNext++;
  clip[i] = attachedClip(i);
  swarm.attachedCount++;
}

/**
 * Per-frame: CLING every ATTACHED nibbler to its anchor on the player's body surface,
 * rotated by the player's facing and ridden off the player's CURRENT feet pos, facing
 * the body center (attacking). On a player jump, start the eject window; while it runs,
 * push each clinger outward+up by an offset that peaks early then decays back to the
 * anchor by the window's end. Recounts swarm.attachedCount (kept in sync against the SoA
 * so stomp/scatter edits can't drift it). Emote phase advances faster while clinging.
 *
 * Only S_ATTACHED nibblers are positioned here — non-attached nibblers keep their
 * ground placement from the FSM/integrate pass and are never touched by this function.
 * @param {object} ctx sim ctx — needs registry + activePlayerId + dt
 */
export function updateAttachment(ctx) {
  const player = ctx.registry.get(ctx.activePlayerId);
  if (!player) return;
  const P = player.motion.pos;          // feet position (body local y=0)
  const facing = player.motion.facing;
  const cosF = Math.cos(facing);
  const sinF = Math.sin(facing);
  const dt = ctx.dt;

  // ── Jump edge-detect → arm the eject window ───────────────────────────────
  // A fresh jump is grounded→airborne this frame, or velY crossing up past a small
  // threshold (covers re-jumps before the grounded flag settles).
  const grounded = !!player.motion.grounded;
  const velY = player.motion.velY || 0;
  const jumped = (_wasGrounded && !grounded) || velY > EJECT_VELY_TRIGGER;
  if (jumped && _ejectT <= 0) _ejectT = EJECT_WINDOW;
  _wasGrounded = grounded;
  if (_ejectT > 0) _ejectT -= dt;

  // Eject envelope 0..1: peaks early (~30% through the window) then decays to 0 by
  // the end, so clingers fling off the body for a beat and fall back to re-cling.
  let ejectEnv = 0;
  if (_ejectT > 0) {
    const u = 1 - _ejectT / EJECT_WINDOW; // 0 at start → 1 at end
    // sin(pi*u) peaks at u=0.5; skew earlier by easing u so the fling is snappy.
    ejectEnv = Math.sin(Math.PI * Math.min(1, u * 1.25));
    if (ejectEnv < 0) ejectEnv = 0;
  }

  // Player down (overwhelm tier ≥ 2)? Collapse the upright orbit shell into a low
  // dogpile heaped ON the prone body, and suppress the jump-eject (you can't jump when
  // you're pinned). World-forward bias centers the heap over the torso, not the feet.
  const prone = nibblerPenalty.overwhelm >= 2;
  if (prone) ejectEnv = 0;
  const fwdX = -sinF; // world-forward (matches stepMotion's facing convention)
  const fwdZ = -cosF;

  const bandSpan = CLING_Y_TOP - CLING_Y_BOTTOM;

  let attached = 0;
  for (let i = 0; i < scale.length; i++) {
    if (state[i] !== S_ATTACHED) continue;
    attached++;

    // Stable body-surface anchor from the attach slot. Columns spread around the
    // body axis; every full lap of columns starts a new concentric layer further out
    // so a big pile covers the body instead of fighting over one ring.
    const s = attachSlot[i] >= 0 ? attachSlot[i] : i;
    const col = s % CLING_ANGULAR_SLOTS;
    const layer = Math.floor(s / CLING_ANGULAR_SLOTS);
    // Angle: even column spread + golden-ratio twist per layer + per-nibbler jitter so
    // stacked layers don't line up into visible spokes.
    const ang = (col / CLING_ANGULAR_SLOTS) * TWO_PI
      + layer * 2.39996
      + (seed[i] - 0.5) * 0.6;
    // Height band climbs feet→head; offset per layer + jitter so layers interleave.
    const yFrac = ((col + layer * 0.5 + hash01(seed[i]) ) % CLING_ANGULAR_SLOTS) / CLING_ANGULAR_SLOTS;
    const anchorY = CLING_Y_BOTTOM + yFrac * bandSpan;
    // Radius: capsule skin + nibbler half-size, pushed out one step per layer.
    const bodyR = CAPSULE_RADIUS + CLING_NIBBLER_HALF + layer * CLING_LAYER_STEP;

    // Local cling offset on the body surface (pre-facing), in body space.
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    let ox, oy, oz;
    if (prone) {
      // Down: flatten the column into a low mound — a wide ground disc stacked a few
      // bodies high so the pile reads as ON TOP of the fallen player, not orbiting one.
      const ringR = 0.22 + layer * 0.18 + (col / CLING_ANGULAR_SLOTS) * 0.12;
      ox = ca * ringR;
      oz = sa * ringR;
      oy = 0.1 + (s % 3) * 0.16 + hash01(seed[i]) * 0.1;
    } else {
      ox = ca * bodyR;
      oz = sa * bodyR;
      oy = anchorY;
    }

    // Jump-eject: shove this clinger radially OUTWARD (+ a little up) by the envelope,
    // phase-staggered by seed so they don't all peel at the exact same instant.
    if (ejectEnv > 0) {
      const e = ejectEnv * (0.7 + 0.6 * seed[i]);
      ox += ca * EJECT_OUT * e;
      oz += sa * EJECT_OUT * e;
      oy += EJECT_UP * e;
    }

    // Rotate the local offset by the player's facing so the cling turns with them, then
    // ride the player's CURRENT feet pos (the body is the ground).
    const rx = ox * cosF - oz * sinF;
    const rz = ox * sinF + oz * cosF;

    // When down, slide the heap forward over the torso (the body lies ahead of the feet).
    const heapX = prone ? fwdX * PRONE_HEAP_FWD : 0;
    const heapZ = prone ? fwdZ * PRONE_HEAP_FWD : 0;
    px[i] = P.x + rx + heapX;
    py[i] = P.y + oy;             // anchor's body height, NOT the ground plane
    pz[i] = P.z + rz + heapZ;
    // Face the body center (inward) — attacking the body, not facing away.
    heading[i] = Math.atan2(-rx, -rz);
    clip[i] = attachedClip(i);
    phase[i] = phase[i] + EMOTE_RATE * 1.3 * dt;
    phase[i] -= Math.floor(phase[i]);
    stateT[i] += dt;
  }
  swarm.attachedCount = attached;

  // One pulse per frame when the pile grows (the SwarmCount widget's pop).
  if (attached > _lastAttached) emit('nibblerAttach', { count: attached });
  _lastAttached = attached;
}
