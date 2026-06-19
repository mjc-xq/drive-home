// Desktop click-to-play. Shown when the game is playing but the pointer isn't
// locked (fresh load, or after Esc). Clicking requests pointer lock. Touch devices
// have no pointer lock, so this is gated to fine pointers only.
//
// Lock acquisition: usePointerLock owns the lifecycle and updates pointerLockedAtom
// on the real `pointerlockchange` event. We don't reach into its internals; we just
// request the lock on the canvas (the same element it listens on). This stays robust
// even if the input cluster also exposes a module-level lock() helper later.

import { useAtomValue } from 'jotai';
import { gamePhaseAtom, pausedAtom, pointerLockedAtom } from '../state/atoms.js';

// Coarse pointers (touch) never show this overlay.
const isFinePointer =
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(pointer: fine)').matches;

function requestLock() {
  const canvas = document.querySelector('canvas');
  // requestPointerLock can throw if called without a user gesture; we're inside a
  // click handler so it's gesture-backed, but guard anyway.
  try {
    const result = canvas?.requestPointerLock?.();
    result?.catch?.(() => {});
  } catch (err) {
    /* keep the click-to-play overlay visible */
  }
}

export default function LockOverlay() {
  const phase = useAtomValue(gamePhaseAtom);
  const paused = useAtomValue(pausedAtom);
  const locked = useAtomValue(pointerLockedAtom);

  if (!isFinePointer) return null;
  if (phase !== 'playing' || paused || locked) return null;

  return (
    <div
      className="dh-lock"
      onClick={requestLock}
      role="button"
      tabIndex={0}
      aria-label="Click to play"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') requestLock();
      }}
    >
      <div className="dh-lock-card">
        <div className="dh-lock-title">Da Hilg</div>
        <div className="dh-lock-sub">Click to play</div>
      </div>
    </div>
  );
}
