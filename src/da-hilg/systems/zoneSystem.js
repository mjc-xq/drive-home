// Zone system — step 5 of the sim loop. Sensor callbacks on <Zone> only ENQUEUE
// raw enter/exit events (collision callbacks fire at arbitrary times); this drains
// the queue once per frame, deterministically, and reconciles membership.
//
// Two membership stores are kept in lockstep:
//   • actor.zonesActive (on the Actor object) — read by commitReactive for the HUD
//   • zoneRegistry.actorZones (the Map)        — read by npcAi via playerIsSafe()/
//                                                 playerNoticeGroups() on the hot path
// Keeping both avoids a per-frame join and lets each consumer read whichever it holds.
//
// Trigger zones additionally fire a named event (zoneEvents) + a HUD toast the
// first time the ACTIVE player enters — that's the "entered the driveway / reached
// the creek" beat. Future quests/music/cutscenes subscribe to zoneEvents without
// ever touching collision code.

import { drainQueue, byId, actorZones } from '../zones/zoneRegistry.js';
import { emit as emitZoneEvent } from '../zones/zoneEvents.js';
import { pushToast } from '../hud/hudEvents.js';

/** Get (or lazily create) the registry membership Set for an actor. */
function regSet(actorId) {
  let s = actorZones.get(actorId);
  if (!s) {
    s = new Set();
    actorZones.set(actorId, s);
  }
  return s;
}

/**
 * Drain queued sensor events and reconcile zone membership. Fires trigger-zone
 * events + toasts for the active player. Called once per frame (step 5).
 * @param {any} ctx
 */
export function flushZones(ctx) {
  const events = drainQueue();
  if (events.length === 0) return;

  for (let i = 0; i < events.length; i++) {
    const { kind, zoneId, actorId } = events[i];
    const actor = ctx.registry.get(actorId);
    const def = byId.get(zoneId);
    const set = regSet(actorId);

    if (kind === 'enter') {
      const wasIn = set.has(zoneId);
      set.add(zoneId);
      if (actor) actor.zonesActive.add(zoneId);

      // First-entry beats, active player only, fired once per actual entry.
      if (!wasIn && def && actorId === ctx.activePlayerId) {
        if (def.type === 'trigger') {
          if (def.event) emitZoneEvent(def.event, { zoneId, actorId });
          if (def.label) pushToast(def.label, 'zone');
        } else if (def.type === 'safe' && def.label) {
          pushToast('Safe — ' + def.label, 'zone');
        }
      }
    } else {
      set.delete(zoneId);
      if (actor) actor.zonesActive.delete(zoneId);
    }
  }
}
