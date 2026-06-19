// Desktop pointer-lock lifecycle + mouse-look. We roll our own (NOT drei
// <PointerLockControls>, which applies its own euler and fights our manual
// yaw/pitch). This hook:
//   • click-to-lock on the R3F canvas,
//   • tracks lock state into pointerLockedAtom (via the shared store),
//   • on mousemove (while locked) accumulates movementX/Y into cameraRig.yaw/pitch
//     with LOOK_SENSITIVITY, clamped to ±PITCH_MAX, honoring INVERT_Y + settings,
//   • Esc auto-unlocks (browser) → we flip pausedAtom so the pause veil shows.
//
// Per-frame look is written straight to the plain cameraRig ref — no React state
// in the move path. Only the discrete locked/paused booleans touch atoms.

import { useEffect } from 'react';
import * as THREE from 'three';
import { daHilgStore } from '../state/store.js';
import { cameraRig } from '../state/refs.js';
import { pointerLockedAtom, pausedAtom, settingsAtom } from '../state/atoms.js';
import { LOOK_SENSITIVITY, PITCH_MAX, INVERT_Y } from '../constants.js';

/**
 * Owns the desktop pointer-lock lifecycle and mouse-look.
 * Mount once in DaHilgApp (inside the Provider). No-ops gracefully on touch-only.
 */
export function usePointerLock() {
  useEffect(() => {
    // The canvas is the only <canvas> the app renders; grab it lazily so we
    // don't depend on a ref crossing the DOM/Canvas boundary.
    const getCanvas = () => /** @type {HTMLCanvasElement|null} */ (
      document.querySelector('canvas')
    );

    const requestLock = () => {
      const canvas = getCanvas();
      // Don't grab the pointer while the game is paused (menu open).
      if (canvas && !daHilgStore.get(pausedAtom)) canvas.requestPointerLock?.();
    };

    const onLockChange = () => {
      const canvas = getCanvas();
      const locked = !!canvas && document.pointerLockElement === canvas;
      daHilgStore.set(pointerLockedAtom, locked);
      // Esc (or any programmatic unlock) → surface the pause menu.
      if (!locked && !daHilgStore.get(pausedAtom)) {
        daHilgStore.set(pausedAtom, true);
      }
    };

    const onMouseMove = (e) => {
      const canvas = getCanvas();
      if (!canvas || document.pointerLockElement !== canvas) return;
      const settings = daHilgStore.get(settingsAtom);
      const sens = LOOK_SENSITIVITY * (settings?.lookSens ?? 1);
      const invert = (settings?.invertY ?? INVERT_Y) ? -1 : 1;
      cameraRig.yaw -= e.movementX * sens;
      cameraRig.pitch -= e.movementY * sens * invert;
      cameraRig.pitch = THREE.MathUtils.clamp(cameraRig.pitch, -PITCH_MAX, PITCH_MAX);
    };

    // Click the canvas to (re)acquire the lock — the LockOverlay sits on top and
    // also forwards clicks here via the same canvas element.
    window.addEventListener('mousedown', requestLock);
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('mousemove', onMouseMove);
    return () => {
      window.removeEventListener('mousedown', requestLock);
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('mousemove', onMouseMove);
    };
  }, []);
}

export default usePointerLock;
