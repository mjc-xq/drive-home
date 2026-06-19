// Controller assignment — the single place that swaps which strategy drives an
// actor. Switching control (Tab / HUD) is nothing more than two attachController
// calls (prev→'npc', next→'player'); no movement code moves because every
// controller feeds the same stepMotion. Also seeds the actor's role + FSM so a
// freshly-handed-off NPC starts in 'cooldown' (won't instantly chase the new
// player) and a freshly-grabbed player is marked 'controlled'.

import { CONTROLLERS } from './Controller.js';

/**
 * Attach a controller of the given kind to an actor, syncing its role + fsm.
 * @param {any} actor  registry actor
 * @param {'player'|'npc'|'idle'} kind  which strategy to attach
 */
export function attachController(actor, kind) {
  actor.controller = CONTROLLERS[kind];
  actor.role = kind === 'player' ? 'player' : 'npc';
  actor.fsm = kind === 'player' ? 'controlled' : 'cooldown';
}
