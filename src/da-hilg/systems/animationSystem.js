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

// States that read as continuous body motion and look robotic when a crowd plays the
// SAME clip at the SAME phase + rate. We desync these per-actor (NPCs only) so the
// family doesn't walk/idle in lockstep — no new assets, just a stable rate + phase.
const VARIETY_STATES = new Set(['idle', 'walk', 'run']);

/**
 * A stable 0..1 hash for an actor, derived once from its id and cached on the ref.
 * Drives the per-actor rate jitter + phase offset so the same actor always desyncs the
 * same way (no per-frame randomness — that would make the timeScale shimmer).
 * @param {import('../actors/actorRegistry.js').Actor} actor
 */
function actorSeed(actor) {
  if (actor.ref._varSeed != null) return actor.ref._varSeed;
  let h = 2166136261;
  const id = actor.id || '';
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const seed = ((h >>> 0) % 1000) / 1000; // 0..0.999
  actor.ref._varSeed = seed;
  return seed;
}

/**
 * Resolve the actual action KEY to play for a canonical animState, preferring this
 * actor's own loaded variant over the shared clip. Variant actions are bound under
 * `<state>__<character>` (e.g. `dance__cece`) when useCharacterClips loads an
 * ANIM_OVERRIDE_URL entry; if none is bound the canonical state key is returned. Cheap:
 * one map lookup, only on a state change.
 * @param {import('../actors/actorRegistry.js').Actor} actor
 * @param {string} state canonical animState (idle|walk|dance|...)
 * @param {Record<string, THREE.AnimationAction>} actions
 * @returns {string} the action key to play
 */
function resolveVariantKey(actor, state, actions) {
  const variant = `${state}__${actor.character}`;
  return actions[variant] ? variant : state;
}

/**
 * Apply the per-actor locomotion/idle desync as the actor ENTERS a variety state:
 * a stable rate jitter (±~8%) multiplied onto the action's authored base timeScale,
 * plus a stable phase offset so two actors in the same clip aren't on the same frame.
 * The ACTIVE PLAYER is left untouched (predictable, input-tight feel); only NPC bodies
 * desync. Called once on the crossfade-in (cheap), and the jitter is stored on the
 * action so the per-frame path never recomputes or compounds it.
 * @param {import('../actors/actorRegistry.js').Actor} actor
 * @param {string} state target animState being entered
 * @param {THREE.AnimationAction} action the action being faded in
 * @param {boolean} isPlayer
 */
function applyLocoVariety(actor, state, action, isPlayer) {
  if (isPlayer || !VARIETY_STATES.has(state)) return;
  const seed = actorSeed(actor);
  // Stable rate jitter once per action: remember the authored base timeScale, then
  // multiply by a per-(actor,state) factor so walk keeps its WALK_TIMESCALE stride and
  // idle its IDLE_TIMESCALE sway — just nudged so the crowd's cadence varies.
  if (action.userData == null) action.userData = {};
  if (action.userData._varBase == null) action.userData._varBase = action.timeScale;
  const stateBump = state === 'run' ? 0.07 : 0.13; // a fraction more spread when walking/idling
  const factor = 1 + (seed - 0.5) * 2 * stateBump; // ~0.87..1.13 (run ~0.93..1.07)
  action.timeScale = action.userData._varBase * factor;
  // Phase offset: start the loop at a stable per-actor point in the cycle.
  const dur = action.getClip()?.duration || 0;
  if (dur > 0) action.time = (seed * dur) % dur;
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
    // Use the variant actually playing (e.g. dance__cece) so one-shot completion is read
    // off the right action, not the shared clip the actor isn't playing.
    const emoteAction = actions[resolveVariantKey(actor, m.action, actions)];
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
    // Prefer this character's OWN variant action for the state when one is bound (e.g. a
    // future cece_dance / kelli_idle bound under a variant key by useCharacterClips), so
    // cece/mike/kelli visibly differ — falling back to the shared clip when absent. The
    // resolved key (not the canonical target) becomes `current` so retire/fadeOut match.
    const isPlayer = actor === activePlayer();
    const playKey = resolveVariantKey(actor, target, actions);
    const next = actions[playKey];
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
      // Per-actor locomotion/idle desync (NPCs only) — set AFTER reset() so the phase
      // offset survives (reset zeroes action.time but leaves timeScale).
      applyLocoVariety(actor, target, next, isPlayer);
      if (current && actions[current]) actions[current].fadeOut(d);
      actor.ref.current = playKey;
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
