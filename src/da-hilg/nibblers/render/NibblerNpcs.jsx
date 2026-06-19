// <NibblerNpcs/> — the real-NPC pool that REPLACES the VAT <SwarmRenderer/>. It mounts
// a fixed pool of NIBBLER_NPC_MAX skinned NPC characters (Cece + Drew, the two light
// Meshy bodies), each a SkeletonUtils clone with its OWN AnimationMixer and the shared
// animation clips, registered into the npcPool sim↔render bridge. The sim positions /
// faces / scales / clips / ticks each one every frame inside updateNibblers (via
// publishToNpcPool) — there is NO useFrame here, so it never becomes a second sim loop.
//
// Slot character is fixed by parity (even slot → cece, odd → drew) to match npcPool's
// stable 1:1 slot↔NPC binding. Inactive slots are hidden (visible=false), not unmounted,
// so the sim activating a slot is just a flag flip + a clip cross-fade — cheap.
//
// Gated on the character + clip GLBs being loaded (Suspense handles that). The pool is
// near the player, so frustum culling is left on per-clone.

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useGLTF } from '@react-three/drei';
import { CHARACTER_URL, ANIM_URL } from '../../constants.js';
import { useDaHilgGLTF } from '../../loaders.js';
import {
  MAX_NIBBLERS,
  NIBBLER_NPC_CHARS,
  NIBBLER_CHARS,
} from '../constants.js';
import { registerNpc, slotCharIx } from './npcPool.js';
import { bindNpcActions } from './npcAnim.js';

// The animation clips this pool needs (subset of the shared clips — only the horde's
// moods). CLIP_ATTACK maps to 'attack' in npcAnim.js, so this must load attack, not cheer.
const NPC_CLIP_KEYS = ['idle', 'run', 'attack', 'dance'];
const NPC_CLIP_URLS = NPC_CLIP_KEYS.map((k) => ANIM_URL[k]);

// Warm drei's cache so the first NPC mount doesn't stall on clip / body fetches.
NPC_CLIP_URLS.forEach((u) => useGLTF.preload(u));

/**
 * One pooled NPC. Clones its character body (own skeleton + materials), binds the
 * shared clips onto its OWN mixer, and registers the entry into npcPool[slot]. Unlike
 * the family's CharacterModel (parented to a capsule center, so it offsets its feet
 * down), these NPCs are free-standing: the clone sits at the group origin and the sim
 * places the group directly at the slot's feet pos each frame.
 */
function PooledNpc({ slot, charScene, clipByKey }) {
  const groupRef = useRef(null);

  // Own clone so two NPCs never share a pose.
  const clone = useMemo(() => {
    const c = SkeletonUtils.clone(charScene);
    c.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.frustumCulled = true;
      }
    });
    return c;
  }, [charScene]);

  // One mixer + actions for this clone.
  const { mixer, actions } = useMemo(() => {
    const m = new THREE.AnimationMixer(clone);
    return { mixer: m, actions: bindNpcActions(m, clipByKey) };
  }, [clone, clipByKey]);

  // Register into the bridge once the group exists; unregister + stop on unmount.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return undefined;
    const character = NIBBLER_CHARS[slotCharIx(slot)];
    const entry = { group, mixer, actions, current: null, character };
    registerNpc(slot, entry);
    return () => {
      mixer.stopAllAction();
      registerNpc(slot, null);
    };
  }, [slot, mixer, actions]);

  return (
    <group ref={groupRef} visible={false}>
      {/* The clone's authored origin is at the feet, matching how the sim places the
          group at the slot's feet pos. */}
      <primitive object={clone} />
    </group>
  );
}

/** Load one character body GLB (cece or drew) and render its half of the pool. */
function CharPool({ character, clipByKey }) {
  const { scene } = useDaHilgGLTF(CHARACTER_URL[character]);
  const charScene = scene;

  // Slots for this character: even slots → cece, odd → drew (NIBBLER_NPC_CHARS order).
  const parity = NIBBLER_NPC_CHARS.indexOf(character); // 0 = even, 1 = odd
  const slots = useMemo(() => {
    const arr = [];
    for (let i = 0; i < MAX_NIBBLERS; i++) if ((i & 1) === parity) arr.push(i);
    return arr;
  }, [parity]);

  return (
    <>
      {slots.map((slot) => (
        <PooledNpc
          key={slot}
          slot={slot}
          charScene={charScene}
          clipByKey={clipByKey}
        />
      ))}
    </>
  );
}

export default function NibblerNpcs() {
  // Load the shared clips once (drei caches by URL; array form returns one per entry).
  const clipGltfs = useGLTF(NPC_CLIP_URLS);
  const clipByKey = useMemo(() => {
    /** @type {Record<string, THREE.AnimationClip|undefined>} */
    const map = {};
    NPC_CLIP_KEYS.forEach((key, i) => {
      map[key] = clipGltfs[i]?.animations?.[0];
    });
    return map;
  }, [clipGltfs]);

  return (
    <>
      {NIBBLER_NPC_CHARS.map((character) => (
        <CharPool key={character} character={character} clipByKey={clipByKey} />
      ))}
    </>
  );
}
