// Binds the canonical animation clips onto a single character's cloned skeleton.
// Clip GLBs bind by shared bone names, then retarget through the source/target
// rest poses so Meshy rigs with different hip/spine locals don't twist waists.
// We build ONE AnimationMixer for the given clone and one AnimationAction per
// clip, with loop modes from CLIP_LOOP.

import { useMemo } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { ANIM_URL, ANIM_OVERRIDE_URL, IDLE_TIMESCALE, WALK_TIMESCALE } from '../constants.js';
import { CLIP_KEYS, CLIP_LOOP, retargetSkinSafeClip } from './clips.js';

// The clip GLB URLs in canonical key order — drei caches each by URL.
const CLIP_URLS = CLIP_KEYS.map((key) => ANIM_URL[key]);

// Flatten the per-character overrides into ONE fixed list of { character, state, url }.
// Loading the whole (small) set every render keeps the useGLTF hook count constant across
// every character (React hook rule), and drei caches by URL so it's shared + cheap. Each
// override is bound under the `<state>__<character>` key the animation system resolves,
// so cece/mike/kelli prefer their OWN clip for that state and fall back to the shared one.
const OVERRIDE_ENTRIES = Object.entries(ANIM_OVERRIDE_URL).flatMap(([character, byState]) =>
  Object.entries(byState).map(([state, url]) => ({ character, state, url })),
);
const OVERRIDE_URLS = OVERRIDE_ENTRIES.map((e) => e.url);

/**
 * Load the shared clip GLBs and bind them as AnimationActions onto `clonedScene`.
 * Returns one mixer + an actions map keyed by clip key (idle/walk/run/...).
 * @param {THREE.Object3D} clonedScene this actor's own SkeletonUtils clone
 * @param {string} character stable character key used for retarget cache reuse
 * @returns {{ mixer: THREE.AnimationMixer, actions: Record<string, THREE.AnimationAction> }}
 */
export function useCharacterClips(clonedScene, character) {
  // useGLTF must be called the same number of times each render, so load the
  // fixed CLIP_URLS array (drei accepts an array and returns one result each).
  const gltfs = useGLTF(CLIP_URLS);
  // Same fixed-length rule for the override set (load all, bind only this char's below).
  const overrideGltfs = useGLTF(OVERRIDE_URLS);

  return useMemo(() => {
    const mixer = new THREE.AnimationMixer(clonedScene);
    /** @type {Record<string, THREE.AnimationAction>} */
    const actions = {};

    // Bind a retargeted clip onto this clone as an action with the right loop mode +
    // base timeScale for `state`. Shared between the canonical clips and the overrides.
    const bind = (state, sourceClip, sourceScene) => {
      const clip = retargetSkinSafeClip(sourceClip, sourceScene, clonedScene, character, state);
      const action = mixer.clipAction(clip);
      if (CLIP_LOOP[state] === 'once') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true; // hold the last pose until cleared
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
      }
      // Calm the bouncy boxer-warmup idle so a standing character reads as relaxed.
      if (state === 'idle') action.timeScale = IDLE_TIMESCALE;
      // Speed up the slow catwalk strut so the stride matches the walk movement speed.
      if (state === 'walk') action.timeScale = WALK_TIMESCALE;
      return action;
    };

    CLIP_KEYS.forEach((key, i) => {
      // Each clip GLB carries exactly its one clip as animations[0].
      const sourceClip = gltfs[i]?.animations?.[0];
      if (!sourceClip) return;
      actions[key] = bind(key, sourceClip, gltfs[i]?.scene);
    });

    // Per-character overrides: bind ONLY this character's variants under `<state>__<char>`.
    // The animation system resolves that key first and falls back to the shared clip, so
    // cece/mike/kelli visibly differ on their overridden states (e.g. cece's breakdance).
    OVERRIDE_ENTRIES.forEach((entry, i) => {
      if (entry.character !== character) return;
      const sourceClip = overrideGltfs[i]?.animations?.[0];
      if (!sourceClip) return;
      actions[`${entry.state}__${character}`] = bind(entry.state, sourceClip, overrideGltfs[i]?.scene);
    });

    return { mixer, actions };
    // Rebuild only when the clone or the loaded clip set changes.
  }, [clonedScene, gltfs, overrideGltfs, character]);
}

// Warm drei's cache so the first character mount doesn't stall on clip fetches.
CLIP_URLS.forEach((url) => useGLTF.preload(url));
OVERRIDE_URLS.forEach((url) => useGLTF.preload(url));
