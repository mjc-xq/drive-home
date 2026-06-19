// updateHealthDrain(ctx) — attached nibblers slowly drain the ACTIVE player's
// health. Movement pressure dominates by design; drain is the gentle secondary
// threat (worst case ~2.5 HP/s → 40 s from full, plenty of time to reach safety).
//
// Health lives on a 0..100 scale. We keep a module float PER ID (so Tab-switching
// characters preserves each one's drained value — the drain target follows whoever
// you're driving), seeded from actor.health on first touch. Each frame we subtract
// drainRate(attachedCount)*dt, clamp at >=0 (NO fail state per spec), and mirror the
// float onto actor.health. We commit the per-id healthAtom map at HEALTH_COMMIT_HZ,
// and only when the integer HP actually changed (change-gated — never per frame).

import { healthAtom } from '../../state/atoms.js';
import { swarm } from '../swarm/swarmState.js';
import {
  HEALTH_DRAIN_PER_ATTACH,
  HEALTH_DRAIN_CAP,
  HEALTH_COMMIT_HZ,
} from '../constants.js';

/** id -> continuous health float (0..100). Seeded from actor.health on first sight. */
const healthFloat = new Map();
/** id -> last committed integer HP (so we only write the atom on integer changes). */
const lastCommittedHp = new Map();
/** Wall-clock (ms) of the last atom commit, for the HEALTH_COMMIT_HZ throttle. */
let lastCommitT = 0;

/** Min ms between health atom commits, from HEALTH_COMMIT_HZ. */
const COMMIT_INTERVAL_MS = 1000 / HEALTH_COMMIT_HZ;

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Drain the active player's health by drainRate(attachedCount), mirror to
 * actor.health, and commit the healthAtom map at HEALTH_COMMIT_HZ on integer change.
 * @param {object} ctx per-frame ctx { store, registry, activePlayerId, now, dt }
 */
export function updateHealthDrain(ctx) {
  const id = ctx.activePlayerId;
  const actor = ctx.registry.get(id);
  if (!actor) return;

  // Seed the float from the actor's current health the first time we see this id.
  let hf = healthFloat.get(id);
  if (hf === undefined) {
    hf = actor.health != null ? actor.health : 100;
    healthFloat.set(id, hf);
  }

  // drainRate = min(a * perAttach, cap)  — HP/sec.
  const a = swarm.attachedCount;
  const drainRate = Math.min(a * HEALTH_DRAIN_PER_ATTACH, HEALTH_DRAIN_CAP);
  if (drainRate > 0) {
    hf = clamp(hf - drainRate * ctx.dt, 0, 100);
    healthFloat.set(id, hf);
  }

  // Mirror the continuous value onto the actor (plain-ref write, per-frame truth).
  actor.health = hf;

  // Commit the integer HP into the per-id atom map at the throttled rate, only when
  // the rounded value changed (avoids store churn while idling at full health).
  if (ctx.now - lastCommitT < COMMIT_INTERVAL_MS) return;
  lastCommitT = ctx.now;

  const hp = clamp(Math.round(hf), 0, 100);
  if (lastCommittedHp.get(id) === hp) return;
  lastCommittedHp.set(id, hp);

  const map = ctx.store.get(healthAtom);
  if (map[id] !== hp) {
    ctx.store.set(healthAtom, { ...map, [id]: hp });
  }
}
