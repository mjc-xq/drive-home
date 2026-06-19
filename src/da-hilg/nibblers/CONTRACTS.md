# Nibblers — Module Contracts (authoritative)

Pins the interfaces so the Nibblers code stays coherent. Layers on the Da Hilg
framework (read ../CONTRACTS.md + ../AGENTS.md). Stack: React 18.3, three 0.184,
@react-three/fiber 8.18, @react-three/drei 9.122, @react-three/rapier 1.5, jotai 2.
Plain .jsx/.js + JSDoc, NO TypeScript. Everything new lives under `nibblers/`.

## Hard rules
- Import ONLY from within `src/da-hilg/**` + node_modules. The swarm is a flat
  typed-array SoA (`swarm/swarmState.js`), NEVER React/registry/atoms.
- The framework `ctx` (built in GameSystems) is: `{ store, world, rapier, registry,
  input, cameraRig, levelMeta, now, dt, activePlayerId }`. Nibblers systems take it.
- Reactive state = atoms in `state/nibblerAtoms.js` (+ framework `markedAtom`,
  `healthAtom`), written ONLY in `systems/commitNibblers.js`, change-gated + bucketed.
- ONE sim loop: all nibbler logic runs inside the existing GameSystems useFrame via
  `updateNibblers(ctx)`. The GPU buffer upload is folded into `updateSwarm`'s tail.
- The active player's feet pos + velY are `registry.get(activePlayerId).motion.{pos,velY,grounded}`.

## Contract files already written (import from these)
`constants.js`, `mode.js` (isNibblersMode(), nibblerPenalty ref `{speedMul,jumpMul,visibility}`),
`state/nibblerAtoms.js`, `swarm/swarmState.js` (SoA: px/py/pz, vx/vy/vz, heading, scale,
phase, stateT, jumpCD, seed, state[], charIx[], clip[], attachSlot[]; `swarm` scalars;
`resetSwarm()/alloc()→idx|-1/free(i)`).

## The renderer ↔ sim bridge — `render/swarmGpu.js` (NEW, write this first)
A plain module the renderer fills on mount and the sim writes each frame:
```js
export const swarmGpu = { mesh:null, aPhase:null, aClip:null, aTint:null }; // InstancedMesh + InstancedBufferAttributes
```
`SwarmRenderer` sets these on mount (and nulls on unmount). `updateSwarm` reads
`swarmGpu.mesh` (skips if null), writes `mesh.instanceMatrix` (yaw+uniform-scale per
slot from px/py/pz/heading/scale), `aPhase.array[i]=phase[i]`, `aClip.array[i]=clip[i]`,
`aTint.array[3i..]=NIBBLER_TINTS[charIx[i]]`, sets `.needsUpdate=true` on each, and
`mesh.instanceMatrix.needsUpdate=true`. `mesh.count = MAX_NIBBLERS`.

## Module signatures
### index.js
`export function initNibblers(ctx)` (load assets/zones, resetSwarm, build minimap projector — idempotent),
`export function updateNibblers(ctx)`, `export { default as SwarmRenderer } from './render/SwarmRenderer.jsx'`,
`export { default as NibblersHud } from './hud/NibblersHud.jsx'`.

### systems/nibblersSystems.js — `export function updateNibblers(ctx)`
Ordered pass (runs only in nibblers mode; GameSystems gates it). Skip the whole pass
until assets ready (`assetsReady()` from render/nibblerAssets):
```
updateNibblerZones(ctx)   // marked/discovered/scatter from reconciled zones
spawnPolicy(ctx)          // attraction curve → target → ring spawn / cull
updateSwarm(ctx)          // FSM over SoA + grid + integrate + GPU upload
updateAttachment(ctx)     // resolve contacts → attached orbit; swarm.attachedCount
updatePenalty(ctx)        // attachedCount → nibblerPenalty ref
updateHealthDrain(ctx)    // attachedCount → health
updateStomp(ctx)          // descending + grid query under feet → kill + bounce
commitNibblers(ctx)       // change-gated/bucketed atom writes
```

### systems/markedSystem.js
`armMarked(now)` (set swarm.marked=true; first arm sets markedT=0; re-arm does NOT reset),
`clearAndScatter(now)` (swarm.marked=false, markedT=0, targetActive=0, panic until now+SCATTER window;
ATTACHED→S_FALL with outward+up vel; WANDER/NOTICE/RUN/JUMP/SPAWN→S_SCATTER; attachedCount=0).

### systems/nibblerZones.js — `export function updateNibblerZones(ctx)`
Read the active player's reconciled `actor.zonesActive` (after flushZones). Edge-detect vs a
module snapshot. Safe zone present → if marked, clearAndScatter; if a `discover` safe zone unseen →
append to discoveredSafeZonesAtom + pushToast('…','safe'); set currentSafeZoneAtom. Else a `danger`
zone present and not marked → armMarked(now) + pushToast('MARKED','danger'). Uses `zoneRegistry.byId`
for the def (type/label/discover). All store writes are edge-only.

### swarm/spawner.js — `export function spawnPolicy(ctx)`
Compute targetActive from swarm.markedT (ATTRACTION curve). While marked && !panic: spawn
deficit (rate-limited SPAWN_RATE_MAX) on a ring SPAWN_RING_MIN..MAX around the player, biased away
from cameraRig.yaw; one down `world.castRay(EXCLUDE_SENSORS|EXCLUDE_KINEMATIC)` to seat spawn Y.
Init slot: random charIx, scale, seed, phase, emote band; state=S_SPAWN. Over target → cull WANDER
nibblers beyond DESPAWN_RADIUS (free()).

