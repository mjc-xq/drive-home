// Nibblers barrel — the public surface the framework wires to. Everything else
// stays inside nibblers/. The framework's only touch points are: the one sim step
// (updateNibblers), the mode gate (isNibblersMode), the swarm renderer, the HUD,
// and the zone config — all re-exported here.

export { isNibblersMode, nibblerPenalty } from './mode.js';
export { updateNibblers } from './systems/nibblersSystems.js';
export { buildNibblersZones } from './zones/zoneConfig.nibblers.js';
export { default as NibblerNpcs } from './render/NibblerNpcs.jsx';
export { default as NibblersHud } from './hud/NibblersHud.jsx';
export { initNibblers } from './init.js';
