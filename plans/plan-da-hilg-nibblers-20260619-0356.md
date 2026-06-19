# Plan: Nibblers — swarm game on the Da Hilg framework

**Created:** 2026-06-19 03:56
**Status:** implemented (in progress)
**Experts consulted:** swarm-architecture, gameplay-systems, zones/minimap/mode, HUD/game-feel, architect, principal-synthesizer, staff-reviewer

## Requirements

Implement **Nibblers** (`/Users/mcohen/Downloads/nibblers-game-spec.md`) ON TOP of the shipped Da Hilg framework (branch `feat/da-hilg-nibblers`). Third-person exploration: hidden **Danger Zones** mark the player → swarms of mini (10–15% scale) clones of the four characters, constantly emoting, converge and **attach**; attachments **slow movement, weaken jumps, reduce visibility** and slowly **drain health**; **stomp** by jumping on them (risky); **Safe Zones** remove Marked, stop spawns, **scatter** the swarm, and reveal permanently on a **minimap** (roads + player + discovered safe zones only). Power comes from discovering safe zones.

## Architecture

Everything new under `src/da-hilg/nibblers/`; framework gets ~9 additive edits. **The swarm is NOT registry actors** — it's a flat typed-array SoA simulated in the single `GameSystems` useFrame (one new gated step) and rendered as **ONE `InstancedMesh`** whose `MeshStandardMaterial` is patched via `onBeforeCompile` to sample a **Vertex Animation Texture** (1 draw call for the whole horde, up to `MAX_NIBBLERS=512`). The character meshes are 57k–166k verts → the bake **decimates to a ~512-vert proxy** first. One shared VAT for all four (identical 24-bone rig) + per-instance `aTint`. GPU buffer upload is folded into the sim tail (literally one sim `useFrame`; `SwarmRenderer` runs no `useFrame`).

**Mode:** `gameModeAtom` defaults to `'nibblers'`; one branch in `GameSystems` step 6 (`updateNibblers` vs `updateGreet`). Greet HUD/AI-chase gated off; family stays Tab-switchable but calm.

## Staff-review MUST-FIXES (applied)

1. **Minimap reads the SOURCE GLB** `exports/1840-dahill-property.glb` at build time (road mesh names are stripped from the runtime `level.glb` by meshopt). Output `public/da-hilg/minimap.json` (recentered XZ polylines).
2. **All road meshes are TRIANGLES** — boundary-edge extraction for every layer; no LINES special-case.
3. **VAT bake = headless three** (`GLTFLoader.parse` proxy + clips → `AnimationMixer.setTime` per frame → `skinnedMesh.applyBoneTransform(i, v)` per vertex → RGBA8 VAT). Browser-harness fallback noted. This is the critical path.
4. **`nibblerPenalty` ref defaults `{speedMul:1, jumpMul:1, visibility:1}`** — `stepMotion` lines 70/91 multiply by it (the `speedMultiplierFor` seam is genuinely unwired; its docstring lies). Greet mode = exact no-op.
5. **First-playable cuts:** all audio, vignette blur/backdrop-filter, golden-spiral attachment (use jittered random offset), the aLod near/far normal split (full VAT normals for all), and chaining the VAT bake into the hero pipeline (keep it a separate script).
6. **Reorder:** danger/safe zones + marked right after the spawner, so marked→spawn→chase is validated before attach/penalty/stomp.

## Swarm (rendering + bake + SoA + sim)

- **VAT bake** `scripts/build_nibbler_vat.mjs` → `public/da-hilg/nibblers/{nibbler.proxy.glb, nibbler.vat.png, nibbler.vat.json}`. Decimate (`MeshoptSimplifier`) to ~512 verts keeping skin; CPU-skin 24 frames/clip for `[idle,run,jump,emote]`; pack pos+normal RGBA8 with per-axis bounds remap; assert no NaN, dims under budget, rig binds.
- **Renderer** ONE `<instancedMesh>` (proxy geom + patched material, `count=MAX`, `frustumCulled=false`, `castShadow=false`); per-instance `aPhase/aClip/aTint/aVertexId`; `customProgramCacheKey`.
- **SoA** `swarm/swarmState.js` Float32/Uint8/Int16 arrays (px/py/pz, vx/vy/vz, heading, scale, phase, state, char, emote, clip, attachSlot, stateT, jumpCD, seed) + free-list + swap-remove compaction. Plain module, NO atoms.
- **Sim** in `GameSystems` step 6: `updateNibblerZones → spawner → updateSwarm(FSM + grid + integrate + buffer upload) → attachment → penalty → healthDrain → stomp → discovery → commitNibblers`.

## Gameplay

Marked (persists until safe); attraction timeline 2-5→10-20→25-40→50-80→100+ over 120s; ring-spawner servo on active count (biased away from camera); per-nibbler FSM (spawn/wander/notice/run/jump/attached/fall/scatter/despawn); attach test = capsule-vs-point (no Rapier); penalty curves `speedMul=1/(1+a/70)`, `jumpMul=1/(1+a/45)^1.3`, `visibility=1-(a/260)^0.85`; health drain `min(a·0.04,2.5)` HP/s (1.5 Hz commit); stomp on descending+near-feet grid query (+bounce); safe-zone `clearAndScatter`. Zero-raycast ground-follow (player feet Y; one castRay at spawn).

## Zones + minimap + mode

5 safe (incl. auto-fit `safe_home`) + 6 hidden danger (`type:'danger'`, sensor-only = invisible), recentered coords. `updateNibblerZones` (after `flushZones`) edge-detects the active player's reconciled zone set → marked/discovered/scatter. New atoms in `nibblers/state/nibblerAtoms.js`: `gameModeAtom`, `discoveredSafeZonesAtom`, `markedTimerAtom`, `attachedCountAtom` (bucketed), `activeNibblersAtom`, `attractionTierAtom`, `visibilityFactorAtom`; reuse `markedAtom`/`healthAtom`. Minimap widget = Canvas2D (roads from `minimap.json` + player dot/heading via throttled ref-poll + discovered safe pips); never danger/nibblers/undiscovered (enforced by data availability).

## Build order (each verifiable)

0. Scaffold + mode gate (greet gated, no-op `updateNibblers`) → 1. VAT bake → 2. Swarm renderer (static 50, 1 draw call) → 3. Swarm sim (seek player) → 4. Spawner + attraction → **5. Danger/safe zones + marked + scatter** (moved up) → 6. Attach + penalty + health → 7. Stomp → 8. Discovery + minimap → 9. HUD → 10. Juice/audio/emote variety → 11. Perf + docs (`nibblers/AGENTS.md`) + sw VERSION bump.

## Verification checklist

- [ ] `public/da-hilg/nibblers/{nibbler.proxy.glb, nibbler.vat.png, nibbler.vat.json}` built; assertions pass; `minimap.json` built from source GLB
- [ ] Swarm renders as mini-characters in ≤~3 draw calls; VAT animates on GPU
- [ ] Enter hidden danger → MARKED + spawns ramp 5→…→100+; nibblers chase; reach safe → scatter to 0 + penalties reset
- [ ] Attach accumulates; movement slows (50 noticeable / 100 difficult / 200 near-immobile); jump weakens; health drains slowly
- [ ] Stomp kills nibblers under descending feet
- [ ] Minimap shows roads + player + discovered safe zones only (never danger/nibblers/undiscovered)
- [ ] `gameModeAtom` toggles cleanly; greet loop gated off; no double sim loop; atoms not thrashed (bucketed)
- [ ] All 15 Nibblers MVP criteria met; isolation guard empty; build + tests clean; pushed
