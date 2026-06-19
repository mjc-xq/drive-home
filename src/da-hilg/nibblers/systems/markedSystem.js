// The marked state machine — module-level (NOT per-nibbler). The zone system calls
// armMarked() when the active player enters a danger zone and clearAndScatter() when
// they reach safety. Both only touch swarm scalars + the SoA; the reactive mirror
// (markedAtom, etc.) is written separately, change-gated, in commitNibblers.

import {
  S_SPAWN,
  S_WANDER,
  S_NOTICE,
  S_RUN,
  S_JUMP,
  S_ATTACHED,
  S_FALL,
  S_SCATTER,
  SCATTER_SPEED,
  SCATTER_TIME,
  PANIC_FLEE,
  PANIC_POP,
} from '../constants.js';
import {
  px,
  py,
  pz,
  vx,
  vy,
  vz,
  scale,
  stateT,
  state,
  swarm,
} from '../swarm/swarmState.js';

/**
 * Arm the marked state. First arm starts the clock (markedT=0); re-arming while
 * already marked does NOT reset markedT (so re-entering a danger zone can't farm a
 * fresh escape window — marked persists until a safe zone clears it).
 * @param {number} _now perf-time ms (unused; markedT is dt-accumulated in spawnPolicy)
 */
export function armMarked(_now) {
  if (swarm.marked) return; // already marked — keep the running clock
  swarm.marked = true;
  swarm.markedT = 0;
}

/**
 * Reach safety: clear marked, stop spawns (panic window), and scatter the whole
 * horde. ATTACHED nibblers pop off into a FALL with an outward+up impulse; every
 * other live, non-dead nibbler flees outward as a SCATTER. attachedCount → 0; panic
 * suppresses spawning until SCATTER_TIME has passed.
 * @param {number} now perf-time ms
 */
export function clearAndScatter(now) {
  swarm.marked = false;
  swarm.markedT = 0;
  swarm.targetActive = 0;
  swarm.panic = true;
  swarm.panicUntil = now + SCATTER_TIME * 1000;

  const player = clearAndScatter._player; // set by caller via setScatterCenter
  const cx = player ? player.x : 0;
  const cz = player ? player.z : 0;

  for (let i = 0; i < scale.length; i++) {
    const st = state[i];
    if (scale[i] <= 0) continue; // dead slot

    // Outward unit direction from the scatter center (the player).
    let ox = px[i] - cx;
    let oz = pz[i] - cz;
    const d = Math.sqrt(ox * ox + oz * oz) + 1e-5;
    ox /= d;
    oz /= d;

    if (st === S_ATTACHED) {
      state[i] = S_FALL;
      stateT[i] = 0;
      vx[i] = ox * PANIC_FLEE;
      vz[i] = oz * PANIC_FLEE;
      vy[i] = PANIC_POP;
      // Nudge above the ground so the FALL arc reads (it was pinned on the capsule).
      py[i] += 0.2;
    } else if (
      st === S_SPAWN ||
      st === S_WANDER ||
      st === S_NOTICE ||
      st === S_RUN ||
      st === S_JUMP
    ) {
      state[i] = S_SCATTER;
      stateT[i] = 0;
      vx[i] = ox * SCATTER_SPEED;
      vz[i] = oz * SCATTER_SPEED;
      vy[i] = 0;
    }
    // S_FALL / S_SCATTER already fleeing — leave them be.
  }
  swarm.attachedCount = 0;
}

/**
 * Set the scatter center (player feet pos) read by the next clearAndScatter. Called
 * by the zone system right before clearAndScatter so the burst radiates from the
 * player. Kept as a tiny side-channel to avoid changing the CONTRACTS signature.
 * @param {{x:number,y:number,z:number}|null} pos
 */
export function setScatterCenter(pos) {
  clearAndScatter._player = pos;
}
