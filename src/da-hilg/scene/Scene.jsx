// Scene — the <Physics> host. Lays out the world subtree (Level, Zones, Actors)
// plus the single GameSystems simulation driver.
//
// Gravity is [0,0,0] on purpose: our characters are KINEMATIC capsules driven by
// a KinematicCharacterController (stepMotion does its OWN gravity integration), so
// the world's gravity must NOT move them, and sensors/zones don't need it either.
//
// Paused-until-ready pattern: physics starts `paused` so freshly-spawned capsules
// don't free-fall during the frame(s) before the level's trimesh collider exists.
// Once the level meta is loaded we flip `paused=false` on the next tick. timeStep
// is "vary" so stepping tracks real frame time (the dt clamp lives in stepMotion's
// caller).

import { Suspense, useEffect, useState } from 'react';
import { Physics } from '@react-three/rapier';
import { useAtomValue } from 'jotai';

import { levelMeta } from '../state/refs.js';
import Level from '../level/Level.jsx';
import Zones from '../zones/Zones.jsx';
import Actors from '../actors/Actors.jsx';
import GameSystems from './GameSystems.jsx';
import CameraRig from '../camera/CameraRig.jsx';
import RenderLoop from './RenderLoop.jsx';
import { gameModeAtom } from '../nibblers/state/nibblerAtoms.js';
import { NibblerNpcs } from '../nibblers/index.js';
import SafeZoneBeacons from '../nibblers/render/SafeZoneBeacons.jsx';

export default function Scene() {
  // Start paused; release one tick after the level (and thus its collider) is up.
  const [physicsPaused, setPhysicsPaused] = useState(true);
  const mode = useAtomValue(gameModeAtom);

  useEffect(() => {
    let raf = 0;
    // Poll the plain levelMeta ref until the level reports loaded, then release
    // physics on the following animation frame so the collider is mounted first.
    const tick = () => {
      if (levelMeta.loaded) {
        // One extra frame of grace so the trimesh collider is registered.
        raf = requestAnimationFrame(() => setPhysicsPaused(false));
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <Physics gravity={[0, 0, 0]} timeStep="vary" paused={physicsPaused}>
      <Suspense fallback={null}>
        <Level />
      </Suspense>
      <Zones />
      <Actors />
      {/* The nibbler horde — a throttled pool of REAL skinned Cece/Drew NPCs driven by
          AnimationMixers (replaces the VAT swarm). Renders only in nibblers mode; gated
          by Suspense on its character + clip GLBs. */}
      {mode === 'nibblers' && (
        <Suspense fallback={null}>
          <NibblerNpcs />
        </Suspense>
      )}
      {/* Glowing pillars at every safe zone so they're findable in-world. */}
      {mode === 'nibblers' && <SafeZoneBeacons />}
      <GameSystems />
      {/* Camera lives inside <Physics> because its third-person collision ray
          uses useRapier(); priority 10 still runs it after the sim each frame. */}
      <CameraRig />
      {/* CameraRig's numeric priority disables R3F auto-render, so render manually. */}
      <RenderLoop />
    </Physics>
  );
}
