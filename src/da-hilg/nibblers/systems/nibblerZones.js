// updateNibblerZones(ctx) — the marked / discovered / scatter edge system.
//
// Runs in the nibblers branch AFTER flushZones, so the active player's
// actor.zonesActive Set is already reconciled this frame. We read it (NOT the raw
// sensor queue), look each id up in zoneRegistry.byId for its def (type/label/
// discover), and edge-detect against a tiny module snapshot so every store.set
// fires only on a transition — same change-gated discipline as commitReactive.
//
// SAFE WINS over danger:
//   • If the player is in any 'safe' zone:
//       - if the swarm is marked → clearAndScatter(now) + markedAtom=false +
//         toast 'Safe — <label>' / 'safe'
//       - if a 'safe' def has discover:true and its id is not yet in
//         discoveredSafeZonesAtom → append it (permanent reveal) + toast
//         'Safe Zone discovered' / 'safe'
//       - set currentSafeZoneAtom = label
//   • Else if a 'danger' zone is present AND the swarm is not marked →
//       armMarked(now) + markedAtom=true + toast 'MARKED — find a Safe Zone' /
//       'danger'; set currentSafeZoneAtom = null. Marked persists outside danger
//       (only a safe zone clears it).

import { byId } from '../../zones/zoneRegistry.js';
import { pushToast, emit } from '../../hud/hudEvents.js';
import {
  markedAtom,
  discoveredSafeZonesAtom,
  currentSafeZoneAtom,
} from '../state/nibblerAtoms.js';
import { swarm } from '../swarm/swarmState.js';
import { armMarked, clearAndScatter, setScatterCenter } from './markedSystem.js';

/** Last currentSafeZone label we wrote, so we only set the atom on change. */
let lastSafeLabel = null;

/**
 * Read the active player's reconciled zone set and drive marked/discovered/scatter
 * on the edges. All store writes are edge-only.
 * @param {object} ctx per-frame ctx { store, registry, activePlayerId, now }
 */
export function updateNibblerZones(ctx) {
  const player = ctx.registry.get(ctx.activePlayerId);
  if (!player) return;

  // Scan the player's current zones (already reconciled by flushZones).
  let safeLabel = null; // label of any safe zone we're in
  let inSafe = false;
  let inDanger = false;
  let discoverableSafeId = null; // a discover:true safe zone we're standing in

  player.zonesActive.forEach((zid) => {
    const def = byId.get(zid);
    if (!def) return;
    if (def.type === 'safe') {
      inSafe = true;
      if (def.label != null) safeLabel = def.label;
      if (def.discover && discoverableSafeId == null) discoverableSafeId = def.id;
    } else if (def.type === 'danger') {
      inDanger = true;
    }
  });

  // ── SAFE WINS ────────────────────────────────────────────────────────────
  if (inSafe) {
    // Marked → safe: clear the mark and scatter the whole horde OFF the player
    // (seed the scatter center to the player's feet — otherwise it radiates from
    // world origin). flushZones already toasts 'Safe — <label>', so we fire the
    // distinct relief beat instead of duplicating it.
    if (swarm.marked) {
      setScatterCenter(player.motion.pos);
      clearAndScatter(ctx.now);
      ctx.store.set(markedAtom, false);
      emit('safeReached', { label: safeLabel || null });
      pushToast('Nibblers scattered!', 'zone');
    }

    // First-time discovery of this safe zone → append to the permanent set.
    if (discoverableSafeId) {
      const discovered = ctx.store.get(discoveredSafeZonesAtom);
      if (!discovered.includes(discoverableSafeId)) {
        ctx.store.set(discoveredSafeZonesAtom, [...discovered, discoverableSafeId]);
        pushToast('Safe Zone discovered', 'safe');
      }
    }

    // Current safe-zone label (edge-gated).
    if (lastSafeLabel !== safeLabel) {
      lastSafeLabel = safeLabel;
      ctx.store.set(currentSafeZoneAtom, safeLabel);
    }
    return; // safe overrides danger
  }

  // ── DANGER (only when not already marked) ────────────────────────────────
  if (inDanger && !swarm.marked) {
    armMarked(ctx.now);
    ctx.store.set(markedAtom, true);
    pushToast('MARKED — find a Safe Zone', 'danger');
  }

  // Left every safe zone — clear the current-safe-zone label (edge-gated).
  if (lastSafeLabel !== null) {
    lastSafeLabel = null;
    ctx.store.set(currentSafeZoneAtom, null);
  }
}
