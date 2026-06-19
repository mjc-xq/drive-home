# Da Hilg — Developer / Agent Guide

This is the authoritative orientation doc for the **Da Hilg** game. Read it before
touching anything under `src/da-hilg/`. The matching machine-pinned interface
contract is `CONTRACTS.md` (do not deviate from those signatures); the design
record is `plans/plan-da-hilg-fps-r3f-20260619-0225.md`; every tunable number lives
in `constants.js`. This guide explains *why* the code is shaped the way it is so
you can extend it without breaking the invariants.

---

## 1. What the game is

Da Hilg is a brand-new, **greenfield** first-person React-Three-Fiber game that
lives entirely under `src/da-hilg/`. You explore the recentered **1840 Dahill
neighborhood** (a hill property with a house, a driveway, and San Lorenzo Creek
below) as **one of four family members** — **Mike** (Dad), **Kelli** (Mom),
**Cece** (Kid), **Drew** (Kid). The four people are *both* the playable characters
*and* the NPCs:

- You embody one of them; the other three wander the neighborhood between points
  of interest, occasionally look at things, and rarely emote (they are not
  constantly dancing).
- **Switch control** to any of them at any time (Tab / HUD tile). The one you drop
  becomes an NPC; the one you pick up keeps its exact position and velocity and
  just starts taking your input.
- NPCs **notice** you within a radius (or inside a notice zone), **chase** to tag
  you, **touch** (a friendly tag, no damage), then **retreat** and **cool down**.
  The house is a **safe zone** — duck inside and the chase stops.
- The core verb is **Greet (E)**: walk up to a family member and greet them; they
  turn to face you, play a reaction emote (cheer/wave), a toast + hit-marker fire,
  and they're marked greeted. **Greet all four → "FAMILY REUNITED" celebration +
  replay.** There is no fail state; the whole thing is replayable.
- Camera is **first-person by default**, with a **third-person** toggle (V) that
  shows the character body with a collision-avoided boom.

This is a warm "reunite the family" exploration loop, not a combat game.

---

## 2. Controls

### Desktop
| Input | Action |
|---|---|
| **W A S D** | Move (camera-relative) |
| **Mouse** | Look (pointer-lock; click the canvas to lock) |
| **Space** | Jump (with coyote time + jump buffer) |
| **Shift** | Run / sprint (held) |
| **Tab** | Switch which family member you control (cycles, wraps) |
| **E** | Greet the nearest greetable family NPC |
| **1 / 2 / 3** | Emote — `1` wave, `2` cheer, `3` dance (see `EMOTE_SLOT`) |
| **V** | Toggle first-person ↔ third-person camera |
| **Esc** | Toggle pause (also drops pointer lock so the menu is clickable) |

Held movement keys (`WASD`/Space/Shift) come through drei `<KeyboardControls>` and
are read transiently inside the sim via `getKeys()`. The one-shot verbs
(Tab/V/E/1/2/3/Esc) are window keydown handlers in `input/useEdgeKeys.js`, each
edge-triggered (`e.repeat` guarded) with browser defaults suppressed for
Tab/Space/arrows. Mouse-look is owned by `input/usePointerLock.js` (NOT drei
`PointerLockControls`) and writes straight to `cameraRig.yaw/pitch`.

### Mobile / touch
- **Left joystick** (`hud/mobile/TouchJoystick.jsx`) → move vector into `refs.input`.
- **Right-half touch-drag** (`hud/mobile/TouchLook.jsx`) → look, into `cameraRig.yaw/pitch`.
- **On-screen buttons** (`hud/mobile/TouchButtons.jsx`) → jump / greet / switch / emote / camera.
- `LookHint.jsx` is a one-time "drag to look" nudge (stubbed juice).

---

## 3. Architecture (read this twice)

**The one idea:** an **Actor is data + refs**; a **Controller is a pure
`(actor, ctx, dt) => Intent` function**; and **movement physics lives in exactly
ONE place**. Player, NPC, and Idle differ *only* in the Intent they produce —
never in how that Intent is applied. This is what makes switching a one-line ref
swap and what keeps Nibblers pluggable later.

