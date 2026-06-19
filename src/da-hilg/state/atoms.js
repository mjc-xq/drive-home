// Reactive Jotai atoms — DISCRETE UI state only. Written by game systems at
// event boundaries (change-gated in systems/commitReactive.js), never per frame.
// The DOM HUD subscribes via useAtomValue; the Canvas writes via the shared store.
// Per-frame physics/camera truth lives in state/refs.js (plain mutable), not here.

import { atom } from 'jotai';
import { CHARACTERS, HEALTH_MAX } from '../constants.js';

const charMap = (v) => Object.fromEntries(CHARACTERS.map((id) => [id, v]));

// Lifecycle / phase. (Maps the spec's "gameMode".)
export const gamePhaseAtom = atom('loading'); // 'loading' | 'playing' | 'won'
export const loadProgressAtom = atom(0);      // 0..100 (bridged from DefaultLoadingManager)

// Who the player controls. (Maps the spec's "selectedCharacter" / activePlayerId.)
export const activePlayerIdAtom = atom(CHARACTERS[0]);
export const rolesAtom = atom(charMap('npc'));        // id -> 'player' | 'npc'
export const npcStatesAtom = atom(charMap('idle'));   // id -> fsm/anim glyph

// Camera + input UX.
export const cameraModeAtom = atom('first');  // 'first' | 'third'
export const pausedAtom = atom(false);
export const pointerLockedAtom = atom(false);

// Objective / scoring.
export const scoreAtom = atom(0);
export const greetedAtom = atom(charMap(false)); // id -> greeted?
export const wonAtom = atom(false);

// Per-actor state shown in HUD.
export const healthAtom = atom(charMap(HEALTH_MAX)); // reserved (inert in framework)
export const playerStateAtom = atom('idle');         // active player's anim/action word
export const currentZoneAtom = atom(null);           // active player's display zone label

// Interaction.
export const nearbyGreetableAtom = atom(null); // { targetId, label } | null
export const canGreetAtom = atom((get) => get(nearbyGreetableAtom) != null);
export const emoteOpenAtom = atom(false);

// Reserved for Nibblers (inert in the framework).
export const markedAtom = atom(false);

// Settings.
export const settingsAtom = atom({
  master: 0.8,
  sfx: 0.9,
  music: 0.5,
  reducedMotion: false,
  showHints: true,
  invertY: false,
  lookSens: 1.0,
});
