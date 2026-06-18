// engine-context — owns the ONE shared engine instance and the route↔mode wiring
// that the whole app hangs off of.
//
// Why a singleton, not one engine per page: the engine builds the entire WebGL
// world (terrain, photoreal tiles, ~50 GLBs) and that's far too heavy to tear
// down and rebuild on every navigation. So the canvas + engine live up here,
// persistent across route changes; each page just renders its own HUD chrome and
// asks the shared engine to be in its mode. React owns the HUD; the engine owns
// the canvas, input and game loop — exactly the split the codebase already had,
// now with the HUD cut along the /drive ÷ /scoop seam.
//
// Two-way mode sync, both idempotent so they can't loop:
//   route → engine: when the URL is /drive or /scoop, make the engine enter that
//                   mode (or exit back to idle on /). Runs once the engine is up.
//   engine → route: when the engine changes mode on its own (e.g. "Get in & drive"
//                   from Scoop, or an Exit button), mirror the URL to match.

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createEngineBus } from './engine-bus.js';
import { useRoute, navigate } from './router.js';

const EngineCtx = createContext(null);

/** Access the shared engine context: { engine, ready, booted, starting,
    engineError, photoreal, route, navigate, bus, canvasRef, uiRefs }. */
export function useEngine() {
  const ctx = useContext(EngineCtx);
  if (!ctx) throw new Error('useEngine must be used inside <EngineProvider>');
  return ctx;
}

/** Subscribe a component to ONE engine event for its lifetime. The handler is
    held in a ref so a fresh closure each render doesn't churn the subscription.
    This is how each page wires up only the events it cares about. */
export function useEngineEvent(type, handler) {
  const { bus } = useEngine();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => bus.on(type, (p) => ref.current(p)), [bus, type]);
}

const routeToMode = (route) => (route === 'drive' ? 'drive' : route === 'scoop' ? 'scoop' : 'explore');
const modeToRoute = (mode) => (mode === 'drive' ? 'drive' : mode === 'scoop' ? 'scoop' : 'menu');

export function EngineProvider({ children }) {
  const route = useRoute();
  const canvasRef = useRef(null);
  // The single shared registry of DOM nodes the engine writes to per frame (mph,
  // gear, minimap, joystick, …). Each page registers its own nodes on mount and
  // React nulls them on unmount; every engine access is null-guarded, so a node
  // that belongs to the other page (or to no page, on the menu) is simply skipped.
  const uiRefs = useRef({
    box: null, mph: null, gear: null, needle: null, joy: null, knob: null,
    minimap: null, speedBar: null, fx: null, runTime: null, rev: null,
    eta: null, brakeLbl: null, boostBar: null,
  });
  const busRef = useRef(null);
  if (!busRef.current) busRef.current = createEngineBus();
  const bus = busRef.current;
  const engineRef = useRef(null);

  const [engine, setEngine] = useState(null);
  const [ready, setReady] = useState(false);
  const [photoreal, setPhotoreal] = useState(false);
  const [booted, setBooted] = useState(false);
  const [engineError, setEngineError] = useState('');
  // Neighbourhood places found — cross-game progression (it both badges the menu
  // and gates car unlocks), so it lives here, persistent across navigations,
  // rather than in a page that unmounts.
  const [poi, setPoi] = useState({ found: 0, total: 5 });

  // True while the route→engine effect is driving enter/exit, so the engine→route
  // mirror below ignores the 'mode' emits those calls produce (otherwise a
  // route-driven exit would push a spurious history entry and re-enter the effect).
  const syncingRef = useRef(false);

  // Boot the engine exactly once. It's lazy-imported as its own chunk so the menu
  // (React + this shell) paints before Three.js + the engine download/parse.
  useEffect(() => {
    setBooted(true);
    // Shell-level events. Everything else fans out to the pages via the bus.
    bus.on('ready', () => setReady(true));
    bus.on('photoreal', () => setPhotoreal(true));
    bus.on('poiProgress', (p) => setPoi(p));
    // engine → route mirror: keeps the URL in step with engine-INITIATED mode
    // changes — "Get in & drive" (scoop→drive) and the Exit buttons (→ explore →
    // menu). Suppressed while the route effect is the one driving the engine, so
    // the two directions can't ping-pong. modeToRoute('explore') === 'menu'.
    bus.on('mode', (m) => { if (!syncingRef.current) navigate(modeToRoute(m)); });

    let cancelled = false;
    import('../engine/engine.js').then(({ createEngine }) => {
      if (cancelled) return;
      try {
        const api = createEngine({ canvas: canvasRef.current, ui: uiRefs.current, emit: bus.emit });
        engineRef.current = api;
        setEngine(api);
      } catch (e) {
        console.error('[engine] failed to start', e);
        setEngineError('Could not start WebGL. Try closing other tabs or using a newer browser.');
      }
    }).catch((e) => {
      if (cancelled) return;
      console.error('[engine] failed to load', e);
      setEngineError('Could not load the 3D engine. Check your connection and reload.');
    });
    return () => {
      cancelled = true;
      if (engineRef.current) engineRef.current.dispose();
      engineRef.current = null;
    };
  }, [bus]);

  // route → engine: keep the engine's mode matched to the URL. Idempotent — does
  // nothing if already in the right mode (so the engine→route mirror above can't
  // ping-pong it). Runs when the engine first becomes ready (handles a direct
  // load of /drive or /scoop) and on every later navigation.
  useEffect(() => {
    if (!engine) return;
    const want = routeToMode(route);
    if (engine.mode === want) return;
    syncingRef.current = true;
    try {
      // Leave whatever game we're in before entering the next, so a direct
      // /drive↔/scoop jump (Back/Forward, typed URL) doesn't leave the old
      // game's car/avatar/HUD bits lingering in the new one.
      if (engine.mode === 'drive') engine.exitDrive();
      else if (engine.mode === 'scoop') engine.exitScoop();
      if (want === 'drive') engine.enterDrive();
      else if (want === 'scoop') engine.enterScoop();
    } finally {
      syncingRef.current = false;
    }
  }, [engine, route]);

  // The menu paints immediately; a /drive or /scoop deep-link shows "Starting…"
  // until the engine lands and the mode-sync above enters the game.
  const starting = !ready && route !== 'menu';

  const value = {
    engine, ready, booted, starting, engineError, photoreal, poi,
    route, navigate, bus, canvasRef, uiRefs,
  };
  return <EngineCtx.Provider value={value}>{children}</EngineCtx.Provider>;
}
