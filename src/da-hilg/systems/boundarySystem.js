// Map boundary. The neighborhood is a finite walkable block; rather than an invisible
// wall, crossing the edge WARPS the active player to a random point on the border, so
// the world reads as bounded + a little surreal. The boundary (walkable XZ extent) is
// computed from the collision mesh at load → levelMeta.bounds. Teleporting just sets a
// new XZ and clears ref._snapped — trySnapActor drops the player onto the terrain there
// on the next frame (so the new spot is always on solid ground at the right height).

import { emit } from '../hud/hudEvents.js';
import { pushToast } from '../hud/hudEvents.js';

const MARGIN = 3; // how far past the edge before warping (avoids rim jitter)
const INSET = 12; // land this far inside the border (solid ground, not the lip)

/**
 * Warp the active player to a random border spot if they've crossed the map edge.
 * Call once per frame AFTER motion is applied, BEFORE animation.
 * @param {object} ctx per-frame ctx { registry, activePlayerId, levelMeta, now }
 */
export function clampToBoundary(ctx) {
  const b = ctx.levelMeta && ctx.levelMeta.bounds;
  if (!b) return;
  const actor = ctx.registry.get(ctx.activePlayerId);
  if (!actor || !actor.ref._snapped) return; // only warp a grounded player

  const p = actor.motion.pos;
  if (
    p.x >= b.minX - MARGIN &&
    p.x <= b.maxX + MARGIN &&
    p.z >= b.minZ - MARGIN &&
    p.z <= b.maxZ + MARGIN
  ) {
    return; // still inside the block
  }

  // Crossed → a random point on the inset border. Seed from ctx.now so the sim stays
  // deterministic (no Math.random on the sim path).
  const minX = b.minX + INSET;
  const maxX = b.maxX - INSET;
  const minZ = b.minZ + INSET;
  const maxZ = b.maxZ - INSET;
  const h = Math.sin(ctx.now * 0.013) * 43758.5453;
  const r1 = h - Math.floor(h);
  const r2 = h * 1.7 - Math.floor(h * 1.7);
  const edge = Math.floor(r1 * 4) % 4;
  let nx;
  let nz;
  if (edge === 0) {
    nx = minX;
    nz = minZ + r2 * (maxZ - minZ);
  } else if (edge === 1) {
    nx = maxX;
    nz = minZ + r2 * (maxZ - minZ);
  } else if (edge === 2) {
    nx = minX + r2 * (maxX - minX);
    nz = minZ;
  } else {
    nx = minX + r2 * (maxX - minX);
    nz = maxZ;
  }

  p.x = nx;
  p.z = nz;
  actor.motion.velY = 0;
  actor.ref._snapped = false; // trySnapActor re-drops onto the terrain at the new XZ
  emit('boundaryWarp', { x: nx, z: nz });
  pushToast('Edge of the neighborhood — warped to the border', 'system');
}
