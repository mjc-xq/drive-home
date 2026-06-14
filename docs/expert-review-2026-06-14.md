# 1840 Dahill Lane — Expert Code Review

**Date:** 2026-06-14
**Repo / package:** `/Users/mcohen/dev/home` (`dahill-3d`)
**Reviewed at:** `HEAD = 9af0334` ("fix(scoop): clear trees from the play area regardless of entry mode")
**Stack:** Three.js r0.184 + React 18 + Vite, `3d-tiles-renderer ^0.4.28`, Google Photorealistic 3D Tiles. Primary target: iOS Safari on phones.
**Method:** Static code review (no browser profiling). Build is clean; 24 vitest tests pass.

---

## Methodology

This is a multi-agent expert review. Independent reviewers each took a domain
(correctness, iOS robustness, game feel, controls/camera, rendering performance,
Google 3D Tiles API/ToS), grounded in that domain's best practices, and produced
candidate findings. Every finding was then put through **adversarial verification**:
two independent skeptics re-checked each claim against the actual source, and a
consensus score (reals/total verifiers + mean confidence) was recorded.

A senior-staff consolidation pass (this document) then **re-verified the survivors
against the real code at HEAD**, deduped overlapping findings across dimensions,
re-scored severity, and — importantly — **discarded findings that described code not
present at HEAD** (see the box below). Line numbers in this report are the *actual*
HEAD line numbers, which differ from the raw finding set.

> ### IMPORTANT — two headline P0/P1 findings were verified against STALE code
>
> The incoming finding set's most-cited issue — *"Scoop flatten disc R = SCOOP_CLEAR_R+14 = 39 m
> pancakes the real house at world origin"* and the premise that *`flattenScoopArea()` /
> `alignP3DT()` now run on tile load in ANY mode* — **does not match the code at HEAD.**
>
> At HEAD (`9af0334`):
> - `photoModes = mode => mode === 'explore' || mode === 'drive'` (engine.js:285) — **Scoop is
>   explicitly excluded**, so photoreal tiles are never shown in Scoop.
> - There is **no `flattenScoopArea` function and no `flatShape`** anywhere in the source.
> - `SCOOP_CLEAR_R = 25` (engine.js:111); the only disc near that radius is the *procedural grass*
>   disc at `R = SCOOP_CLEAR_R + 4 = 29` (engine.js:119), which draws a textured ground plane —
>   it does **not** flatten any tile geometry.
> - The code comment at engine.js:282-284 explicitly states Scoop renders the procedural world and
>   that this means **"no tile-flattening hacks (which used to pancake the house)."**
>
> In other words, the house-pancake regression the user reported was real in an *earlier* approach,
> and the current commit's design — render the clean procedural world in Scoop and never stream
> tiles there — **structurally prevents it.** The reviewers who flagged R=39 were looking at a stale
> or speculative snapshot. Those two findings are **dropped** (marked Resolved below). Confirm by
> entering Scoop and checking the house is intact; if it is not, the cause is elsewhere (the grass
> disc or procedural house geometry), not a tile flatten.

---

## Summary

The app is well-structured and the recent Scoop redesign is sound: by rendering the clean
procedural world in Scoop and never streaming Google tiles there, the previous house-pancaking
regression is now structurally impossible — so the most alarming incoming P0 does not apply to the
current code. The real, present-at-HEAD problems cluster in three areas: (1) **two genuine
gameplay complaints the user raised** — Scoop movement is camera-relative so orbiting the look
control re-aims the walk direction, and Drive is hard-walled at a 314 m radius that also *bounces*
the car backward; (2) **Google 3D Tiles ToS compliance** — neither the required live data
attribution nor the Google logo is rendered in any photoreal mode; and (3) **iOS Safari
robustness** — there is no WebGL context-loss handling, no `visibilitychange` pause, and no
AudioContext re-resume, all of which bite the exact OOM-sensitive iPhone target the app prioritizes.
None of these block the build, but the ToS and iOS items are ship-blockers for a public deploy,
and the two control issues are the user's stated priorities.

---

## Top Risks (fix first)

1. **Google 3D Tiles ToS: missing live data attribution AND missing Google logo** in every
   photoreal mode (Explore/Drive). Public deploy risk: key suspension / terms enforcement.
