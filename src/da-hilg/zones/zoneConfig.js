// The level's zone layout, built from level metadata. Coordinates are in
// RECENTERED space (house at origin, ground ≈ y0) — the same space <Level>
// renders in after applying its -offset recenter group. Each def is spread
// straight onto a <Zone {...def}/>.
//
// home_safe is AUTO-FIT from levelMeta.houseBox so it always wraps the actual
// house. The meta ships houseBox in RAW source coords (its Y range sits up near
// the original world height), so we recenter it here by subtracting the meta
// offset before turning it into a padded center+size box. The other zones are
// hand-placed near origin against the recentered spawn layout.

// Padding (meters) added around the house bounds so the porch/eaves count as
// "safe", and a floor on the safe box so a short/low house still gets headroom.
const SAFE_PAD_XZ = 5;
const SAFE_PAD_Y = 2;
const SAFE_MIN_HEIGHT = 6;

/**
 * Recenter a raw-coord point by subtracting the level offset.
 * @param {number[]} p  [x,y,z] in raw level coords
 * @param {number[]} offset  levelMeta.offset
 * @returns {[number,number,number]}
 */
function recenter(p, offset) {
  return [p[0] - offset[0], p[1] - offset[1], p[2] - offset[2]];
}

/**
 * Build the home_safe def by fitting it to the (recentered) house bounding box.
 * Falls back to a sensible box at origin if the meta has no usable houseBox.
 * @param {import('../state/refs.js').levelMeta} levelMeta
 * @returns {{id:string,type:string,position:number[],size:number[]}}
 */
function buildHomeSafe(levelMeta) {
  const box = levelMeta.houseBox;
  const offset = levelMeta.offset || [0, 0, 0];
  const hasBox =
    box &&
    Array.isArray(box.min) &&
    Array.isArray(box.max) &&
    (box.max[0] - box.min[0]) > 0;

  if (!hasBox) {
    // No house bounds available — cover a generous box around origin.
    return { id: 'home_safe', type: 'safe', position: [0, 3, 0], size: [26, 6, 26] };
  }

  const min = recenter(box.min, offset);
  const max = recenter(box.max, offset);

  // Center of the recentered box, padded out to include the porch/yard skirt.
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2;

  const sizeX = (max[0] - min[0]) + SAFE_PAD_XZ * 2;
  const sizeY = Math.max((max[1] - min[1]) + SAFE_PAD_Y * 2, SAFE_MIN_HEIGHT);
  const sizeZ = (max[2] - min[2]) + SAFE_PAD_XZ * 2;

  return { id: 'home_safe', type: 'safe', position: [cx, cy, cz], size: [sizeX, sizeY, sizeZ] };
}

/**
 * Return the array of zone defs for the current level, in recentered coords.
 * @param {import('../state/refs.js').levelMeta} levelMeta
 * @returns {Array<Object>}
 */
export function buildZoneConfig(levelMeta) {
  return [
    // House + porch = safe. Auto-fit to the recentered house bounds. NPCs stop
    // chasing while the active player is anywhere inside this box.
    buildHomeSafe(levelMeta),

    // The whole neighborhood block. NPCs in the 'family' group can notice and
    // chase the player anywhere out here (outside the safe box, which wins).
    {
      id: 'street_notice',
      type: 'notice',
      position: [0, 4, 0],
      size: [120, 10, 120],
      npcGroup: 'family',
    },

    // Landmark triggers — fire a one-time HUD toast + named event on enter.
    {
      id: 'driveway_trig',
      type: 'trigger',
      position: [14, 2, 4],
      size: [12, 6, 12],
      event: 'entered_driveway',
      label: 'The Dahill Driveway',
    },
    {
      id: 'creek_trig',
      type: 'trigger',
      position: [-40, 2, -28],
      size: [30, 8, 60],
      event: 'reached_creek',
      label: 'San Lorenzo Creek',
    },

    // Inert stub reserved for the Nibblers mode — a 'danger' zone tracks
    // membership today (via the generic registry) but has no per-frame effect
    // yet. Uncomment + place to arm it; no zone-code changes needed.
    // {
    //   id: 'nibbler_den',
    //   type: 'danger',
    //   position: [-25, 2, 30],
    //   size: [20, 8, 20],
    //   npcGroup: 'nibblers',
    // },
  ];
}
