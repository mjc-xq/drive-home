// TouchJoystick — floating left-screen movement stick. The base appears wherever
// the thumb lands inside the left zone (forgiving dynamic origin); the knob
// follows, clamped to the base radius. The normalized vector is written to the
// shared mutable touch ref exported by input/useInput.js (NOT a Jotai atom) so it
// is read in useFrame without ever re-rendering React per touch-move. The knob is
// positioned via direct DOM writes inside the pointer handlers — no React state in
// the hot path.

import { useEffect, useRef } from 'react';
import { touchMove, touchRun } from '../../input/useInput.js';

const DEAD_ZONE = 0.12; // ignore tiny thumb tremor
const RUN_THRESHOLD = 0.85; // past this magnitude → push-to-run

export default function TouchJoystick() {
  const baseRef = useRef(null);
  const knobRef = useRef(null);
  // Per-gesture state kept in a ref so handlers don't trigger renders.
  const g = useRef({
    active: false,
    pointerId: null,
    originX: 0,
    originY: 0,
    radius: 35, // half of base size; recomputed on touchstart
  });

  useEffect(() => {
    const base = baseRef.current;
    if (!base) return undefined;

    // The interactive capture surface is the whole left half; we attach to a
    // dedicated zone element rendered below.
    const zone = base.parentElement;
    if (!zone) return undefined;

    function show(x, y) {
      g.current.radius = base.offsetWidth ? base.offsetWidth / 2 : 35;
      g.current.originX = x;
      g.current.originY = y;
      base.style.left = `${x - g.current.radius}px`;
      base.style.top = `${y - g.current.radius}px`;
      base.style.opacity = '1';
      moveKnob(0, 0);
    }

    function moveKnob(dx, dy) {
      if (knobRef.current) {
        knobRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
      }
    }

    function clearOut() {
      g.current.active = false;
      g.current.pointerId = null;
      if (base) base.style.opacity = '0';
      moveKnob(0, 0);
      touchMove.x = 0;
      touchMove.y = 0;
      touchRun.on = false;
    }

    function onDown(e) {
      // only react to the primary touch in the left zone
      if (g.current.active) return;
      g.current.active = true;
      g.current.pointerId = e.pointerId;
      zone.setPointerCapture?.(e.pointerId);
      show(e.clientX, e.clientY);
      e.preventDefault();
    }

    function onMove(e) {
      if (!g.current.active || e.pointerId !== g.current.pointerId) return;
      const radius = g.current.radius || 35;
      let dx = e.clientX - g.current.originX;
      let dy = e.clientY - g.current.originY;
      const dist = Math.hypot(dx, dy);
      const clamped = Math.min(dist, radius);
      const ang = Math.atan2(dy, dx);
      const kx = Math.cos(ang) * clamped;
      const ky = Math.sin(ang) * clamped;
      moveKnob(kx, ky);

      // normalize to [-1..1]; screen-down (+y) is "backward", so invert for
      // forward intent (moveY: forward +).
      let nx = kx / radius;
      let ny = -(ky / radius);
      const mag = Math.hypot(nx, ny);
      if (mag < DEAD_ZONE) {
        nx = 0;
        ny = 0;
      }
      touchMove.x = nx;
      touchMove.y = ny;
      touchRun.on = mag > RUN_THRESHOLD;
      e.preventDefault();
    }

    function onUp(e) {
      if (e.pointerId !== g.current.pointerId) return;
      clearOut();
      e.preventDefault();
    }

    zone.addEventListener('pointerdown', onDown, { passive: false });
    zone.addEventListener('pointermove', onMove, { passive: false });
    zone.addEventListener('pointerup', onUp, { passive: false });
    zone.addEventListener('pointercancel', onUp, { passive: false });

    return () => {
      zone.removeEventListener('pointerdown', onDown);
      zone.removeEventListener('pointermove', onMove);
      zone.removeEventListener('pointerup', onUp);
      zone.removeEventListener('pointercancel', onUp);
      clearOut();
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

// The capture zone is the lower-left quarter of the screen; the base floats to
// the touch point inside it.
const zoneStyle = {
  position: 'absolute',
  left: 0,
  bottom: 0,
  width: '50vw',
  height: '55vh',
  pointerEvents: 'auto',
  touchAction: 'none',
  zIndex: 4,
};

const baseStyle = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: 'min(16vw, 70px)',
  height: 'min(16vw, 70px)',
  borderRadius: '50%',
  background: 'rgba(8,10,14,.45)',
  border: '1px solid rgba(255,255,255,.18)',
  boxShadow: '0 8px 24px rgba(0,0,0,.4)',
  opacity: 0,
  transition: 'opacity .12s ease',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none', // the zone captures; the base is purely visual
};

const knobStyle = {
  width: '46%',
  height: '46%',
  borderRadius: '50%',
  background: `radial-gradient(circle at 35% 30%, #5fa8ff, ${NAV})`,
  boxShadow: `0 0 14px rgba(45,140,255,.6)`,
  willChange: 'transform',
};
