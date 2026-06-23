// GameSystems — the ONE simulation useFrame for Da Hilg. Default priority, so it
// runs BEFORE the cameras (CameraRig at priority 10 reads post-move transforms).
// Renders nothing. Implements the fixed Update Order from CONTRACTS.md:
//   1. clock.now/dt (clamped) + updateInput(getKeys)
//   2. build the full per-frame ctx (with world + rapier from useRapier)
//   3. per actor: intent = controller.produce(actor, ctx, dt); stepMotion(actor, intent, ctx)
//   4. per actor: updateAnimation(actor, dt)
//   5. flushZones(ctx)
//   6. updateGreet(ctx)
//   7. commitReactive(ctx)
//
// Every per-frame write lands in plain refs; the only React/Jotai writes are the
// change-gated ones inside commitReactive (step 7).

import { useFrame } from '@react-three/fiber';
import { useRapier } from '@react-three/rapier';
import { useKeyboardControls } from '@react-three/drei';

import { daHilgStore } from '../state/store.js';
import { registry, input, cameraRig, levelMeta, clock } from '../state/refs.js';
import { activePlayerIdAtom, pausedAtom } from '../state/atoms.js';
import { DT_CLAMP } from '../constants.js';
import { updateInput } from '../input/useInput.js';
import { stepMotion } from '../systems/stepMotion.js';
import { trySnapActor } from '../systems/spawnSnap.js';
import { updateAnimation } from '../systems/animationSystem.js';
import { clampToBoundary } from '../systems/boundarySystem.js';
import { autoBumpAttack } from '../systems/familyPunch.js';
import { flushZones } from '../systems/zoneSystem.js';
import { updateGreet } from '../systems/greetSystem.js';
import { commitReactive } from '../systems/commitReactive.js';
import { isNibblersMode, updateNibblers } from '../nibblers/index.js';

/** The single simulation driver. Renders null. */
export default function GameSystems() {
  const { world, rapier } = useRapier();
  // Transient getKeys — NEVER the subscribe form (that re-renders).
  const [, getKeys] = useKeyboardControls();

  useFrame((_state, dtRaw) => {
    // Guard: do nothing until the registry is built and the level is ready.
    if (!levelMeta.loaded || registry.size === 0) return;
    // Pause halts the whole simulation (camera keeps reading the frozen refs).
    if (daHilgStore.get(pausedAtom)) return;

    // ── 1. Clock + input ──
    const now = performance.now();
    const dt = Math.min(dtRaw, DT_CLAMP);
    clock.now = now;
    clock.dt = dt;
    updateInput(getKeys);

    // ── 2. Build the full per-frame ctx (controllers + systems share this) ──
    const activePlayerId = daHilgStore.get(activePlayerIdAtom);
    const ctx = {
      store: daHilgStore,
      world,
      rapier,
      registry,
      input,
      cameraRig,
      levelMeta,
      now,
      dt,
      activePlayerId,
    };

    // ── 3. Intent → motion (single KCC apply per actor) ──
    // Each actor is dropped onto the terrain (trySnapActor) before its first step;
    // until then it is skipped, so it never sims while buried in the hillside.
    registry.forEach((actor) => {
      if (!actor.ref._snapped) {
        trySnapActor(actor, ctx);
        return;
      }
      const intent = actor.controller
        ? actor.controller.produce(actor, ctx, dt)
        : null;
      if (intent) stepMotion(actor, intent, ctx);
    });

    // ── 3b. Map boundary: warp the player to a random border spot if they cross the
    //        walkable edge (after motion, before animation/zones read the position). ──
    clampToBoundary(ctx);

    // ── 3c. Auto-bump: walking INTO a full-size family NPC throws an automatic swing
    //        (player attacks, the bumped NPC gets shoved + flinched). Greet mode only — in
    //        Nibblers mode the combat focus is the swarm, not the wandering family. ──
    if (!isNibblersMode()) autoBumpAttack(ctx);

    // ── 4. Animation (reads motion produced in step 3, strictly after) ──
    registry.forEach((actor) => {
      updateAnimation(actor, dt);
    });

    // ── 5. Zones: drain queued sensor events → zonesActive + toasts ──
    flushZones(ctx);

    // ── 6. Mode loop: Nibblers swarm sim OR the greet-the-family scan ──
    if (isNibblersMode()) updateNibblers(ctx);
    else updateGreet(ctx);

    // ── 7. Change-gated atom writes (the only React-facing writes) ──
    commitReactive(ctx);
  });

  return null;
}
