# Plan: Break up the monolithic engine into small, targeted modules

**Created:** 2026-06-17 14:57
**Status:** implemented (engine.js 4569 -> 1560 lines; 18 modules; verified)
**Experts consulted:** architect, three.js/WebGL expert, sr-staff-engineer (×2: design + review), 8 region analyzers

## Requirements

Break up the monolithic engine (`src/engine/engine.js`, 4569 lines — one `createEngine()`
closure) into many small, targeted files. Architecture should be beautiful, elegant,
extensible, concise, readable. Separate the **driving** and **scoop** games, and within
that, cleanly separate **map management**, **occlusion**, **controls**, and
**follow-the-car**. Refactor shared utilities as needed. Update docs. Implement with a
dynamic workflow; verify with code reviews + functional browser testing.

### Steering constraints (from the user, mid-session)
- **Full auto** — implement fully, no approval gates (dahill auto-ship).
- **Map management, occlusion, controls, follow-the-car** each cleanly separable.
- **State management**: engine hot-loop state stays **plain JS** (a shared `ctx` object),
  NOT React/jotai — per-frame React re-renders would tank perf. React context only for
  the UI layer if needed. **Never Redux.** Prefer built-in React context. Stay on Vite —
  **no Next.js** (flag if that ever changes; it does not for this work).

## Architecture

`createEngine({canvas, ui, emit})` is one ~4500-line closure: ~213 top-level declarations,
~150 nested functions, ~80 scalar `let`s reassigned across far-flung regions, all driven by
one RAF `loop()`. The big aggregates (`car`, `CHAR`, `ctl`, `camOrbit`, `inp2`, `FX`,
`world`, `audio`) are already objects (mutate fine across modules); the coupling is the
scalar `let`s (`mode`, `czoom`, `szoom`, `camMode`, `boost`, `DEST`, `ROUTE`, `autoDrive`,
`followMode`, `nearCar`, `scoopScene`, `interior`, …).

**Behavior-preservation contract** (App.jsx talks to the engine ONLY through this surface,
so keeping it byte-identical means App.jsx needs zero changes):
`createEngine` signature · the returned `api` object (every method) · `emit` event names ·
the `ui` refs touched · `window.__dahill`. Build stays green; vitest stays green; the game
behaves identically in-browser.

### The `ctx` object — FLAT, plain JS, one owner
`createCtx({canvas, ui, emit})` returns one plain mutable object, never reassigned, no
proxy/getters/event-bus. Modules take `ctx` as first arg and read/write `ctx.foo` **live at
use-site**. This formalizes the pattern `car` already establishes. **Flat, not nested**
(grouped by comment banners) so Phase 0 is a mechanical find-replace and each step stays
green. `ctx.car` stays the existing flat bag. A minimal `ctx.fn` registry (4 entries:
`setMode`, `clearRouteRail`, `nearestRoadPoint/Seg`, `viewHeading`) covers the only genuine
two-way cycles; everything else is plain imports. `camera/presets.js` (DRIVE_CAMS/SCOOP_CAMS)
is a leaf that breaks the controls↔drive-cam cycle.

### Target tree (~28 files)
```
src/engine/
  engine.js            assembly root only (~150 lines): build ctx, call factories in DAG
                       order, wire ctx.fn + listeners, build api + __dahill, return api
  ctx.js               createCtx() — the flat ctx bag + caps/device flags + prefs
  core/   renderer.js scene.js mode.js loop.js lifecycle.js viewport.js api.js debug-handle.js
  nav/    geo.js road-graph.js route.js destination.js places.js teleport.js osm-roads.js
          minimap.js markers.js
  drive/  drive.js update-drive.js physics.js collision.js car-pose.js cameras.js
          autodrive.js cars.js score-fx.js poi.js traffic.js clean-patch.js
  scoop/  scoop.js interior-cam.js
  house/  house.js npc.js
  crowd/  crowd.js
  camera/ presets.js explore-cam.js
  controls/ index.js pointer.js keyboard.js input.js
  occlusion/ ground-height.js tiles.js tile-clip.js prefetch.js see-through.js cam.js
  follow/ follow.js
```
(Existing leaf modules — data, geom, coords, car, world, crowd, interior, tiles3d, animals,
audio, terrain, models, dad/mom/cece/drew — stay.)

