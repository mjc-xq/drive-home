// The visual character: loads this actor's GLB, clones it (own skeleton +
// material instances) so four actors never share a pose, binds the seven
// animation clips, and exposes group/mixer/actions on actor.ref. The clone sits
// at the capsule's feet — the parent RigidBody origin is at the capsule center,
// so we offset the model DOWN by CAPSULE_CENTER_Y to align feet with the floor.
//
// We do NOT hide head bones in first-person: the camera near-plane (FP_NEAR)
// clips the player's own head, so no bone hacks are needed.

import { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CHARACTER_URL, CAPSULE_CENTER_Y } from '../constants.js';
import { useCharacterClips } from '../animation/useCharacterClips.js';

/**
 * @param {{ actor: import('./actorRegistry.js').Actor }} props
 */
export default function CharacterModel({ actor }) {
  const { scene } = useGLTF(CHARACTER_URL[actor.character]);

  // Each actor gets its OWN clone (skeleton + materials) so animations and any
  // future per-actor tinting never bleed across the family.
  const clone = useMemo(() => {
    const c = SkeletonUtils.clone(scene);
    c.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.frustumCulled = true;
      }
    });
    return c;
  }, [scene]);

  const { mixer, actions } = useCharacterClips(clone);

  // The group whose world transform the camera/motion can read.
  const groupRef = useRef(null);

  // Publish the visual handles onto the actor ref bag for the animation system.
  useEffect(() => {
    actor.ref.group = groupRef.current;
    actor.ref.mixer = mixer;
    actor.ref.actions = actions;
    return () => {
      // Stop the mixer so a hot-reload doesn't leak running actions.
      mixer.stopAllAction();
      if (actor.ref.mixer === mixer) {
        actor.ref.group = null;
        actor.ref.mixer = null;
        actor.ref.actions = {};
      }
    };
  }, [actor, mixer, actions]);

  return (
    // Feet sit CAPSULE_CENTER_Y below the RigidBody origin (capsule center).
    // The mesh authoring faces +Z, matching our yaw convention.
    <group ref={groupRef} position={[0, -CAPSULE_CENTER_Y, 0]}>
      <primitive object={clone} />
    </group>
  );
}

// Warm the four character GLBs so the first actor mount doesn't stall.
Object.values(CHARACTER_URL).forEach((url) => useGLTF.preload(url));
