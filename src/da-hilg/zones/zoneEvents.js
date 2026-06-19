// A tiny synchronous event emitter for trigger-zone beats (e.g. 'entered_driveway',
// 'reached_creek'). zoneSystem.flushZones emits the named event when the active
// player enters a trigger zone; game logic (toasts, music swaps, objective beats)
// subscribes here without ever touching collision code.
//
// Deliberately minimal: a Map<event, Set<fn>>, no wildcards, no async. Listeners
// fire in insertion order; an exception in one listener is logged and swallowed
// so a bad subscriber can't break the frame.

/** @type {Map<string, Set<(payload:any)=>void>>} */
const listeners = new Map();

/**
 * Subscribe `fn` to `event`. Returns nothing; pair with off() to unsubscribe.
 * @param {string} event
 * @param {(payload:any)=>void} fn
 */
export function on(event, fn) {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(fn);
}

/**
 * Unsubscribe `fn` from `event`. Safe to call if it was never subscribed.
 * @param {string} event
 * @param {(payload:any)=>void} fn
 */
export function off(event, fn) {
  const set = listeners.get(event);
  if (!set) return;
  set.delete(fn);
  if (set.size === 0) listeners.delete(event);
}

/**
 * Emit `event` with `payload` to every current subscriber.
 * @param {string} event
 * @param {any} [payload]
 */
export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set || set.size === 0) return;
  // Snapshot so a listener may safely off() itself during dispatch.
  for (const fn of Array.from(set)) {
    try {
      fn(payload);
    } catch (err) {
      // A misbehaving listener must never break the simulation frame.
      console.error(`[zoneEvents] listener for "${event}" threw:`, err);
    }
  }
}