## Implementation Steps (risk-ordered; each shippable: build + vitest + browser smoke)

- **Step 0 — Phase 0: promote ~80 cross-region scalars to `ctx` IN PLACE** (no file moves),
  one namespace per sub-commit: (0a) core singletons; (0b) lifecycle kill-switches
  `disposed/paused/ctxLost/raf/prev`; (0c) `mode` alone; (0d) nav spine
  `DEST/ROUTE/routeIdx/autoDrive/osmRoadSegs` (grep stale destructures after); (0e) camera
  scalars; (0f) `inp2→ctx.input`; (0g) drive score/feel scalars; (0h) follow/scoop/house/
  tiles/crowd state + prefs. **HIGHEST risk; the hard gate before any move.**
- **Step 1 — pure leaves**: `nav/geo.js`, `camera/presets.js`, `nav/road-graph.js`.
- **Step 2 — `occlusion/ground-height.js`** (highest fanout, 8+ callers).
- **Step 3 — core construction**: `core/renderer.js` (carry `localClippingEnabled=true`),
  `core/scene.js` (PMREM one-shot), `core/mode.js` (wire `ctx.fn.setMode`).
- **Step 4 — self-contained drive visuals**: `score-fx.js`, `poi.js`, `traffic.js`,
  `clean-patch.js`.
- **Step 5 — nav/**: `route.js`, `destination.js`, `places.js`, `teleport.js`,
  `osm-roads.js`, `minimap.js`, `markers.js` (grep `_jumpSnap` writers; preserve api names).
- **Step 6 — house/ + crowd/**: house must call a camera re-seat hook, not poke camera scalars.
- **Step 7 — scoop/**: `scoop.js`, `interior-cam.js`, `occlusion/see-through.js`.
- **Step 8 — occlusion tiles/clip/prefetch/cam + camera/explore + controls + follow**:
  `controls/index.js` owns `attach()/detach()` pair; tile-clip after camera placement.
- **Step 9 — `updateDrive` (RISKIEST, last, 2-step)**: carve into in-order sub-functions
  WITHIN engine.js, verify, THEN move to `physics/collision/car-pose/cameras/autodrive/
  score-fx` + `follow`. Preserve physics→collision→position-override order; follow-glide/rail
  if/else is the only safe seam.
- **Step 10 — reduce engine.js to assembly root** + `core/loop.js` (exact frame order),
  `core/lifecycle.js` (single dispose owner, exact teardown order), `core/viewport.js`,
  `core/api.js`, `core/debug-handle.js`. Verify `madge --circular`, App.jsx unchanged.

## Verification Checklist
- [ ] `npm run build` green after every step
- [ ] `npx vitest run` (31 tests) green after every step
- [ ] Browser smoke after every step via `:5173` + `__dahill.state()/scoop()/crowd()/traffic()`
- [ ] All 3 mode transitions explore↔drive↔scoop
- [ ] Drive feel unchanged; auto-drive rail; follow-glide; tile cutaway not one-frame-lagged
- [ ] Scoop: scoop/clean, tools, interior cam, see-through, scoop→drive handoff
- [ ] House enter/leave, NPC FSM, crowd density, interior dancers
- [ ] No WebGL context leak on mount/unmount; `madge --circular src/engine` clean
- [ ] App.jsx unchanged; `api`/`emit`/`__dahill` contracts byte-identical
- [ ] Docs updated (architecture, drive-mode, scoop-mode, HANDOFF)

## Key Risks (mitigations in steps)
1. Silent `let`→`ctx` miss (no type checker) → Phase 0 per-namespace + grep + smoke.
2. Stale captured ref to reassigned array (`ctx.ROUTE`/`ctx.osmRoadSegs`) → never destructure
   mutable scalars; read at use-site.
3. `updateDrive` carve-up changes feel → 2-step, preserve order, don't share scratch.
4. WebGL context leak on dispose → ONE scene.traverse owner; external holders first; renderer
   last; `controls` owns attach/detach pair.
5. Lost `localClippingEnabled` → moves with renderer.
6. Frame order: `camera.updateMatrixWorld()` before `p3dtiles.update()`; `updateTileClip` after
   camera placement; single `renderer.render()` last.
7. `_jumpSnap` 3 writers; `setMode`/tiles-callback cross-call; React contract byte-identical.
