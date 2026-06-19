# Nibblers — developer / agent guide

Read this before touching anything under `nibblers/`. It is the companion to the
pinned interfaces in `CONTRACTS.md` and the tunables in `constants.js`. The parent
framework is documented in `../AGENTS.md` / `../CLAUDE.md`; everything that file says
about isolation, refs-vs-atoms, the single `stepMotion`, and the single sim loop is
still law here — Nibblers is a **layer on top of Da Hilg**, not a fork of it.

---

## 1. What Nibblers is

Da Hilg is a calm, third-person walk through the recentered 1840 Dahill
neighborhood as one of four family members (Mike, Kelli, Cece, Drew). Nibblers turns
that walk into a survival loop:

- The neighborhood is seeded with **hidden Danger Zones** — invisible sensor boxes on
  the approaches between landmarks. Walking into one **marks** you. There is no visual
  warning; the only feedback is the MARKED toast + indicator.
- While you are marked, **swarms of mini character clones** (10–15% scale copies of the
  four family members, constantly emoting) spawn off-camera and **converge** on you. As
  they reach you they **attach** and ride your capsule as a writhing pile.
- Attachments are the cost: each one **slows your movement**, **weakens your jump**,
  **dims your visibility** (a darkening vignette), and **slowly drains your health**.
  The more attached, the worse it gets.
- You can **stomp** clones by jumping and coming down on them — risky, because you have
  to descend into the horde to do it.
- Reaching a **Safe Zone** clears Marked, stops new spawns, **scatters** the whole swarm
  (attached ones fall off and flee, then despawn), and — if the safe zone is
  discoverable — **reveals it permanently on the minimap**. Power comes from discovering
  safe zones: the map fills in only with places you've personally reached.

The minimap shows **roads + your dot + discovered safe zones only**. It never shows
danger zones, the swarm, or undiscovered safe zones — by construction, because it has
no data source for them.

## 2. The core loop

```
explore  →  step into a hidden Danger Zone  →  MARKED
   ↑                                              ↓
   │                                  swarm spawns & ramps over time
   │                                  (2–5 → 10–20 → 25–40 → 50–80 → 100+)
   │                                              ↓
   │                          clones chase, jump, ATTACH → slow/weak/dim/drain
   │                                              ↓
   │              survive: stomp a few, run for a Safe Zone you know or guess
   │                                              ↓
   └──── reach a Safe Zone → clear Marked + scatter swarm + reveal it on the map
```

The pressure ramps the longer you stay marked (the attraction timeline), so the loop is
"get marked, suffer-while-you-search, reach safety, expand your known map." Survivability
grows as you discover more safe zones.

## 3. Swarm architecture (the heart of it)

The swarm is **not registry actors**. Hundreds of independent Rapier bodies / React
components would never hit frame. Instead:

**Data — typed-array SoA.** `swarm/swarmState.js` is a flat Structure-of-Arrays sized to
`MAX_NIBBLERS` (512), allocated once at module load. `px/py/pz`, `vx/vy/vz`, `heading`,
`scale`, `phase`, `stateT`, `jumpCD`, `seed` (Float32); `state`, `charIx`, `clip` (Uint8);
`attachSlot` (Int16). A `swarm` scratch object holds the swarm-wide counters
(`liveCount`, `activeCount`, `attachedCount`, `marked`, `markedT`, `targetActive`,
`panic`/`panicUntil`, `attachNext`). It is a **plain module — never React/Jotai/registry**.
Slots are handed out by a free-list: `alloc()` returns an index or `-1` when full,
`free(i)` reclaims it. Dead slots keep `scale=0` so they collapse to a degenerate point
and the GPU discards them — we always upload all 512 instances and never shift arrays.

