import { resetSwarm } from './swarm/swarmState.js';
import { resetThrottle } from './render/throttle.js';
import { resetOverwhelm } from './systems/overwhelmSystem.js';
import { isNibblersMode, nibblerPenalty } from './mode.js';
import { daHilgStore } from '../state/store.js';
import { cameraModeAtom } from '../state/atoms.js';
import { cameraRig } from '../state/refs.js';
import { discoveredSafeZonesAtom, revealedDangerZonesAtom } from './state/nibblerAtoms.js';

/**
 * Reset the swarm to a clean empty state and boot the camera in third-person so the
 * player sees their character and the swarm climbing on the body (press V — or the
 * pause-menu Camera switch — for first-person).
 */
export function initNibblers() {
  resetSwarm();
  resetThrottle();
  resetOverwhelm();
  // Penalties start clean (a fresh run, or a mode re-enter).
  nibblerPenalty.speedMul = 1;
  nibblerPenalty.jumpMul = 1;
  nibblerPenalty.visibility = 1;
  // Keep one safe zone and one danger zone visible from the start so the player
  // understands both halves of the mode before the first swarm ramps up.
  const discovered = daHilgStore.get(discoveredSafeZonesAtom);
  if (!discovered.includes('safe_home')) {
    daHilgStore.set(discoveredSafeZonesAtom, ['safe_home', ...discovered]);
  }
  const revealedDanger = daHilgStore.get(revealedDangerZonesAtom);
  if (!revealedDanger.includes('danger_drive')) {
    daHilgStore.set(revealedDangerZonesAtom, ['danger_drive', ...revealedDanger]);
  }
  if (isNibblersMode()) {
    daHilgStore.set(cameraModeAtom, 'third');
    cameraRig.mode = 'third';
  }
}
