// Animation for one pooled NPC. Maps the SoA clip band (CLIP_IDLE / CLIP_RUN /
// CLIP_ATTACK / CLIP_DANCE that the swarm FSM already computes per slot) to a real
// animation-clip key, and cross-fades between AnimationActions exactly like the four
// family members do (animationSystem.js) so the NPCs MOVE LIKE PEOPLE — no jumpy VAT
// frames, just smoothly blended skinned motion.
//
//   CLIP_RUN    → 'run'    (seeking the player — a full run)
//   CLIP_IDLE   → 'idle'   (spawn settle / wander / scatter ground beat)
//   CLIP_ATTACK → 'attack' (clinging + slamming the body — a punchy, looped emote)
//   CLIP_DANCE  → 'dance'  (the partying minority riding the body)
//
// The pool FORCE-LOOPS every clip because a clinging NPC
// emotes continuously; the player's one-shot semantics don't apply to the horde.
// Cross-fade durations reuse the framework FADE_* constants so the feel matches.

import * as THREE from 'three';
import {
  FADE_LOCO,
  FADE_IDLE,
  FADE_EMOTE,
  IDLE_TIMESCALE,
} from '../../constants.js';
import {
  CLIP_IDLE,
  CLIP_RUN,
  CLIP_ATTACK,
  CLIP_DANCE,
} from '../constants.js';
import { skinSafeClip } from '../../animation/clips.js';

// SoA clip band → animation clip key.
const BAND_TO_CLIP = {
  [CLIP_IDLE]: 'idle',
  [CLIP_RUN]: 'run',
  [CLIP_ATTACK]: 'attack', // aggressive ground-slam while clinging (not the cheer)
  [CLIP_DANCE]: 'dance',
};

/** Cross-fade duration into a given clip key (mirrors animationSystem.fadeFor). */
function fadeFor(key) {
  if (key === 'idle') return FADE_IDLE;
  if (key === 'attack' || key === 'cheer' || key === 'dance' || key === 'wave') return FADE_EMOTE;
  return FADE_LOCO;
}

/**
 * Bind one mixer's clip actions from a loaded clip map. The pool loops EVERY clip
 * (the horde emotes continuously) and slows the bouncy idle the same as the family.
 * @param {THREE.AnimationMixer} mixer
 * @param {Record<string, THREE.AnimationClip|undefined>} clipByKey  key -> AnimationClip
 * @returns {Record<string, THREE.AnimationAction>} actions keyed by clip key
 */
export function bindNpcActions(mixer, clipByKey) {
  /** @type {Record<string, THREE.AnimationAction>} */
  const actions = {};
  for (const key of ['idle', 'run', 'attack', 'dance']) {
    const sourceClip = clipByKey[key];
    if (!sourceClip) continue;
    const clip = skinSafeClip(sourceClip);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity); // force-loop all horde moods
    action.clampWhenFinished = false;
    if (key === 'idle') action.timeScale = IDLE_TIMESCALE;
    actions[key] = action;
  }
  return actions;
}

/**
 * Pick + cross-fade the clip for one NPC entry from its SoA clip band. No-op when the
 * band hasn't changed (the action keeps playing). Same cross-fade shape as the family.
 * @param {import('./npcPool.js').NpcEntry} e
 * @param {number} band  CLIP_* value from the SoA `clip` array
 */
export function setNpcClip(e, band) {
  const key = BAND_TO_CLIP[band] || 'idle';
  if (key === e.current) return;
  const next = e.actions[key];
  if (!next) return;
  const d = fadeFor(key);
  next.reset().fadeIn(d).play();
  const cur = e.current && e.actions[e.current];
  if (cur) cur.fadeOut(d);
  e.current = key;
}

/**
 * Advance one NPC's mixer by dt. Separated so the pool can tick all live NPCs in a
 * tight loop with the shared sim dt.
 * @param {import('./npcPool.js').NpcEntry} e
 * @param {number} dt clamped seconds
 */
export function advanceNpc(e, dt) {
  e.mixer.update(dt);
}
