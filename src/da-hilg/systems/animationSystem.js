// Animation system: picks an animState for each actor every frame from its
// realized motion + any active emote, cross-fades between AnimationActions, and
// advances the mixer. Plain JS, no React — called from the one sim useFrame
// (step 4, strictly after stepMotion has written motion this frame).
//
// Priority: jump (airborne) > emote (action) > run / walk / idle.

import {
  IDLE_SPEED_EPS,
  RUN_ANIM_THRESH,
  COYOTE_TIME,
  FADE_LOCO,
  FADE_IDLE,
  FADE_JUMP,
  FADE_EMOTE,
} from '../constants.js';
import { CLIP_LOOP, EMOTE_HELD } from '../animation/clips.js';

/**
 * Choose the target animState for an actor from its motion + active emote.
 * @param {import('../actors/actorRegistry.js').Actor} actor
 * @returns {string} one of idle|walk|run|jump|dance|wave|cheer
 */
function pickAnimState(actor) {
  const m = actor.motion;
  // Only play 'jump' when genuinely airborne — rising, or ungrounded past the
  // coyote window. This matches stepMotion's coyote grace and stops the jump clip
  // from latching on the single-frame grounded=false flickers the KCC reports
  // while walking the hill's slopes/steps.
  const airborne =
    !m.grounded && (m.velY > 0.1 || performance.now() - m.lastGroundedT > COYOTE_TIME * 1000);
  if (airborne) return 'jump';
  // An active emote overrides locomotion while it's held / playing.
  if (m.action) return m.action;
  // Locomotion by realized horizontal speed.
  if (m.speed < IDLE_SPEED_EPS) return 'idle';
  // Drew's authored walk is the flirty strut. Keep it for every grounded movement
  // speed so both player-controlled and full-size NPC Drew move with that style.
  if (actor.character === 'drew') return 'walk';
  if (m.speed >= RUN_ANIM_THRESH) return 'run';
  return 'walk';
}

/**
 * Fade duration for a transition into `next`. Jump and emotes are snappier;
 * idle settles a touch slower; locomotion uses the standard locomotion fade.
 * @param {string} next target animState
 */
function fadeFor(next) {
  if (next === 'jump') return FADE_JUMP;
  if (next === 'idle') return FADE_IDLE;
  if (next === 'dance' || next === 'wave' || next === 'cheer') return FADE_EMOTE;
  return FADE_LOCO;
}

/**
 * Advance one actor's animation: clear finished one-shot emotes, choose the
 * target state, cross-fade if it changed, then tick the mixer.
 * @param {import('../actors/actorRegistry.js').Actor} actor
 * @param {number} dt clamped seconds
 */
export function updateAnimation(actor, dt) {
  const { mixer, actions, current } = actor.ref;
  if (!mixer || !actions) return;
  const m = actor.motion;

  // --- Retire a finished/expired emote so we fall back to locomotion ---
  if (m.action) {
    const emoteAction = actions[m.action];
    const isOneShot = CLIP_LOOP[m.action] === 'once';
    const interruptedByMove = m.speed > IDLE_SPEED_EPS || !m.grounded;
    let done = false;

    if (isOneShot && emoteAction) {
      const clip = emoteAction.getClip();
      // LoopOnce clamps at the end; detect completion by action time.
      if (emoteAction.time >= clip.duration - 1e-3) done = true;
    }
    // Held emotes (dance) end when the actor starts moving or goes airborne.
    if (EMOTE_HELD[m.action] && interruptedByMove) done = true;
    // One-shots are also cancellable by movement/jump.
    if (isOneShot && interruptedByMove) done = true;
    // Timed expiry safety net (set by requestEmote for held loops).
    if (m.actionUntil > 0 && performance.now() >= m.actionUntil) done = true;

    if (done) {
      m.action = null;
      m.actionUntil = 0;
    }
  }

  // --- Choose target state and cross-fade if changed ---
  const target = pickAnimState(actor);
  if (target !== current) {
    const next = actions[target];
    if (next) {
      const d = fadeFor(target);
      // Restart emote/jump one-shots from frame 0 so they always play in full.
      next.reset().fadeIn(d).play();
      if (current && actions[current]) actions[current].fadeOut(d);
      actor.ref.current = target;
      m.animState = target;
    }
  }

  mixer.update(dt);
}

/**
 * Request an emote on an actor. Sets motion.action (held vs one-shot per
 * EMOTE_HELD / CLIP_LOOP) and an optional faceTarget. The actual clip swap
 * happens in updateAnimation; one-shots clear themselves on finish, held loops
 * clear on movement/jump or the optional `holdMs` expiry.
 * @param {import('../actors/actorRegistry.js').Actor} actor
 * @param {'dance'|'wave'|'cheer'} key
 * @param {{ faceTarget?: import('three').Vector3|null, holdMs?: number }} [opts]
 */
export function requestEmote(actor, key, opts = {}) {
  const m = actor.motion;
  m.action = key;
  // Held loops can carry an optional auto-expiry; one-shots clear on finish.
  m.actionUntil =
    EMOTE_HELD[key] && opts.holdMs ? performance.now() + opts.holdMs : 0;
  actor.ai.faceTarget = opts.faceTarget ?? actor.ai.faceTarget;
}