2. **No WebGL context-loss / `visibilitychange` handling** on an iOS-primary, OOM-courting 3D app —
   backgrounding or memory pressure leaves a permanent black canvas and keeps streaming tiles while hidden.
3. **Scoop movement is camera-relative** (the user's exact complaint: "look-controls also rotate
   the movement direction"). Decouple left-stick move from right-side orbit.
4. **Drive is fenced at 314 m and bounces the car backward** (the user's exact complaint: "let me
   roam much further"). Expand the radius and make the boundary soft.

## Quick Wins (cheap, high value)

- Drop the `car.speed *= -0.2` bounce at the Drive boundary (engine.js:896) and raise `lim`
  toward ~1500 m+ — one-line fence change, directly answers "roam further."
- `errorTarget: MOBILE ? 16 : 10` (engine.js:299) — one-line mobile carve-out that cuts the
  dominant iOS memory consumer.
- `renderer.shadowMap.autoUpdate = false` + `needsUpdate = true` on a cadence (engine.js:41-56) —
  removes a full per-frame depth render on mobile.
- Add `e.preventDefault()` in a `webglcontextlost` listener — minimal code, prevents the
  permanent-black-canvas failure mode.
- Re-apply the DPR cap inside `resize()` (engine.js:980) — one line.
- Dead-zone rescale for the move stick (engine.js:661) — removes the speed lurch at the edge.

---

## Findings (consolidated, prioritized)

### P0

#### 1. Google 3D Tiles data attribution + Google logo are never displayed (ToS violation)
- **Dimension:** Google Photorealistic 3D Tiles API / ToS · **Consensus:** 2/2 (logo), 2/2 (attribution)
- **Files:** `src/engine/tiles3d.js` (no `getAttributions` wiring), `src/App.jsx:81-134` (HUD has no credits/logo element), `index.html`, `src/styles.css`
- **Evidence:** No `getAttributions`/`asset.copyright`/attribution aggregation anywhere in app code (the only `copyright` hits are static StreetView image credits in `src/assets/streetview/manifest.json`, unrelated to the live 3D tiles). The HUD renders title/compass/speedo/scoop chips but no always-visible credits line and no Google logo asset (none exists in `src/` or `public/`).
- **Impact:** Direct Google Maps / Tile API Policy violation whenever photoreal tiles render (Explore + Drive). Risks key suspension. The mobile-first chrome-hiding design makes it worse — even the start menu shows tiles with zero branding.
- **Fix:** On `tiles-load-end` (or each frame after `p3dtiles.update()`, engine.js:1020), call `tiles.getAttributions(target)`, aggregate by occurrence, dedupe, join on ` · `, and render into a new always-visible bottom-of-screen credits node in App.jsx shown whenever `p3dtiles.holder.visible`. Add the official Google logo (outlined variant for photographic backgrounds), 16-19dp with clear space, z-ordered above the joystick/HUD and inside the safe area. Do not hardcode a static string — it must reflect in-view tiles.

#### 2. No WebGL context-loss / restore handling — iOS drops to a permanent black canvas
- **Dimension:** iOS Safari robustness · **Consensus:** 2/2
- **File:** `src/engine/engine.js:38` (renderer created), `1026-1034` (listeners wired), `1049-1079` (dispose)
- **Evidence:** Zero matches for `webglcontextlost|webglcontextrestored|loseContext` across `src/` and `index.html`. Canvas only wires pointer/wheel/contextmenu/dblclick. The loop guards on `disposed` (line 994) but not on a lost context, and keeps calling `renderer.render` (1021).
- **Impact:** iOS 17/18+ fire `webglcontextlost` aggressively on backgrounding / memory pressure. Without `preventDefault()` the context never restores and three.js does not rebuild streamed tile geometry — the user is left on a frozen/black canvas with the loop still spinning. Hard defect for an iOS-primary app that deliberately courts memory pressure.
- **Fix:** Add a `webglcontextlost` listener that calls `e.preventDefault()` and pauses the loop, plus `webglcontextrestored`. Given the heavy streamed-tiles state, the pragmatic path is to reload the page on restore rather than rebuild GPU resources. Wire alongside the other canvas listeners (1026-1032) and remove in `dispose()` (1053-1061).

#### 3. No `visibilitychange` handler — RAF, tile streaming, and audio keep running while backgrounded
- **Dimension:** iOS Safari robustness · **Consensus:** 1/2 (down-weighted, but verified real and high-impact)
- **File:** `src/engine/engine.js:993-1023` (loop), `1026-1034` (wiring)
- **Evidence:** `loop()` unconditionally ends `raf = requestAnimationFrame(loop)` (1022) and calls `p3dtiles.update()` (1020) every frame. Zero matches for `visibilitychange|document.hidden|pagehide` in `src/`/`index.html`.
- **Impact:** A backgrounded iOS tab that keeps a WebGL loop alive AND keeps calling `.update()` continues fetching/allocating GPU tiles off-screen — growing resident memory exactly when the OS is most likely to jetsam WebContent (the "A problem repeatedly occurred" reload). Also drains battery and raises the odds the context is reclaimed (feeds finding #2).
- **Fix:** `document.addEventListener('visibilitychange', ...)`: when `document.hidden`, `cancelAnimationFrame(raf)` and set a paused flag so `p3dtiles.update()` is skipped; on return, re-seed `prev = performance.now()` and resume the loop. Remove in `dispose()`.

> **Note on consensus:** #3 was 1/2 in the raw set but I confirmed it directly against HEAD and rate
> it P0 — it is the most likely root cause of the app's documented iOS force-reload history and it
> compounds #2.

### P1

#### 4. Scoop movement is camera-relative — orbiting the look control rotates the walk direction (USER-REPORTED)
- **Dimension:** Controls / camera UX · **Consensus:** merged 2/2 + 1/2 (three overlapping findings consolidated)
- **File:** `src/engine/engine.js:664-668` (move basis from `camYawS`), `516` (look drag mutates `camYawS`), `736` (camera also uses `camYawS`)
- **Evidence:** In `updateScoop`, the move basis is `fX=sin(camYawS), fZ=cos(camYawS); rX=-cos(camYawS), rZ=sin(camYawS)`, then `mx=rX*jx-fX*jy, mz=rZ*jx-fZ*jy` and `if (!shiftLock) CHAR.yaw = atan2(mx,mz)` (664-668). `camYawS` is mutated only by the right-side look drag (`camYawS -= dx*LOOK_SENS`, line 516). So every degree of camera orbit re-points the walk direction and snaps Drew's facing — exactly the "look-controls also rotate movement" the user reports.
- **Impact:** The default (unlocked) Scoop control scheme is camera-relative, not the requested Roblox-style decoupling (left stick = world-stable move, right side = independent orbit). Disorienting on the primary mobile target. Note: when the stick is idle, look does *not* move/turn Drew (the heading update is inside the `mag > MOVE_DEADZONE` block), so the core contract is partially intact — the problem is mid-walk orbiting.
- **Fix:** Keep an independent `moveYaw` (or a fixed world frame) that the look drag does NOT touch, and derive the move basis from it; let `camYawS` affect only the camera. Reserve camera-relative facing for shift-lock (which already sets `CHAR.yaw = camYawS`, line 660). Optionally lerp `CHAR.yaw` toward the move heading instead of snapping.

#### 5. Drive is hard-fenced at 314 m and bounces the car backward (USER-REPORTED "roam much further")
- **Dimension:** Game feel / controls · **Consensus:** 2/2 (merged across game + controls dimensions)
- **File:** `src/engine/engine.js:895-896` (drive fence), `688` (scoop fence), `566-567`/`792` (explore/exit clamp ±310)
- **Evidence:** `const lim = 314; if (Math.hypot(nx,nz) > lim) { ... nx *= lim/d; nz *= lim/d; car.speed *= -0.2; }`. The car is clamped to a 314 m circle AND its velocity is reversed, so it bounces off nothing. Explore pan/exit clamp to ±310. The Google tileset streams well beyond 314 m and the LRU cache already caps resident tiles at 200 MB (tiles3d.js:72), so there is no memory reason for so tight a bound. The terrain heightfield supports ~340 m (`terrain.half`), and `terrainAt` is clamped/NaN-safe past the edge.
- **Impact:** The user explicitly asked to roam much further; today the car hits an unmarked invisible circular wall that shoves it backward — the textbook flow-breaking boundary.
- **Fix:** Remove the `car.speed *= -0.2` bounce (let the edge slow to a stop). Raise `lim` substantially (e.g. 1500-3000 m) and widen the explore/exit clamps to match; make the boundary soft (scale max speed / fade fog near the edge). If staying inside the current heightfield, ~335 m is safe; beyond 340 m the terrain flat-lines (no NaN), so expand `terrain.half` if a larger world is wanted.

#### 6. Per-frame photoreal ground down-rays run with no BVH; `firstHitOnly` is a silent no-op
- **Dimension:** Rendering performance · **Consensus:** 2/2
- **File:** `src/engine/engine.js:223` (`firstHitOnly=true`), `232` (`p3dtiles.raycast`), `246-251` (`actorGroundY`), `901`/`1009`-area calls; `tiles3d.js:68` (`displayActiveTiles=true`)
- **Evidence:** `three-mesh-bvh` is not installed (no `acceleratedRaycast`/`computeBoundsTree` anywhere). So `firstHitOnly` only enables the tiles-renderer's per-*tile* bounding-volume pruning, after which it linearly tests every triangle of each hit Google leaf tile (tens of thousands of tris). `updateDrive` casts at least the `actorGroundY(car.x,car.z)` ray each frame (line 901), plus the camera collision ray (finding #7); Scoop avoids this (rides `terrainAt`), so the cost is Drive-specific and worsens during the requested "roam further."
- **Impact:** The dominant per-frame CPU cost in photoreal Drive; scales with leaf-tile triangle density → frame-time spikes / sustained hitching on iOS.
- **Fix:** Add `three-mesh-bvh` and wire `computeBoundsTree` on tile geometries in the `load-model` handler, OR sample the ground ray every N frames and lerp (the car moves smoothly), and reuse a single ray for both actor height and camera floor.

#### 7. `resolveCam` raycasts the entire tile group recursively every frame in low-chase Drive
- **Dimension:** Rendering performance · **Consensus:** 2/2
- **File:** `src/engine/engine.js:846` (raycast), `839-849`; called from the Drive chase cam
- **Evidence:** When `p3dtiles.holder.visible`, `resolveCam` does `camRay.intersectObject(p3dtiles.group, true)[0]` (line 846) — a raw recursive three.js raycast over the whole tile group, NOT the pruned `p3dtiles.raycast()`. `displayActiveTiles=true` (tiles3d.js:68) keeps off-camera tiles in the active set, enlarging what it traverses.
- **Impact:** A second, more expensive per-frame full-scene tile raycast in the chase cam; compounds #6.
- **Fix:** Route the camera collision ray through `p3dtiles.raycast(camRay, hits)` (sets `firstHitOnly` + bounding-volume pruning) instead of `intersectObject(group, true)`, and/or run it every few frames. Cheap once a BVH is in place.

#### 8. No tiles `load-error` / auth-failure listener — a bad or over-quota key fails silently
- **Dimension:** Correctness · **Consensus:** 1/2 (down-weighted; verified real)
- **File:** `src/engine/engine.js:304-310` (only `load-model` listened for), `tiles3d.js:18-20`
- **Evidence:** The only tiles handler is `addEventListener('load-model', ...)` (line 304). No `load-error`/`load-content-error`/root-tileset-error listener. `tiles3d.js:20` only handles a *missing* key (`console.warn` + `return null`); a present-but-invalid / referrer-blocked / over-quota (403) key surfaces via error events that are never observed, so `tilesReady` stays false with no toast or diagnostic.
- **Impact:** On the public bundle (key baked in), a referrer restriction silently disables the whole photoreal feature with no diagnosis path. The procedural fallback does show (good), but the user/dev gets zero signal.
- **Fix:** Register a `load-error` (and root-tileset error) listener that `console.warn`s with context and emits a HUD toast. Keep the working procedural fallback but surface the failure loudly. Also confirm the baked `VITE_GOOGLE_MAPS_KEY` is HTTP-referrer + API restricted in Cloud Console.

#### 9. `errorTarget` hard-coded to 10 with no mobile branch — loads finer/more tiles on the OOM target
- **Dimension:** iOS Safari robustness · **Consensus:** 1/2 (verified real)
- **File:** `src/engine/engine.js:299` (overrides `tiles3d.js:67` default of 16)
- **Evidence:** `createPhotorealTiles(..., { ... errorTarget: 10 /* sharper tiles (was 16) */ })`. `MOBILE` (engine.js:31) is consulted for DPR (line 40) and shadows (54) but NOT for `errorTarget`. Lower errorTarget → finer leaf tiles → more/higher-res geometry+textures, the dominant memory consumer.
- **Impact:** Increases resident tile bytes on exactly the iPhone class the app says it must protect; contradicts the guidance to *raise* errorTarget on mobile, and compounds with the requested Drive roam expansion.
- **Fix:** `errorTarget: MOBILE ? 16 : 10` (or higher on mobile). Pair with the 200 MB cache so roam expansion doesn't multiply resident bytes.

### P2

#### 10. DirectionalLight shadow map re-renders every frame (`autoUpdate` never disabled), 600 m frustum
- **Dimension:** Rendering performance · **Consensus:** 2/2
- **File:** `src/engine/engine.js:41-56`
- **Evidence:** `shadowMap.enabled = !LITE` (41), `sun.castShadow = true` (53), `mapSize 1024` on mobile (54), shadow camera `left/right/top/bottom = -300..300, far 900` (56). `shadowMap.autoUpdate` left at default `true`, so the depth pass re-renders every frame even though the light and most casters are static.
- **Impact:** An always-on extra full depth render per frame on mobile, plus poor texel density (1024 across 600 m). Works against the thermal budget.
- **Fix:** `shadowMap.autoUpdate = false`; flip `needsUpdate = true` only when a caster moves enough / once per N frames. Tighten the frustum around the actual play area. Consider a fake blob/contact shadow under car+Drew (the patch disc already exists).

#### 11. Scoop vertical look drag dollies the camera (distance+height), not pitch, and fights pinch/scroll zoom
- **Dimension:** Controls / camera UX · **Consensus:** 2/2
- **File:** `src/engine/engine.js:517` (`scPitch` stored), `738` (consumed as dolly)
- **Evidence:** Up/down drag stores `scPitch = clamp(scPitch + dy*PITCH_SENS, -0.3, 0.8)` (517) but `updateScoop` consumes it as `dist = (SC.dist + scPitch*5)*szoom, h = (SC.h + scPitch*6)*Math.max(0.75,szoom)` (738) — it pushes the camera farther/higher AND multiplies on top of `szoom` (the dedicated pinch/scroll zoom). The two zoom controls stack; the camera angle barely changes.
- **Impact:** Vertical look does not pitch as a player expects; it duplicates the zoom axis and makes fine framing fuzzy. Drive does this correctly (`camOrbit.pitch` feeds height, `czoom` separate), so Scoop is the inconsistent one.
- **Fix:** Make `scPitch` an actual tilt (derive height/distance from a pitch angle, e.g. `height = dist*sin(pitch)`-style) and keep `szoom` as the only distance multiplier. Mirror the Drive split.

#### 12. Scooping a poop has no visual juice — it snaps to scale 0 and vanishes
- **Dimension:** Game design / feel · **Consensus:** 2/2
- **File:** `src/engine/animals.js:164-167`; `src/engine/engine.js:711`
- **Evidence:** `removePoop()` does `p.mesh.setMatrixAt(p.idx, ZERO)` — instant snap to scale 0. The collect path (engine.js:711) plays `audio.sfxScoop()` and increments the counter, but there is no scale-punch, particle puff, or ease.
- **Impact:** The core reward verb of the entire mode — done dozens of times per session — has the weakest possible visual feedback. Undersells every pickup and flattens the loop.
- **Fix:** Animate the instance matrix scale down over ~80 ms (ease-out overshoot pop) instead of snapping to ZERO, or add a small sparkle/particle puff at the poop position. Keep it subtle (high-frequency) but make it pop, not vanish.

#### 13. Walk-to-a-parked-car handoff is undiscoverable
- **Dimension:** Game design / feel · **Consensus:** 2/2
- **File:** `src/engine/engine.js:746-749` (proximity prompt), `660-700` (Drew spawn in backyard); `src/App.jsx:128`
- **Evidence:** Parked cars are at the front curb (`frontPt` + offsets); Drew spawns in the backyard sanctuary near `sancCx=-16, sancCz=-10`, with the house between them. The "Get in & drive" button only appears within 3.6 m of a spot (engine.js:748, App.jsx:128). Nothing points to the cars; the only nav aid is the yellow pin tracking Drew himself.
- **Impact:** A genuinely cool feature (walk out, get in a car, drive off) is effectively hidden — a player dropped straight into Scoop has no cue. The modes feel disconnected.
- **Fix:** Surface the affordance: a faint marker/arrow toward the nearest parked car (or a "cars in the driveway →" hint) once some poop is scooped, and/or extend the `lookHint` to mention "walk out front to drive."

#### 14. AudioContext is never re-resumed after iOS interruption / backgrounding
- **Dimension:** iOS Safari robustness · **Consensus:** 2/2
- **File:** `src/engine/audio.js:7-12`
- **Evidence:** `ensure()` creates the context and calls `AC.resume()` but is only invoked at mode entry. No `statechange` listener and no resume tied to `visibilitychange` (zero matches for `statechange|interrupted`). On iOS, a phone call / Siri / route change moves the context to `interrupted`; backgrounding suspends it.
- **Impact:** After any interruption the context stays suspended for the rest of the session — engine, scoop SFX, and chimes go permanently silent while gameplay continues. Compounds with the missing `visibilitychange` handler (#3).
- **Fix:** Add a `statechange` listener on the single AC that calls `AC.resume()` when it leaves `running`, and call `audio.ensure()` on the foreground-resume path. Keep the single-context gesture-unlock design.

#### 15. No WebGL2 probe / graceful failure for renderer or missing key — silent black/procedural screen
- **Dimension:** iOS Safari robustness · **Consensus:** 2/2
- **File:** `src/engine/engine.js:38`; `tiles3d.js:20`
- **Evidence:** `new THREE.WebGLRenderer(...)` is constructed with no try/catch and no `isWebGL2Available`/`getContext` probe. A missing key only `console.warn`s (tiles3d.js:20) with no user-facing message.
- **Impact:** If WebGL2 creation fails, the constructor throws and the whole mount aborts to a blank canvas / stuck `#loading`. A missing/expired/over-quota key silently shows the procedural fallback with no indication the photoreal failed.
- **Fix:** Probe WebGL2 (or wrap construction in try/catch) and emit a real toast/overlay on failure. Surface a user-visible note when the key is missing or tile auth fails (ties into #8).

#### 16. Look/orbit sensitivity is raw CSS-pixels → radians, not normalized to screen size / DPR
- **Dimension:** Controls / camera UX · **Consensus:** 2/2
- **File:** `src/engine/engine.js:440` (`LOOK_SENS=0.0046, PITCH_SENS=0.003`), `511-517`
- **Evidence:** Handlers apply the constants to raw pointer deltas (`camOrbit.yaw -= dx*LOOK_SENS`, `camYawS -= dx*LOOK_SENS`) with no division by canvas width/height or DPR. The same physical swipe rotates more on a 390 px phone than a 1024 px tablet.
- **Impact:** Inconsistent camera feel across devices; on small phones a normal thumb swipe over-rotates.
- **Fix:** Express orbit as a fraction of screen width, e.g. `yaw -= (dx / VW) * YAW_PER_SCREEN` with `YAW_PER_SCREEN ≈ Math.PI`. Keep it tunable; do not multiply the drag→angle mapping by dt.

### P3

#### 17. Explore main-loop smoothing uses fixed per-frame lerp alphas, not dt-corrected decay
- **Dimension:** Game feel · **Consensus:** 2/2
- **File:** `src/engine/engine.js:1003`, `1008-1009`
- **Evidence:** `const k = reduceMotion ? 1 : 0.16` then `ctl.tx += (ctl.gtx-ctl.tx)*k; ...` with no dt term, while drive/scoop cams correctly use `Math.min(1, dt*k)` (e.g. 742, 867, 902). So the Explore ease runs faster at 120 fps than at 30 fps.
- **Impact:** Explore orbit/zoom feels snappier on a 120 Hz iPad and floatier on a throttled 30 fps iPhone — the frame-rate-dependent-feel bug, scoped to Explore only.
- **Fix:** Make the block dt-corrected: `k = 1 - Math.exp(-lambda*dt)` (or `Math.min(1, dt*lambda)`), mirroring the drive/scoop cams.

#### 18. Movement stick has a large radial dead zone (0.12) with no rescaling — speed lurches at the edge
- **Dimension:** Controls / camera UX · **Consensus:** 2/2
- **File:** `src/engine/engine.js:440` (`MOVE_DEADZONE = 0.12`), `659-669`
- **Evidence:** `mag = min(1, hypot(jx,jy))` is used directly as the speed scalar (`sp = 4.4*mag`) without subtracting the dead zone and rescaling, so speed jumps from 0 to `4.4*0.12 ≈ 0.53 m/s` at the threshold; 0.12 is large for a resting-thumb dead zone.
- **Impact:** Slight lurch crossing the dead-zone edge and reduced low-speed precision for careful poop positioning.
- **Fix:** `const m = mag <= DZ ? 0 : (mag - DZ)/(1 - DZ); sp = 4.4*m;` and lower DZ to ~0.06-0.08. Apply the same rescale to the Drive throttle/steer mix.

#### 19. DPR cap is set once at init and never re-applied on resize / orientation change
- **Dimension:** iOS Safari robustness · **Consensus:** 2/2
- **File:** `src/engine/engine.js:40` (set once), `980-987` (`resize` never re-calls `setPixelRatio`)
- **Evidence:** `setPixelRatio(LITE ? 1 : Math.min(devicePixelRatio, MOBILE ? 1.5 : 2))` runs once at line 40; `resize()` calls `setSize(w,h,false)` (which preserves the existing ratio) but never re-clamps DPR.
- **Impact:** Low — the cap is correctly clamped and `setSize(...,false)` keeps the framebuffer bounded. Only matters if `devicePixelRatio` changes mid-session (rare on phones).
- **Fix:** Re-apply `setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.5 : 2))` inside `resize()`.

#### 20. Main index chunk is 963 KB (288 KB gz) eagerly loaded for all modes
- **Dimension:** Rendering performance · **Consensus:** 2/2
- **File:** `vite.config.js` (manualChunks)
- **Evidence:** Built `index-*.js` 963 KB (288 KB gz) holds all engine code (engine.js, world.js, car.js, drew.js, animals.js + React HUD). `three` (613 KB) and `tiles` (161 KB, lazy) are split, but `three` loads eagerly for the start menu before any 3D renders.
- **Impact:** ~445 KB+ gz of JS parse/eval before first interaction on a phone, including all three modes' engine code regardless of choice.
- **Fix:** Lazy-load the engine itself (dynamic import on Start) so the start menu boots with just the React HUD, and/or split mode-specific code (car/drew/world). Lower priority since `three` must load before any 3D anyway.

#### 21. Drive/Scoop roam capped at 314 m while the heightfield supports ~340 m
- **Dimension:** Correctness · **Consensus:** 2/2 — **subsumed by finding #5**
- **File:** `src/engine/engine.js:895` (drive), `688` (scoop); `terrain.half=340`
- **Note:** This is the same boundary as #5, scoped to the heightfield limit. Fix together with #5; if staying inside the current terrain, ~335 m is safe (terrain is clamped/NaN-safe past the edge).

---

## Resolved / Not Applicable at HEAD (dropped from the active list)

- **"Scoop flatten disc R = 39 m pancakes the real house at world origin" (incoming P0)** — and its
  P1 duplicate. **Does not match HEAD.** There is no `flattenScoopArea`/`flatShape`; `photoModes`
  excludes Scoop (engine.js:285); the comment at engine.js:282-284 states the flatten/house-pancake
  hack was removed and Scoop renders the procedural world. The grass disc (`R = SCOOP_CLEAR_R+4 = 29`,
  engine.js:119) only draws a textured ground plane and does not flatten tile geometry. **Verify by
  entering Scoop:** the house should be intact. If it is somehow still flattened, the cause is the
  procedural house geometry or the grass disc, not a tile flatten — re-file with the new evidence.
- **"alignP3DT()/flattenScoopArea() now run on tile load in ANY mode"** — premise is false at HEAD;
  `alignP3DT()` runs from `load-model` but only matters where tiles render (Explore/Drive), and there
  is no flatten step at all.
- **"Flatten disc geometry dropped without dispose() when alignment shifts the holder offset"
  (incoming P3)** — no `flatShape` exists at HEAD, so there is nothing to leak. Dropped.

> If the developer intended to keep a tile-flatten approach in Scoop (e.g. to pancake melty
> property-line trees while keeping tiles visible), that code is not present at HEAD and would need
> to be re-introduced — at which point the house-carve-out recommendation (clip the house AABB out
> of the flatten shape) would apply. As shipped, Scoop avoids the whole problem by not streaming tiles.