### Actor = data + refs
`actors/actorRegistry.js#createActor` builds a plain object (see `CONTRACTS.md` for
the full shape). The four actors are created **once** at load in `buildRegistry`,
stored in `refs.registry` (a `Map<id, Actor>`), placed at spawns from
`level.meta.json`, and given initial controllers (first = `player`, rest = `npc`).
An Actor carries:
- `motion` — the per-frame truth (`pos` = **feet**, velocities, `facing`, `speed`,
  `grounded`, `animState`, `action`). Mutated in place every frame.
- `ref` — the Rapier/three handles (`rigid`, `collider`, `kcc`, `group`, `mixer`,
  `actions`), filled on mount in `ActorView`/`CharacterModel`.
- `ai` — NPC scratch (home, wanderTo, timers, faceTarget). Ignored while
  player-controlled.
- `controller` — the swappable strategy object.

### Controller = pure intent
A Controller is `{ id, produce(actor, ctx, dt) -> Intent }` and **never touches
Rapier**. The `Intent` is `{ move:{x,z} (WORLD-space XZ, 0..1), run, jump, action }`.
- `PlayerController` maps `ctx.input` + `cameraRig.yaw` into a camera-relative
  world move (it bakes the yaw rotation in, so `stepMotion` does not rotate). Only
  the active player; otherwise returns `EMPTY_INTENT`. It leaves `action: null` —
  emotes are routed separately through the edge keys.
- `NpcController` delegates to `npcAi.npcStep(actor, ctx, dt)` — the FSM
  (`idle → wander → chase → touch → retreat → cooldown`), navmesh-free seek + a
  cheap stuck-escape nudge, with the **safe-zone override checked first**.
- `IdleController` returns `EMPTY_INTENT`.
- `controllers/assign.js#attachController(actor, kind)` is the only thing that
  rewires a controller — it also sets `role` and `fsm`.

### ONE stepMotion (the only KCC apply site)
`systems/stepMotion.js#stepMotion(actor, intent, ctx)` is the **single** place that
calls `kcc.computeColliderMovement`. It runs for *every* actor each frame (player
and NPCs are identical here). It integrates horizontal accel (ground vs air),
gravity + coyote/buffer jump, solves collide-and-slide through the KCC, applies via
`rigid.setNextKinematicTranslation`, then writes back `motion.{pos,vel*,speed,
facing,grounded,lastGroundedT}`. **No other module may call
`computeColliderMovement`.** The KCC filter is fixed:
`EXCLUDE_SENSORS | EXCLUDE_KINEMATIC` (so the four kinematic capsules pass through
each other and ignore the sensor zones).

### ONE GameSystems sim `useFrame`
`scene/GameSystems.jsx` owns the **single** simulation `useFrame` (default
priority). It builds the per-frame `ctx` once and runs the fixed update order
(below). It renders nothing. **Do not add another simulation `useFrame`** anywhere
— new systems hang off this one.

### Refs vs atoms (the hard split)
- **Plain mutable refs** (`state/refs.js`): `registry, input, cameraRig, levelMeta,
  clock`. This is the 60–144 fps truth. Modules import them by reference and mutate
  fields in place. **Never** put per-frame data in React state or Jotai — it would
  thrash re-renders.
- **Jotai atoms** (`state/atoms.js`): **discrete UI state only** (phase, score,
  greeted, cameraMode, currentZone, nearbyGreetable, roles, npcStates, …). Written
  **change-gated at event boundaries** in `systems/commitReactive.js` — *never*
  every frame. The Canvas/systems read/write the store imperatively via
  `daHilgStore.get/set` (`state/store.js`); the DOM HUD subscribes via hooks.
- **Transient pulses** (hit-markers, toasts) go through `hud/hudEvents.js`
  (`emit('greetHit')`, `pushToast(text, kind)`), **not** atoms.

