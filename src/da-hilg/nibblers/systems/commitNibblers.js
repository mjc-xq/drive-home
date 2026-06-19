// commitNibblers(ctx) — the ONLY per-frame nibbler writes into Jotai, all
// change-gated and bucketed so a swarm churning every frame touches the store a
// handful of times per growth phase, not 60×/s. Each value is diffed against a
// module snapshot; no store.set fires unless the bucketed value actually changed.
//
// Handled here:
//   markedTimerAtom     ← floor(swarm.markedT)            (1 Hz integer seconds)
//   attractionTierAtom  ← ATTRACTION band index 0..N      (which timeline band)
//   activeNibblersAtom  ← swarm.activeCount rounded to 5   (coarse)
//   attachedCountAtom   ← bucketed swarm.attachedCount     (threshold list)
//   visibilityFactorAtom← nibblerPenalty.visibility to 0.05 steps
//
// NOT handled here (owned by their own systems, per the contracts):
//   markedAtom / currentSafeZoneAtom / discoveredSafeZonesAtom → nibblerZones
//   healthAtom                                                 → healthDrain

import { nibblerPenalty } from '../mode.js';
import { swarm } from '../swarm/swarmState.js';
import { ATTRACTION } from '../constants.js';
import {
  markedTimerAtom,
  attractionTierAtom,
  activeNibblersAtom,
  attachedCountAtom,
  visibilityFactorAtom,
} from '../state/nibblerAtoms.js';

// Coarse buckets for the attached-count readout: small counts read exactly, large
// counts coarsen so a 199<->201 churn doesn't thrash the store.
const ATTACH_BUCKETS = [
  0, 1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 400, 512,
];

/** Bucket a raw attached count down to the nearest threshold at or below it. */
function bucketAttached(n) {
  let b = 0;
  for (let i = 0; i < ATTACH_BUCKETS.length; i++) {
    if (ATTACH_BUCKETS[i] <= n) b = ATTACH_BUCKETS[i];
    else break;
  }
  return b;
}

/** How many ATTRACTION thresholds markedT has passed → tier 0..ATTRACTION.length. */
function attractionTier(t) {
  let tier = 0;
  for (let i = 0; i < ATTRACTION.length; i++) {
    if (t >= ATTRACTION[i].t) tier = i + 1;
    else break;
  }
  return tier;
}

// Module snapshot of the last committed bucketed values (-1 / NaN force first write).
const last = {
  markedTimer: -1,
  tier: -1,
  active: -1,
  attached: -1,
  visibility: -1,
};

/**
 * Diff the swarm's bucketed UI values against the snapshot and write only the
 * changed atoms. Reads the SoA + nibblerPenalty ref; writes Jotai change-gated.
 * @param {object} ctx per-frame ctx { store }
 */
export function commitNibblers(ctx) {
  const store = ctx.store;

  // Marked elapsed seconds (1 Hz integer).
  const markedTimer = swarm.marked ? Math.floor(swarm.markedT) : 0;
  if (markedTimer !== last.markedTimer) {
    last.markedTimer = markedTimer;
    store.set(markedTimerAtom, markedTimer);
  }

  // Attraction tier (which timeline band).
  const tier = swarm.marked ? attractionTier(swarm.markedT) : 0;
  if (tier !== last.tier) {
    last.tier = tier;
    store.set(attractionTierAtom, tier);
  }

  // Active count, coarsened to multiples of 5.
  const active = Math.round(swarm.activeCount / 5) * 5;
  if (active !== last.active) {
    last.active = active;
    store.set(activeNibblersAtom, active);
  }

  // Attached count, bucketed.
  const attached = bucketAttached(swarm.attachedCount);
  if (attached !== last.attached) {
    last.attached = attached;
    store.set(attachedCountAtom, attached);
  }

  // Visibility factor, rounded to 0.05 steps (HUD vignette source).
  const visibility = Math.round(nibblerPenalty.visibility * 20) / 20;
  if (visibility !== last.visibility) {
    last.visibility = visibility;
    store.set(visibilityFactorAtom, visibility);
  }
}
