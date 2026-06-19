// Binds the canonical animation clips onto a single character's cloned
// skeleton. All four rigs are byte-identical 24-bone Mixamo skeletons with bare
// bone names, so each clip-only GLB (ANIM_URL) binds by bone name with zero
// remapping. We build ONE AnimationMixer for the given clone and one
// AnimationAction per clip, with loop modes from CLIP_LOOP.

import { useMemo } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { ANIM_URL, IDLE_TIMESCALE } from '../constants.js';
import { CLIP_KEYS, CLIP_LOOP, skinSafeClip } from './clips.js';

// The clip GLB URLs in canonical key order — drei caches each by URL.
const CLIP_URLS = CLIP_KEYS.map((key) => ANIM_URL[key]);

/**
 * Load the shared clip GLBs and bind them as AnimationActions onto `clonedScene`.
 * Returns one mixer + an actions map keyed by clip key (idle/walk/run/...).
 * @param {THREE.Object3D} clonedScene this actor's own SkeletonUtils clone
 * @returns {{ mixer: THREE.AnimationMixer, actions: Record<string, THREE.AnimationAction> }}
 */
export function useCharacterClips(clonedScene) {
  // useGLTF must be called the same number of times each render, so load the
  // fixed CLIP_URLS array (drei accepts an array and returns one result each).
  const gltfs = useGLTF(CLIP_URLS);

  return useMemo(() => {
    const mixer = new THREE.AnimationMixer(clonedScene);
    /** @type {Record<string, THREE.AnimationAction>} */
    const actions = {};

    CLIP_KEYS.forEach((key, i) => {
      // Each clip GLB carries exactly its one clip as animations[0].
      const sourceClip = gltfs[i]?.animations?.[0];
      if (!sourceClip) return;

      const clip = skinSafeClip(sourceClip);
      const action = mixer.clipAction(clip);
      if (CLIP_LOOP[key] === 'once') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true; // hold the last pose until cleared
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
      }
      // Calm the bouncy boxer-warmup idle so a standing character reads as relaxed.
      if (key === 'idle') action.timeScale = IDLE_TIMESCALE;
      actions[key] = action;
    });

    return { mixer, actions };
    // Rebuild only when the clone or the loaded clip set changes.
  }, [clonedScene, gltfs]);
}

// Warm drei's cache so the first character mount doesn't stall on clip fetches.
CLIP_URLS.forEach((url) => useGLTF.preload(url));
