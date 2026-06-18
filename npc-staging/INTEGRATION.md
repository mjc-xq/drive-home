# Mobile-Controls + NPC-Brain Integration Recipe

Single handoff doc for wiring the staged modules under `src/controls/`, `src/player/`,
`src/ui/` and `src/engine/npc-brain.js` into the live engine **once the engine
decomposition refactor settles**.

The engine is mid-refactor. **Do NOT start any of this until the refactor lands** —
`ctx.inp2`, `ctx.follow`, `ctx.CHAR`, `ctx.car`, `ctx.npcs`, and the per-mode update
loops are the moving parts and they will shift. This recipe targets the shapes those
have *today* (see "Engine surface" below) and flags every spot that depends on them.

---

## 0. READ THIS FIRST — status of the consistency-pass blockers

1. **`InputManager.js` API mismatch — ✅ FIXED (post-review).** `InputManager` was
   rewritten to use the leaf modules' ACTUAL APIs (`joystick.start/move/end/.value`,
   `look.start/move/end/consume()→{lookX,lookY}`, `pinch.addPointer/movePointer/
   removePointer/wheel/consume()`, `keyboard.update(state)`, `OrientationManager({onChange})
   /.current`), and the pinch model now lets `PinchZoomController` own its own pointer set.
   Verified: the whole graph imports + runs (`node` ESM smoke test); a 2nd finger ends the
   single-finger gesture; one-frame `requestJump()` added for the mobile button. Appendix A
   is kept for the historical call-site→fix table but **no longer needs action**.