**Render — ONE InstancedMesh + a Vertex Animation Texture.** `render/SwarmRenderer.jsx`
mounts a **single** `<instancedMesh args={[geom, mat, 512]} frustumCulled={false}
castShadow={false}>`. The material is a `MeshStandardMaterial` patched via
`onBeforeCompile` (`render/vatMaterial.js`) to displace every vertex by sampling a baked
animation texture — the whole horde animates on the GPU in **one draw call**. The
character GLBs are 57k–166k verts; far too heavy to bake per-vertex, so the VAT pipeline
**decimates to a ~512-vert proxy** first. Per-instance variety comes from three
`InstancedBufferAttribute`s: `aPhase` (clip cursor 0..1), `aClip` (which animation band),
`aTint` (per-character color). The renderer runs **no `useFrame`** — that would be a
second sim loop. It only publishes its mesh + buffers into the `swarmGpu` bridge on mount.

### The VAT bake — `scripts/build_nibbler_vat.mjs`

This is the critical-path artifact. Run `npm run build:nibbler-vat`. It is **headless
three.js** (no WebGL — `GLTFLoader.parse` of geometry+skin+anims never touches the GPU)
and emits to `public/da-hilg/nibblers/`:

1. **Decimate.** Read `src/assets/drew.glb` (the lowest-poly family character, a 24-bone
   Mixamo rig), `dequantize` → `weld` → `MeshoptSimplifier.simplify(... ['Permissive'])`
   down to a **~512-vert proxy keeping skin weights** (`JOINTS_0`/`WEIGHTS_0`) and the
   skeleton. The `Permissive` flag is load-bearing: without it the attribute-aware
   simplifier floors at ~4900 verts on the Meshy export's UV/skin seams. `compactMesh`
   renumbers and rebuilds the attribute arrays in place.
