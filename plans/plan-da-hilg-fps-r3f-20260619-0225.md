# Plan: Da Hilg — Greenfield R3F First-Person Game (`/da-hilg`)

**Created:** 2026-06-19 02:25
**Status:** implemented (in progress)
**Experts consulted:** architect, FPS controls/camera, NPC AI + animation, zones/level/asset-pipeline, HUD/UX/game-feel, principal-synthesizer, staff-reviewer (all greenfield, zero old-engine reuse)

## Requirements

Brand-new game **"Da Hilg"** at route `/da-hilg`, linked from the main menu. **Greenfield**: React Three Fiber + Rapier + drei + **Jotai** (not Zustand). Completely separate code — imports **nothing** from `src/engine|controls|player|lib|pages`; reuses only raw **assets** (the level GLB, the 4 character GLBs + animation clips, fonts) and the driving HUD's **visual style**. First-person feel. The playable level is the detailed neighborhood export. The four people — **Mike (dad.glb), Kelli (mom.glb), Cece (cece.glb), Drew (drew.glb)** — are both the playable characters and the NPCs; switch between them at any time. NPCs **walk and interact** with their environment (not constantly dancing); emotes are controllable at certain times. Source spec: `/Users/mcohen/Downloads/web-3d-game-framework-mvp-spec.md`.

**This framework is a deliberate foundation for the next game, Nibblers** (`/Users/mcohen/Downloads/nibblers-game-spec.md`, implemented separately after this is verified+pushed): third-person exploration, hidden Danger Zones → Marked state → swarms of mini (10–15% scale) clones of the 4 characters that converge/attach (up to 200+), slow movement + drain health; Safe Zones clear Marked + scatter swarm + reveal on minimap; jump = stomp. **Readiness requirements** are folded into this plan (see §12).

## Architecture

**The one idea:** An **Actor is data + refs**; a **Controller is a pure `(actor, ctx, dt) => Intent` function**; **movement physics lives in exactly ONE place** (`systems/stepMotion.js`, the only Rapier KCC apply site). Player/NPC/Idle differ only in the *intent* they produce, never in how it's applied. **Switching = swap the controller + retarget the camera** (single ref reassignment + one atom write). One `useFrame` simulation driver in `<GameSystems>`; cameras are read-only at priority 10. Per-frame truth lives in **plain-mutable singletons** (`registry, input, cameraRig, levelMeta, clock`); **Jotai atoms hold discrete UI state only** and are written change-gated at event boundaries — never per frame.

**Stack (locked, React-18-safe, installed + verified):** react 18.3.1 · three 0.184.0 (overrides `$three`, single instance verified) · @react-three/fiber 8.18.0 · @react-three/drei 9.122.0 · @react-three/rapier 1.5.0 · @dimforge/rapier3d-compat 0.14.0 · jotai 2.20.1 · sharp 0.33.5 (build only). No TypeScript (JSDoc-typed plain objects). StrictMode is OFF.

**Mounting (true isolation):** `src/main.jsx` root-switch — `location.pathname.startsWith('/da-hilg')` → lazy `import('./da-hilg/index.js')` mounts `<DaHilgApp/>`; else lazy `import('./App.jsx')`. The old `EngineProvider` is never constructed on `/da-hilg` (no second WebGL context). One new menu card in `MenuPage.jsx` does `window.location.assign('/da-hilg')` (hard nav so the root-switch runs and the old engine disposes). No router/sw code change (bump `public/sw.js` VERSION on ship).

## Asset pipeline (`scripts/build_dahilg_assets.mjs` → tracked `public/da-hilg/`)

Meshopt geometry + webp textures (offline-decodable, no Draco/CDN at runtime); NodeIO registers the Draco **decoder** to read the mixed-compressed character sources. Pipeline order: `dedup → prune({keepLeaves:true}) → weld → textureCompress(sharp webp 1024/q80) → reorder(MeshoptEncoder) → quantize → EXTMeshoptCompression.setRequired(true) → write`. Outputs: `level.glb` (Collision_* preserved, **LOD_Buildings_Low dropped**), `{mike,kelli,cece,drew}.glb` (embedded clips removed, skinned-safe quantize 14/8/8), `anims/{idle,walk,run,jump,dance,wave,cheer}.glb` (clip-only, renamed to canonical key; **stripRootXZ on walk/run at build time**), and **computed** `level.meta.json` (offset, groundY, houseCenter, houseBox, spawns, npcSpawns — derived from level bbox + House_walls bounds, **never hardcoded**).

