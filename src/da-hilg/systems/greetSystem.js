// Greet system — the game's core verb. Walk up to a family member (they must be
// an NPC) and press E: they turn to face you, play a one-shot reaction emote, a
// toast + hit-marker fire, and they're marked greeted. Greeting all four wins.
//
// updateGreet runs ~5 Hz from the sim loop to find the nearest greetable NPC and
// stash it (change-gated) for the HUD prompt + commitReactive. requestGreet is
// the edge-key action. onNpcTouch is the friendly "you got tagged" reaction.

import {
  GREET_DIST,
  SCORE_FIRST_GREET,
  CHARACTER_LABELS,
} from '../constants.js';
import {
  activePlayerIdAtom,
  scoreAtom,
  greetedAtom,
  wonAtom,
  gamePhaseAtom,
} from '../state/atoms.js';
import { requestEmote } from './animationSystem.js';
import { emit, pushToast } from '../hud/hudEvents.js';

// 5 Hz proximity scan throttle (ms between scans).
const SCAN_INTERVAL_MS = 200;
let lastScan = 0;

// What updateGreet found last; commitReactive mirrors this into nearbyGreetableAtom.
// Plain module var (per-frame truth) — NOT an atom — so the scan never thrashes React.
/** @type {{targetId:string,label:string}|null} */
let nearbyGreetable = null;

/** The current nearest-greetable, for commitReactive to gate against. */
export function getNearbyGreetable() {
  return nearbyGreetable;
}

/**
 * ~5 Hz scan: nearest NPC within GREET_DIST of the active player becomes the
 * greetable. Re-greeting is allowed (no hard block), but already-greeted members
 * lose the tie-break so a fresh face is preferred.
 * @param {any} ctx
 */
export function updateGreet(ctx) {
  const { now, registry, activePlayerId } = ctx;
  if (now - lastScan < SCAN_INTERVAL_MS) return;
  lastScan = now;

  const player = registry.get(activePlayerId);
  if (!player) {
    nearbyGreetable = null;
    return;
  }
  const ppos = player.motion.pos;

  let best = null;
  let bestScore = Infinity;
  registry.forEach((actor) => {
    if (actor.id === activePlayerId) return;
    if (actor.role !== 'npc') return;
    const dx = actor.motion.pos.x - ppos.x;
    const dz = actor.motion.pos.z - ppos.z;
    const d = Math.hypot(dx, dz);
    if (d > GREET_DIST) return;
    // Prefer un-greeted, then nearer: greeted members get a distance penalty so
    // an un-greeted neighbor at the same range always wins.
    const score = d + (actor.greeted ? 1000 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = actor;
    }
  });

  nearbyGreetable = best
    ? { targetId: best.id, label: CHARACTER_LABELS[best.id] || best.id }
    : null;
}

/**
 * Player pressed E — greet the nearest greetable, if any. Marks greeted, scores
 * the first greet, turns the target to face the player + plays a reaction emote,
 * fires HUD feedback, and runs the win check.
 * @param {any} ctx
 */
export function requestGreet(ctx) {
  const { store, registry, activePlayerId } = ctx;
  if (!nearbyGreetable) return;

  const target = registry.get(nearbyGreetable.targetId);
  const player = registry.get(activePlayerId);
  if (!target || !player) return;

  const firstGreet = !target.greeted;
  target.greeted = true;

  // Score only the first greet of each member.
  if (firstGreet) {
    const cur = store.get(scoreAtom);
    store.set(scoreAtom, cur + SCORE_FIRST_GREET);
  }

  // Turn the target to face the player and play a one-shot reaction. Cheer for
  // the first greet (bigger moment), a friendly wave on re-greets.
  target.ai.faceTarget = player.motion.pos.clone();
  requestEmote(target, firstGreet ? 'cheer' : 'wave', {
    faceTarget: player.motion.pos.clone(),
  });

  // HUD juice: hit-marker pulse + toast.
  emit('greetHit');
  const label = CHARACTER_LABELS[target.id] || target.id;
  pushToast('Greeted ' + label, 'go');

  // Win check — all four greeted ends the game.
  if (firstGreet) {
    let allGreeted = true;
    registry.forEach((a) => {
      if (!a.greeted) allGreeted = false;
    });
    if (allGreeted) {
      store.set(wonAtom, true);
      store.set(gamePhaseAtom, 'won');
    }
  }
}

/**
 * Friendly "tagged" reaction — an NPC reached the active player. No health
 * change (this is a greet game, not combat): just a small toast + brief cheer on
 * the NPC so contact reads as playful.
 * @param {any} actor  the NPC that made contact
 * @param {any} ctx
 */
export function onNpcTouch(actor, ctx) {
  const label = CHARACTER_LABELS[actor.id] || actor.id;
  pushToast(label + ' tagged you!', 'tag');
  // Brief celebratory cheer; faces the active player for the moment of contact.
  const player = ctx.registry.get(ctx.activePlayerId);
  requestEmote(actor, 'cheer', {
    faceTarget: player ? player.motion.pos.clone() : null,
  });
}