### Update order (GameSystems `useFrame`, default priority — BEFORE cameras)
```
1. clock.now/dt (clamp dt to DT_CLAMP); updateInput(getKeys)
2. build ctx { store, world, rapier, registry, input, cameraRig, levelMeta, now, dt, activePlayerId }
3. per actor: snap-once (trySnapActor) → intent = controller.produce(actor, ctx, dt) → stepMotion(actor, intent, ctx)
4. per actor: updateAnimation(actor, dt)     // reads motion produced in step 3, strictly after
5. flushZones(ctx)                            // drain sensor queue → zonesActive + toasts
6. updateGreet(ctx)                           // ~5 Hz proximity scan
7. commitReactive(ctx)                        // the ONLY React-facing writes, change-gated
```
The sim is gated on `levelMeta.loaded && registry.size > 0` and short-circuits when
paused (the camera keeps reading the frozen refs).

### Cameras at priority 10 + the manual RenderLoop at priority 100
`camera/CameraRig.jsx` runs in a `useFrame(..., 10)` so it positions the camera
*after* the sim has moved bodies this frame. It is **read-only** with respect to
game state — it only writes the three.js camera. First-person: eye at
`feet + EYE_HEIGHT`, quaternion from `(pitch, yaw, 'YXZ')`, `near = FP_NEAR` (the
near-plane clips the player's own head — **no bone hacks**). Third-person: a
collision-avoided boom behind a shoulder pivot via one backward `world.castRay`,
smoothed, `near = TP_NEAR`. It reads `cameraModeAtom` imperatively (no re-render).

**Crucial consequence:** the moment any `useFrame` uses a *numeric* priority, R3F
stops auto-rendering and rendering becomes *our* job. `scene/RenderLoop.jsx` does
the manual `gl.render(scene, camera)` at **priority 100** (after sim at 0 and
camera at 10). If you ever remove the CameraRig priority or the RenderLoop, the
screen goes black — see Known Gotchas.

---

## 4. File layout (one line each)

```
src/da-hilg/
  index.js                  default-exports DaHilgApp (the lazy entry main.jsx mounts)
  DaHilgApp.jsx             root composition: Provider + HUD + KeyboardControls > Canvas + input hooks
  constants.js              ALL tunables (units = m / s / rad); no magic numbers elsewhere
  fonts.css                 HUD typeface @font-face (AGC + Chakra)
  CONTRACTS.md              authoritative module interface contract — do not deviate
  AGENTS.md / CLAUDE.md     this guide + its short pointer

  scene/
    Scene.jsx               <Physics gravity=[0,0,0]> host: Level, Zones, Actors, GameSystems, CameraRig, RenderLoop
    SceneEnv.jsx            dusk fog, hemi+dir light, ACES tone mapping, sky tint
    GameSystems.jsx         the ONE simulation useFrame (update order above); renders null
    RenderLoop.jsx          the manual gl.render pass at priority 100 (required by CameraRig's numeric priority)

  level/
    Level.jsx               loads level GLB, recenters, hides Collision_*/LOD_*, bakes ONE fixed trimesh collider
    levelMeta.js            useLevelMeta() fetches level.meta.json into refs.levelMeta (offset/groundY/spawns/houseBox)

  actors/
    actorRegistry.js        createActor / buildRegistry / getActor / forEachActor (registry built ONCE)
    Actors.jsx              ensures registry built; renders an <ActorView/> per actor
    ActorView.jsx           kinematicPosition RigidBody + CapsuleCollider + CharacterModel; creates/cleans the KCC; name on RigidBody ONLY
    CharacterModel.jsx      useGLTF + SkeletonUtils.clone; binds the 7 clips; FP head handled by near-plane (no bone hide)

  controllers/
    Controller.js           Intent typedef + CONTROLLERS registry + EMPTY_INTENT
    PlayerController.js      camera-relative move for the active player (bakes yaw)
    NpcController.js         delegates to npcAi.npcStep
    IdleController.js        returns EMPTY_INTENT
    assign.js               attachController(actor, kind) — the only controller rewire (sets role + fsm)

  systems/
    stepMotion.js           THE single KCC apply site (no other module calls computeColliderMovement)
    spawnSnap.js            trySnapActor — raycast each actor onto the hill terrain before its first step
    animationSystem.js      updateAnimation (speed→clip crossfade) + requestEmote
    npcAi.js                the NPC FSM (idle/wander/chase/touch/retreat/cooldown) + seek + stuck-escape
    pointsOfInterest.js     buildPOIs(levelMeta) + pickWander(actor, ctx)
    zoneSystem.js           flushZones — drain sensor queue → zonesActive + trigger toasts + display zone
    greetSystem.js          updateGreet (~5 Hz scan) + requestGreet (E) + onNpcTouch; win check
    switchSystem.js         switchTo / cycleSwitch — swap controllers + retarget camera
    commitReactive.js       change-gated atom writes (the only React-facing writes)

  camera/
    CameraRig.jsx           the one camera, priority 10, read-only on game state (FP near-plane / TP boom)
    cameraRig.js            pure helpers (clampPitch, forwardFromYaw, eyeOffset)

  input/
    keyMap.js               drei KeyboardControls map (forward/back/left/right/jump/run)
    useInput.js             updateInput(getKeys) — merges keyboard + joystick into refs.input each frame
    useEdgeKeys.js          window keydown for the one-shot verbs (Tab/V/E/1-3/Esc)
    usePointerLock.js       owns pointer-lock + mousemove → cameraRig.yaw/pitch (NOT drei PointerLockControls)

  animation/
    clips.js                canonical 7-clip manifest (CLIP_KEYS, CLIP_LOOP, EMOTE_HELD, EMOTE_SLOT)
    useCharacterClips.js    binds the 7 anim GLBs onto a cloned skeleton via one AnimationMixer

  zones/
    zoneRegistry.js         plain registry: actorZones, byId, queue; playerIsSafe / playerNoticeGroups / actorInZoneType
    zoneEvents.js           tiny on/off/emit emitter for trigger-zone events
    Zone.jsx                generic <Zone type ...> — fixed RigidBody + sensor CuboidCollider; enqueues enter/exit
    Zones.jsx               maps buildZoneConfig(levelMeta) → <Zone/>
    zoneConfig.js           the zone defs (home_safe auto-fit from houseBox; notice; triggers; a reserved danger stub)

  state/
    store.js                daHilgStore (jotai createStore) shared by HUD + Canvas
    atoms.js                discrete UI atoms (event-boundary writes only)
    refs.js                 plain mutable singletons: registry, input, cameraRig, levelMeta, clock

  hud/                      DOM overlay (pointer-events: wrapper none / widgets auto); styled to tokens in hud.css
    DaHilgHud.jsx           overlay root; owns LoadingVeil / LockOverlay via atoms
    Crosshair, StateStrip, ObjectiveStrip, CharacterBar, EmoteWheel, InteractPrompt,
    HudMenu, ToastFeed, LockOverlay, LoadingVeil, CelebrationBanner
    ProgressBridge.jsx      bridges drei useProgress → loadProgressAtom
    hudEvents.js            transient pulses: emit('greetHit') / pushToast(text, kind)
    mobile/                 TouchJoystick, TouchLook, TouchButtons, LookHint

  audio/
    sfx.js                  tiny gesture-gated WebAudio helper (stub no-ops first)
```

Integration files **outside** the module (the only ones): `src/main.jsx` (root
switch), `src/pages/MenuPage.jsx` (menu card), `public/sw.js` (bump `VERSION` on
ship).

---

## 5. Asset pipeline

The runtime serves **optimized, tracked** assets from `public/da-hilg/`. They are
regenerated from the read-only source GLBs by:

```
npm run build:dahilg-assets        # → node scripts/build_dahilg_assets.mjs
```

Every shipped GLB is **meshopt geometry-compressed** (`EXT_meshopt_compression`) and
its textures are **KTX2 / Basis Universal** (`KHR_texture_basisu`) — GPU-compressed,
so they stay compressed in VRAM (~8× less than RGBA-decoded webp) and upload fast.
Everything is **offline-decodable**: meshopt via three's built-in `MeshoptDecoder`,
KTX2 via a **local** basis transcoder in `public/da-hilg/basis/` (no CDN, no Draco).

Outputs:

- `level.glb` — the neighborhood. `Collision_*` meshes preserved (hidden, used only to
  bake the collider) but their **materials are stripped** (visual/collision separation
  — physics geometry ships no texture payload); `LOD_Buildings_Low` dropped.
- `mike.glb`, `kelli.glb`, `cece.glb`, `drew.glb` — the 4 characters (embedded clips
  removed; skinned-safe quantization).
- `anims/{idle,walk,run,jump,dance,wave,cheer}.glb` — the **7 canonical clips**,
  clip-only, renamed to the canonical key, with `stripRootXZ` applied to walk/run at
  build time. Skin-safe retarget: every clip **drops non-`Hips` translation channels**
  (keeps rotations + Hips root motion), so a clip authored on one character binds to
  any of the four without tearing the torso off the hips. (All four share a 24-bone
  Mixamo rig but **not** identical bind transforms — see the skin-safe note below.)
- `level.meta.json` — **computed at build time**, never hand-edited: `offset`,
  `groundY`, `houseCenter`, `houseBox`, `spawns`, `npcSpawns`.

**Per-class texture caps:** the landscape caps at **1024**, characters at **512** (a
1.7 m rig never needs more). Set in `meshoptPipeline(doc, label, quant, texCap)`.

Pipeline order inside the script: `dedup → prune({keepLeaves:true}) → weld →
[ktx2CompressDoc | webp fallback] → reorder(MeshoptEncoder) → quantize →
EXT_meshopt_compression.setRequired(true) → write`. KTX2 encoding lives in
`scripts/lib/ktx2_pass.mjs` and shells out to **`basisu`** (preferred) or `toktx`
(`brew install basis_universal`). **If no encoder is on PATH it transparently falls
back to webp** and logs how to enable KTX2 — the build never fails for a missing
encoder. The NodeIO registers the Draco **decoder** only to *read* the
mixed-compressed sources; nothing Draco is written out. The build **asserts**: (a) no
output declares `KHR_draco_mesh_compression`; (b) every clip binds to the reference
rig with 0 unmatched tracks; (c) no clip keeps a non-`Hips` translation channel (the
skin-safe guard). It fails loudly if any trips.

**Runtime loading** goes through `loaders.js` (`useDaHilgGLTF` / `<DaHilgPreloader>`),
which attaches a `KTX2Loader` pointed at the local transcoder and the meshopt decoder,
with `useDraco=false`. KTX2's `detectSupport` needs the live renderer, so preloading
is done inside the Canvas by `<DaHilgPreloader>`, not at module scope.

> **Skin-safe retarget (the waist bug):** a Mixamo clip bakes a `translation` track for
> *every* bone holding the **source** character's rest offsets. Bound onto a character
> with a different bind, those tracks yank the torso-root bone off the hips (a floating
> torso / waist gap). The build drops every non-`Hips` translation channel — rotations
> carry the real motion and are bind-agnostic. If you re-author the clip pipeline, keep
> assertion (c).

The **Nibblers swarm** has its own pipeline (`npm run build:nibbler-vat`,
`build:minimap`) — see `nibblers/AGENTS.md`.

There is a dev fast-path (`DEV_RAW_LEVEL` in `constants.js`, default `false`) to load
the raw uncompressed level export while the meshopt pipeline is mid-tune.

**How-to guides:** adding a playable/NPC character → `docs/dahilg-adding-a-character.md`;
improving the neighborhood GLB export (sidewalks, facades, creek, re-export) →
`docs/dahilg-neighborhood-export.md`.

---

## 6. The critical distinction: FRAMEWORK vs CONTENT

Hold this line clearly when you extend the codebase — it is the whole reason the
project is structured this way.

**GAME-INFRASTRUCTURE / FRAMEWORK** (reusable; the thing the next game inherits):
- The **Actor = data + refs** model and the registry plumbing (`actorRegistry`,
  `Actors`, `ActorView`, `CharacterModel`).
- The **Controller** contract + `CONTROLLERS` registry + `attachController`.
- The **single `stepMotion` KCC apply**, the **single `GameSystems` sim loop**, and
  the fixed update order.
- The **camera** (FP + TP) at priority 10 and the manual RenderLoop at priority 100.
- The **zone** system (generic `<Zone type>`, registry, sensor queue, flush).
- The **HUD** overlay framework + `hudEvents` + the refs/atoms split + `store`.
- The **input** layer (keyboard map, pointer lock, edge keys, touch).
- The **asset build script** as a reusable pipeline shape.

**GAME-CONTENT / ASSETS** (specific to *Da Hilg*; what you swap to make a new game):
- The level GLB and the four character GLBs + the 7 animation clips.
- The specific **greet-the-family game loop**: `greetSystem` (greet → emote + score
  → win), the family-flavored `npcAi` chase/tag/retreat, the score/greeted/won atoms,
  the celebration banner, the specific `zoneConfig` (home_safe / street_notice /
  landmark triggers).
- The character roster + labels + blurbs in `constants.js`.

When you build a new game on this framework, you keep the left column and replace
the right column. **Gameplay is meant to be a pluggable "mode," not a fork.** If you
find yourself editing `stepMotion`, the update order, or the camera to add *game*
behavior, stop — that behavior almost certainly belongs in a controller, a system,
or a zone, not in the framework spine.

---

## 7. HARD RULE: total isolation from the old app

This module imports **NOTHING** from `src/engine`, `src/controls`, `src/player`,
`src/lib`, `src/pages`, or `src/ui`. It is a fully separate application from the old
Drive/Scoop app. The only allowed imports are **within `src/da-hilg/**`** and from
`node_modules`. (Reusing the old app's *raw assets* — the source GLBs and fonts — is
fine; importing its *code* is not.)

A quick guard you can run:
```
rg -n "src/(engine|controls|player|lib|pages|ui)" src/da-hilg/   # must be empty
```

### How it's mounted (true isolation)
- `src/main.jsx` is a **root switch**: if `location.pathname.startsWith('/da-hilg')`
  it lazy-`import('./da-hilg/index.js')` and renders `<DaHilgApp/>`; otherwise it
  lazy-imports the old `App.jsx`. The old `EngineProvider` is **never constructed**
  on `/da-hilg`, so there is exactly one WebGL context alive. Both roots are lazy so
  neither bundle ships to the other.
- `src/pages/MenuPage.jsx` has one menu card that does
  `window.location.assign('/da-hilg')` — a **hard navigation** (not a router push) so
  the root switch runs and the old engine disposes before this one mounts.
- **No StrictMode** anywhere up the tree (each world builds in its mount effect and
  must not double-construct).
- On ship, bump `VERSION` in `public/sw.js`.

---

## 8. Nibblers-readiness

This framework is a deliberate foundation for the next game, **Nibblers** (a
third-person exploration game with hidden danger zones, a "Marked" state, and swarms
of 200+ mini-clones that converge and drain health). The seams are already in place
so Nibblers layers on **without a rewrite**:

- **Third-person is first-class.** The camera already supports FP/TP (`CameraRig`);
  Nibblers will default to TP. No camera rework needed.
- **A `'danger'` zone type exists.** `ZONE_TYPES` in `constants.js` includes
  `'danger'` (and `'damage'`, `'speed'`, `'noCombat'`), and the generic `<Zone type>`
  + registry already track membership for any type. `zoneConfig.js` ships a
  commented-out `nibbler_den` danger-zone stub — uncomment and place it; no
  zone-*code* changes needed. There is a reserved `markedAtom` (inert now).
- **Health-drain hooks are present but inert:** `healthAtom` (per-character) and an
  `Actor.health` field exist now and do nothing yet. `HEALTH_MAX` is in `constants.js`.
- **Gameplay is structured as a pluggable mode**, so Nibblers plugs in as another
  mode rather than a fork (see §6).
- A **minimap HUD slot** is reserved in the HUD layout.

> **NOTE — the swarm is NOT a registry actor.** The `Actor`/registry model and the
> per-actor skinned-mesh path (`ActorView` + `CharacterModel`, one `AnimationMixer`
> each) are for the **≤4 named family actors only**. Nibblers' 200+ mini-character
> horde **must** be a **separate, high-performance system** —
> `InstancedMesh` / vertex-animation-texture (VAT) — and **must NOT** be routed
> through the per-actor skinned-mesh registry. Do not try to scale the family
> registry to hundreds of bodies; that path runs one skinned mesh + one mixer per
> actor and will not survive 200 of them. Build the swarm as its own instanced
> system that reads the same `refs`/`ctx` world, and keep the named-actor registry
> small.

---

## 9. Known gotchas

- **Meshopt int16 collision bake — read via `fromBufferAttribute`, never
  `applyMatrix4` in place.** The level GLB uses `KHR_mesh_quantization`, so each
  `Collision_*` mesh's positions are int16/normalized (-1..1) and the real-world
  scale lives on the node matrix. `level/Level.jsx#bakeCollider` reads each vertex
  with `v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld)` into a **fresh
  Float32Array**. If you instead transform the geometry *in place*
  (`geometry.applyMatrix4(...)`), you write back into the int16 buffer and clamp the
  whole world to ±1 meter — the collider collapses to a tiny crumpled sheet and
  everyone falls through. The collider is baked **after** the recenter group is
  committed (one deferred frame) and mounted at identity so there is exactly one
  recenter.

- **CameraRig's numeric priority requires the manual RenderLoop.** R3F auto-renders
  *only* while no `useFrame` uses a numeric priority. `CameraRig` runs at priority
  10, which flips R3F into manual-render mode — so `scene/RenderLoop.jsx` does the
  `gl.render(scene, camera)` at priority 100 (after sim at 0 and camera at 10). If
  you remove the RenderLoop, or drop the camera's priority, **the screen goes
  black**. Any new camera/render-ordering work must preserve this: sim (0) →
  camera (10) → render (100).

- **The hill spawn-snap.** "Da Hilg" is a *hill*. `level.meta.json`'s `groundY` is
  the **global** terrain minimum (the creek bed), so recentered spawn points sit at
  `y ≈ 0` while the house terrain is ~10 m higher; the KCC's snap-to-ground only
  reaches 0.3 m. So `systems/spawnSnap.js#trySnapActor` raycasts straight **down**
  from high above each actor's spawn XZ onto the fixed level collider and places its
  feet on the real surface **before its first sim step**. The sim **skips** an actor
  until `actor.ref._snapped` is true (it returns early in step 3), so nobody sims
  while buried in the hillside, and the snap re-anchors the NPC's `ai.home` to the
  true spawn height. If actors spawn underground or float, check that the collider
  is built and the snap raycast is hitting (it ignores kinematic capsules + sensors
  via `EXCLUDE_KINEMATIC | EXCLUDE_SENSORS`).

- **Physics starts paused.** `Scene.jsx` mounts `<Physics paused>` and releases one
  frame after `levelMeta.loaded`, so freshly-spawned capsules don't free-fall before
  the trimesh collider exists. World `gravity` is `[0,0,0]` on purpose — the
  capsules are kinematic and `stepMotion` does its own gravity.

- **`name` is set once, on the RigidBody only.** Zone sensors match by
  `other.rigidBodyObject?.name === actor.id`. Setting `name` on the inner group too
  would make that match ambiguous — don't.

- **`getKeys`, never the subscribe form.** `GameSystems` reads keyboard via the
  transient `getKeys()` from `useKeyboardControls()`. The subscribe form re-renders
  and has no place in the hot loop.
