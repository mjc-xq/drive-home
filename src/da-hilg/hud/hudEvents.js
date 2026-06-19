// Transient HUD pulse emitter — NOT Jotai.
//
// Some HUD feedback is sub-200ms and fires constantly during play (greet
// hit-markers, toasts). Routing those through atoms would write the shared store
// on every pulse and thrash React across the whole tree. Instead they ride this
// tiny synchronous emitter: components subscribe with on()/off() in an effect and
// systems fire with emit() / the pushToast() convenience.
//
// Events:
//   'greetHit'                 — crosshair punch (no payload)
//   'toast' { text, kind, id } — a toast row (ToastFeed subscribes), kind is one
//                                of 'greet'|'zone'|'system'|'celebrate'
//   'tagged'                   — NPC tagged the player (screen flash / crosshair flicker)

/** @typedef {'greet'|'zone'|'system'|'celebrate'} ToastKind */

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

/**
 * Subscribe to a HUD event. Returns an unsubscribe fn for convenience.
 * @param {string} event
 * @param {Function} fn
 * @returns {() => void}
 */
export function on(event, fn) {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(fn);
  return () => off(event, fn);
}

/**
 * Unsubscribe a previously-registered listener.
 * @param {string} event
 * @param {Function} fn
 */
export function off(event, fn) {
  listeners.get(event)?.delete(fn);
}

/**
 * Fire an event synchronously to all current listeners.
 * @param {string} event
 * @param {*} [payload]
 */
export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  // copy so a listener that unsubscribes mid-dispatch doesn't break iteration
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (err) {
      // a misbehaving listener must never break the game loop
      console.error('[hudEvents] listener for "%s" threw', event, err);
    }
  }
}

let toastId = 0;

/**
 * Convenience: push a toast row into the feed.
 * @param {string} text
 * @param {ToastKind} [kind='system']
 */
export function pushToast(text, kind = 'system') {
  emit('toast', { id: ++toastId, text, kind });
}
