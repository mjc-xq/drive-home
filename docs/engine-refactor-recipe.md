# Engine decomposition — extraction recipe (in progress)

The 4569-line `src/engine/engine.js` god-closure is being split into small modules under
`src/engine/{core,nav,drive,scoop,house,crowd,camera,controls,occlusion,follow}/`.
Plan: `plans/plan-engine-decomposition-20260617-1457.md`.

## Foundation (DONE)
`createEngine({canvas,ui,emit})` builds one flat **`ctx`** object holding 100% of cross-region
engine state + the React bridge (`ctx.emit/ui/canvas`). The RAF loop mutates `ctx` ~60–120×/s,
so it stays plain JS — NOT React/jotai. `ctx.car`/`ctx.CHAR`/`ctx.inp2` are the existing
aggregate bags. Every function can read/write `ctx.*` and is therefore freely movable.

## The codemod: `scripts/promote-ctx.mjs` (scope/comment-aware, formatting-preserving)
- `node scripts/promote-ctx.mjs --scan` — list closure top-level decls + shadow conflicts.
- `node scripts/promote-ctx.mjs --write --ns NS --refs-only a,b,c` — rewrite every in-scope
  reference of a,b,c to `ctx.NS.a` (call-site rewrite; leaves function-definition ids alone).
  ALWAYS put names as the `--refs-only` value and `--ns` separately, e.g.
  `--write --ns ground --refs-only rawTileY,groundAt,actorGroundY`.

## Per-module extraction recipe (proven on ground-height, tile-clip, geo, presets)
1. **Write** `src/engine/<folder>/<mod>.js`: `export function createX(ctx) { ...private helpers + public fns...; return { pub1, pub2 } }`. Function bodies already use `ctx.*` for state. Import leaf deps (`three`, `../coords.js`, `../data.js`, sibling modules). Keep each module's reused raycaster/scratch PRIVATE (never share across modules — aliases per-frame casts).
2. **Rewrite external call sites**: `node scripts/promote-ctx.mjs --write --ns <ns> --refs-only <publicFnNames>`. (Intra-module calls are bare closures inside the factory and must STAY bare — so after the codemod runs, the module file you wrote keeps bare intra-calls; the codemod only touches engine.js.)
3. **Delete** the original definitions from engine.js; **replace** with `ctx.<ns> = createX(ctx);` (or `ctx.occ = { ...ctx.occ, ...createX(ctx) }` to fold into an existing namespace). Place the wiring where the code was (it runs during construction, before the loop, so it's defined before any runtime call).
4. **Import** `createX` at the top of engine.js.
5. **Verify**: parse both files (`node --input-type=module -e "import {parseAst} from 'vite';import {readFileSync} from 'node:fs';parseAst(readFileSync(F,'utf8'),{ecmaVersion:'latest',sourceType:'module'})"`), `npx vitest run` (31 tests), `npm run build`. Browser-smoke at cluster boundaries on the EXISTING dev server `http://localhost:5173/?lite` via chrome-devtools MCP: `window.__dahill.state()/scoop()/crowd()/traffic()` + exercise the relevant mode + check `list_console_messages` for errors.
6. **Commit** each green module: `refactor(engine): extract <path> (...)`.

## Back-edges (calls OUT of a module into not-yet-extracted code)
Route through `ctx.fn` — a registry of still-in-engine functions that extracted modules call.
In engine.js, after those functions are defined, set e.g. `ctx.fn = ctx.fn || {}; ctx.fn.clearRouteRail = clearRouteRail; ...` (write this assignment BY HAND — do NOT run the codemod over the registry object or shorthand will self-reference). Inside the moved module, call `ctx.fn.clearRouteRail()`. When that function is later extracted to its own module, move the `ctx.fn.x = ...` assignment into that module's factory (the KEY stays stable, so all callers keep working). Leaves already extracted are called directly: `ctx.geo.*`, `ctx.ground.*`, `ctx.occ.*`; presets via `import { DRIVE_CAMS, SCOOP_CAMS }`.

## Hard invariants (must survive the split)
- `renderer.localClippingEnabled = true` stays with the renderer (or the drive cutaway dies).
- ONE owner of the `scene.traverse` dispose (core/lifecycle); external holders
  (controls.detach, stopFollow, disposeMiniMap, setScout(false), p3dtiles.disposeAll) run
  BEFORE the traverse BEFORE `scene.environment.dispose()` BEFORE `renderer.dispose()`.
- Loop order: dt/timeScale → animals+crowd (every mode) → mode dispatch → ring/shadow throttle
  → updateTilePrefetch → `camera.updateMatrixWorld()` then `p3dtiles.update()` (~55ms) → minimap
  → single `renderer.render()` LAST. `updateTileClip` runs AFTER the drive camera is placed.
- Never destructure a mutable `ctx` scalar at module top (`const {ROUTE}=ctx` freezes a stale
  ref); read `ctx.ROUTE` live at the use site. Stable singletons (`ctx.scene/renderer/car`) are fine.
- The React contract is byte-identical: `createEngine` signature, the returned `api` methods,
  `emit` event names, `ui` refs, and `window.__dahill`. App.jsx must not need changes.
- `updateDrive` (HIGHEST risk): extract by first carving its in-order blocks into sub-functions
  WITHIN engine.js, verify, THEN move. Preserve physics→collision→position-override order; the
  follow-glide/rail if/else is the only safe split seam.

## Dependency order (callees first, hub last)
leaves (geo✓, presets✓, ground-height✓, tile-clip✓, road-graph, route-math, label-tex, fx-particles)
→ occlusion (prefetch, tiles, cam, see-through) → drive self-contained (score, poi, traffic,
clean-patch) → nav (route, destination, places, teleport, osm-roads, minimap, markers) →
follow → house+crowd → scoop → controls + explore-cam → drive cameras → **updateDrive** →
core (mode, loop, lifecycle, viewport, api, debug-handle) + slim engine.js to the assembly root.
