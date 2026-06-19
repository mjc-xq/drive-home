// Nibblers barrel — the public surface the framework wires to. Everything else
// stays inside nibblers/. The framework's only touch points are: the one sim step
// (updateNibblers), the mode gate (isNibblersMode), the swarm renderer, the HUD,
// and the zone config — all re-exported here.

export { isNibblersMode, nibblerPenalty } from './mode.js';
export { updateNibblers } from './systems/nibblersSystems.js';
export { buildNibblersZones } from './zones/zoneConfig.nibblers.js';
export { default as NibblerNpcs } from './render/NibblerNpcs.jsx';
export { default as NibblersHud } from './hud/NibblersHud.jsx';

import { resetSwarm } from './swarm/swarmState.js';
import { resetThrottle } from './render/throttle.js';
import { isNibblersMode, nibblerPenalty } from './mode.js';
import { daHilgStore } from '../state/store.js';
import { cameraModeAtom } from '../state/atoms.js';
import { cameraRig } from '../state/refs.js';
import { discoveredSafeZonesAtom } from './state/nibblerAtoms.js';

/**
 * Reset the swarm to a clean empty state and, in Nibblers mode, default the camera
 * to THIRD-PERSON — the whole game is watching the pile cling to your visible body
 * and aiming a dive-stomp, both invisible in first-person. Called once on mount
 * (and safe to re-run). Asset loading + zone building happen reactively elsewhere.
 */
export function initNibblers() {
  resetSwarm();
  resetThrottle();
  // Penalties start clean (a fresh run, or a mode re-enter).
  nibblerPenalty.speedMul = 1;
  nibblerPenalty.jumpMul = 1;
  nibblerPenalty.visibility = 1;
  // Keep the home/front-yard anchor pre-discovered so the player always starts with a
  // safe zone marked on the minimap (the spawn sits inside it). Append-only so this is
  // safe to re-run on a mode re-enter without wiping zones discovered in a prior run.
  const discovered = daHilgStore.get(discoveredSafeZonesAtom);
  if (!discovered.includes('safe_home')) {
    daHilgStore.set(discoveredSafeZonesAtom, ['safe_home', ...discovered]);
  }
  if (isNibblersMode()) {
    daHilgStore.set(cameraModeAtom, 'third');
    cameraRig.mode = 'third';
  }
}
