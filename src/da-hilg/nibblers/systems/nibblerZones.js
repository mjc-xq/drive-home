// updateNibblerZones(ctx) — the marked / safe / scatter system, the heart of the loop.
//
// SAFE vs DANGER is decided GEOMETRICALLY in 2D (XZ), NOT via Rapier sensor volumes.
// The neighborhood is a hill, so fixed-height sensor AABBs miss a ground-standing
// player whose Y varies with the terrain (the old bug: you could never get marked, and
// even the home zone didn't register). Here we test the player's XZ against each safe
// zone's footprint, ignore Y entirely, and treat EVERYWHERE OUTSIDE a safe zone as
// danger — so the open neighborhood is the threat:
//
//   • In a safe zone  → if marked, scatter the horde + clear the mark; reveal/discover
//                       the zone; publish its label.
//   • Outside ALL safe zones → arm the mark (the swarm spawns + chases). Reaching any
//     safe zone clears it.
//
// All store writes are edge-gated (same discipline as commitReactive).

import { pushToast, emit } from '../../hud/hudEvents.js';
import {
  markedAtom,
  discoveredSafeZonesAtom,
  currentSafeZoneAtom,
} from '../state/nibblerAtoms.js';
import { swarm } from '../swarm/swarmState.js';
import { armMarked, clearAndScatter, setScatterCenter } from './markedSystem.js';
import { buildNibblersZones } from '../zones/zoneConfig.nibblers.js';

/** Memoized safe-zone footprints (XZ rectangles), built once from the zone config. */
let safeRects = null;
/** Last currentSafeZone label written, so the atom only changes on a transition. */
let lastSafeLabel = null;

/** Reset memoization (call on a fresh level / mode re-enter if ever needed). */
export function resetNibblerZones() {
  safeRects = null;
  lastSafeLabel = null;
}

/** Build the XZ rectangles for every 'safe' zone once levelMeta is available. */
function ensureSafeRects(levelMeta) {
  if (safeRects) return safeRects;
  const zones = buildNibblersZones(levelMeta).filter((z) => z.type === 'safe');
  safeRects = zones.map((z) => ({
    id: z.id,
    label: z.label ?? null,
    discover: !!z.discover,
    minX: z.position[0] - z.size[0] / 2,
    maxX: z.position[0] + z.size[0] / 2,
    minZ: z.position[2] - z.size[2] / 2,
    maxZ: z.position[2] + z.size[2] / 2,
  }));
  return safeRects;
}

/**
 * Decide safe/danger from the active player's XZ position and drive marked/discovered/
 * scatter on the edges.
 * @param {object} ctx per-frame ctx { store, registry, activePlayerId, now, levelMeta }
 */
export function updateNibblerZones(ctx) {
  const player = ctx.registry.get(ctx.activePlayerId);
  if (!player) return;
  const rects = ensureSafeRects(ctx.levelMeta);

  const px = player.motion.pos.x;
  const pz = player.motion.pos.z;

  // Which safe zone (if any) is the player standing over? (2D point-in-rectangle.)
  let inSafe = false;
  let safeLabel = null;
  let discoverableSafeId = null;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (px >= r.minX && px <= r.maxX && pz >= r.minZ && pz <= r.maxZ) {
      inSafe = true;
      if (r.label != null) safeLabel = r.label;
      if (r.discover && discoverableSafeId == null) discoverableSafeId = r.id;
    }
  }

  // ── SAFE ──────────────────────────────────────────────────────────────────
  if (inSafe) {
    // Marked → safe: scatter the whole horde OFF the player (seed the scatter center
    // to the player's feet so it radiates from them, not world origin) and clear.
    if (swarm.marked) {
      setScatterCenter(player.motion.pos);
      clearAndScatter(ctx.now);
      ctx.store.set(markedAtom, false);
      emit('safeReached', { label: safeLabel || null });
      pushToast('Nibblers scattered!', 'greet');
    }

    // First-time discovery → append to the permanent revealed set.
    if (discoverableSafeId) {
      const discovered = ctx.store.get(discoveredSafeZonesAtom);
      if (!discovered.includes(discoverableSafeId)) {
        ctx.store.set(discoveredSafeZonesAtom, [...discovered, discoverableSafeId]);
        pushToast('Safe Zone discovered', 'greet');
      }
    }

    if (lastSafeLabel !== safeLabel) {
      lastSafeLabel = safeLabel;
      ctx.store.set(currentSafeZoneAtom, safeLabel);
    }
    return;
  }

  // ── DANGER (everywhere outside a safe zone) ────────────────────────────────
  // The open neighborhood is the threat: stepping off safe ground arms the mark and
  // the swarm spawns + closes in. Only reaching a safe zone clears it.
  if (!swarm.marked) {
    armMarked(ctx.now);
    ctx.store.set(markedAtom, true);
    pushToast('Marked — get to a Safe Zone!', 'tag');
  }

  if (lastSafeLabel !== null) {
    lastSafeLabel = null;
    ctx.store.set(currentSafeZoneAtom, null);
  }
}
