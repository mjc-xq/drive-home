// The actor registry: the four family members as plain data + ref bags. Built
// ONCE at load from level metadata, stored in refs.registry (never an atom).
// An Actor is data; a Controller is the swappable strategy attached via
// controllers/assign.js. Per-frame truth lives in actor.motion / actor.ref and
// is mutated in place by the systems — nothing here is React state.

import * as THREE from 'three';
import { CHARACTERS } from '../constants.js';
import { registry, cameraRig } from '../state/refs.js';
import { daHilgStore } from '../state/store.js';
import { rolesAtom } from '../state/atoms.js';
import { attachController } from '../controllers/assign.js';

/**
 * @typedef {Object} Actor
 * @property {string} id            'mike'|'kelli'|'cece'|'drew' (also the registry key + RigidBody name)
 * @property {string} character     which GLB mesh to render (same set as id)
 * @property {'player'|'npc'} role
 * @property {boolean} greeted
 * @property {number} health
 * @property {'idle'|'wander'|'chase'|'touch'|'retreat'|'cooldown'|'controlled'} fsm
 * @property {Object} ref           plain mutable Rapier/three handles (filled on mount)
 * @property {Object} motion        the per-frame motion truth
 * @property {Object} ai            NPC scratch (ignored while player-controlled)
 * @property {Set<string>} zonesActive zone ids this actor currently overlaps
 * @property {Object|null} controller strategy object from CONTROLLERS
 */

/**
 * Create a fresh Actor in its default (idle NPC) state. Controllers are attached
 * separately via buildRegistry → assign.attachController.
 * @param {string} id one of CHARACTERS
 * @returns {Actor}
 */
export function createActor(id) {
  return {
    id,
    character: id,
    role: 'npc',
    greeted: false,
    health: 100,
    fsm: 'idle',
    ref: {
      rigid: null,
      collider: null,
      kcc: null,
      group: null,
      mixer: null,
      actions: {}, // clipKey -> AnimationAction
      current: null, // current animState driving the mixer
    },
    motion: {
      pos: new THREE.Vector3(),
      velX: 0,
      velY: 0,
      velZ: 0,
      facing: 0,
      speed: 0,
      grounded: true,
      lastGroundedT: 0,
      animState: 'idle',
      action: null, // active emote clip key, or null
      actionUntil: 0, // perf-time the held/one-shot emote ends (0 = not timed)
      jumpBufferedT: -1,
    },
    ai: {
      target: null,
      timer: 0,
      retreatUntil: 0,
      cooldownUntil: 0,
      scanAt: 0,
      home: new THREE.Vector3(),
      wanderTo: null,
      dwellUntil: 0,
      faceTarget: null,
      stuckT: 0,
      group: 'family',
    },
    zonesActive: new Set(),
    controller: null,
  };
}

// Fallback spread used when the level meta has no NPC spawn points yet — keeps
// the family from stacking on the player's spawn during early bring-up.
const FALLBACK_SPREAD = [
  [2.5, 0, 0],
  [-2.5, 0, 0],
  [0, 0, 2.5],
  [0, 0, -2.5],
];

// Module guard: the registry is built exactly once per session.
let built = false;

/**
 * Place an actor's feet at a spawn point and seed its AI home/facing.
 * @param {Actor} actor
 * @param {number[]} spawn [x, y, z] recentered world position
 */
function placeActor(actor, spawn) {
  actor.motion.pos.set(spawn[0], spawn[1], spawn[2]);
  actor.ai.home.copy(actor.motion.pos);
}

/**
 * Build the four-actor registry once: create mike/kelli/cece/drew, place them
 * from level spawns (player first, NPCs from npcSpawns / fallback spread),
 * attach controllers (first = player, rest = npc), point the camera at the
 * player, and write the initial roles atom. Idempotent.
 * @param {import('../state/refs.js').levelMeta} levelMeta
 */
export function buildRegistry(levelMeta) {
  if (built) return;
  built = true;

  const spawns = levelMeta?.spawns ?? [[0, 0.1, 0]];
  const npcSpawns = levelMeta?.npcSpawns ?? [];

  CHARACTERS.forEach((id, i) => {
    const actor = createActor(id);

    if (i === 0) {
      // The player takes the first/primary spawn.
      placeActor(actor, spawns[0] ?? [0, 0.1, 0]);
    } else {
      // NPCs take npcSpawns in order; fall back to a fixed spread around spawn0.
      const npcIndex = i - 1;
      const spawn =
        npcSpawns[npcIndex] ??
        (() => {
          const base = spawns[0] ?? [0, 0.1, 0];
          const off = FALLBACK_SPREAD[npcIndex % FALLBACK_SPREAD.length];
          return [base[0] + off[0], base[1] + off[1], base[2] + off[2]];
        })();
      placeActor(actor, spawn);
    }

    registry.set(id, actor);
  });

  // First character is the player; the rest are NPCs. attachController also sets
  // role + fsm per the contract.
  CHARACTERS.forEach((id, i) => {
    attachController(registry.get(id), i === 0 ? 'player' : 'npc');
  });

  // Camera targets the player from the very first frame.
  cameraRig.targetId = CHARACTERS[0];

  // Mirror the initial roles to the HUD (discrete write, once).
  const roles = {};
  registry.forEach((a) => {
    roles[a.id] = a.role;
  });
  daHilgStore.set(rolesAtom, roles);
}

/**
 * @param {string} id
 * @returns {Actor|undefined}
 */
export function getActor(id) {
  return registry.get(id);
}

/**
 * Iterate every actor in the registry.
 * @param {(actor: Actor) => void} fn
 */
export function forEachActor(fn) {
  registry.forEach(fn);
}
