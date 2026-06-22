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
  ANIM_FAR_DIST,
  ANIM_FAR_DT,
} from '../constants.js';
import * as THREE from 'three';
import { CLIP_LOOP, EMOTE_HELD } from '../animation/clips.js';
import { activePlayer } from '../state/refs.js';
import { nibblerPenalty } from '../nibblers/mode.js';

/**
 * Choose the target animState for an actor from its motion + active emote.
 * @param {import('../actors/actorRegistry.js').Actor} actor
 * @returns {string} one of idle|walk|run|jump|dance|wave|cheer
 */
function pickAnimState(actor) {
  const m = actor.motion;
  const isPlayer = actor === activePlayer();
  // An active emote (incl. the knockdown one-shot) plays first.
  if (m.action) return m.action;
  // Overwhelm: once buried (tier ≥ 2) the player is taken to the ground → 'knockdown',
  // a LoopOnce clip that clamps on its prone end pose (held while still buried). This
  // overrides jump/locomotion. (The 'crawl' clip is a vertical climb pose, which reads
  // as standing — so we use the prone knockdown for the downed state.)
  if (isPlayer && nibblerPenalty.overwhelm >= 2) return 'knockdown';
  // Only play 'jump' when genuinely airborne — rising, or ungrounded past the coyote
  // window. Matches stepMotion's coyote grace; ignores the KCC's single-frame flickers.
  const airborne =
    !m.grounded && (m.velY > 0.1 || performance.now() - m.lastGroundedT > COYOTE_TIME * 1000);
  if (airborne) return 'jump';
  // Staggering under the load (tier 1) → stumble in place of normal locomotion.
  if (isPlayer && nibblerPenalty.overwhelm >= 1) return 'stumble';
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
    // A clip is one-shot here if its manifest loop is 'once', OR the request forced it
    // (m.actionOnce — the player punch reuses the shared 'attack' clip, which loops for
    // the nibbler swarm but must play exactly once on the player).
    const isOneShot = CLIP_LOOP[m.action] === 'once' || m.actionOnce === true;
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
      // Restore a forced one-shot clip (the punch's 'attack') back to its default
      // loop mode so nothing else inherits LoopOnce on this actor's action.
      if (m.actionOnce && emoteAction && CLIP_LOOP[m.action] !== 'once') {
        emoteAction.setLoop(THREE.LoopRepeat, Infinity);
        emoteAction.clampWhenFinished = false;
      }
      m.action = null;
      m.actionUntil = 0;
      m.actionOnce = false;
    }
  }

  // --- Choose target state and cross-fade if changed ---
  const target = pickAnimState(actor);
  if (target !== current) {
    const next = actions[target];
    if (next) {
      const d = fadeFor(target);
      // Forced one-shot (the player punch on the shared 'attack' clip): bound as a
      // repeat by default, so flip THIS actor's action to LoopOnce+clamp for the
      // single play. The swarm never goes through this path, so its looping use of
      // 'attack' is untouched.
      if (target === m.action && m.actionOnce && CLIP_LOOP[target] !== 'once') {
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
      }
      // Restart emote/jump one-shots from frame 0 so they always play in full.
      next.reset().fadeIn(d).play();
      if (current && actions[current]) actions[current].fadeOut(d);
      actor.ref.current = target;
      m.animState = target;
    }
  }

  // Throttle skinning for distant, non-controlled actors (background NPC bodies — incl.
  // the heavy mike/kelli — are wasted work off-screen). The active player + nearby
  // actors stay full-rate; far ones re-skin at ~ANIM_FAR_DT, advancing by accumulated
  // dt so playback speed is preserved.
  const p = activePlayer();
  if (p && actor !== p) {
    const dx = m.pos.x - p.motion.pos.x;
    const dz = m.pos.z - p.motion.pos.z;
    if (dx * dx + dz * dz > ANIM_FAR_DIST * ANIM_FAR_DIST) {
      const acc = (actor.ref._animAcc || 0) + dt;
      if (acc < ANIM_FAR_DT) {
        actor.ref._animAcc = acc;
        return;
      }
      actor.ref._animAcc = 0;
      mixer.update(acc);
      return;
    }
  }

  mixer.update(dt);
}

/**
 * Request an emote on an actor. Sets motion.action (held vs one-shot per
 * EMOTE_HELD / CLIP_LOOP) and an optional faceTarget. The actual clip swap
 * happens in updateAnimation; one-shots clear themselves on finish, held loops
 * clear on movement/jump or the optional `holdMs` expiry.
 *
 * `opts.oneShot` forces a normally-looping clip (e.g. the shared 'attack' used by
 * the player punch) to play exactly once and then return to locomotion.
 * @param {import('../actors/actorRegistry.js').Actor} actor
 * @param {'dance'|'wave'|'cheer'|'attack'} key
 * @param {{ faceTarget?: import('three').Vector3|null, holdMs?: number, oneShot?: boolean }} [opts]
 */
export function requestEmote(actor, key, opts = {}) {
  const m = actor.motion;
  m.action = key;
  m.actionOnce = !!opts.oneShot;
  // Held loops can carry an optional auto-expiry; one-shots clear on finish.
  m.actionUntil =
    EMOTE_HELD[key] && opts.holdMs ? performance.now() + opts.holdMs : 0;
  actor.ai.faceTarget = opts.faceTarget ?? actor.ai.faceTarget;
}

/**
 * Play the player's PUNCH: the shared 'attack' clip as a brief one-shot. Distinct
 * from requestEmote so a rapid second punch re-fires even while 'attack' is already
 * the current action (rewind the bound action so the swing replays from frame 0).
 * The nibblers' looping use of 'attack' is in the SoA swarm, never this path.
 * @param {import('../actors/actorRegistry.js').Actor} actor
 */
export function requestPunch(actor) {
  if (!actor) return;
  // Don't punch while downed/pinned — the body is prone (knockdown clip owns it).
  if (nibblerPenalty.overwhelm >= 2) return;
  const m = actor.motion;
  // If already mid-punch, rewind the bound action so the swing restarts cleanly.
  const a = actor.ref?.actions?.attack;
  if (m.action === 'attack' && a) a.reset();
  m.action = 'attack';
  m.actionOnce = true;
  m.actionUntil = 0;
}
