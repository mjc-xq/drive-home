# Da Hilg — Module Contracts (authoritative)

This file pins the interfaces every module implements so the codebase stays coherent.
**Do not deviate from these signatures.** Stack: React 18.3 (no StrictMode), three 0.184,
@react-three/fiber 8.18, @react-three/drei 9.122, @react-three/rapier 1.5,
@dimforge/rapier3d-compat 0.14, jotai 2.20. **Plain `.jsx`/`.js`, JSDoc types only — no TypeScript.**

## Hard rules
- **Imports:** ONLY from within `src/da-hilg/**` and node_modules. NEVER import from
  `src/engine`, `src/controls`, `src/player`, `src/lib`, `src/pages`, or `src/ui`.
- **Per-frame data is plain refs** (`state/refs.js`): `registry, input, cameraRig, levelMeta, clock`.
  Mutate in place. NEVER put per-frame data in React state or Jotai.
- **Jotai atoms** (`state/atoms.js`) are discrete UI state only, written change-gated in
  `systems/commitReactive.js` at event boundaries — never every frame. Read the shared store
  imperatively inside systems via `daHilgStore.get/set` (from `state/store.js`); HUD uses hooks.
- One simulation `useFrame` lives in `scene/GameSystems.jsx`. Cameras are read-only at `priority 10`.
- One Rapier KCC apply site: `systems/stepMotion.js`. No other module calls `computeColliderMovement`.

## The `ctx` object (built once per frame in GameSystems, passed to controllers + systems)
```js
ctx = {
  store,            // daHilgStore (jotai)
  world,            // rapier world (from useRapier().world)
  rapier,           // rapier module (from useRapier().rapier) — for QueryFilterFlags etc.
  registry,         // refs.registry  (Map<id, Actor>)
  input,            // refs.input
  cameraRig,        // refs.cameraRig
  levelMeta,        // refs.levelMeta
  now,              // ms (performance.now-ish, from clock.now)
  dt,               // clamped seconds (<= DT_CLAMP)
  activePlayerId,   // string
}
```

## Actor shape (created by `actors/actorRegistry.js#createActor`)
```js
Actor = {
  id, character,            // both 'mike'|'kelli'|'cece'|'drew'
  role: 'player'|'npc',
  greeted: false,
  health: 100,
  fsm: 'idle'|'wander'|'chase'|'touch'|'retreat'|'cooldown'|'controlled',
  ref: { rigid:null, collider:null, kcc:null, group:null, mixer:null,
         actions:{}/*clipKey->AnimationAction*/, current:null/*current animState*/ },
  motion: { pos:Vector3, velX:0, velY:0, velZ:0, facing:0, speed:0,
            grounded:true, lastGroundedT:0, animState:'idle', action:null,
            actionUntil:0, jumpBufferedT:-1 },
  ai: { target:null, timer:0, retreatUntil:0, cooldownUntil:0, scanAt:0,
        home:Vector3, wanderTo:null, dwellUntil:0, faceTarget:null,
        stuckT:0, group:'family' },
  zonesActive: new Set(),   // zone ids this actor currently overlaps
  controller: null,         // strategy object from CONTROLLERS (assigned via assign.js)
}
```

## Module signatures

### controllers/
- `PlayerController` (named export, object) `{ id:'player', produce(actor, ctx, dt): Intent }`
  Builds camera-relative move from `ctx.input` + `ctx.cameraRig.yaw`; sets `run`, `jump` (edge),
  `action` from queued emote (read a small module-level queue set by input edge keys, or expose
  `requestEmote`). Only the active player; if `actor.role!=='player'` return `EMPTY_INTENT`.
- `NpcController` `{ id:'npc', produce(actor, ctx, dt): Intent }` — delegates to `npcAi.npcStep(actor, ctx, dt)`.
- `IdleController` `{ id:'idle', produce(): Intent }` — returns `EMPTY_INTENT`.
- `assign.js`: `export function attachController(actor, kind)` — sets `actor.controller = CONTROLLERS[kind]`,
  `actor.role = kind==='player'?'player':'npc'`, and `actor.fsm = kind==='player'?'controlled':'cooldown'`.

### systems/
- `stepMotion.js`: `export function stepMotion(actor, intent, ctx)` — THE only KCC apply.
  Camera-relative already baked into `intent.move` (world XZ). Integrate accel (ground/air),
  gravity + coyote/buffer jump, then:
  `kcc.computeColliderMovement(collider, desired, rapier.QueryFilterFlags.EXCLUDE_SENSORS | rapier.QueryFilterFlags.EXCLUDE_KINEMATIC, undefined, undefined)`,
  read `kcc.computedMovement()`, `rigid.setNextKinematicTranslation(t+mv)`, `kcc.computedGrounded()` resets velY.
  Writes `actor.motion.{pos,velX,velY,velZ,speed,facing,grounded,lastGroundedT}`. Face: player follows
  camera yaw; NPC follows travel direction (slerp). Clamp `dt` is already done by caller.
