// CPU throttle for the real-NPC pool. Real skinned NPCs (each its own AnimationMixer
// + skinned clone) are far heavier than a GPU-instanced VAT clone, so the active
// count must be capped to what the machine can sustain. We fold the real per-frame
// time into an exponential moving average and servo a dynamic cap inside
// [NIBBLER_NPC_MIN, NIBBLER_NPC_MAX]:
//
//   • avg frame time over budget+slack → ramp the cap DOWN (shed NPCs) fast
//   • avg frame time under budget−slack → ramp the cap UP (admit NPCs) gently
//   • inside the dead-band → hold steady
//
// The spawner reads activeCap() and clamps swarm.targetActive to it, so the
// attraction curve never asks for more bodies than we can animate. Plain module,
// mutated in place from the single sim loop — no React, no atoms, no allocation.

import {
  NIBBLER_NPC_MAX,
  NIBBLER_NPC_MIN,
  NIBBLER_FRAME_BUDGET_MS,
  NIBBLER_FRAME_SLACK_MS,
  NIBBLER_FRAME_EMA,
  NIBBLER_CAP_RAMP_DOWN,
  NIBBLER_CAP_RAMP_UP,
} from '../constants.js';

// Rolling average frame time (ms). Seeded at the budget so we don't slam the cap on
// the very first (cold) frame.
let avgMs = NIBBLER_FRAME_BUDGET_MS;
// Float cap, servoed each frame; rounded down to an int when read. Starts mid-band so
// the horde ramps up from a safe size rather than spiking the cap on entry.
let cap = NIBBLER_NPC_MIN;

/**
 * Fold this frame's dt into the rolling average and ramp the cap toward what the
 * frame budget allows. Call once per sim frame (before the spawner reads activeCap).
 * @param {number} dt clamped seconds this frame
 */
export function updateThrottle(dt) {
  const ms = dt * 1000;
  // EMA of frame time. dt is already clamped (DT_CLAMP) so a single GC hitch can't
  // yank the average to the moon.
  avgMs += (ms - avgMs) * NIBBLER_FRAME_EMA;

  const hi = NIBBLER_FRAME_BUDGET_MS + NIBBLER_FRAME_SLACK_MS;
  const lo = NIBBLER_FRAME_BUDGET_MS - NIBBLER_FRAME_SLACK_MS;

  if (avgMs > hi) {
    cap -= NIBBLER_CAP_RAMP_DOWN * dt;        // frames slow → shed NPCs
  } else if (avgMs < lo) {
    cap += NIBBLER_CAP_RAMP_UP * dt;          // frames smooth → admit more
  }
  // Clamp to the configured band.
  if (cap < NIBBLER_NPC_MIN) cap = NIBBLER_NPC_MIN;
  else if (cap > NIBBLER_NPC_MAX) cap = NIBBLER_NPC_MAX;
}

/** The current integer active cap the spawner clamps targetActive to. */
export function activeCap() {
  return Math.floor(cap);
}

/** The rolling average frame time (ms) — exposed for HUD/debug readouts. */
export function avgFrameMs() {
  return avgMs;
}

/** Reset the throttle to its cold-start state (called on mode enter). */
export function resetThrottle() {
  avgMs = NIBBLER_FRAME_BUDGET_MS;
  cap = NIBBLER_NPC_MIN;
}