**Canonical 7-clip set** (identical rig → any clip binds to any character, 0 remap): idle←`Armature|Boxing_Warmup|baselayer`(drew-idle), walk←`Walking`(dad), run←`Running`(dad), jump←`360_Power_Spin_Jump`(dad), dance←`All_Night_Dance`(dad), wave←`Big_Heart_Gesture`(cece), cheer←`Cheer_with_Both_Hands_1`(cece).

## Staff-review MUST-FIXES (applied)

1. **KCC filter:** `computeColliderMovement(collider, desired, QueryFilterFlags.EXCLUDE_SENSORS | QueryFilterFlags.EXCLUDE_KINEMATIC, undefined, undefined)` — drop the per-collider predicate + filterGroups. Stops the 4 kinematic capsules from blocking each other / resolving against sensor zones (actors pass through each other for MVP).
2. **FP head-hide:** NO bone scaling. Use **camera near-plane clipping** (eye 1.62, near 0.18) so the head is clipped, zero skeleton manipulation. (TP restores normal near.)
3. **Compute meta, don't hardcode** — offset/groundY/houseBox/houseCenter/spawns derived in the build script and written to `level.meta.json`; the probed numbers are sanity logs only.
4. **Build assertions:** (a) every output GLB has **no** `KHR_draco_mesh_compression`; (b) each canonical clip binds to dad.glb's skeleton with **0 unmatched tracks**. Build fails if either trips.
5. **stripRootXZ build-time only** (not also runtime).
6. **Drop `LOD_Buildings_Low`** from the shipped level (keep only Collision_* as hidden collider source).
7. **Scope quantization** so collision geometry keeps adequate precision (≤cm error within the 0.01 KCC skin; acceptable).
8. **Dev raw-level fast-path** (a flag/constant to load the uncompressed `exports/` level via a Vite `?url` import) so gameplay isn't blocked by pipeline tuning; build the level pipeline first and verify it renders recentered before chars/anims.
9. **`name` set once per actor** on the `<RigidBody>` (the `rigidBodyObject`), not also the inner group, so `other.rigidBodyObject.name === id` is unambiguous.
10. **Map spec `gameMode`/`selectedCharacter`** → `gamePhaseAtom`/`activePlayerIdAtom` (documented).

**Simplicity cuts:** collapse `SafeZone/NoticeZone/TriggerZone` wrappers into the generic `<Zone type>`; stub audio, confetti, FOV-kick, head-bob, LookHint as no-ops until the greet loop is fun; do not implement damage/speed/noCombat membership tracking yet (generic `Zone` taking a `type` string satisfies "easy to add").

## File layout (`src/da-hilg/`)

