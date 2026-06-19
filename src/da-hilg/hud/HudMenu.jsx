// HudMenu — top-right hamburger FAB → square-glass dropdown. Houses the camera
// FP/TP toggle, settings sliders/toggles, a "How to play" blurb, Restart, and a
// confirm-gated EXIT back to the site menu. Subscribes to atoms via hooks and
// writes them through the same atoms; pushes volume changes to the audio module
// eagerly so the sliders feel live.

import { useState, useRef, useEffect } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import {
  cameraModeAtom,
  settingsAtom,
  scoreAtom,
  wonAtom,
  greetedAtom,
  pausedAtom,
} from '../state/atoms.js';
import { showFacadesAtom, showWaterAtom, showGrassAtom, perfModeAtom } from '../state/settingsAtoms.js';
import { CHARACTERS } from '../constants.js';
import { pushToast } from './hudEvents.js';
import { gameModeAtom } from '../nibblers/state/nibblerAtoms.js';
import { initNibblers } from '../nibblers/init.js';

const charMap = (v) => Object.fromEntries(CHARACTERS.map((id) => [id, v]));

export default function HudMenu() {
  // The menu's open state IS pausedAtom — single source of truth. usePointerLock
  // sets paused=true when the pointer lock is lost (Esc/alt-tab), which opens the
  // menu with a free cursor; the hamburger + outside-click toggle it.
  const [open, setOpen] = useAtom(pausedAtom);
  const [cameraMode, setCameraMode] = useAtom(cameraModeAtom);
  const [settings, setSettings] = useAtom(settingsAtom);
  // Graphics layer toggles live in the menu alongside audio (single settings surface).
  const [showFacades, setShowFacades] = useAtom(showFacadesAtom);
  const [showWater, setShowWater] = useAtom(showWaterAtom);
  const [showGrass, setShowGrass] = useAtom(showGrassAtom);
  const [perfMode, setPerfMode] = useAtom(perfModeAtom);
  const mode = useAtomValue(gameModeAtom);
  const [, setScore] = useAtom(scoreAtom);
  const [, setWon] = useAtom(wonAtom);
  const [, setGreeted] = useAtom(greetedAtom);
  // EXIT is a two-tap confirm so you can't rage-quit by accident.
  const [confirmExit, setConfirmExit] = useState(false);
  const confirmTimer = useRef(null);
  const panelRef = useRef(null);

  // Close on outside click while open.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  useEffect(() => () => clearTimeout(confirmTimer.current), []);

  // Patch a single setting field.
  function patch(key, value) {
    setSettings({ ...settings, [key]: value });
  }

  // Restart the active mode. The proximity scan + Nibblers systems re-arm naturally
  // on subsequent frames.
  function restart() {
    if (mode === 'nibblers') {
      initNibblers();
      pushToast('Nibblers reset', 'system');
    } else {
      setGreeted(charMap(false));
      setScore(0);
      setWon(false);
      pushToast('Family scattered — greet them again!', 'system');
    }
    setOpen(false);
  }

  function exit() {
    if (!confirmExit) {
      setConfirmExit(true);
      clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmExit(false), 2000);
      return;
    }
    window.location.assign('/');
  }

  return (
    <div style={wrapStyle}>
      <button
        type="button"
        className="dhMenuFab dhPanel"
        aria-label="Menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={fabStyle}
      >
        <span style={barStyle} />
        <span style={barStyle} />
        <span style={barStyle} />
      </button>

      {open && (
        <div
          ref={panelRef}
          className="dhMenu dhPanel"
          role="menu"
          aria-label="Game menu"
          style={panelStyle}
        >
          {/* CAMERA */}
          <div className="dhKick" style={kickStyle}>
            CAMERA
          </div>
          <div style={segStyle}>
            {[
              ['first', 'First-Person'],
              ['third', 'Third-Person'],
            ].map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setCameraMode(mode)}
                aria-pressed={cameraMode === mode}
                style={{
                  ...segBtnStyle,
                  ...(cameraMode === mode ? segActiveStyle : null),
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* SETTINGS */}
          <div className="dhKick" style={kickStyle}>
            SETTINGS
          </div>
          <Toggle
            label="Reduced motion"
            checked={!!settings.reducedMotion}
            onChange={(v) => patch('reducedMotion', v)}
          />
          <Toggle
            label="Invert look Y"
            checked={!!settings.invertY}
            onChange={(v) => patch('invertY', v)}
          />
          <Slider
            label="Look sens"
            min={0.4}
            max={2}
            value={settings.lookSens ?? 1}
            onChange={(v) => patch('lookSens', v)}
          />

          {/* GRAPHICS — performance mode + the optional world layers. */}
          <div className="dhKick" style={kickStyle}>
            GRAPHICS
          </div>
          <Toggle
            label="Performance mode"
            checked={perfMode}
            onChange={setPerfMode}
          />
          <Toggle label="Photo facades" checked={showFacades} onChange={setShowFacades} />
          <Toggle label="Fancy water" checked={showWater} onChange={setShowWater} />
          <Toggle label="Grass" checked={showGrass} onChange={setShowGrass} />

          {/* HOW TO PLAY */}
          <div className="dhKick" style={kickStyle}>
            HOW TO PLAY
          </div>
          <div style={blurbStyle}>
            {mode === 'nibblers'
              ? 'Scout the block. Safe Zones scatter attached swarms; red danger zones call them in.'
              : 'Find the family, greet everyone, and reunite at home.'}
          </div>

          {/* ACTIONS */}
          <button type="button" onClick={restart} style={restartStyle}>
            Restart
          </button>
          <button
            type="button"
            onClick={exit}
            style={{ ...exitStyle, ...(confirmExit ? exitConfirmStyle : null) }}
          >
            {confirmExit ? 'Tap again to exit' : 'Exit to menu'}
          </button>

          <style>{menuKeyframes}</style>
        </div>
      )}
    </div>
  );
}

