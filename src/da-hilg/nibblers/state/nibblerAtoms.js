// Reactive Jotai atoms for Nibblers — discrete UI state only, written change-gated
// (and bucketed) in nibblers/systems/commitNibblers.js, never per frame. The 400+
// fast-changing swarm values live in the typed-array SoA (swarm/swarmState.js), a
// plain module — NOT here. markedAtom + healthAtom are reused from the framework's
// state/atoms.js (they were reserved for exactly this).

import { atom } from 'jotai';

// markedAtom + healthAtom live in the framework's state/atoms.js (reserved there
// for exactly this). Re-export them so nibblers code has one import source.
export { markedAtom, healthAtom } from '../../state/atoms.js';

// Which game loop is active. Nibblers is the default mode.
export const gameModeAtom = atom('nibblers'); // 'nibblers' | 'greet'

// Safe zones the player has discovered (permanent, append-only) — drives the minimap.
// Seeded with 'safe_home' so the player STARTS safe-zone-aware: the home/front-yard
// anchor (buildNibblersZones → id 'safe_home', which contains the spawn) shows its pip
// on the minimap from the first frame, so there's always a marked safe zone to head for.
// initNibblers() re-seeds this on every (re)mount so it survives a mode re-enter.
export const discoveredSafeZonesAtom = atom(['safe_home']); // string[] of zone ids

// Danger zones the player has learned about. Seed one near-home hazard so the
// minimap always communicates both sides of the loop from the first frame:
// green = safety, red = danger. Additional hidden danger zones append on contact.
export const revealedDangerZonesAtom = atom(['danger_drive']); // string[] of zone ids

// Marked elapsed seconds (1 Hz) + the attraction tier 0..4 (for HUD ramp).
export const markedTimerAtom = atom(0);
export const attractionTierAtom = atom(0);

// Swarm counts (bucketed so churn doesn't thrash the store).
export const activeNibblersAtom = atom(0);
export const attachedCountAtom = atom(0);

// Visibility 0..1 (1 = clear). Drives the HUD vignette; mirrored from the
// nibblerPenalty ref in 0.05 steps.
export const visibilityFactorAtom = atom(1);

// The current safe zone the player is standing in (label), or null.
export const currentSafeZoneAtom = atom(null);
