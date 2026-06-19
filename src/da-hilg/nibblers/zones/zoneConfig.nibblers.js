// buildNibblersZones(levelMeta) — the Nibblers-mode zone layout, parallel to the
// framework's buildZoneConfig (not a replacement). Coordinates are in RECENTERED
// space (house at origin, the same space <Level> renders in) on the ±200 m block.
//
// Layout logic: the house is the anchor safe zone; four more discoverable safe
// zones sit at the cardinals along the road network; six HIDDEN danger zones are
// seeded on the approaches BETWEEN them, so traveling is the risk. Danger zones are
// invisible for free — <Zone> renders only a sensor collider — and they never reach
// the minimap (the minimap has no data source for them; it reads only the discovered
// safe-zone set).
//
// Safe boxes are tall (~12 m) so the player triggers them regardless of the exact
// hill height at that XZ; danger boxes are likewise tall + invisible. Each safe def
// carries label (toast + minimap pip) and discover:true (first entry reveals it).
// Danger defs carry npcGroup:'nibblers' so future per-zone tuning stays data-only.

import { buildHomeSafe } from '../../zones/zoneConfig.js';

/**
 * Build the array of Nibblers zone defs (recentered coords), spread straight onto
 * <Zone {...def}/>.
 * @param {import('../../state/refs.js').levelMeta} levelMeta
 * @returns {Array<Object>}
 */
export function buildNibblersZones(levelMeta) {
  // Reuse the houseBox auto-fit for the anchor safe zone; tag it discoverable.
  const home = { ...buildHomeSafe(levelMeta), id: 'safe_home', label: 'Home', discover: true };

  return [
    // ── SAFE ZONES (type 'safe') — home anchor + 4 discoverable along the roads.
    home,
    { id: 'safe_creek', type: 'safe', position: [-60, 6, -120], size: [26, 12, 26], label: 'Creek Landing', discover: true },
    { id: 'safe_overlook', type: 'safe', position: [130, 8, 40], size: [24, 12, 24], label: 'East Overlook', discover: true },
    { id: 'safe_park', type: 'safe', position: [-110, 6, 90], size: [28, 12, 28], label: 'West Green', discover: true },
    { id: 'safe_corner', type: 'safe', position: [70, 6, 150], size: [24, 12, 24], label: 'North Corner', discover: true },

    // ── DANGER ZONES (type 'danger') — HIDDEN, seeded between the safe zones on the
    // approaches. npcGroup tags them for future data-only spawn-rate tuning.
    { id: 'danger_drive', type: 'danger', position: [26, 5, 24], size: [30, 10, 30], npcGroup: 'nibblers' },
    { id: 'danger_south', type: 'danger', position: [-20, 5, -70], size: [44, 12, 44], npcGroup: 'nibblers' },
    { id: 'danger_eastrd', type: 'danger', position: [80, 6, 0], size: [50, 12, 40], npcGroup: 'nibblers' },
    { id: 'danger_westrd', type: 'danger', position: [-80, 6, 40], size: [50, 12, 44], npcGroup: 'nibblers' },
    { id: 'danger_northrd', type: 'danger', position: [30, 6, 100], size: [48, 12, 48], npcGroup: 'nibblers' },
    { id: 'danger_far', type: 'danger', position: [150, 8, 150], size: [60, 14, 60], npcGroup: 'nibblers' },
  ];
}