- `animationSystem.js`: `export function updateAnimation(actor, dt)` — pick animState from
  `actor.motion.speed`/`grounded`/`action` (priority: jump>emote>run/walk/idle), crossfade via
  `next.reset().fadeIn(d).play(); current?.fadeOut(d)`, then `actor.ref.mixer.update(dt)`.
  `export function requestEmote(actor, key, opts)` — set `actor.motion.action` (held per CLIP_LOOP/EMOTE_HELD),
  optional `faceTarget`. One-shot emotes clear on mixer 'finished' (wire in CharacterModel or here via flag).
- `npcAi.js`: `export function npcStep(actor, ctx, dt): Intent` — the FSM (idle/wander/chase/touch/retreat/cooldown),
  uses `zoneRegistry.playerIsSafe()`, `playerNoticeGroups()`, NOTICE_RADIUS, TOUCH_DIST, timers from constants.
  On `touch` calls `greetSystem.onNpcTouch(actor, ctx)`. Uses `pointsOfInterest.pickWander(actor, ctx)`.
- `pointsOfInterest.js`: `export function buildPOIs(levelMeta)`, `export function pickWander(actor, ctx)` (returns Vector3 + optional emote/lookAt).
- `zoneSystem.js`: `export function flushZones(ctx)` — drains the queued sensor events from
  `zones/zoneRegistry.js`, updates each actor's `zonesActive` + the registry, fires toasts via
  `hud/hudEvents.js` for trigger zones, computes the active player's display zone.
- `greetSystem.js`: `export function updateGreet(ctx)` (proximity scan ~5 Hz; set/clear nearbyGreetable),
  `export function requestGreet(ctx)` (player pressed E — greet nearest), `export function onNpcTouch(actor, ctx)`.
  Greet: mark greeted, score++, NPC faces player + plays wave/cheer, toast + hudEvents 'greetHit', win check.
- `switchSystem.js`: `export function switchTo(nextId, ctx)`, `export function cycleSwitch(ctx, dir=1)`.
  Reassign controllers (attachController prev→'npc', next→'player'), grace cooldown, `cameraRig.targetId=nextId`,
  `cameraRig.yaw=next.motion.facing`, write `activePlayerIdAtom`.
- `commitReactive.js`: `export function commitReactive(ctx)` — change-gated writes of
  activePlayerId(if not already), score, greeted, currentZone, playerState, npcStates, nearbyGreetable, roles, gamePhase.

### camera/
- `CameraRig.jsx` — `<CameraRig/>` default export. `useFrame(()=>{...}, 10)` reads `cameraRig` +
  active actor's `motion.pos`. FP: set cam quaternion from (pitch,yaw,'YXZ'), pos = feet+EYE_HEIGHT,
  near=FP_NEAR (head clipped — NO bone hacks). TP: boom behind TP pivot, one backward `world.castRay`
  collision-avoid, smooth boom, `cam.lookAt(pivot)`, near=TP_NEAR. Reads `cameraModeAtom` for FP/TP.
- `cameraRig.js` — small pure helpers (clampPitch, forwardFromYaw, eyeOffset).

### input/
- `keyMap.js` — drei KeyboardControls map: forward/back/left/right/jump/run.
- `useInput.js` — `export function updateInput(getKeys)` mutates `refs.input` from held keys + joystick ref.
  Called at top of GameSystems each frame with drei `getKeys`.
- `useEdgeKeys.js` — `export function useEdgeKeys(ctx)` React hook: window keydown for Tab(switch)/V(camera)/
  E(greet)/1/2/3(emote)/Esc(pause), `e.repeat` guard + preventDefault on Tab/Space/arrows. Calls switchSystem/greet/etc.
- `usePointerLock.js` — `export function usePointerLock()` hook: owns pointerlock lifecycle + mousemove →
  `cameraRig.yaw/pitch` (clamped), writes `pointerLockedAtom`. NOT drei PointerLockControls.

### level/
- `levelMeta.js` — `export function useLevelMeta()` loads LEVEL_META_URL into `refs.levelMeta` (or DEV defaults), returns ready bool.
- `Level.jsx` — `<Level/>`: `useGLTF(LEVEL_URL)` (meshopt auto-decoded). Recenter via `<group position={[-ox,-oy,-oz]}>`.
  Traverse: `Collision_*` → visible=false + collect; build ONE fixed trimesh `<MeshCollider type="trimesh">` from them;
  drop/ignore `LOD_*`. Visual meshes castShadow=false on terrain. DEV_RAW_LEVEL path loads raw export via ?url import.