### swarm/updateSwarm.js — `export function updateSwarm(ctx)`
Build the spatial grid (grid.js), run the per-nibbler FSM (nibblerFSM helpers) + integrate (seek
player for RUN/JUMP, separation, gravity/ground-follow using player feet Y, jump arc, scatter),
advance phase, set clip from state, write motion; then UPLOAD to swarmGpu (the bridge above).
Recompute swarm.activeCount (NOTICE+RUN+JUMP).

### swarm/nibblerFSM.js
Pure helpers used by updateSwarm: `seekTo(i, tx, tz, speed, dt)`, `separate(i, grid, dt)`,
`integrate(i, dt, groundY)`, `tryJumpAndAttach(i, ctx, playerPos)`. Index-based, no alloc.

### swarm/attachment.js
`export function updateAttachment(ctx)` — for ATTACHED nibblers, position them on a jittered shell
around the player capsule (feet+CAPSULE_CENTER_Y, radius from CAPSULE_RADIUS) rotated by player
facing, emoting; keep swarm.attachedCount in sync. `attachNibbler(i, ctx)` (RUN/JUMP→ATTACHED,
assign attachSlot=swarm.attachNext++). `releaseAll()` used by scatter.

### swarm/grid.js
`export function buildGrid(maxLive)` (uniform spatial hash over XZ, cell=SEP_RADIUS),
`export function forNeighbors(i, fn)`, `export function forNibblersNear(x,z,r,fn)` (for stomp).

### systems/penaltySystem.js — `export function updatePenalty(ctx)`
attachedCount → nibblerPenalty.{speedMul,jumpMul,visibility} via the constants curves
(only recompute on change). Outside nibblers mode it's never called → ref stays {1,1,1}.

### systems/healthDrain.js — `export function updateHealthDrain(ctx)`
Drain the active player's health by drainRate(attachedCount) (module float), mirror to actor.health,
commit healthAtom at HEALTH_COMMIT_HZ when integer HP changes.

### systems/stompSystem.js — `export function updateStomp(ctx)`
player.motion.velY < STOMP_DESCEND_VEL && marked → grid-query nibblers within STOMP_R under feet,
free() them (FALL+fling), set player.motion.velY = STOMP_BOUNCE (plain-ref write, allowed).

### systems/commitNibblers.js — `export function commitNibblers(ctx)`
Change-gated/bucketed writes: markedAtom (bool), markedTimerAtom (int sec), attractionTierAtom,
activeNibblersAtom (coarse), attachedCountAtom (bucketed), visibilityFactorAtom (0.05 steps from
nibblerPenalty.visibility), healthAtom (handled in healthDrain), discoveredSafeZonesAtom/currentSafeZoneAtom
(handled in nibblerZones). Diff vs a module snapshot.

### render/SwarmRenderer.jsx — `<SwarmRenderer/>` default
`useGLTF(NIBBLER_PROXY_URL)` geom; `makeVatMaterial(vat)`; mount ONE `<instancedMesh args={[geom, mat, MAX]}
frustumCulled={false} castShadow={false}>` with InstancedBufferAttributes aPhase(1)/aClip(1)/aTint(3).
On mount register into swarmGpu; on unmount null it. NO useFrame. Renders only when assetsReady.

### render/vatMaterial.js — `export function makeVatMaterial(vatTextures, vatMeta)`
MeshStandardMaterial + onBeforeCompile patch sampling the VAT pos (and normal) by (aVertexId, aClip+phase),
write object-space `transformed` (do NOT multiply by instanceMatrix — three's instancing chunk does it),
`diffuseColor.rgb *= aTint`. customProgramCacheKey='nibblerVAT'. Read layout from nibbler.vat.json.

### render/nibblerAssets.js
`export function useNibblerAssets()` (drei loader hook → DataTextures Nearest/no-mips/flipY=false + meta),
`export function assetsReady()` (plain bool for the sim gate).

### zones/zoneConfig.nibblers.js — `export function buildNibblersZones(levelMeta)`
Array of zone defs (recentered): reuse the framework's exported buildHomeSafe(levelMeta) as safe_home;
+4 discoverable `type:'safe'` zones (label + discover:true) along roads; +6 hidden `type:'danger'`
(npcGroup:'nibblers') between them. Plain data.

### minimap/minimapTransform.js — `export function makeMinimapProjector(worldHalf, sizePx)`
world XZ ↔ map pixels (player-locked north-up); helpers worldToMap(x,z,playerX,playerZ)→[px,py].

### hud/* — DOM, mode-gated, reuse framework hud.css tokens
`NibblersHud.jsx` (root; only renders in nibblers mode), `MarkedIndicator`, `SwarmCount`, `HealthBar`,
`Minimap` (Canvas2D: minimap.json roads + player dot via ~10Hz rAF ref-poll + discovered pips),
`Vignette` (DOM overlay scaled by visibilityFactorAtom — simple darkening for v1), `ObjectiveHint`,
`SafeBanner`. Subscribe to nibblerAtoms via hooks; transient pulses via framework hud/hudEvents.js.

## Framework edits (additive only — done by the integrator, not these agents)
GameSystems step 6 mode-branch; stepMotion lines (speed/jump) ×= nibblerPenalty; Scene mounts
`{isNibblersMode() && <SwarmRenderer/>}`; Zones picks buildNibblersZones in nibblers mode; Zone.jsx
carries `discover` through registerZone; zoneConfig.js exports buildHomeSafe; DaHilgHud mounts
`<NibblersHud/>` + gates greet widgets; DaHilgApp calls initNibblers.
