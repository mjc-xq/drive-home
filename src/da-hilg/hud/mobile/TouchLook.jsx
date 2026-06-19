// TouchLook — invisible right-screen drag surface for camera look on touch. A one
// finger drag maps to cameraRig.yaw/pitch using TOUCH_LOOK_SENSITIVITY, with the
// same pitch clamp the mouse path uses. It sits to the RIGHT of the joystick zone
// and BELOW the button cluster anchor so it never steals movement/button touches.
// Writes straight to the shared cameraRig ref (no React per frame), and respects
// settings.invertY / settings.lookSens read imperatively from the store.

import { useEffect, useRef } from 'react';
import { cameraRig } from '../../state/refs.js';
import { TOUCH_LOOK_SENSITIVITY, PITCH_MAX } from '../../constants.js';
import { daHilgStore } from '../../state/store.js';
import { settingsAtom } from '../../state/atoms.js';

export default function TouchLook() {
  const surfRef = useRef(null);
  // Per-gesture tracking; kept in a ref so look-drag never re-renders React.
  const g = useRef({ active: false, pointerId: null, lastX: 0, lastY: 0 });

  useEffect(() => {
    const surf = surfRef.current;
    if (!surf) return undefined;

    function readSettings() {
      try {
        const s = daHilgStore.get(settingsAtom);
        return {
          invertY: !!s?.invertY,
          lookSens: typeof s?.lookSens === 'number' ? s.lookSens : 1,
        };
      } catch {
        return { invertY: false, lookSens: 1 };
      }
    }

    function onDown(e) {
      if (g.current.active) return;
      g.current.active = true;
      g.current.pointerId = e.pointerId;
      g.current.lastX = e.clientX;
      g.current.lastY = e.clientY;
      surf.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    }

    function onMove(e) {
      if (!g.current.active || e.pointerId !== g.current.pointerId) return;
      const dx = e.clientX - g.current.lastX;
      const dy = e.clientY - g.current.lastY;
      g.current.lastX = e.clientX;
      g.current.lastY = e.clientY;
      const { invertY, lookSens } = readSettings();
      const sens = TOUCH_LOOK_SENSITIVITY * lookSens;
      cameraRig.yaw -= dx * sens;
      const pitchDelta = dy * sens * (invertY ? -1 : 1);
      cameraRig.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, cameraRig.pitch - pitchDelta));
      e.preventDefault();
    }

    function onUp(e) {
      if (e.pointerId !== g.current.pointerId) return;
      g.current.active = false;
      g.current.pointerId = null;
      e.preventDefault();
    }

    surf.addEventListener('pointerdown', onDown, { passive: false });
    surf.addEventListener('pointermove', onMove, { passive: false });
    surf.addEventListener('pointerup', onUp, { passive: false });
    surf.addEventListener('pointercancel', onUp, { passive: false });

    return () => {
      surf.removeEventListener('pointerdown', onDown);
      surf.removeEventListener('pointermove', onMove);
      surf.removeEventListener('pointerup', onUp);
      surf.removeEventListener('pointercancel', onUp);
    };
  }, []);

  return <div ref={surfRef} className="dhLookSurface" style={surfaceStyle} />;
}

// Right ~50% of the screen, top portion only — leaves the bottom-right corner
// free for the button cluster and the left half free for the joystick.
const surfaceStyle = {
  position: 'absolute',
  right: 0,
  top: 0,
  width: '50vw',
  height: '75vh',
  pointerEvents: 'auto',
  touchAction: 'none',
  background: 'transparent',
  zIndex: 2,
};
