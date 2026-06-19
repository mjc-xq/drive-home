// The zone registry — a plain mutable module (NOT React, NOT Jotai). NPC AI and
// the player path query it many times per frame ("is the player safe? can my
// group chase?"), so every read here must be allocation-light and never trigger
// a render. Sensor callbacks enqueue raw enter/exit events; zoneSystem.flushZones
// drains the queue once per frame and reconciles actorZones against it.
//
// Two maps form the hot path:
//   actorZones: actorId -> Set<zoneId>   (which zones each actor currently overlaps)
//   byId:       zoneId  -> def           (O(1) type/npcGroup/label lookup)

import { daHilgStore } from '../state/store.js';
import { activePlayerIdAtom } from '../state/atoms.js';

/** @typedef {{id:string, type:string, npcGroup?:string, event?:string, label?:string, discover?:boolean, reveal?:boolean, marker?:boolean, active?:boolean}} ZoneDef */

/** actorId -> Set<zoneId> currently occupied. Mutated by flushZones, read everywhere. */
export const actorZones = new Map();

/** zoneId -> def, for O(1) hot-path lookups (type, npcGroup, label). */
export const byId = new Map();

// Raw sensor events, pushed by <Zone> collider callbacks, drained once per frame
// by zoneSystem.flushZones. Kept as a flat array of small records to stay cheap.
/** @type {{kind:'enter'|'exit', zoneId:string, actorId:string}[]} */
const queue = [];

/** Get (or lazily create) the zone Set for an actor. */
function ensureSet(actorId) {
  let s = actorZones.get(actorId);
  if (!s) {
    s = new Set();
    actorZones.set(actorId, s);
  }
  return s;
}

/**
 * Push a sensor event onto the queue. Called from Zone's onIntersectionEnter/Exit.
 * @param {'enter'|'exit'} kind
 * @param {string} zoneId
 * @param {string} actorId
 */
export function enqueueZoneEvent(kind, zoneId, actorId) {
  queue.push({ kind, zoneId, actorId });
}

/**
 * Return all queued events and clear the queue. The drained array is the live
 * buffer (re-used by emptying it), so consume it within the same frame.
 * @returns {{kind:'enter'|'exit', zoneId:string, actorId:string}[]}
 */
export function drainQueue() {
  if (queue.length === 0) return EMPTY_EVENTS;
  const out = queue.slice();
  queue.length = 0;
  return out;
}
const EMPTY_EVENTS = [];

/**
 * Register a zone definition for hot-path lookup. Called by <Zone> on mount.
 * @param {ZoneDef} def
 */
export function registerZone(def) {
  byId.set(def.id, def);
}

/**
 * Unregister a zone and scrub it from every actor's membership set. Called by
 * <Zone> on unmount so a removed zone never lingers in actorZones.
 * @param {string} id
 */
export function unregisterZone(id) {
  byId.delete(id);
  for (const set of actorZones.values()) set.delete(id);
}

/** The active player id, read imperatively (never as a hook on the hot path). */
function activePlayerId() {
  return daHilgStore.get(activePlayerIdAtom);
}

/**
 * Is the given actor currently inside any zone of `type`?
 * @param {string} actorId
 * @param {string} type
 * @returns {boolean}
 */
export function actorInZoneType(actorId, type) {
  const set = actorZones.get(actorId);
  if (!set || set.size === 0) return false;
  for (const id of set) {
    if (byId.get(id)?.type === type) return true;
  }
  return false;
}

/**
 * Is the active player standing in any 'safe' zone? NPC AI checks this first
 * each tick — a safe player short-circuits chase/touch straight to retreat.
 * @returns {boolean}
 */
export function playerIsSafe() {
  const pid = activePlayerId();
  return pid ? actorInZoneType(pid, 'safe') : false;
}

/**
 * The set of npcGroups whose 'notice' zones the active player currently occupies.
 * An NPC may only chase a player it can "notice" — its group must be in this set.
 * Returns a fresh Set (small, called ~once per NPC tick, not per inner loop).
 * @returns {Set<string>}
 */
export function playerNoticeGroups() {
  const out = new Set();
  const pid = activePlayerId();
  if (!pid) return out;
  const set = actorZones.get(pid);
  if (!set) return out;
  for (const id of set) {
    const z = byId.get(id);
    if (z?.type === 'notice') out.add(z.npcGroup ?? '*');
  }
  return out;
}