### actors/
- `actorRegistry.js` — `export function createActor(id)`, `export function buildRegistry(levelMeta)`
  (fills `refs.registry`, sets motion.pos from spawns/npcSpawns, attaches initial controllers: first='player' rest='npc',
  sets cameraRig.targetId), `export function getActor(id)`, `export function forEachActor(fn)`.
- `Actors.jsx` — `<Actors/>`: ensures registry built; renders `<ActorView actor key=id/>` for each.
- `ActorView.jsx` — `<ActorView actor/>`: `<RigidBody type="kinematicPosition" name={actor.id} colliders={false}
  enabledRotations={[false,false,false]}>` + `<CapsuleCollider args={[CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS]}/>` +
  `<CharacterModel/>`. On mount wires `actor.ref.{rigid,collider,group}` and creates KCC (paired cleanup); set name ONLY on RigidBody.
- `CharacterModel.jsx` — `<CharacterModel actor/>`: `useGLTF(CHARACTER_URL[actor.character])`,
  `SkeletonUtils.clone(scene)` (own instance), `useCharacterClips` to retarget/bind the 8 anim actions onto its skeleton,
  store `actor.ref.{group,mixer,actions}`. No FP head-bone manipulation (camera near-plane handles it).

### animation/
- `useCharacterClips.js` — `export function useCharacterClips(clonedScene, character)` → `{ mixer, actions }`
  retargeting the 8 anim GLBs (ANIM_URL) through source/target rest poses, then binding onto
  `clonedScene`'s skeleton via one AnimationMixer; loop modes per CLIP_LOOP.

### zones/
- `zoneRegistry.js` — plain registry: `actorZones:Map<id,Set>`, `byId:Map<id,def>`, queue array.
  `enqueueZoneEvent(kind/*'enter'|'exit'*/, zoneId, actorId)`, `drainQueue()`, `registerZone(def)/unregisterZone(id)`,
  `playerIsSafe()`, `playerNoticeGroups():Set`, `actorInZoneType(id,type)`, `speedMultiplierFor(id)` (returns 1 for now).
- `zoneEvents.js` — tiny emitter `on(event,fn)/off/emit(event,payload)` for trigger zone events.
- `Zone.jsx` — `<Zone id type position size npcGroup event label active>`: fixed RigidBody + sensor CuboidCollider
  (`args=[w/2,h/2,d/2]`), `onIntersectionEnter/Exit` filter by `other.rigidBodyObject?.name` → `enqueueZoneEvent`.
  Registers def on mount. (Generic — type covers safe/notice/trigger/danger/...; no separate wrapper components.)
- `Zones.jsx` — maps `zoneConfig` → `<Zone/>`. `zoneConfig.js` — array of zone defs (recentered coords, home_safe auto-fit from levelMeta.houseBox).

### scene/
- `Scene.jsx` — `<Physics>` host: `<Level/> <Zones/> <Actors/> <GameSystems/>`. Physics `paused` until collider ready then flip.
- `SceneEnv.jsx` — dusk fog, hemi+dir light, ACES tone mapping, sky tint.
- `GameSystems.jsx` — the ONE sim `useFrame` (default priority). Order per "Update order" below. Renders null.

### hud/  (DOM overlay; styled to tokens in hud.css + fonts.css)
Components per plan §9.2. Subscribe to atoms via hooks; pointer-events discipline (wrapper none, widgets auto).
Transient pulses via `hudEvents.js` (`emit('greetHit')`, `pushToast(text,kind)`), NOT atoms.

### audio/
- `sfx.js` — tiny WebAudio helper, gesture-gated. Stub no-op functions first; real sounds later.

## Update order (GameSystems useFrame, default priority — BEFORE cameras at priority 10)
```
1. clock.now/dt (clamp dt); updateInput(getKeys)         // refs.input from keyboard+joystick
2. build ctx
3. for each actor: intent = actor.controller.produce(actor, ctx, dt); stepMotion(actor, intent, ctx)
4. for each actor: updateAnimation(actor, dt)
5. flushZones(ctx)                                        // drain sensor queue → zonesActive + toasts
6. updateGreet(ctx)                                       // ~5Hz proximity scan
7. commitReactive(ctx)                                    // change-gated atom writes
// CameraRig runs separately at priority 10 (after movement); usePointerLock + touch write cameraRig directly.
```

## Spec → atom mapping
- spec `gameMode` → `gamePhaseAtom`; spec `selectedCharacter`/`activePlayerId` → `activePlayerIdAtom`;
  spec `actors` → `refs.registry`; spec zones-per-actor → `actor.zonesActive` + `zoneRegistry.actorZones`.
