// TouchJoystick — a VISIBLE movement stick anchored in the lower-left. The base is
// always shown (faint) so the control is discoverable; touching anywhere in the left
// zone grabs it and the knob deflects from the base centre. The normalized vector is
// written to the shared mutable touch ref exported by input/useInput.js (NOT a Jotai
// atom) so it is read in useFrame without re-rendering React per touch-move.
//
// CRITICAL: we set touchActive.on while a touch is down — updateInput() only folds the
// joystick into refs.input when that flag is true, so without it movement is dead.

import { useEffect, useRef } from 'react';
import { touchMove, touchRun, touchActive } from '../../input/useInput.js';

const DEAD_ZONE = 0.14; // ignore tiny thumb tremor
const RUN_THRESHOLD = 0.9; // past this magnitude → push-to-run

export default function TouchJoystick() {
  const baseRef = useRef(null);
  const knobRef = useRef(null);
  const g = useRef({ active: false, pointerId: null, originX: 0, originY: 0, radius: 44 });

  useEffect(() => {
    const base = baseRef.current;
    if (!base) return undefined;
    const zone = base.parentElement;
    if (!zone) return undefined;

    function moveKnob(dx, dy) {
      if (knobRef.current) knobRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
    }

    function reset() {
      g.current.active = false;
      g.current.pointerId = null;
      base.style.opacity = '0.5';
      moveKnob(0, 0);
      touchMove.x = 0;
      touchMove.y = 0;
      touchRun.on = false;
      touchActive.on = false;
    }

    function apply(e) {
      const r = g.current.radius || 44;
      const dx = e.clientX - g.current.originX;
      const dy = e.clientY - g.current.originY;
      const dist = Math.hypot(dx, dy);
      const clamped = Math.min(dist, r);
      const ang = Math.atan2(dy, dx);
      const kx = Math.cos(ang) * clamped;
      const ky = Math.sin(ang) * clamped;
      moveKnob(kx, ky);

      // normalize to [-1..1]; screen-down (+y) is "backward", invert for forward intent.
      let nx = kx / r;
      let ny = -(ky / r);
      const mag = Math.hypot(nx, ny);
      if (mag < DEAD_ZONE) {
        nx = 0;
        ny = 0;
      }
      touchMove.x = nx;
      touchMove.y = ny;
      touchRun.on = mag > RUN_THRESHOLD;
    }

    function onDown(e) {
      if (g.current.active) return;
      g.current.active = true;
      g.current.pointerId = e.pointerId;
      zone.setPointerCapture?.(e.pointerId);
      const rect = base.getBoundingClientRect();
      g.current.originX = rect.left + rect.width / 2;
      g.current.originY = rect.top + rect.height / 2;
      g.current.radius = rect.width / 2 || 44;
      base.style.opacity = '1';
      touchActive.on = true;
      apply(e); // respond to the initial touch immediately
      e.preventDefault();
    }

    function onMove(e) {
      if (!g.current.active || e.pointerId !== g.current.pointerId) return;
      apply(e);
      e.preventDefault();
    }

    function onUp(e) {
      if (e.pointerId !== g.current.pointerId) return;
      reset();
      e.preventDefault();
    }

    zone.addEventListener('pointerdown', onDown, { passive: false });
    zone.addEventListener('pointermove', onMove, { passive: false });
    zone.addEventListener('pointerup', onUp, { passive: false });
    zone.addEventListener('pointercancel', onUp, { passive: false });
    reset(); // start at rest (faint, centred)

    return () => {
      zone.removeEventListener('pointerdown', onDown);
      zone.removeEventListener('pointermove', onMove);
      zone.removeEventListener('pointerup', onUp);
      zone.removeEventListener('pointercancel', onUp);
      reset();
    };
  }, []);

  return (
    <div className="dhJoyZone" style={zoneStyle}>
      <div ref={baseRef} className="dhJoyBase" style={baseStyle}>
        <div ref={knobRef} className="dhJoyKnob" style={knobStyle} />
      </div>
    </div>
  );
}

const NAV = '#2D8CFF';

// The capture zone is the lower-left of the screen; a touch anywhere in it grabs the
// stick (forgiving). The visible base is anchored within it (lower-left, above insets).
const zoneStyle = {
  position: 'absolute',
  left: 0,
  bottom: 0,
  width: '50vw',
  height: '60vh',
  pointerEvents: 'auto',
  touchAction: 'none',
  zIndex: 4,
};

// Always-visible fixed base so the control is discoverable (faint at rest, bright when
// grabbed). position:fixed → clientX/Y map straight to screen coords.
const baseStyle = {
  position: 'fixed',
  left: 'calc(env(safe-area-inset-left, 0px) + 20px)',
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 92px)',
  width: 'min(24vw, 104px)',
  height: 'min(24vw, 104px)',
  borderRadius: '50%',
  background: 'rgba(8,10,14,.4)',
  border: '2px solid rgba(255,255,255,.3)',
  boxShadow: '0 8px 24px rgba(0,0,0,.4)',
  opacity: 0.5,
  transition: 'opacity .12s ease',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none', // the zone captures; the base is purely visual
};

const knobStyle = {
  width: '44%',
  height: '44%',
  borderRadius: '50%',
  background: `radial-gradient(circle at 35% 30%, #5fa8ff, ${NAV})`,
  boxShadow: `0 0 14px rgba(45,140,255,.6)`,
  willChange: 'transform',
};