2. **CPU-skin** every vertex for 24 frames of each of **4 clip bands** in this exact
   order — `[idle, run, jump, emote(=dance)]` — via `AnimationMixer.setTime` +
   `applyBoneTransform` (4-bone LBS), then `* matrixWorld` (the rig's 0.01 scale) to land
   a ~1.6 m humanoid in world meters. Normals come from the blended-bone rotation.
3. **RGBA8 bounds-pack.** Float positions can't survive 8-bit directly, so each axis is
   remapped `(val − min)/(max − min)` into 0..255. Texture width = vertCount, height =
   4 clips × 24 = 96 rows. Position → `nibbler.vat.pos.png`, normal →
   `nibbler.vat.nrm.png` (separate PNGs; the loader also tolerates a combined layout).
4. **Emit** `nibbler.proxy.glb` (position + normal + uv + a baked **float `aVertexId`**
   attribute 0..N-1, meshopt-compressed), the two PNGs, and `nibbler.vat.json` (vertCount,
   rows, per-clip `{row,frames}` bands, per-axis pos/nrm min-max, texture URLs/layout).
   Everything the runtime needs is read from the json — nothing is hardcoded.
5. **Assert loudly:** vertCount in [200,1024], dims < 4096, no NaN, idle loops
   (frame0 ≈ frameLast), each band fully written, frames differ within a clip.

The shader (`vatMaterial.js`) recovers each vertex's row from `aClip` (which band) plus
`floor(aPhase × frames)` (which frame), samples `uVatPos`/`uVatNrm` at
`((aVertexId+0.5)/vertCount, (frame+0.5)/rows)`, unpacks with the bounds, and writes
**object-space** `transformed` / `objectNormal`. It deliberately does **not** multiply by
`instanceMatrix` — three's instancing chunk does that downstream in `<project_vertex>` /
`<defaultnormal_vertex>`. `diffuseColor.rgb *= aTint` tints per instance.
`customProgramCacheKey = 'nibblerVAT'` keeps it one program for the whole horde.

> **aVertexId is permuted, not identity.** Decimation renumbers vertices, so the proxy's
> vertex order does **not** match a plain 0..N-1. The bake writes a float `aVertexId`
> attribute that maps each surviving proxy vertex to its row column in the VAT.
> `render/swarmGeometry.js` guarantees that attribute exists on the geometry — aliasing
> the proxy's baked `_VERTEXID`/`aVertexId` if present (same buffer, no copy), else
> synthesizing 0..N-1. The shader always reads the attribute (never `gl_VertexID`),
> because that is the only id that indexes the texture correctly. If you ever rebake and
> drop the permutation, the swarm will animate as scrambled confetti.

## 4. File layout (one line each)

**Top level**
- `constants.js` — every gameplay tunable, pure data, no imports.
- `mode.js` — `isNibblersMode()` (imperative `gameModeAtom` read) + the `nibblerPenalty`
  ref (`{speedMul,jumpMul,visibility}`, defaults all-ones).
- `index.js` — the public barrel the framework wires to: `isNibblersMode`,
  `nibblerPenalty`, `updateNibblers`, `buildNibblersZones`, `SwarmRenderer`,
  `NibblersHud`, `initNibblers`.
- `CONTRACTS.md` — pinned module signatures. `AGENTS.md` — this file.

**`state/`**
- `nibblerAtoms.js` — discrete UI atoms (`gameModeAtom` default `'nibblers'`,
  `discoveredSafeZonesAtom`, `markedTimerAtom`, `attractionTierAtom`,
  `activeNibblersAtom`, `attachedCountAtom`, `visibilityFactorAtom`,
  `currentSafeZoneAtom`); re-exports framework `markedAtom`/`healthAtom`.

**`swarm/` (the SoA sim — plain modules, no React)**
- `swarmState.js` — the SoA arrays + `swarm` scratch + `resetSwarm/alloc/free` free-list.
- `spawner.js` — `spawnPolicy(ctx)`: attraction curve → target active count → ring spawn
  (one down-castRay per spawn to seat Y) / cull.
- `updateSwarm.js` — `updateSwarm(ctx)`: per-nibbler FSM over the SoA, then the GPU upload.
- `nibblerFSM.js` — pure index-based steering verbs (`seekTo`, `separate`, `integrate`,
  `tryJumpAndAttach`); no alloc.
- `grid.js` — uniform spatial hash over XZ (`buildGrid`, `forNeighbors`, `forNibblersNear`).
- `attachment.js` — `updateAttachment(ctx)` orbit-shell placement + `attachNibbler`/`releaseAll`.

**`systems/` (the ordered pass + reactive bridge)**
- `nibblersSystems.js` — `updateNibblers(ctx)`: the single ordered pass (see §5).
- `nibblerZones.js` — `updateNibblerZones(ctx)`: edge-detect reconciled zones → marked /
  discover / scatter.
- `markedSystem.js` — `armMarked(now)` / `clearAndScatter(now)`.
- `penaltySystem.js` — `updatePenalty(ctx)`: attachedCount → `nibblerPenalty` curves.
- `healthDrain.js` — `updateHealthDrain(ctx)`: attachedCount → health drain.
- `stompSystem.js` — `updateStomp(ctx)`: descending + grid query under feet → kill + bounce.
- `commitNibblers.js` — `commitNibblers(ctx)`: change-gated / bucketed atom writes.

**`render/` (sim ↔ GPU bridge)**
- `swarmGpu.js` — the plain `{mesh,aPhase,aClip,aTint}` bridge module.
- `SwarmRenderer.jsx` — the ONE InstancedMesh; publishes into `swarmGpu`; no `useFrame`.
- `vatMaterial.js` — `makeVatMaterial(assets)`: the `onBeforeCompile` VAT patch.
- `nibblerAssets.js` — loads/caches the VAT json+PNGs; `useNibblerAssets()` + `assetsReady()`.
- `swarmGeometry.js` — `useSwarmGeometry()`: proxy GLB geom with `aVertexId` guaranteed.

**`zones/`**
- `zoneConfig.nibblers.js` — `buildNibblersZones(levelMeta)`: 5 safe (home + 4
  discoverable) + 6 hidden danger defs, recentered coords.

**`minimap/`**
- `minimapTransform.js` — `makeMinimapProjector(worldHalf, sizePx)`: pure player-locked,
  north-up world-XZ↔pixel projector.

**`hud/` (DOM, mode-gated, reuses framework `hud.css` tokens + `hudEvents.js`)**
- `NibblersHud.jsx` (root, renders only in nibblers mode), `MarkedIndicator.jsx`,
  `SwarmCount.jsx`, `HealthBar.jsx`, `Minimap.jsx` (Canvas2D), `Vignette.jsx`,
  `ObjectiveHint.jsx`, `SafeBanner.jsx`, `nibblers.css`.

## 5. Sim integration

There is exactly **one** simulation `useFrame` in the whole game — `scene/GameSystems.jsx`.
Nibblers does not add a second one. It hangs off step 6's mode branch:

```js
// GameSystems.jsx, step 6 — Mode loop
if (isNibblersMode()) updateNibblers(ctx);
else updateGreet(ctx);
```

`updateNibblers(ctx)` runs **after** `stepMotion` (so the active player already has its
post-collision feet `pos`/`velY` this frame) and **after** `flushZones` (so zone
membership is reconciled), and **before** `commitReactive`. The whole pass is gated on
`assetsReady()` — until the VAT json + textures load there are no bodies and the grid
isn't built, so it returns early and penalties stay `{1,1,1}`.

**The ordered pass** (`systems/nibblersSystems.js`):

```
updateNibblerZones  marked / discovered / scatter from the reconciled zone set
spawnPolicy         attraction curve → target active → ring spawn / cull
updateSwarm         FSM over the SoA + spatial grid + integrate + GPU upload
updateAttachment    resolve contacts → attached orbit shell; swarm.attachedCount
updatePenalty       attachedCount → nibblerPenalty ref (stepMotion reads next frame)
updateHealthDrain   attachedCount → active player's health
updateStomp         descending + grid query under feet → kill + bounce
commitNibblers      change-gated / bucketed atom writes (the React-facing surface)
```

The order matters: zones first (so spawning reacts to this frame's mark), then spawn →
sim → attach → penalty/health/stomp, then the single reactive commit at the tail.

**Refs vs atoms** — same discipline as the framework. Per-frame truth (the SoA, the
`swarm` scratch, `nibblerPenalty`) is plain mutable, mutated in place, never in React.
The only React/Jotai writes happen in `commitNibblers` (and the edge-only writes in
`nibblerZones`), all change-gated and bucketed so the store never thrashes. The active
player's feet pos / velY / grounded are read from
`registry.get(activePlayerId).motion.{pos,velY,grounded}`.

**The GPU upload is folded into `updateSwarm`'s tail** — there is no separate render-side
copy. After the FSM pass, `uploadToGpu()` reads `swarmGpu.mesh` (skips entirely if the
renderer hasn't mounted), writes each slot's instance matrix directly (yaw + uniform
scale, 16 floats, dead slots zeroed to a degenerate point), copies `phase`/`clip`/tint
into `aPhase`/`aClip`/`aTint`, flips `needsUpdate` on each, and holds `mesh.count = 512`.

## 6. Framework seams (the ~9 additive edits)

Nibblers ships as **additive** edits to the framework — nothing was removed or rewritten.
The full set (verify with `rg -n "nibbler|gameMode|buildHomeSafe" src/da-hilg --glob '!nibblers/**'`):

1. **`scene/GameSystems.jsx`** — step 6 mode branch: `if (isNibblersMode()) updateNibblers(ctx); else updateGreet(ctx);`
2. **`systems/stepMotion.js`** — the speed line `× nibblerPenalty.speedMul` and the jump
   line `× nibblerPenalty.jumpMul`. (This is the seam the `speedMultiplierFor` docstring
   claimed but never wired; the multiply lives here.)
3. **`scene/Scene.jsx`** — `{mode === 'nibblers' && <SwarmRenderer />}`.
4. **`zones/Zones.jsx`** — picks `buildNibblersZones(levelMeta)` in nibblers mode (vs the
   framework's `buildZoneConfig`).
5. **`zones/Zone.jsx`** — carries the `discover` prop through `registerZone`.
6. **`zones/zoneConfig.js`** — exports `buildHomeSafe(levelMeta)` so the nibblers config
   can reuse the house auto-fit for `safe_home`.
7. **`hud/DaHilgHud.jsx`** — mounts `<NibblersHud />` and gates the greet widgets by mode.
8. **`DaHilgApp.jsx`** — calls `initNibblers()` on mount (resets the swarm).
9. **`state/atoms.js`** — `markedAtom` / `healthAtom` were reserved here for exactly this
   (re-exported from `nibblerAtoms.js`, not duplicated).

Keep new edits in this shape: additive, mode-gated, no-op in greet mode.

## 7. The mode system

`gameModeAtom` (`state/nibblerAtoms.js`) is `'nibblers'` by default — Nibblers is the
shipping experience; greet is the calmer fallback. `isNibblersMode()` reads it
imperatively (no React) so the single `useFrame` can branch cheaply. In greet mode the
swarm pass never runs, `SwarmRenderer`/`NibblersHud` don't mount, and `nibblerPenalty`
stays `{1,1,1}` — so the framework's `stepMotion` multiplies are an **exact no-op**. The
family stays Tab-switchable in both modes.

## 8. Gameplay tunables (`constants.js`)

All of it lives in `constants.js` — pure data, units in meters/seconds/radians. The knobs
you'll reach for most:

- **Capacity/scale:** `MAX_NIBBLERS=512`, `NIBBLER_SCALE_MIN/MAX` 0.1–0.15.
- **Attraction timeline:** `ATTRACTION` bands (2–5 / 10–20 / 25–40 / 50–80 over 0–120s)
  + `ATTRACTION_GROWTH` past 120s; `ACTIVE_RESERVE=64` keeps slots for fall/scatter/attach.
- **Spawner:** `SPAWN_RING_MIN/MAX` 8–16, `SPAWN_RATE_MAX=14/s`, `DESPAWN_RADIUS=42`,
  `SPAWN_BEHIND_BIAS=0.7` (prefer off camera-forward).
- **Behavior:** `NOTICE_RADIUS=14`, `NIBBLER_RUN_SPEED=4.5`, `SEP_RADIUS=0.6` (also the
  hash cell size), `JUMP_RADIUS=2.0`, `NIBBLER_JUMP_VEL/LUNGE`, `EMOTE_RATE=1.5`.
- **Attach test:** `ATTACH_RADIUS/PAD/HEIGHT_BAND` (capsule-vs-point, no Rapier).
- **Penalty curves (a = attachedCount):** `speedMul = clamp(1/(1+a/70), 0.12, 1)`,
  `jumpMul = clamp(1/(1+a/45)^1.3, 0.05, 1)`, `visibility = clamp(1−(a/260)^0.85, 0.18, 1)`.
- **Health:** `HEALTH_DRAIN_PER_ATTACH=0.04` HP/s, capped at `HEALTH_DRAIN_CAP=2.5`,
  committed at `HEALTH_COMMIT_HZ=1.5`.
- **Stomp:** must fall faster than `STOMP_DESCEND_VEL=-1.5`, kill within `STOMP_RADIUS=1.0`,
  `STOMP_BOUNCE=3.0`.
- **Scatter:** `SCATTER_SPEED`, `PANIC_FLEE`, `PANIC_POP`, `SCATTER_TIME=1.2`.
- **Tints:** `NIBBLER_TINTS` index 0..3 = mike/kelli/cece/drew.
- **Minimap:** `MINIMAP_VIEW_RADIUS=80`, `MINIMAP_SIZE_PX=180`.

## 9. Rebuilding assets

Two separate build scripts (kept out of the hero asset pipeline on purpose):

- **`npm run build:nibbler-vat`** → `public/da-hilg/nibblers/{nibbler.proxy.glb,
  nibbler.vat.pos.png, nibbler.vat.nrm.png, nibbler.vat.json}`. Run this after changing
  the proxy decimation, the clip bands, frame counts, or the packing. The asserts fail
  loudly if a bake is broken — trust them.
- **`npm run build:minimap`** → `public/da-hilg/minimap.json`. Reads the **source** export
  `exports/1840-dahill-property.glb` (not the runtime `public/da-hilg/level.glb`, whose
  mesh names are stripped by meshopt), recenters road meshes by the **same** offset the
  asset build uses (House_walls center XZ, Collision_Terrain min-Y), runs boundary-edge
  extraction (all road meshes are triangles, no LINES special-case), and emits 2D
  polylines per layer.

The framework's own assets still rebuild with `npm run build:dahilg-assets`.

## 10. The minimap

`hud/Minimap.jsx` is a Canvas2D widget driven by `minimap/minimapTransform.js`. It is
**player-locked and north-up**: the player sits dead-center, −Z (north) is up. It draws
(a) the road polylines from `minimap.json`, (b) the player dot/heading via a throttled
(~10 Hz) ref-poll of the active player's motion, and (c) pips for **discovered** safe
zones only — it intersects `discoveredSafeZonesAtom` with the XZ of each def from
`buildNibblersZones(levelMeta)`. There is **no code path** that plots danger zones, the
swarm, or undiscovered safe zones; the privacy of the map is enforced by data
availability, not by a filter you could accidentally remove.

## 11. Gotchas

- **The VAT `aVertexId` is a permutation, not identity.** Decimation renumbers vertices.
  The shader must read the baked float `aVertexId` attribute (which maps each proxy vertex
  to its VAT texture column), never `gl_VertexID`. `swarmGeometry.js` guarantees the
  attribute exists. Break this and the horde animates as scrambled noise. See §3.
- **Object-space, not clip-space, in the VAT shader.** Write `transformed` /
  `objectNormal` in object space and let three's instancing chunk apply `instanceMatrix`.
  Multiplying it yourself double-transforms every vertex.
- **Ground-follow is sensor-on-walk, not teleport.** Spawns do exactly one down-`castRay`
  to seat the spawn Y on the real hill; after that, nibblers follow the **active player's
  feet Y** as a flat local ground reference (`groundY = P.y`) inside `integrate`. There is
  no per-nibbler raycast per frame — that's the whole point. Don't add one.
- **`nibblerPenalty` defaults `{1,1,1}` and is read unconditionally.** `stepMotion` imports
  and multiplies by it every frame in both modes. In greet mode (and with zero
  attachments) it must stay all-ones or you'll silently nerf normal movement. `updatePenalty`
  is the only writer, and it never runs outside the nibblers pass.
- **Perf at 512.** One InstancedMesh, one draw call, one upload folded into the sim tail.
  Dead slots ride at `scale=0` (degenerate → discarded) so we always upload all 512 and
  never compact/shift arrays. Keep it that way: no per-nibbler React, no second `useFrame`,
  no per-frame allocation in the FSM verbs, no Rapier bodies for the swarm. The attach test
  is capsule-vs-point math, not a physics query.
- **Atoms are bucketed and change-gated.** `attachedCount` and counts are bucketed,
  `visibility` is quantized to 0.05 steps, the marked timer is integer seconds.
  `commitNibblers` diffs against a module snapshot — don't write atoms anywhere else in
  the pass (zone edges in `nibblerZones` are the one deliberate exception, and they're
  edge-only).
- **Re-arming marked does not reset the timer.** `armMarked` only sets `markedT=0` on the
  *first* arm; stepping into a second danger zone while already marked keeps the
  attraction ramp climbing. Only `clearAndScatter` (a safe zone) resets it.
