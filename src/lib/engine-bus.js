// engine-bus — a tiny synchronous pub/sub the engine emits into and the route
// pages subscribe to. The engine is created ONCE (see engine-context) and speaks
// to React only through `emit(type, payload)`; this bus fans each emit out to
// whichever page registered for it. That's what lets Drive, Scoop and the menu
// each own ONLY the events they care about, so the two mini-games can grow
// independently without a shared God-component holding both their states.

export function createEngineBus() {
  const listeners = new Map();   // type -> Set<fn>
  return {
    /** Subscribe `fn` to `type`. Returns an unsubscribe function. */
    on(type, fn) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
      return () => { set.delete(fn); };
    },
    /** Emit `payload` to every current listener of `type` (snapshot so a
        handler that unsubscribes mid-dispatch doesn't skip a sibling). */
    emit(type, payload) {
      const set = listeners.get(type);
      if (set) for (const fn of [...set]) fn(payload);
    },
  };
}