// ── Small controls ───────────────────────────────────────────────────────────

/** Volume / sensitivity slider with a Chakra-Petch label + tabular readout. */
function Slider({ label, value, onChange, min = 0, max = 1 }) {
  const pct = Math.round(((value - min) / (max - min)) * 100);
  return (
    <label style={sliderRowStyle}>
      <span style={sliderLabelStyle}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={sliderInputStyle}
        aria-label={label}
      />
      <span style={sliderValStyle}>{pct}</span>
    </label>
  );
}

/** Simple labelled checkbox toggle. */
function Toggle({ label, checked, onChange }) {
  return (
    <label style={toggleRowStyle}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: GO }}
      />
      <span style={sliderLabelStyle}>{label}</span>
    </label>
  );
}

// ── Inline styles (token mirror) ─────────────────────────────────────────────
const NAV = '#2D8CFF';
const GO = '#2BE84F';
const JUMP = '#9B7BFF';
const REVERSE = '#FF5247';
const GLASS = 'rgba(8,10,14,.66)';
const LINE = 'rgba(255,255,255,.18)';
const FONT = "'Chakra Petch',system-ui,sans-serif";

const wrapStyle = {
  position: 'absolute',
  top: 'calc(12px + env(safe-area-inset-top,0px))',
  right: 'calc(12px + env(safe-area-inset-right,0px))',
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: '8px',
  zIndex: 5,
};

const fabStyle = {
  width: '40px',
  height: '40px',
  background: GLASS,
  border: `1px solid ${LINE}`,
  borderRadius: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '4px',
  cursor: 'pointer',
};

const barStyle = { width: '18px', height: '2px', background: '#fff', display: 'block' };

const panelStyle = {
  width: '260px',
  maxHeight: 'min(70vh, 560px)',
  overflowY: 'auto',
  background: GLASS,
  border: `1px solid ${LINE}`,
  borderRadius: 0,
  boxShadow: '0 16px 40px rgba(0,0,0,.5)',
  backdropFilter: 'blur(18px) saturate(1.3)',
  WebkitBackdropFilter: 'blur(18px) saturate(1.3)',
  padding: '12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  color: '#fff',
  fontFamily: FONT,
  animation: 'menuDrop .16s ease',
};

const kickStyle = {
  fontFamily: FONT,
  fontWeight: 600,
  fontSize: '8px',
  letterSpacing: '.16em',
  textTransform: 'uppercase',
  color: 'rgba(255,255,255,.5)',
  marginTop: '4px',
};

const segStyle = { display: 'flex', gap: '4px' };

const segBtnStyle = {
  flex: 1,
  padding: '7px 6px',
  background: 'transparent',
  border: `1px solid ${LINE}`,
  borderRadius: 0,
  color: 'rgba(255,255,255,.8)',
  fontFamily: FONT,
  fontWeight: 600,
  fontSize: '11px',
  cursor: 'pointer',
};

const segActiveStyle = {
  background: 'rgba(155,123,255,.22)',
  borderColor: JUMP,
  color: '#fff',
};

const sliderRowStyle = { display: 'flex', alignItems: 'center', gap: '8px' };

const sliderLabelStyle = {
  fontFamily: FONT,
  fontSize: '12px',
  color: 'rgba(255,255,255,.85)',
  minWidth: '66px',
};

const sliderInputStyle = { flex: 1, accentColor: GO, height: '18px' };

const sliderValStyle = {
  fontFamily: "'AGC',system-ui,sans-serif",
  fontVariantNumeric: 'tabular-nums',
  fontSize: '11px',
  color: 'rgba(255,255,255,.7)',
  minWidth: '24px',
  textAlign: 'right',
};

const toggleRowStyle = { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' };

const blurbStyle = {
  fontFamily: FONT,
  fontSize: '11px',
  lineHeight: 1.5,
  color: 'rgba(255,255,255,.75)',
};

const restartStyle = {
  marginTop: '6px',
  padding: '9px',
  background: 'transparent',
  border: `1px solid ${NAV}`,
  borderRadius: 0,
  color: NAV,
  fontFamily: FONT,
  fontWeight: 600,
  fontSize: '12px',
  cursor: 'pointer',
};

const exitStyle = {
  padding: '9px',
  background: 'rgba(255,82,71,.14)',
  border: `1px solid ${REVERSE}`,
  borderRadius: 0,
  color: REVERSE,
  fontFamily: FONT,
  fontWeight: 700,
  fontSize: '12px',
  cursor: 'pointer',
};

const exitConfirmStyle = { background: REVERSE, color: '#fff' };

const menuKeyframes = `
@keyframes menuDrop{from{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
`;
