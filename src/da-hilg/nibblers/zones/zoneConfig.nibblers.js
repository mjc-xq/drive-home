// buildNibblersZones(levelMeta) — the Nibblers-mode zone layout, parallel to the
// framework's buildZoneConfig (not a replacement). Coordinates are in RECENTERED
// space (house at origin, the same space <Level> renders in) on the ±200 m block.
//
// Layout logic: the house is the anchor safe zone; four more discoverable safe
// zones sit at the cardinals along the road network; six danger zones are seeded on
// the approaches BETWEEN them, so traveling is the risk. Most danger zones reveal
// after discovery. The near-home driveway danger is known from the start so the
// minimap immediately communicates both sides of the loop: green safe, red danger.
//
// Safe boxes are tall (~12 m) so the player triggers them regardless of the exact
// hill height at that XZ; danger boxes are likewise tall + invisible. Each safe def
// carries label (toast + minimap pip) and discover:true (first entry reveals it).
// Danger defs carry npcGroup:'nibblers' so future per-zone tuning stays data-only.

/**
 * Build the home/front-yard anchor safe zone, GROUND-ANCHORED around the spawn.
 *
 * NOTE: we do NOT reuse the framework's buildHomeSafe here. Its box is fit to
 * levelMeta.houseBox, whose Y range is the house WALL geometry (~10–14 m above the
 * recentered ground) — so that box floats ~8 m over a ground-standing player and the
 * spawned player never overlaps it (the Rapier sensor is a real 3D AABB). For Nibblers
 * the home zone MUST contain the spawn so the player starts safe, so we take the house
 * XZ footprint (padded) but anchor the box from the ground up through the roofline.
 * @param {import('../../state/refs.js').levelMeta} levelMeta
 * @returns {{id:string,type:string,position:number[],size:number[],label:string,discover:boolean}}
 */
function buildHomeSafeGrounded(levelMeta) {
  const box = levelMeta && levelMeta.houseBox;
  const hasBox =
    box && Array.isArray(box.min) && Array.isArray(box.max) && (box.max[0] - box.min[0]) > 0;

  // XZ footprint of the house, padded to include the porch/front-yard skirt, else a
  // generous box around origin (the spawn sits near origin in recentered space).
  const PAD_XZ = 8;
  const cx = hasBox ? (box.min[0] + box.max[0]) / 2 : 0;
  const cz = hasBox ? (box.min[2] + box.max[2]) / 2 : 0;
  const sizeX = hasBox ? (box.max[0] - box.min[0]) + PAD_XZ * 2 : 30;
  const sizeZ = hasBox ? (box.max[2] - box.min[2]) + PAD_XZ * 2 : 30;

  // Vertical span: floor a couple meters BELOW the ground (recentered ground ≈ 0) so a
  // capsule whose feet sit at y≈0.05 is comfortably inside, and reach up over the roof
  // (box.max[1] ≈ 14 m). Center + full-height so the AABB is [-2 .. roofTop].
  const roofTop = hasBox ? box.max[1] : 14;
  const floorY = -2;
  const sizeY = roofTop - floorY;
  const cy = (floorY + roofTop) / 2;

  return {
    id: 'safe_home',
    type: 'safe',
    position: [cx, cy, cz],
    size: [sizeX, sizeY, sizeZ],
    label: 'Home',
    discover: true,
    marker: true,
  };
}

/**
 * Build the array of Nibblers zone defs (recentered coords), spread straight onto
 * <Zone {...def}/>.
 * @param {import('../../state/refs.js').levelMeta} levelMeta
 * @returns {Array<Object>}
 */
export function buildNibblersZones(levelMeta) {
  // Ground-anchored home anchor safe zone around the spawn; tagged discoverable AND
  // pre-discovered at start (see discoveredSafeZonesAtom seed) so the player begins safe
  // and sees the home pip on the minimap from the first frame.
  const home = buildHomeSafeGrounded(levelMeta);

  return [
    // ── SAFE ZONES (type 'safe') — home anchor + 4 discoverable along the roads.
    home,
    { id: 'safe_creek', type: 'safe', position: [-60, 6, -120], size: [26, 12, 26], label: 'Creek Landing', discover: true, marker: true },
    { id: 'safe_overlook', type: 'safe', position: [130, 8, 40], size: [24, 12, 24], label: 'East Overlook', discover: true, marker: true },
    { id: 'safe_park', type: 'safe', position: [-110, 6, 90], size: [28, 12, 28], label: 'West Green', discover: true, marker: true },
    { id: 'safe_corner', type: 'safe', position: [70, 6, 150], size: [24, 12, 24], label: 'North Corner', discover: true, marker: true },

    // ── DANGER ZONES (type 'danger') — seeded between safe zones on the approaches.
    // Labels feed toasts, the action pulse, and the minimap marker after a trigger.
    { id: 'danger_drive', type: 'danger', position: [26, 5, 24], size: [30, 10, 30], label: 'Driveway Swarm', npcGroup: 'nibblers', reveal: true, marker: true },
    { id: 'danger_south', type: 'danger', position: [-20, 5, -70], size: [44, 12, 44], label: 'South Ambush', npcGroup: 'nibblers', reveal: true },
    { id: 'danger_eastrd', type: 'danger', position: [80, 6, 0], size: [50, 12, 40], label: 'East Road Swarm', npcGroup: 'nibblers', reveal: true },
    { id: 'danger_westrd', type: 'danger', position: [-80, 6, 40], size: [50, 12, 44], label: 'West Road Swarm', npcGroup: 'nibblers', reveal: true },
    { id: 'danger_northrd', type: 'danger', position: [30, 6, 100], size: [48, 12, 48], label: 'North Road Swarm', npcGroup: 'nibblers', reveal: true },
    { id: 'danger_far', type: 'danger', position: [150, 8, 150], size: [60, 14, 60], label: 'Far Corner Swarm', npcGroup: 'nibblers', reveal: true },
  ];
}
