// Minimap world↔pixel projector — pure, no imports, no DOM. Shared by the build
// output's coordinate convention and the runtime Canvas2D widget (hud/Minimap.jsx).
//
// The map is PLAYER-LOCKED and NORTH-UP: the player sits dead-center, world +Z
// points DOWN the screen by raw convention so we flip Z to put +Z (south) at the
// bottom and -Z (north) at the top. A view radius (meters shown from center to
// edge) sets the zoom; recentered world XZ (the space <Level> renders in, already
// offset-subtracted in minimap.json) maps to pixels around the canvas center.
//
// makeMinimapProjector(worldHalf, sizePx) returns:
//   worldToMap(x, z, playerX, playerZ)   → [px, py]   (player-locked, north-up)
//   scale(meters)                        → pixels      (length helper)
//   viewRadius / pxPerMeter / sizePx     (readback for callers)
//
// Note: `worldHalf` (the minimap.json worldHalfExtent, ~220 m) bounds how far the
// road data extends; the on-screen zoom is driven by MINIMAP_VIEW_RADIUS, passed
// by the widget. We keep worldHalf in the signature (per the contract) and expose
// it so a future fixed-extent mode can use it, but the player-locked transform is
// driven by the view radius the widget configures via `setViewRadius`.

import { MINIMAP_VIEW_RADIUS } from '../constants.js';

/**
 * Build a pure minimap projector.
 * @param {number} worldHalf  world meters from map center to the road-data edge (minimap.json worldHalfExtent)
 * @param {number} sizePx      square canvas size in CSS pixels
 * @param {number} [viewRadius=MINIMAP_VIEW_RADIUS] meters shown from center to edge (zoom)
 */
export function makeMinimapProjector(worldHalf, sizePx, viewRadius = MINIMAP_VIEW_RADIUS) {
  const half = sizePx / 2;
  // pixels per world meter so that `viewRadius` meters fill half the canvas.
  const pxPerMeter = half / viewRadius;

  /**
   * Project a recentered world XZ point to canvas pixels, player-locked + north-up.
   * The player is always at the canvas center; everything is plotted relative to it.
   * Screen Y is inverted vs world Z so north (−Z) is up.
   * @param {number} x  world X (recentered)
   * @param {number} z  world Z (recentered)
   * @param {number} playerX  active player world X (recentered)
   * @param {number} playerZ  active player world Z (recentered)
   * @returns {[number, number]} [px, py] in canvas pixel space (0,0 = top-left)
   */
  function worldToMap(x, z, playerX, playerZ) {
    const dx = x - playerX;
    const dz = z - playerZ;
    return [half + dx * pxPerMeter, half - dz * pxPerMeter];
  }

  /**
   * Convert a length in world meters to map pixels.
   * @param {number} meters
   * @returns {number}
   */
  function scale(meters) {
    return meters * pxPerMeter;
  }

  return {
    worldToMap,
    scale,
    pxPerMeter,
    viewRadius,
    sizePx,
    worldHalf,
  };
}
