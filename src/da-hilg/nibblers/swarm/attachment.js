// Attachment: once a nibbler passes the attach test it rides the player capsule as
// part of a writhing pile. We position attached nibblers on a jittered shell around
// the player's capsule each frame (no independent sim, no seek) and keep
// swarm.attachedCount in sync — that count is the single number the penalty + health
// systems read. v1 placement is a deterministic per-nibbler jitter (seed/phase), not
// a golden-spiral; it reads as a clinging swarm and is allocation-free.

import {
  S_ATTACHED,
  CLIP_EMOTE,
  EMOTE_RATE,
} from '../constants.js';
import { CAPSULE_RADIUS, CAPSULE_CENTER_Y, CAPSULE_HALF_HEIGHT } from '../../constants.js';
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

// Vertical span the pile covers around the capsule (feet .. ~head).
const SHELL_BOTTOM = 0.05;
const SHELL_TOP = 2 * (CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS) - 0.1;

/** Cheap deterministic hash of a 0..1 seed into another 0..1 value. */
function hash01(s) {
  const x = Math.sin(s * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Promote nibbler `i` to ATTACHED. Assigns a monotonic attach slot (used only to
 * spread the angular placement so two attaching on the same frame don't stack), and
 * flips it to the emote clip. Increments swarm.attachedCount.
 * @param {number} i
 * @param {object} _ctx (unused; kept for signature symmetry / future capsule reads)
 */
export function attachNibbler(i, _ctx) {
  if (state[i] === S_ATTACHED) return;
  state[i] = S_ATTACHED;
  stateT[i] = 0;
  attachSlot[i] = swarm.attachNext++;
  clip[i] = CLIP_EMOTE;
  swarm.attachedCount++;
}

/**
 * Per-frame: place every ATTACHED nibbler on a jittered shell around the player
 * capsule, rotated by the player's facing, and recount swarm.attachedCount (kept in
 * sync against the SoA so stomp/scatter edits can't drift it). Emote phase advances
 * faster while clinging (manic).
 * @param {object} ctx sim ctx — needs registry + activePlayerId
 */
export function updateAttachment(ctx) {
  const player = ctx.registry.get(ctx.activePlayerId);
  if (!player) return;
  const P = player.motion.pos;
  const facing = player.motion.facing;
  const cosF = Math.cos(facing);
  const sinF = Math.sin(facing);
  const dt = ctx.dt;

  let attached = 0;
  for (let i = 0; i < scale.length; i++) {
    if (state[i] !== S_ATTACHED) continue;
    attached++;

    // Stable per-nibbler placement: angle from the attach slot + seed jitter; height
    // and radius jittered by seed/hash so the pile reads as a clump, not a ring.
    const s = attachSlot[i] >= 0 ? attachSlot[i] : i;
    const ang = s * 2.39996 + seed[i] * TWO_PI; // golden-ish angular spread + jitter
    const yFrac = hash01(seed[i] + 0.123); // 0..1 up the body
    const ring = 0.6 + 0.4 * hash01(seed[i] + 0.777); // how far out around the shell
    const bodyR = CAPSULE_RADIUS + 0.15 * ring;

    // Breathing wobble from the emote phase so the pile visibly writhes.
    const wob = Math.sin(phase[i] * TWO_PI) * 0.04;

    const ox = Math.cos(ang) * bodyR + (seed[i] - 0.5) * 0.1;
    const oz = Math.sin(ang) * bodyR + (hash01(seed[i]) - 0.5) * 0.1;
    const oy = CAPSULE_CENTER_Y - CAPSULE_HALF_HEIGHT - CAPSULE_RADIUS
      + SHELL_BOTTOM + yFrac * (SHELL_TOP - SHELL_BOTTOM) + wob;

    // Rotate the local offset by the player's facing so the pile turns with them.
    const rx = ox * cosF - oz * sinF;
    const rz = ox * sinF + oz * cosF;

    px[i] = P.x + rx;
    py[i] = P.y + oy;
    pz[i] = P.z + rz;
    heading[i] = facing + (seed[i] - 0.5) * 2; // varied facings
    clip[i] = CLIP_EMOTE;
    phase[i] = phase[i] + EMOTE_RATE * 1.3 * dt;
    phase[i] -= Math.floor(phase[i]);
    stateT[i] += dt;
  }
  swarm.attachedCount = attached;
}
