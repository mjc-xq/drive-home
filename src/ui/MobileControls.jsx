// MobileControls — the on-screen touch HUD for the staged mobile-controls stack:
// a floating MOVE joystick (bottom-LEFT) plus an action-button cluster
// (bottom-RIGHT). Mobile-only and orientation-aware (portrait + landscape both
// read native), safe-area-aware on every edge.
//
// DESIGN INVARIANT — this component owns ONLY the joystick + the buttons. Every
// other pixel is the CAMERA dead-space that the InputManager's canvas pointer
// handler turns into drag-to-look / pinch-zoom. So the wrapper is
// pointer-events:none and ONLY the joystick base/knob and the buttons re-enable
// pointer-events (auto). The buttons also stopPropagation so a tap on them never
// leaks down to the camera/joystick handlers underneath.
//
// Plain JS + React (matches src/App.jsx): function component, hooks, JSDoc. No
// three import — purely presentational. It READS a render-state off the
// InputManager (`input.joystick`) and writes nothing back except via onJump.

import { useEffect, useRef, useState } from 'react';

/**
 * The render-state this component reads off `input.joystick`. The InputManager
 * owns this object and updates it from pointer events; we only read it to paint
 * the knob. Everything is optional/defensive so the HUD renders sanely before
 * the manager has wired up.
 *
 * @typedef {Object} JoystickRenderState
 * @property {boolean} [active]  True while a finger is dragging the stick — knob
 *   lights up and the base loses its idle dimming.
 * @property {number}  [knobX]   Knob offset from base centre, in px, -radius..radius.
 * @property {number}  [knobY]   Knob offset from base centre, in px, -radius..radius.
 *   Screen convention (down is +Y); we paint it straight through to CSS translate.
 */

/**
 * @typedef {Object} InputManagerLike
 * @property {JoystickRenderState} [joystick] Live joystick render-state (read each frame).
 */

/**
 * On-screen mobile controls: floating joystick + action buttons.
 *
 * @param {Object} props
 * @param {InputManagerLike} props.input  The shared InputManager; we read `input.joystick`.
 * @param {'portrait'|'landscape'} props.orientation  Current device orientation.
 * @param {() => void} [props.onJump]  Called when the jump action button is tapped.
 * @returns {JSX.Element}
 */
