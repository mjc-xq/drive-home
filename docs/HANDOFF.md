# Agent handoff — gotchas that cost real debugging time

Read README.md first for architecture. This file is the lessons.

## Coordinate frames

- **orig**: meters east/north of geocode (37.6835313, −122.0686199).
- **world**: `x = east`, `z = −north` (so **+z is SOUTH**), `y` up.
  `W(p) = [p[0]−C[0], −(p[1]−C[1])]`, `C = scene.center` ≈ house centroid
  (20.91, 35.17). The house sits near world origin.
- To re-place anything from an annotated satellite screenshot: read pixel
  coords of 3 known building centroids + the target, solve the affine,
  transform (±3 m). Sanctuary constants live in `data.js` (`SREC`).

## Collision model (the shed lesson)

`bldBoxes` are **axis-aligned** bboxes (+0.4 m) of each footprint. The house
is rotated ~35°, so its AABB covers a lot of yard the walls don't. Anything
the keeper must reach (animals, poop, spawn points) must sit **outside the
house AABB** — orig x∈[8.3,33.4], n∈[26.2,45.6] — or it's unreachable. The
iguana shed hugs the house's south corner *just* outside it.

## Screen-space conventions (the strafe lesson)

Game cameras sit at `subject − f·dist` looking along `f = (sin yaw, cos yaw)`.
Screen-right is therefore `(−cos yaw, +sin yaw)` — NOT `(+cos, −sin)`. The
scoop strafe shipped mirrored once. Drive steering: increasing `car.yaw`
turns screen-LEFT; Left key ⇒ `kx=−1` ⇒ `steerTarget=+` is correct.

## Draco / the "tab crash" (root cause, finally)

Two prior theories were wrong (main-thread blockage; asm.js strict-mode
validation). The real bug: **the Emscripten module object is thenable** —
`onModuleLoaded: m => resolve(m)` makes the promise machinery chase
`m.then(cb)→cb(m)` forever: infinite `PromiseResolveThenableJob` + GC,
100% CPU, tab dies. Fix: `resolve({ draco: m })` (official DRACOLoader does
the same). Diagnosed via macOS `sample` on the spinning Node process —
when something hangs, **sample the stack; don't guess**.

Still true: keep the vendored decoder byte-pristine (no ESM wrap — strict
mode breaks its Node branch; no minification), inject as a classic script,
no Workers/WASM/eval in the artifact webview.

## Verification discipline (user directive)

Node-first (`scripts/verify_car_node.mjs`, vitest). At most ONE time-boxed
browser check; never launch-Chrome-and-poll loops. Dev servers: check for a
running one first (`lsof -nP -iTCP:5173 -sTCP:LISTEN`), max one per session.

## Street View pipeline

`scripts/fetch_streetview.py` mirrors engine.js's ring selection (6 longest
named residential/tertiary roads, midpoint, heading along the street) →
`src/assets/streetview/sv_*.jpg` + `manifest.json` keyed by **street name**.
The engine joins on that name when building rings; missing entries are
silently skipped, so the feature is inert until images exist. Photos are
baked at build time — the artifact webview is offline at runtime. The API
key must have "Street View Static API" enabled (status was REQUEST_DENIED
on the provided key as of 2026-06-12).

## r128 quirks

No BufferGeometryUtils (custom non-indexed `merge()`); roads/roofs need
`DoubleSide`; sprites balloon near the ground (hidden in game modes);
InstancedMesh per-instance color unreliable (hence two poop pools);
`toNonIndexed` warning ×516 at startup is benign.

## Tests

24 vitest tests. Never change a test for convenience — justify every change
(user rule). Implementation code is largely verbatim proven artifact code;
tolerance changes (`toBeCloseTo`) were the only justified edits so far.

## Open items

- Street View images: waiting on API enablement, then one script run.
- Roadmap #4: optional sharper Esri z19 satellite patch (~300 KB) for
  top-down mode.
- Duck/iguana models could get the pig-quality treatment (roadmap #6 tail).
