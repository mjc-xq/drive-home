// One actor's physics body: a kinematicPosition RigidBody named by the actor id,
// a CapsuleCollider sized to the 1.70 m rig, and the visual CharacterModel. On
// mount we wire the Rapier handles onto actor.ref and create this actor's own
// KinematicCharacterController (paired cleanup on unmount / HMR). The RigidBody
// origin is the capsule center; the model offsets itself down to stand on feet.
//
// The `name` lives ONLY on the RigidBody (zone sensors filter by it); the inner
// group carries no name.

import { useEffect, useRef } from 'react';
import { RigidBody, CapsuleCollider, useRapier } from '@react-three/rapier';
import * as THREE from 'three';
import {
  CAPSULE_HALF_HEIGHT,
  CAPSULE_RADIUS,
  CAPSULE_CENTER_Y,
  KCC_OFFSET,
  AUTOSTEP_HEIGHT,
  AUTOSTEP_MIN_WIDTH,
  SNAP_TO_GROUND,
  MAX_SLOPE_CLIMB_DEG,
  MIN_SLOPE_SLIDE_DEG,
  CHARACTER_MASS,
} from '../constants.js';
import CharacterModel from './CharacterModel.jsx';

const deg2rad = THREE.MathUtils.degToRad;

/**
 * @param {{ actor: import('./actorRegistry.js').Actor }} props
 */
export default function ActorView({ actor }) {
  const rbRef = useRef(null);
  const { world } = useRapier();
  const pos = actor.motion.pos;

  // Wire Rapier handles + build this actor's KCC once the body exists.
  useEffect(() => {
    const rb = rbRef.current;
    if (!rb) return;

    actor.ref.rigid = rb;
    actor.ref.collider = rb.collider(0);

    // Per-actor character controller — cheap (just a query config). Tuned to
    // climb curbs/porch steps, slide on steep banks, and hug the ground.
    const kcc = world.createCharacterController(KCC_OFFSET);
    kcc.enableAutostep(AUTOSTEP_HEIGHT, AUTOSTEP_MIN_WIDTH, true);
    kcc.enableSnapToGround(SNAP_TO_GROUND);
    kcc.setApplyImpulsesToDynamicBodies(true);
    kcc.setMaxSlopeClimbAngle(deg2rad(MAX_SLOPE_CLIMB_DEG));
    kcc.setMinSlopeSlideAngle(deg2rad(MIN_SLOPE_SLIDE_DEG));
    kcc.setSlideEnabled(true);
    kcc.setCharacterMass(CHARACTER_MASS);
    actor.ref.kcc = kcc;

    return () => {
      // StrictMode is OFF, but pair create/remove so HMR can't leak controllers.
      world.removeCharacterController(kcc);
      actor.ref.kcc = null;
      actor.ref.rigid = null;
      actor.ref.collider = null;
    };
  }, [actor, world]);

  return (
    <RigidBody
      ref={rbRef}
      type="kinematicPosition"
      name={actor.id}
      colliders={false}
      enabledRotations={[false, false, false]}
      position={[pos.x, pos.y + CAPSULE_CENTER_Y, pos.z]}
    >
      <CapsuleCollider args={[CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS]} />
      <CharacterModel actor={actor} />
    </RigidBody>
  );
}
