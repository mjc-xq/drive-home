// Mode gate + the movement-penalty bridge.
//
// isNibblersMode() reads gameModeAtom imperatively (no React) so the single
// GameSystems useFrame can branch cheaply. nibblerPenalty is a PLAIN MUTABLE ref
// the swarm's penaltySystem writes and the framework's stepMotion reads (lines
// where speed + jump are set). It defaults to all-ones so greet mode is an exact
// no-op — the framework imports it unconditionally.

import { daHilgStore } from '../state/store.js';
import { gameModeAtom } from './state/nibblerAtoms.js';

/** True when the Nibblers loop should run (default mode). */
export function isNibblersMode() {
  return daHilgStore.get(gameModeAtom) === 'nibblers';
}

/**
 * Movement penalties from the attached swarm, written by penaltySystem each frame
 * and read by stepMotion. {1,1,1} = no effect (greet mode / no attachments).
 */
export const nibblerPenalty = {
  speedMul: 1,
  jumpMul: 1,
  visibility: 1,
  // Overwhelm arc — the swarm burying the player. Tier 0 normal · 1 stagger · 2 downed
  // (crawl-only) · 3 pinned (can't move). moveCap is an absolute m/s ceiling stepMotion
  // applies on top of speedMul; canJump gates jumping. Written by updateOverwhelm.
  overwhelm: 0,
  moveCap: Infinity,
  canJump: true,
};
