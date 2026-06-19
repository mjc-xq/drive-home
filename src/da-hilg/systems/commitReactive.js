// Commit-reactive — step 6 of the sim loop and the ONLY place per-frame truth
// crosses into React. It diffs coarse discrete facts against a module-cached
// snapshot and store.set()s ONLY on change, so a character standing in 'chase'
// for five seconds writes the store zero times. This is the firewall that keeps
// the render path off the simulation path.

import {
  activePlayerIdAtom,
  scoreAtom,
  greetedAtom,
  currentZoneAtom,
  playerStateAtom,
  npcStatesAtom,
  nearbyGreetableAtom,
  rolesAtom,
  gamePhaseAtom,
} from '../state/atoms.js';
import { getNearbyGreetable } from './greetSystem.js';
import * as zoneRegistry from '../zones/zoneRegistry.js';

// Last-committed snapshot. Nulls/sentinels force a write on the first frame.
const last = {
  activePlayerId: null,
  score: -1,
  greeted: null, // {id:bool}
  currentZone: undefined, // string|null (undefined = never committed)
  playerState: null, // word
  npcStates: null, // {id:word}
  nearbyKey: undefined, // serialized nearbyGreetable, undefined = never committed
  roles: null, // {id:role}
  gamePhase: null,
};

/** Shallow-equal two flat string/bool maps over the same keys. */
function mapEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

/** The word shown for an actor: an in-progress emote/action wins over locomotion. */
function actorWord(actor) {
  const m = actor.motion;
  return m.action || m.animState || 'idle';
}

/**
 * Derive the active player's display-zone label from its live zone set. Picks
 * the most relevant overlapping zone (safe > trigger > notice > others) and
 * returns its label, or null if it's in no labelled zone.
 */
function deriveCurrentZone(activePlayer) {
  if (!activePlayer || !activePlayer.zonesActive || activePlayer.zonesActive.size === 0) {
    return null;
  }
  const byId = zoneRegistry.byId;
  if (!byId) return null;
  const priority = { safe: 4, trigger: 3, notice: 2, danger: 1 };
  let bestLabel = null;
  let bestRank = -1;
  activePlayer.zonesActive.forEach((zoneId) => {
    const def = byId.get(zoneId);
    if (!def) return;
    const rank = priority[def.type] != null ? priority[def.type] : 0;
    if (rank > bestRank) {
      bestRank = rank;
      bestLabel = def.label != null ? def.label : null;
    }
  });
  return bestLabel;
}

/**
 * Change-gated commit of discrete facts into the store. Called once per frame at
 * the end of the sim loop.
 * @param {any} ctx
 */
export function commitReactive(ctx) {
  const { store, registry, activePlayerId } = ctx;

  // ── activePlayerId (switchSystem already writes it; mirror only if drifted) ─
  if (activePlayerId !== last.activePlayerId) {
    if (store.get(activePlayerIdAtom) !== activePlayerId) {
      store.set(activePlayerIdAtom, activePlayerId);
    }
    last.activePlayerId = activePlayerId;
  }

  // ── score (greetSystem writes on greet; gate against the store value) ───────
  const score = store.get(scoreAtom);
  if (score !== last.score) {
    last.score = score;
  }

  // ── gamePhase (greetSystem writes on win; mirror cache) ─────────────────────
  const phase = store.get(gamePhaseAtom);
  if (phase !== last.gamePhase) {
    last.gamePhase = phase;
  }

  // Build fresh per-actor views in one pass.
  const greeted = {};
  const roles = {};
  const npcStates = {};
  let activePlayer;
  registry.forEach((actor) => {
    greeted[actor.id] = !!actor.greeted;
    roles[actor.id] = actor.role;
    // NPC glyph = its fsm if an NPC, else its locomotion word for completeness.
    npcStates[actor.id] = actor.role === 'npc' ? actor.fsm : actorWord(actor);
    if (actor.id === activePlayerId) activePlayer = actor;
  });

  // ── greeted (shallow compare) ───────────────────────────────────────────────
  if (!mapEqual(greeted, last.greeted)) {
    store.set(greetedAtom, greeted);
    last.greeted = greeted;
  }

  // ── roles (shallow compare) ─────────────────────────────────────────────────
  if (!mapEqual(roles, last.roles)) {
    store.set(rolesAtom, roles);
    last.roles = roles;
  }

  // ── npcStates (shallow compare) ─────────────────────────────────────────────
  if (!mapEqual(npcStates, last.npcStates)) {
    store.set(npcStatesAtom, npcStates);
    last.npcStates = npcStates;
  }

  // ── playerState (active actor's anim/action word) ───────────────────────────
  const playerState = activePlayer ? actorWord(activePlayer) : 'idle';
  if (playerState !== last.playerState) {
    store.set(playerStateAtom, playerState);
    last.playerState = playerState;
  }

  // ── currentZone (active player's display zone label) ────────────────────────
  const currentZone = deriveCurrentZone(activePlayer);
  if (currentZone !== last.currentZone) {
    store.set(currentZoneAtom, currentZone);
    last.currentZone = currentZone;
  }

  // ── nearbyGreetable (from greetSystem scan) ─────────────────────────────────
  const nearby = getNearbyGreetable();
  const nearbyKey = nearby ? nearby.targetId + '|' + nearby.label : null;
  if (nearbyKey !== last.nearbyKey) {
    store.set(nearbyGreetableAtom, nearby ? { targetId: nearby.targetId, label: nearby.label } : null);
    last.nearbyKey = nearbyKey;
  }
}