2. **`npc-brain.js` reads `ctrl.idleClip` / `ctrl.lookClip` (still TODO at integration).**
   `makeController` (drew.js) never sets them; every access is guarded so the NPCs run, but
   dad's "idle" falls through to `locomotion(0)` → `DAD_NAME_MAP.idle = 'Arm_Circle_Shuffle'`
   — a *dance*, not a stand. Apply the exact dad.js / mom.js edits in [Appendix B](#appendix-b--npc-brain-controller-clip-gaps)
   when wiring (verify the clip names against each GLB's `g.animations`).

Everything else (TouchJoystick, CameraLookController, PinchZoomController,
KeyboardControls, OrientationManager, ThirdPersonCamera, CharacterController,
MobileControls, npc-brain core) is internally consistent and imports the exact names from
`src/controls/types.js`. Syntax-checked clean (`node --check`) for all 10 files.

---

## 1. The shared plan — ONE InputState, mapped onto `ctx.inp2`

The whole point of the staged stack is: **one** `InputManager` owns **one** shared
`InputState` (from `createInputState()`), and BOTH modes (scoop + drive) read from it.
There must be **no duplicated movement/look/zoom logic** — the legacy pointer handlers in
`src/engine/controls/controls.js` get retired for the new modes.

### 1.1 Construct once, in engine init

```js
// engine.js init, after the canvas exists and after ctx.inp2 is created (~line 904).
import { InputManager } from '../controls/InputManager.js';

ctx.im = new InputManager(ctx.renderer.domElement, {
  orientation: 'portrait',   // seeded; OrientationManager corrects it on first flip
  keyboard: true,            // desktop WASD/space; harmless on touch
  wheel: true,               // desktop wheel -> zoom
});
// CSS prerequisite: the canvas MUST have `touch-action: none` or the browser steals
// pinch/scroll. Confirm in styles.css (the existing canvas rule likely already sets it
// for the legacy handlers — keep it).
```

`ctx.im.state` is the single `InputState`. `ctx.im.update(dt)` folds joystick + keyboard +
look + pinch into it. `ctx.im.joystick` is the render-state the HUD reads. `ctx.im.dispose()`
goes in the engine teardown next to the other disposes (~line 1408).

### 1.2 The bridge function — InputState -> ctx.inp2 (the ONLY mapping)

Add ONE helper, called once per frame at the very top of the main loop (before
`updateScoop`/`updateDrive`), so both modes consume the same input with zero duplication:

```js
// One mapping, both modes. InputState is camera-relative + accumulated; ctx.inp2 is the
// engine's existing aggregate bag. We translate, we do NOT re-derive movement.
function pumpInput(dt) {
  ctx.im.update(dt);                 // joystick+kbd -> moveX/moveY (persist);
                                     // look -> lookX/lookY (consumed); pinch/wheel -> zoomDelta (consumed)
  const s = ctx.im.state;

  // ORIENTATION: keep engine + InputManager agreeing (drives CAMERA_PRESET/LOOK_SENS rows).
  if (s.orientation !== ctx._orient) ctx.fn.setOrientation(s.orientation);

  // MOVE — persisted camera-relative axes -> the stick channel of inp2.
  //   In SCOOP these feed CharacterController directly (see §2), so we DON'T also write jx/jy.
  //   In DRIVE moveY=throttle intent, moveX=steer intent (see §3).
  if (ctx.mode === 'scoop') {
    // CharacterController reads s.moveX/s.moveY itself; nothing to copy here.
  } else if (ctx.mode === 'drive') {
    ctx.inp2.jx = s.moveX;           // steer axis  (right +, left -)
    ctx.inp2.jy = s.moveY;           // throttle/brake axis (forward +, back -)
  }

  // LOOK — accumulated delta -> camOrbit, EXACTLY like the legacy look-drag did
  // (see controls.js:143-145 and the existing ctx.fn.lookDelta at engine.js:1483).
  // s.lookX/lookY are already scaled by LOOK_SENS upstream, so apply them raw, same
  // signs the legacy handler used. NOTE: ThirdPersonCamera (scoop) consumes lookX/lookY
  // ITSELF and zeroes them — so only read them here when NOT using ThirdPersonCamera.
  if (ctx.mode === 'drive') {
    if (s.lookX || s.lookY) {
      ctx.camOrbit.yaw   = clamp(ctx.camOrbit.yaw   - s.lookX, -2.4, 2.4);
      ctx.camOrbit.pitch = clamp(ctx.camOrbit.pitch + s.lookY, -0.45, 0.8);
      ctx.camOrbit.t = performance.now();
      ctx._orbitUserSet = true;      // user grabbed the cam -> stop the cinematic sweep
    }
    // ZOOM — accumulated zoomDelta -> czoom. The drive cam's czoom is a MULTIPLIER, not
    // metres, and the existing pinch path multiplies it (controls.js:133). Convert the
    // additive metre-ish delta to a multiplicative nudge so the tuned czoom range is kept:
    if (s.zoomDelta) {
      const f = Math.exp(s.zoomDelta * 0.12);   // +delta = zoom IN = smaller czoom
      const td = ctx.controls.driveTopDown();
      ctx.czoom = clamp(ctx.czoom / f, td ? 0.14 : 0.4, td ? 7 : 3.4);
      ctx.controls.emitDriveZoom();
    }
  }
  // jump handled per-mode in §2 (scoop only).
}
```

> Why `czoom` is multiplicative here: the **tuned drive camera must be preserved**
> (`ctx.follow` heading-up cam, the `(185 + sp*38) * czoom` boom in
> `drive/drive.js:645/668/698`, the 3/4 cruise). `PinchZoomController` emits an *additive*
> metres-ish delta sized for `ThirdPersonCamera`'s `distance += zoomDelta` model
> (`ZOOM_LIMITS` 3..12 m). Drive's `czoom` is a different unit. We bridge with
> `exp(delta*k)` so a pinch still feels right and never leaves the tuned range. Do not
> rip out the drive cam to use `ThirdPersonCamera` — drive keeps its own.

### 1.3 What gets retired

Once `pumpInput` is live for both modes, the legacy per-mode pointer/look/pinch handlers in
`src/engine/controls/controls.js` (the `ptrs`/`lookPtrs`/`movePtr`/`joyB*`/`pinchD`/wheel
block, ~lines 50-200) are **dead for scoop + drive** and should be deleted to honour
"no duplicated movement logic". Keep `setDriveZoom`/`emitDriveZoom`/`driveZoomRange`
(the slider API) — they still drive `czoom` and are called from the HUD.
The **explore** mode camera (overhead orbit `ctl.az/po/r`) is out of scope for this batch;
if explore still uses the legacy handlers, gate the retirement on `ctx.mode !== 'explore'`.

---

## 2. SCOOP — adopt InputManager + ThirdPersonCamera + CharacterController

This is the cleanest win: replace the bespoke scoop cam (`camYawS`, `scPitch`,
`scoopMoveYaw`, `scoopMoveActive`, `szoom`, the `houseSys` indoor follow cam) and the
bespoke scoop move with the three shared classes.

### 2.1 Construct on scoop-enter (or lazily, once)

```js
import { ThirdPersonCamera } from '../controls/ThirdPersonCamera.js';
import { CharacterController } from '../player/CharacterController.js';

// ctx.CHAR is the keeper. CharacterController drives an Object3D — pass ctx.CHAR.group.
// The keeper's facing convention is `group.rotation.y = CHAR.yaw - PI/2` (see drew.js),
// so DON'T let CharacterController rotate the group directly: subclass move() to write
// the world translation through the existing collision clamp, and let the host keep
// driving CHAR.yaw + group.rotation as it does now — OR adopt CC's facing and drop the
// -PI/2 offset by parenting the mesh under a yaw node. Simplest: keep CHAR.yaw authoritative
// (see §2.3) and use CC ONLY for camera-relative translation + moveMagnitude.

class ScoopCharacter extends CharacterController {
  // Wrap translation with the active scene's collision clamp. update() hands us the
  // intended world velocity; we sweep it through interior.collide (interior) or a yard
  // clamp (yard), exactly the clamps updateScoop already uses.
  move(velocity, dt) {
    const px = this.object.position.x, pz = this.object.position.z;
    let nx = px + velocity.x * dt, nz = pz + velocity.z * dt;
    if (ctx.scoopScene === 'interior' && ctx.interior) {
      const r = ctx.interior.collide(px, pz, nx, nz, ctx.NPC_RAD);  // reuse the keeper radius/feel
      nx = r.x; nz = r.z;
    } else {
      // yard: reuse whatever updateScoop's yard clamp is (terrain bounds / building boxes).
      const r = ctx.scoopClampYard ? ctx.scoopClampYard(px, pz, nx, nz, ctx.NPC_RAD) : { x: nx, z: nz };
      nx = r.x; nz = r.z;
    }
    this.object.position.x = nx; this.object.position.z = nz;
    // keep the engine's mirror coords in sync (lots of code reads ctx.CHAR.x/z)
    ctx.CHAR.x = nx; ctx.CHAR.z = nz;
  }
}

ctx.scoopChar = new ScoopCharacter({
  object: ctx.CHAR.group,
  input:  ctx.im.state,
  camera: ctx.camera,            // whatever the renderer camera is named on ctx
  speed:  ctx.NPC_SPD ? 3.2 : 3.2,   // tune to the old keeper speed
});

ctx.scoopCam = new ThirdPersonCamera({
  camera: ctx.camera,
  target: ctx.CHAR.group,        // { position } — Object3D works directly
  input:  ctx.im.state,          // consumes lookX/lookY/zoomDelta and zeroes them
  orientation: ctx.im.state.orientation,
});
```

### 2.2 Per-frame, inside `updateScoop(dt)`

Replace the bespoke cam/move math with:

```js
// (pumpInput already ran at the top of the main loop and folded input into ctx.im.state.)
ctx.scoopChar.update(dt);     // camera-relative move + collision (via our move() override)
ctx.scoopCam.update(dt);      // consumes look/zoom, eases the chase boom, lookAt the keeper

// JUMP — InputState.jump is a level flag. Edge-detect it (the existing jump impulse logic
// lives at engine.js:1432: vy=8.5 when grounded). The MobileControls jump button calls
// ctx.fn.jump via props.onJump; the keyboard space also sets state.jump. Consume it:
if (ctx.im.state.jump && ctx.CHAR.airY <= 0 && ctx.CHAR.vy === 0) {
  ctx.CHAR.vy = 8.5; if (ctx.audio.blip) ctx.audio.blip();
}
// gravity / airY / vy integration stays where it is in updateScoop.

// Animation: feed the move magnitude into the keeper's controller so idle/walk/run blend.
if (ctx.CHAR.drew) ctx.CHAR.drew.locomotion(ctx.scoopChar.moveMagnitude * ctx.scoopChar.speed);
```

### 2.3 Facing — keep `CHAR.yaw` authoritative

`CharacterController._faceDirection` rotates `object.quaternion` to face travel using
`atan2(dir.x, dir.z)` (local +Z = front). The keeper instead uses
`group.rotation.y = CHAR.yaw - PI/2`. Two clean options:

- **(preferred, least churn)** Let CC rotate the group (it faces travel correctly via
  quaternion), and **stop** writing `group.rotation.y = CHAR.yaw - PI/2` in updateScoop.
  Then derive `CHAR.yaw` *from* the group for any code that still reads it:
  `ctx.CHAR.yaw = Math.atan2(_fwd.x, _fwd.z)` after update. The `-PI/2` was a voxel-rig
  offset; the GLB rigs already apply their own `inner.rotation.y = PI/2` (drew/cece/dad/mom),
  so CC facing the group's +Z is correct for the GLB keeper.
- **(alt)** Keep `CHAR.yaw` authoritative: override `_faceDirection` to a no-op in
  `ScoopCharacter` and instead set `ctx.CHAR.yaw` from `atan2(moveDir.x, moveDir.z)` with
  the engine's existing yaw easing, leaving the `- PI/2` group write in place. Use this if
  other systems (tool aim, camera seed) read `CHAR.yaw` mid-frame.

Verify which by checking what reads `CHAR.yaw` after the move each frame.

### 2.4 Snap on enter

In `enterScoop`/`houseSys.enterHouse`/`leaveHouse`, after positioning `ctx.CHAR`, call
`ctx.scoopCam.snap()` so the boom doesn't slide in from the previous pose (replaces the
`ctx.camInit = false` re-seed dance). Set the camera's orientation too:
`ctx.scoopCam.setOrientation(ctx.im.state.orientation)`.

---

## 3. DRIVE — feed the EXISTING tuned cam + car physics from InputState

**Do NOT replace the drive camera.** `ctx.follow` (heading-up + GPS), the cinematic sweep,
the `czoom` boom range, and the 3/4 cruise in `drive/drive.js` are tuned and must stay.
Drive only changes its *input source*: the legacy pointer handlers are swapped for
`pumpInput`'s mapping (§1.2).

### 3.1 What `pumpInput` already did for drive

- `s.moveX -> ctx.inp2.jx` (steer), `s.moveY -> ctx.inp2.jy` (throttle/brake). The car
  physics in `car.js` / `drive/drive.js` already read `inp2.jx/jy` (mixed with `steer/gas/
  brake` from the pedals). **No car-physics change needed** — the bag is the contract.
- `s.lookX/lookY -> camOrbit.yaw/pitch` with the same signs + clamps the legacy look-drag
  used (`controls.js:143-145`), so `_orbitUserSet` flips and the cinematic sweep yields to
  the user exactly as before.
- `s.zoomDelta -> czoom` via the multiplicative bridge, preserving the tuned range.

### 3.2 Pedals / handbrake / boost / nav stay on their existing channels

The on-screen gas/brake/boost/handbrake buttons and the nav system already write
`inp2.gas/brake/boost/hbrake/navActive/navX/navZ` through `ctx.fn.setGas/setBrake/...`
(engine.js:1478-1491). Those are **independent of the move axes** and unchanged. The new
joystick's `moveX/moveY` is the *steer + throttle* stick; if the current touch UI uses a
steer stick + separate gas pedal, decide one of:

- **Stick = steer only:** map `s.moveX -> inp2.steer` (not `jx`) and leave `gas/brake` to
  the pedals. Then `s.moveY` is free (ignore it in drive, or use it for brake-when-pulled-back).
- **Stick = steer + throttle (twin-axis):** keep the `jx/jy` mapping above and drop the gas
  pedal. Pick based on the shipped drive HUD; the current code paths support both because
  `inp2` carries `jx/jy` AND `steer/gas/brake` and the physics sums them.

The `MobileControls.jsx` jump button is **scoop-only** — in drive, render the existing
drive HUD (pedals/handbrake) instead, or hide `MobileControls`' button cluster and show
the drive pedals. `MobileControls` only owns the move joystick + one action button; the
drive pedals remain their own component.

---

## 4. ORIENTATION — portrait vs landscape, preserve live state

The contract: portrait/landscape pick `CAMERA_PRESET` + `LOOK_SENS` rows, and **rotating
the device must NOT teleport the player or reset yaw/pitch/move**.

### 4.1 Single source of truth

`InputManager` already owns an `OrientationManager` and mirrors orientation into
`state.orientation` every frame; `pumpInput` forwards a *flip* to `ctx.fn.setOrientation`.
Implement that engine fn to fan out:

```js
ctx.fn.setOrientation = (o) => {
  if (o !== 'portrait' && o !== 'landscape') return;
  ctx._orient = o;
  ctx.im.setOrientation(o);                 // updates LOOK_SENS row used by lookCtrl
  if (ctx.scoopCam) ctx.scoopCam.setOrientation(o);   // swaps DEFAULT distance/height/pitch
  // drive cam: it has its own framing; if you want orientation tuning there, branch on `o`
  // for the boom constants — but the live camOrbit.yaw/pitch/czoom MUST be preserved.
  ctx.emit?.('orientation', o);             // let the UI relayout (MobileControls already
                                            // self-resizes via its own resize listener)
};
```

`ThirdPersonCamera.setOrientation` is divergence-preserving by design: it only retargets a
field (`distance`/`targetHeight`/`pitch`) if the user hasn't manually moved it off the old
preset, and **yaw is always preserved**. So an in-progress look/zoom survives a rotate —
exactly the requirement. `InputManager.setOrientation` recomputes the pointer zone-split
*lazily on the next pointerdown*, so live pointers keep their owner and no deltas reset.

### 4.2 Things NOT to do on rotate

Do not call `snap()`, do not reset `camOrbit`, `czoom`, `CHAR.x/z/yaw`, or any joystick
state on orientation change. The only state that changes is *presentation* (preset rows +
HUD layout). `MobileControls` recomputes its joystick base size on its own
`resize`/`orientationchange` listener — no action needed.

---

## 5. NPC BRAIN — build the per-frame `world` view + wire the loop

`npc-brain.js` is engine-agnostic: it reads/writes `npc.brain` and calls
`ctrl.{locomotion,react,pose,reset,tick}`. The engine owns the `npc` records
(`{ ctrl, group, x, z, yaw, baseY, brain? }`) — those already exist in `ctx.npcs`
(dad + mom, built from `loadDadController`/`loadMomController`, engine.js:439-440).

You build a **per-scene `world` object each frame** and call `updateNpcs(ctx.npcs, dt, world)`.
Call `resetNpcs(...)` once on scene-enter.

### 5.1 INTERIOR world view (house NPCs walk rooms, inspect, sit)

```js
// Build ONCE per interior load (nav/props are static for that interior); cache on ctx.
ctx.npcNav   = makeNav(ctx.interior);              // room graph + door routing
ctx.npcProps = propsFromInterior(ctx.interior);    // couches + room centres to inspect

// Each frame (only while interior is the active scoop scene):
function interiorWorld(now, dt) {
  return {
    now,
    speed: ctx.NPC_SPD,            // 1.35 m/s (engine.js:869)
    radius: ctx.NPC_RAD,           // 0.34
    floorY: ctx.interior.floorY,
    nav:   ctx.npcNav,             // interior -> door-routed pathing
    props: ctx.npcProps,
    seats: ctx.interior.seats,     // [{x,z,y,yaw}] couch sit-targets
    collide: ctx.interior.collide, // (px,pz,nx,nz,rad)->{x,z} — same clamp the keeper uses
    player: ctx.CHAR,              // {x,z} read for greet + personal-space
    animals: [],                   // no critters indoors
    // resetNpcs uses world.clearAt(px,pz,rad)->{x,z}; interior has no clearAt, reuse collide:
    clearAt: (px, pz, rad) => ctx.interior.collide(px, pz, px, pz, rad),
    center: ctx.interior.spawn,    // optional, only for partyDance face-in
  };
}
```

> `world.clearAt` and `world.center` are NOT on the interior module — the host supplies
> them (above). `clearAt` is only used by `resetNpcs` to nudge a spawn off a collider;
> wrapping `collide(px,pz,px,pz,rad)` is the correct reuse. `center` is only used by
> `partyDance`. Everything else (`nav`, `props`, `seats`, `collide`, `floorY`) maps
> 1:1 onto the interior return shape (`interior.js:230-231`).

### 5.2 YARD world view (open wander + critter chase)

```js
function yardWorld(now, dt) {
  return {
    now,
    speed: ctx.NPC_SPD,
    radius: ctx.NPC_RAD,
    floorY: ctx.scoopGroundY ?? 0,    // yard ground height
    nav: null,                        // OPEN scene -> no room graph
    openWander: true,                 // <-- enables the 'wander' action with no nav (npc-brain:168)
    props: [],                        // (optional) yard inspectables; [] is fine
    seats: [],
    collide: ctx.scoopClampYard || ((px,pz,nx,nz,rad)=>({x:nx,z:nz})),  // yard bounds clamp
    player: ctx.CHAR,
    animals: ctx.animals.ANIMALS,     // [{x,z,kind}] live critters
    // make a chased/too-close critter actually bolt — bridge into animals.js's spook:
    spookAnimal: (a, x, z, now) => {
      // animals.js startle works off proximity to a `player`-like {x,z}. Easiest bridge:
      // give the animal a temporary spook target away from (x,z) using its existing fields.
      const ang = Math.atan2(a.x - x, a.z - z), R = 6;
      a.tx = a.x + Math.sin(ang) * R; a.tz = a.z + Math.cos(ang) * R;
      a.wait = 0; a.spookT = (now || 0) + 1400;   // matches animals.js spook window
    },
    clearAt: (px, pz, rad) => ({ x: px, z: pz }),
    center: { x: ctx.CHAR.x, z: ctx.CHAR.z },
  };
}
```

> The `spookAnimal` bridge writes the same `a.tx/a.tz/a.wait/a.spookT` fields
> `animals.js:updateAnimals` already reacts to (animals.js:230-233). Confirm those field
> names against the live animals module when you wire it; the startle path there keys off
> `spookT`. If `animals.js` exposes a dedicated spook helper after the refactor, call that
> instead.

### 5.3 Drive the loop

```js
import { makeNav, propsFromInterior, resetNpcs, updateNpcs, partyDance } from './npc-brain.js';

// On scoop-enter / scene switch (interior<->yard), reset to a calm clustered idle:
function onScoopSceneEnter(spawn /* {x,z} */) {
  const now = performance.now();
  const world = ctx.scoopScene === 'interior' ? interiorWorld(now, 0) : yardWorld(now, 0);
  resetNpcs(ctx.npcs, world, spawn);   // places NPCs around spawn, all idling
}

// Per frame, ONLY while in scoop (NPCs are scoop-scene actors):
if (ctx.mode === 'scoop') {
  const now = performance.now();
  const world = ctx.scoopScene === 'interior' ? interiorWorld(now, dt) : yardWorld(now, dt);
  updateNpcs(ctx.npcs, dt, world);     // ticks each NPC's action FSM + writes group pos/rot
}
```

`updateNpcs` writes `npc.group.position` + `npc.group.rotation.y = npc.yaw - PI/2` and calls
`npc.ctrl.tick(dt)` — it fully owns NPC transforms + animation advance. **Delete the old
dance-heavy NPC FSM block** in engine.js (~lines 864-869 + wherever its per-frame update
lives) — that's the duplication this module replaces. Keep `ctx.NPC_RAD`/`ctx.NPC_SPD`.

`partyDance(ctx.npcs, world, clip)` is optional — call it for a rare "everybody dance"
moment (e.g. after the yard is cleaned), replacing the old `_syncDance` timer
(engine.js:441). Pick a clip both rigs share, e.g. `'All_Night_Dance'` (in dad.dances and
mom.dances).

---

## 6. The EXACT per-character clip fixes (dad.js / mom.js)

`npc-brain` wants a real **stand** clip for idle (`ctrl.idleClip`) and a soft **look** clip
for inspect (`ctrl.lookClip`). `makeController` (drew.js) passes neither through, so set
them on the returned controller. Two equivalent ways: (a) pass them into the `opts` and
have `makeController` copy them through, or (b) set them on the controller object right
after `makeController` returns. Option (b) needs **zero** change to drew.js and is the
minimal edit:

### 6.1 `src/engine/dad.js`

Dad's `DAD_NAME_MAP.idle` is `'Arm_Circle_Shuffle'` — a *dance*, so dad currently "idles"
by shuffling. Repoint idle to a neutral clip and tag idle/look clips. Edit the `onReady`
call so the controller carries the clips:

```js
// BEFORE (dad.js:12):
const DAD_NAME_MAP = { idle: 'Arm_Circle_Shuffle', walk: 'Walking', run: 'Running', dance: 'All_Night_Dance', cheer: 'Bass_Beats' };

// AFTER — point idle at a genuine standing/breathing clip from dad's set. 'Arm_Circle_Shuffle'
// is a dance; move it to dances (it already is at line 41) and idle to a calm clip. If dad's
// GLB has no plain idle, the LEAST-bad neutral is the slowest upright loop — confirm the clip
// list and pick one (e.g. a 'Breathing_Idle'/'Idle' if present; else reuse 'Walking' frozen
// is wrong — prefer a true idle). Set a placeholder here and verify against g.animations:
const DAD_NAME_MAP = { idle: 'Idle', walk: 'Walking', run: 'Running', dance: 'All_Night_Dance', cheer: 'Bass_Beats' };
```

```js
// AFTER the onReady(makeController(...)) — tag the brain clips. Change:
//   onReady(makeController(inner, mixer, actions, { kind: 'dad', ... sitClip: null }));
// to capture + decorate the controller:
const ctrl = makeController(inner, mixer, actions, {
  kind: 'dad', nameMap: DAD_NAME_MAP, actionList: [],
  dances: ['All_Night_Dance', 'Bass_Beats', 'Arm_Circle_Shuffle'],
  emotes: ['360_Power_Spin_Jump', 'Angry_Ground_Stomp_2', 'air_squat'],
  sitClip: null,
});
// npc-brain idle/inspect clips — only set if the rig actually has them, else leave undefined
// (npc-brain guards every access and falls back to locomotion(0)):
if (actions['Idle']) ctrl.idleClip = DAD_NAME_MAP.idle;          // a real STAND for idle
if (actions['Looking_Around'] || actions['Idle']) ctrl.lookClip = actions['Looking_Around'] ? 'Looking_Around' : DAD_NAME_MAP.idle;  // soft look-beat for inspect
onReady(ctrl);
```

> **Verify the clip names** against `g.animations` (dad's GLB ships 15 merged clips). The
> names above (`'Idle'`, `'Looking_Around'`) are placeholders — dump
> `g.animations.map(c=>c.name)` once and substitute the real neutral/look clips. If dad has
> NO neutral idle, leave `idleClip` unset: npc-brain then idles via `locomotion(0)`, which
> with the repointed `DAD_NAME_MAP.idle` (now NOT a dance) reads as a proper stand.

### 6.2 `src/engine/mom.js`

Mom's `MOM_NAME_MAP.idle` is `'Phone_Conversation'` — fine as a calm idle, but tag the
brain clips and give a look beat. Mom already has `sitClip: 'Sit_and_Doze_Off'` so the
`sit` action works for her.

```js
const ctrl = makeController(inner, mixer, actions, {
  kind: 'mom', nameMap: MOM_NAME_MAP, actionList: [],
  dances: ['Shake_It_Off_Dance', 'You_Groove', 'All_Night_Dance'],
  emotes: ['Squat_Stance', 'Alert_Quick_Turn_Right'],
  sitClip: 'Sit_and_Doze_Off',
});
if (actions['Phone_Conversation']) ctrl.idleClip = 'Phone_Conversation';  // calm stand
// 'Alert_Quick_Turn_Right' is a nice "notice + study it" look beat for inspect:
if (actions['Alert_Quick_Turn_Right']) ctrl.lookClip = 'Alert_Quick_Turn_Right';
onReady(ctrl);
```

> Same caveat: confirm clip names against mom's 17-clip set. `ctrl.idleClip` is played via
> `ctrl.pose(idleClip)` (a held loop) in the idle action; `ctrl.lookClip` via `ctrl.react`
> (a one-shot) in inspect. Both are guarded — wrong/absent names just degrade to
> `locomotion(0)` with no crash.

> **Optional, cleaner:** instead of decorating after the fact, add `idleClip`/`lookClip` to
> `makeController`'s returned object (drew.js:91-98) reading `opts.idleClip`/`opts.lookClip`.
> That's a 2-line drew.js change and lets dad/mom pass the clips inline. Justified because
> it extends the controller contract that npc-brain already documents (`ctrl.idleClip?`,
> `ctrl.lookClip?`), without changing any existing behaviour (both default to undefined).

---

## 7. Step-by-step integration ORDER (each step builds + verifies independently)

Do these in order; **after each step run `npm run build` (or `node --check` on touched
files) and smoke-test the named behaviour before moving on.** Commit after each green step
(Conventional Commits) for easy rollback.

**Step 0 — Fix the blockers (no engine changes yet).**
- Apply Appendix A (InputManager ↔ sibling API). `node --check src/controls/InputManager.js`,
  then an ESM smoke test: construct an `InputManager` over a fake canvas, dispatch synthetic
  pointer events, assert `state.moveX/moveY/lookX/lookY/zoomDelta` update and that a 2-finger
  sequence produces a nonzero `zoomDelta`. **Verify:** no thrown method-not-found.
- Apply Appendix B / §6 (dad.js, mom.js clip tags). **Verify:** `node --check` both.

**Step 1 — InputManager construction only.**
- Construct `ctx.im` in init; add `ctx.im.dispose()` to teardown. Do NOT yet route it into
  movement. **Verify:** build passes; app boots; existing controls still work (you haven't
  retired them yet); no console errors from the new manager.

**Step 2 — MobileControls HUD (read-only).**
- Render `<MobileControls input={ctx.im} orientation={orient} onJump={ctx.fn.jump} />` in
  App.jsx (scoop only). It reads `ctx.im.joystick`. **Verify:** the joystick base + knob draw
  bottom-left, the knob tracks a drag, the jump button taps fire `ctx.fn.jump`, and dragging
  on empty space does NOT move the knob (pointer-events pass-through to canvas works).

**Step 3 — `pumpInput` bridge, DRIVE first (lower risk, cam unchanged).**
- Add `pumpInput(dt)` (§1.2) at the top of the loop; wire ONLY the drive branch
  (`jx/jy`, `camOrbit`, `czoom`). Leave the legacy drive handlers attached but guard them
  off when `ctx.mode==='drive'` so you can A/B. **Verify:** steering, look-drag-to-orbit,
  and pinch-zoom all work in drive identically to before; the heading-up `ctx.follow` cam,
  cinematic sweep, and 3/4 cruise are visually unchanged. Then delete the legacy drive
  handlers.

**Step 4 — SCOOP camera (ThirdPersonCamera), still legacy move.**
- Construct `ctx.scoopCam`; in `updateScoop` call `ctx.scoopCam.update(dt)` and `snap()` on
  enter; remove the bespoke scoop cam math (`camYawS`/`scPitch`/indoor follow cam). Keep the
  OLD scoop move for now. **Verify:** drag orbits the keeper, pinch zooms within
  `ZOOM_LIMITS`, rotate preserves the angle, no flip at pitch extremes.

**Step 5 — SCOOP movement (CharacterController + collision override).**
- Construct `ctx.scoopChar` (the `ScoopCharacter` subclass, §2.1); in `updateScoop` call
  `ctx.scoopChar.update(dt)`; feed `moveMagnitude` to `ctx.CHAR.drew.locomotion`; resolve
  facing per §2.3; wire jump-edge (§2.2). Delete the bespoke scoop move + `scoopMoveYaw`/
  `scoopMoveActive`. **Verify:** stick walks the keeper camera-relative, collision clamps at
  walls/furniture (interior) and yard bounds, idle/walk/run anim blends, jump works, no drift
  at rest (dead-zone holds).

**Step 6 — Orientation fan-out.**
- Implement `ctx.fn.setOrientation` (§4.1); confirm `pumpInput` calls it on flips. **Verify:**
  rotating the device swaps presets WITHOUT teleporting the keeper or resetting look/zoom;
  HUD relayouts; `LOOK_SENS` feels right in both orientations.

**Step 7 — Retire legacy controls + explore guard.**
- Delete the now-dead pointer/look/pinch block in `controls/controls.js` for scoop+drive
  (keep `setDriveZoom`/`emitDriveZoom`/`driveZoomRange`; keep explore's path if it still uses
  them). **Verify:** full build; both modes fully driven by `ctx.im`; no duplicate handlers.

**Step 8 — NPC brain.**
- Import the npc-brain fns; build `interiorWorld`/`yardWorld` (§5.1/5.2); call `resetNpcs`
  on scoop-scene enter and `updateNpcs` each scoop frame; delete the old NPC FSM
  (engine.js:864+) and the `_syncDance` timer; optionally call `partyDance`. **Verify:**
  dad/mom mostly idle (a real stand, not a shuffle — confirms §6), wander room-to-room
  through doorways without clipping walls, occasionally inspect a couch, mom sits, emotes are
  sprinkled (not a constant party), and in the yard they chase a critter that then bolts.

**Step 9 — Cleanup pass.**
- Remove dead `ctx` fields (`movePtr`, `joyBX/Y`, `pinchD`, `szoom`, `scoopMoveYaw`,
  `scoopMoveActive`, `lookPtrs`, etc.) once nothing references them. `rg` each before delete.
  **Verify:** build + a full play loop (explore -> drive -> scoop yard -> house -> back).

---

## Appendix A — InputManager vs sibling API mismatch (BLOCKER)

`InputManager.js` calls methods that the authored sibling modules do **not** define. As
written it throws on the first pointerdown. **Recommended fix: rename the calls inside
`InputManager.js`** (the modules are the source of truth and are individually smoke-tested).
Exact required changes, call-site -> correct sibling API:

| InputManager call (current) | Actual sibling API | Fix in InputManager |
|---|---|---|
| `joystickCtrl.onStart(e.clientX,e.clientY)` (`:389`) | `TouchJoystick.start(pointerId, x, y)` | `joystickCtrl.start(e.pointerId, e.clientX, e.clientY)` |
| `joystickCtrl.onMove(x,y)` (`:326`) | `move(x,y)` | `joystickCtrl.move(e.clientX, e.clientY)` |
| `joystickCtrl.onEnd()` (`:406,465`) | `end()` | `joystickCtrl.end()` |
| `joystickCtrl.getVector()` (`:165`) | `.value` (`{x,y}`, mutated in place) | `const stick = this.joystickCtrl.value;` |
| `lookCtrl.onStart(e)` (`:391`) | `start(x,y)` | `lookCtrl.start(e.clientX, e.clientY)` |
| `lookCtrl.onMove(e)` (`:329`) | `move(x,y)` | `lookCtrl.move(e.clientX, e.clientY)` |
| `lookCtrl.onEnd()` (`:407,466`) | `end()` | `lookCtrl.end()` |
| `lookCtrl.consumeLook()` -> `{x,y}` (`:183`) | `consume()` -> `{lookX,lookY}` | `const look = this.lookCtrl.consume(); s.lookX = look.lookX; s.lookY = look.lookY;` |
| `pinchCtrl.onStart(p1,p2)` (`:418`) | `addPointer(id,x,y)` (tracks pointers itself) | see note below |
| `pinchCtrl.onMove(p1,p2)` (`:428`) | `movePointer(id,x,y)` | see note below |
| `pinchCtrl.onEnd()` (`:458`) | `removePointer(id)` | see note below |
| `pinchCtrl.onWheel(deltaY)` (`:364`) | `wheel(deltaY)` | `pinchCtrl.wheel(e.deltaY)` |
| `pinchCtrl.consumeZoom()` (`:188`) | `consume()` | `s.zoomDelta = this.pinchCtrl.consume();` |
| `keyboardCtrl.update(dt)` + `getMove()` + `.jump` (`:170,171,175`) | `update(state)` writes moveX/moveY/jump **into the state directly**; no `getMove`/`jump` | see note below |
| `new KeyboardControls(target)` (`:98`) | `constructor()` takes no args (always `window`) | `new KeyboardControls()` |
| `new OrientationManager((o)=>...)` + `.orientation` (`:103,111`) | `constructor({ onChange })`, prop is `.current` | `new OrientationManager({ onChange: (o)=>this._onOrientation(o) })`; read `.current` |
| `lookCtrl.setOrientation?.(o)` (`:497`) | not defined; look reads sens via the `sens` provider | construct `lookCtrl` with `new CameraLookController({ sens: () => LOOK_SENS[this.orientation] })` and make `setOrientation` a no-op / drop the call |
| `pinchCtrl.setOrientation?.(o)` / `joystickCtrl.setOrientation?.(o)` (`:498,499`) | not defined | harmless (optional-chained) — leave or drop |

**Pinch note (the deepest mismatch).** `PinchZoomController` tracks pointers *itself* by id
(`addPointer/movePointer/removePointer` + `wheel` + `consume`). `InputManager` instead tries
to compute two `{x,y}` points and feed them via `onStart/onMove/onEnd`. Reconcile by routing
RAW pointer ids straight to the pinch controller and letting IT measure separation — i.e.
in `_promoteToPinch`/`_updatePinch`/`_releasePointer`, call
`pinchCtrl.addPointer(e.pointerId, e.clientX, e.clientY)`,
`pinchCtrl.movePointer(id, x, y)` (per moved pointer),
`pinchCtrl.removePointer(e.pointerId)`. Then `_pinchPoints()` and the two-point plumbing are
unnecessary — delete them. This is *simpler* than the current code (the controller already
handles the "exactly two pointers" gate and baseline re-seed). The InputManager's ownership
table still decides WHEN a pointer is a pinch pointer; it just hands ids to the controller.

**Keyboard note.** `KeyboardControls.update(state)` writes `moveX/moveY/jump` **into the
InputState directly** — it does NOT return a vector. So the InputManager's
"`joystick + keyboard` then clamp" merge can't work as written (keyboard would overwrite the
joystick's `moveX/moveY`). Cleanest reconciliation: in `InputManager.update`, read the
joystick `value` FIRST, then for keyboard, either (a) call `keyboardCtrl.update(s)` only when
the joystick is idle (`!joystickCtrl.active`), or (b) have keyboard write to a scratch state
and sum. (a) is simplest and matches "touch OR WASD". `state.jump` from keyboard then coexists
with the button's `onJump`.

> Alternative fix path (more churn, not recommended): rename the *modules'* methods to match
> InputManager (`start->onStart`, `value->getVector()`, `consume->consumeLook/consumeZoom`,
> add `getMove()/jump` to keyboard, accept a bare fn in OrientationManager, change pinch to a
> two-point API). This breaks the modules' individually-verified smoke tests and their
> documented public APIs, so prefer fixing InputManager.

After the fix, re-run an ESM smoke test (synthetic pointer/wheel events over a stub canvas)
asserting joystick move, look accumulation+consume, two-finger pinch -> `zoomDelta`, and
keyboard fallback when no touch.

---

## Appendix B — npc-brain controller clip gaps

`npc-brain.js` reads `ctrl.idleClip` (a real STAND clip, played via `pose()` in the idle
action) and `ctrl.lookClip` (a soft look beat, played via `react()` in inspect). Both are
**guarded** — if unset, idle/inspect fall back to `locomotion(0)`. But:

- **dad** maps `idle -> 'Arm_Circle_Shuffle'` (a DANCE), so without `idleClip` dad "idles"
  by shuffling. Fix per §6.1: repoint `DAD_NAME_MAP.idle` to a neutral clip AND/OR set
  `ctrl.idleClip`. `Arm_Circle_Shuffle` stays in `dances`.
- **mom** maps `idle -> 'Phone_Conversation'` (fine), `sitClip -> 'Sit_and_Doze_Off'`
  (sit works). Just tag `idleClip`/`lookClip` per §6.2.

Confirm clip names against each GLB's `g.animations` (dad: 15 clips, mom: 17) before
hardcoding — the names in §6 are placeholders to be verified. All accesses are guarded, so
a wrong name degrades gracefully (no crash), but you won't get the intended stand/look beat.

The rest of the npc-brain contract maps cleanly onto the engine:
`ctrl.{dances,emotes,sitClip,locomotion,react,pose,reset,tick}` all exist on
`makeController`'s return (drew.js); `interior.{rooms,seats,doorways,collide,floorY,spawn}`
all exist (interior.js:230-231) and `rooms` records carry `{x,z,area,minX,maxX,minZ,maxZ}`
exactly as `makeNav`/`wanderTarget` expect (interior.js:201). The only host-supplied
extras are `world.clearAt` (wrap `collide`) and `world.center` (use `interior.spawn`).

---

## Engine surface (shapes this recipe assumes — re-verify after the refactor)

- `ctx.inp2 = { jx, jy, kx, ky, steer, gas, brake, navActive, navX, navZ, hbrake, boost }`
  (engine.js:904) — the aggregate input bag both modes read.
- `ctx.follow` (engine.js:73, follow/follow.js) — the tuned heading-up drive cam + GPS
  follow. **Keep it.** `viewHeading()` is what the drive cam orbits behind.
- `ctx.camOrbit = { yaw, pitch, t }` (engine.js:893) — the user's look offset in drive;
  `_orbitUserSet` gates the cinematic sweep. Legacy look-drag wrote it (controls.js:143).
- `ctx.czoom` (engine.js:897) — drive cam zoom MULTIPLIER (not metres); range gated by
  `controls.driveTopDown()` (0.14..7 overhead, 0.4..3.4 otherwise).
- `ctx.CHAR` — the scoop keeper; `.group` (Object3D), `.x/.z/.yaw` mirror coords,
  `.drew` (the active `makeController` controller), `.vy/.airY` for jump.
- `ctx.car` — the vehicle (car.js); reads `inp2`.
- `ctx.npcs` — house NPCs `[{ ctrl, group, x, z, yaw, baseY, brain? }]` (dad, mom).
- `ctx.interior` — `{ group, floorY, ceilingY, roomAABB, spawn, walls, occluders, rooms,
  seats, doorways, collide, ... }` (interior.js:230). `ctx.scoopScene` is `'yard'|'interior'`.
- `ctx.animals.ANIMALS` — `[{ x, z, kind, tx, tz, wait, spookT, ... }]`; `updateAnimals`
  reacts to `spookT` proximity (animals.js).
- `ctx.fn.jump` (engine.js:1432) — the existing jump impulse; wire `MobileControls.onJump`
  to it.
</content>
