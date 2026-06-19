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

/**
 * Reset the swarm to a clean empty state. Called once when the Nibblers app mounts
 * so re-entering the mode (or a hot reload) starts fresh. Asset loading + zone
 * building happen reactively via the renderer/Zones; this is just the sim reset.
 */
export function initNibblers() {
  resetSwarm();
}