`index.js` (default-exports DaHilgApp) · `DaHilgApp.jsx` (Provider+store, HUD, KeyboardControls>Canvas, phase gating) · `constants.js` (all tunables) · `fonts.css` · **scene/** Scene, SceneEnv, **GameSystems** (the single sim useFrame) · **level/** Level (recenter, hide Collision_*, one trimesh collider, dev raw-path), levelMeta · **actors/** actorRegistry, Actors, ActorView (KCC create/cleanup, name on RigidBody), CharacterModel (clone+mixer, FP near-plane not bone-hide) · **controllers/** Controller (Intent+CONTROLLERS), PlayerController, NpcController, IdleController, assign · **systems/** stepMotion (ONLY KCC apply), animationSystem, npcAi, pointsOfInterest, zoneSystem, greetSystem, switchSystem, commitReactive · **camera/** CameraRig (FP near-plane / TP collision-avoid, priority 10), cameraRig · **input/** useInput, keyMap, useEdgeKeys, usePointerLock · **animation/** clips, useCharacterClips · **zones/** zoneRegistry, zoneEvents, Zone (generic), Zones, zoneConfig · **state/** store, atoms, refs · **hud/** DaHilgHud, Crosshair, StateStrip, ObjectiveStrip, CharacterBar, EmoteWheel, InteractPrompt, HudMenu, ToastFeed, LockOverlay, LoadingVeil, CelebrationBanner, hudEvents, hud.css, mobile/{TouchJoystick,TouchLook,TouchButtons,LookHint} · **audio/** sfx (stub first).

Integration files (only ones outside the module): `src/main.jsx`, `src/pages/MenuPage.jsx`, `public/sw.js` (VERSION bump), plus new `AGENTS.md` + `CLAUDE.md`.

## Game loop

First-person exploration of the recentered 1840 Dahill neighborhood. Embody one family member; the other three wander between POIs, look at things, rarely emote. **Greet (E)** a nearby NPC family member → they face you + play a reaction emote + toast + score; greeting all four → "FAMILY REUNITED" celebration + replay. NPCs notice within radius 20 / in a NoticeZone, chase to tag, then retreat 3 s + cooldown 2 s; the house is a SafeZone (chasing stops). **Tab** switches control (prev→NPC, camera snaps). **V** toggles FP↔TP. Player emotes 1/2/3 (+ wheel). No fail state; fully replayable. Gameplay is structured as a pluggable **mode** so Nibblers becomes another mode later.

## Jotai contract

Reactive atoms (event-boundary writes only): gamePhase, loadProgress, activePlayerId, cameraMode, paused, pointerLocked, score, greeted, won, health(reserved), roles, npcStates, currentZone, playerState, nearbyGreetable, canGreet(derived), emoteOpen, settings. Plain refs (per-frame): registry, input, cameraRig, levelMeta, clock. Transient pulses (greetHit/toasts) via `hud/hudEvents.js`, not atoms.

## Build order (each independently verifiable)

0. Deps+scaffold (done) → 1. Asset build script (running) → 2. App shell + route + menu card → 3. Level + physics (recenter, hidden collider, dev raw-path) → 4. FP controller (refs, constants, actorRegistry, ActorView+KCC, stepMotion, useInput, usePointerLock, CameraRig FP, single GameSystems) → 5. Animation (clips, useCharacterClips, CharacterModel, animationSystem; TP body) → 6. Switching (assign, switchSystem, Tab/HUD, retarget) → 7. NPC AI (NpcController, npcAi FSM+wander, POIs, clones) → 8. Zones (registry, generic Zone, zoneConfig, zoneSystem flush, SafeZone stops chase, NoticeZone gates, trigger toasts) → 9. HUD (css+fonts, all components, mobile, commitReactive, useProgress bridge) → 10. Greet + emotes + juice + win → 11. QA (desktop+mobile, reduced-motion, perf, `npm test`, `npm run build`, grep proves no off-limits imports) → 12. Docs (AGENTS.md/CLAUDE.md) + sw VERSION bump.

## §12 Nibblers-readiness (built into the framework now)

- **Third-person camera is first-class** (CameraRig FP/TP); Nibblers will default to TP.
- **Zone `type` union includes `'danger'`** (inert stub now) + a reserved `markedAtom` hook; Safe/Danger semantics already in the generic Zone.
- **Health-drain hooks** present (healthAtom + per-actor health field, inert now).
- **Swarm seam:** the Actor/registry model is for the ≤4 named family actors only. Nibblers' 200+ horde will be a **separate high-performance system** (InstancedMesh / VAT), NOT routed through per-actor skinned R3F components — documented in AGENTS.md so it's not retrofitted into the registry.
- **Minimap HUD slot** reserved in the HUD layout.
- **Gameplay-as-mode** so Nibblers plugs in as a mode rather than a fork.

## Verification checklist

- [ ] `public/da-hilg/{level.glb, *.glb, anims/*.glb, level.meta.json}` exist; build assertions pass (no Draco in outputs; 0 unmatched clip tracks); meta computed not hardcoded
- [ ] `/da-hilg` mounts the new app; `/` still loads the old app; menu card navigates
- [ ] Neighborhood renders recentered (~y0); one trimesh collider; veil hides bake; no fall-through
- [ ] WASD+mouse+Space+Shift move/look/jump/run; FP head clipped via near-plane; TP shows body + collision-avoid boom
- [ ] idle/walk/run/jump crossfade by speed; no foot-slide; emotes 1/2/3; all 4 characters animate
- [ ] Tab switches control; prev→NPC; camera snaps; position/velocity preserved; no remount
- [ ] NPCs wander/look/rarely emote; chase within 20; touch→retreat3s→cooldown2s→chase; wall-slide; SafeZone stops chase; NoticeZone gates; trigger toasts; `actorZones` tracked
- [ ] Greet (E) → reaction+toast+score; greet all 4 → celebration + replay
- [ ] HUD matches tokens (square glass, AGC+Chakra, accent semantics); mobile joystick/look/buttons work
- [ ] No imports from `src/engine|controls|player|lib|pages` (grep clean)
- [ ] `npm run test` + `npm run build` clean; 60 fps desktop / ≥30 mobile
- [ ] AGENTS.md + CLAUDE.md present + accurate; sw VERSION bumped
- [ ] Nibblers-readiness items (§12) in place
