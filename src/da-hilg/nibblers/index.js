// Nibblers barrel — the public surface the framework wires to. Everything else
// stays inside nibblers/. The framework's only touch points are: the one sim step
// (updateNibblers), the mode gate (isNibblersMode), the swarm renderer, the HUD,
// and the zone config — all re-exported here.

export { isNibblersMode, nibblerPenalty } from './mode.js';
export { updateNibblers } from './systems/nibblersSystems.js';
export { buildNibblersZones } from './zones/zoneConfig.nibblers.js';
export { default as SwarmRenderer } from './render/SwarmRenderer.jsx';
export { default as NibblersHud } from './hud/NibblersHud.jsx';

import { resetSwarm } from './swarm/swarmState.js';
import { isNibblersMode, nibblerPenalty } from './mode.js';
import { daHilgStore } from '../state/store.js';
import { cameraModeAtom } from '../state/atoms.js';
import { cameraRig } from '../state/refs.js';

/**
 * Reset the swarm to a clean empty state and, in Nibblers mode, default the camera
 * to THIRD-PERSON — the whole game is watching the pile cling to your visible body
 * and aiming a dive-stomp, both invisible in first-person. Called once on mount
 * (and safe to re-run). Asset loading + zone building happen reactively elsewhere.
 */
export function initNibblers() {
  resetSwarm();
  // Penalties start clean (a fresh run, or a mode re-enter).
  nibblerPenalty.speedMul = 1;
  nibblerPenalty.jumpMul = 1;
  nibblerPenalty.visibility = 1;
  if (isNibblersMode()) {
    daHilgStore.set(cameraModeAtom, 'third');
    cameraRig.mode = 'third';
  }
}