export default function MobileControls({ input, orientation, onJump, buttons = true }) {
  // The joystick base diameter scales with the viewport but caps at 70px so it
  // never dominates a small phone. Recomputed on resize/orientation change.
  const [baseSize, setBaseSize] = useState(() => joySize());
  useEffect(() => {
    const onResize = () => setBaseSize(joySize());
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  // The knob is repositioned every animation frame straight into the DOM node
  // (no React re-render per frame) by reading the manager's joystick state. This
  // mirrors App.jsx's "engine writes per-frame values into registered refs"
  // pattern — React owns chrome, the rAF loop owns motion.
  const knobRef = useRef(null);
  const baseRef = useRef(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const js = (input && input.joystick) || null;
      const knob = knobRef.current;
      const base = baseRef.current;
      const active = !!(js && js.active);
      // FLOATING stick: the base appears at the touch-down point (baseX/baseY) and hides when
      // released; the knob offsets from the base by knobX/knobY. (TouchJoystick recentres on touch.)
      if (base) {
        base.style.display = active ? 'block' : 'none';
        if (active) { base.style.left = (js.baseX || 0) + 'px'; base.style.top = (js.baseY || 0) + 'px'; }
      }
      if (knob) {
        const x = (js && js.knobX) || 0;
        const y = (js && js.knobY) || 0;
        knob.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [input]);

  const knobSize = Math.round(baseSize * 0.46);

  // Buttons must NOT leak their pointer down to the camera/joystick layers. We
  // swallow pointerdown (capture phase isn't needed — the wrapper below it is
  // pointer-events:none, so only these auto-enabled controls receive events).
  const swallow = (e) => { e.stopPropagation(); };
  const fireJump = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (onJump) onJump();
  };

  return (
    <div className={'mobileControls ' + orientation} aria-hidden={false}>
      <style>{MC_CSS}</style>

      {/* ── BOTTOM-LEFT: floating MOVE joystick (base + knob) ── */}
      <div
        ref={baseRef}
        className="mcJoyBase"
        data-active="false"
        role="presentation"
        style={{ width: baseSize, height: baseSize }}
        onPointerDown={swallow}
      >
        <div
          ref={knobRef}
          className="mcJoyKnob"
          style={{ width: knobSize, height: knobSize }}
        />
      </div>

      {/* ── BOTTOM-RIGHT: action-button cluster (optional — the host HUD may supply its own) ── */}
      {buttons && (
      <div className="mcButtons" onPointerDown={swallow}>
        <button
          type="button"
          className="mcBtn mcJump"
          aria-label="Jump"
          // Pointerdown fires the action (snappy on touch); click is a no-op
          // fallback for keyboards/AT. stopPropagation on every handler so the
          // tap never reaches the camera drag underneath.
          onPointerDown={fireJump}
          onClick={swallow}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5" />
            <path d="m6 11 6-6 6 6" />
          </svg>
        </button>
      </div>
      )}
    </div>
  );
}

/**
 * Joystick base diameter: 16% of the viewport's short side, capped at 70px so it
 * stays thumb-sized. Guards against SSR / no-window.
 * @returns {number}
 */
function joySize() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 375;
  return Math.round(Math.min(w * 0.16, 70));
}

// Scoped, self-contained styles. Kept inline so this module ships as one
// drop-in file (no edit to styles.css required). Accent matches the existing
// engine thumbstick blue (rgba(45,140,255,…)). Safe-area insets via env() with
// sensible px floors.
const MC_CSS = `
/* The wrapper covers the screen but is pointer-transparent: the CAMERA layer
   (canvas) underneath must receive every drag that isn't on a control. Only the
   joystick base and the buttons re-enable pointer-events. */
.mobileControls{
  position:fixed; inset:0; z-index:30;
  pointer-events:none;
  -webkit-user-select:none; user-select:none;
  touch-action:none;
}

/* ── floating MOVE joystick (bottom-LEFT) ── */
.mobileControls .mcJoyBase{
  position:fixed;            /* FLOATING: the rAF loop sets left/top to the touch point + centres it */
  transform:translate(-50%, -50%);
  display:none;             /* shown (block) only while a finger is down */
  border-radius:50%;
  pointer-events:none;      /* the InputManager already owns the canvas pointer; the base is purely visual */
  touch-action:none;
  background:radial-gradient(circle at 50% 50%, rgba(20,28,46,.30), rgba(10,14,22,.42));
  border:1.5px solid rgba(45,140,255,.55);
  box-shadow:inset 0 0 18px rgba(45,140,255,.12), 0 6px 18px rgba(0,0,0,.4);
  opacity:.62;
  transition:opacity .18s ease, border-color .18s ease;
  display:grid; place-items:center;
}
.mobileControls .mcJoyBase.mc-active{
  opacity:1;
  border-color:rgba(45,140,255,.9);
  box-shadow:inset 0 0 22px rgba(45,140,255,.22), 0 6px 22px rgba(0,0,0,.5);
}
.mobileControls .mcJoyKnob{
  position:absolute; left:50%; top:50%;
  border-radius:50%;
  transform:translate(-50%,-50%);
  background:radial-gradient(circle at 40% 32%, #3a6fd6, #1b3a82);
  border:1px solid rgba(255,255,255,.45);
  box-shadow:0 4px 14px rgba(0,0,0,.55), 0 0 16px rgba(45,140,255,.45);
  /* No transition on transform: the rAF loop drives it for 1:1 finger tracking. */
}
.mobileControls .mcJoyKnob.mc-active{
  box-shadow:0 4px 16px rgba(0,0,0,.6), 0 0 24px rgba(45,140,255,.7);
}

/* ── action-button cluster (bottom-RIGHT) ── */
.mobileControls .mcButtons{
  position:absolute;
  right:max(16px, env(safe-area-inset-right));
  bottom:max(24px, env(safe-area-inset-bottom));
  display:flex; flex-direction:column; align-items:flex-end; gap:12px;
  pointer-events:none; /* gaps stay transparent; each .mcBtn re-enables */
}
.mobileControls .mcBtn{
  pointer-events:auto;
  touch-action:none;
  -webkit-tap-highlight-color:transparent;
  display:grid; place-items:center;
  width:64px; height:64px;
  border-radius:50%;
  border:1.5px solid rgba(255,255,255,.28);
  background:radial-gradient(circle at 42% 34%, rgba(58,111,214,.92), rgba(27,58,130,.92));
  color:#fff;
  box-shadow:0 6px 18px rgba(0,0,0,.45), 0 0 18px rgba(45,140,255,.32);
  cursor:pointer;
  transition:transform .08s ease, box-shadow .12s ease, filter .12s ease;
}
.mobileControls .mcBtn:active{
  transform:scale(.92);
  filter:brightness(1.12);
  box-shadow:0 3px 10px rgba(0,0,0,.5), 0 0 22px rgba(45,140,255,.5);
}

/* ── landscape: nudge controls in slightly and make them a touch smaller so a
      thumb wrapping the long edge can reach without crowding the dash. ── */
.mobileControls.landscape .mcJoyBase{
  left:max(22px, env(safe-area-inset-left));
  bottom:max(18px, env(safe-area-inset-bottom));
}
.mobileControls.landscape .mcButtons{
  right:max(22px, env(safe-area-inset-right));
  bottom:max(18px, env(safe-area-inset-bottom));
  flex-direction:row; align-items:center;
}
.mobileControls.landscape .mcBtn{ width:58px; height:58px; }

@media (prefers-reduced-motion:reduce){
  .mobileControls .mcJoyBase,
  .mobileControls .mcBtn{ transition:none; }
}
`;
