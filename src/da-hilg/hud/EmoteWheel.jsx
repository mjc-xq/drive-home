// EmoteWheel — radial emote picker (wave / cheer / dance). This is the CLICK UI;
// the 1/2/3 keyboard shortcuts are handled in input/useEdgeKeys.js. Opened via
// emoteOpenAtom (Q key or the mobile EMOTE button). Selecting an emote calls
// animationSystem.requestEmote(activePlayer(), key) and closes the wheel.
//
// Pure DOM overlay: subscribes to emoteOpenAtom via hooks, writes nothing per
// frame, plays the emote on the active rig through the animation system.

import { useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import { emoteOpenAtom, settingsAtom } from '../state/atoms.js';
import { activePlayer } from '../state/refs.js';
import { requestEmote } from '../systems/animationSystem.js';
import { pushToast } from './hudEvents.js';
import { emoteWhoosh } from '../audio/sfx.js';

// The three wedges, in click/visual order. label = Chakra Petch caption, glyph =
// a quick emoji affordance, key = the clip key handed to requestEmote.
const EMOTES = [
  { key: 'wave', label: 'WAVE', glyph: '👋' },
  { key: 'cheer', label: 'CHEER', glyph: '🎉' },
  { key: 'dance', label: 'DANCE', glyph: '🕺' },
];

export default function EmoteWheel() {
  const [open, setOpen] = useAtom(emoteOpenAtom);
  const [settings] = useAtom(settingsAtom);
  const reduced = !!settings?.reducedMotion;
  // Ref to the panel so an outside-click can dismiss without stealing focus.
  const panelRef = useRef(null);

  // Fire the chosen emote on the active player, confirm, and close.
  function pick(key) {
    const actor = activePlayer();
    if (actor) {
      requestEmote(actor, key);
      emoteWhoosh();
      const label = EMOTES.find((e) => e.key === key)?.label || key;
      pushToast(`You ${label.toLowerCase()}d`, 'system');
    }
    setOpen(false);
  }

  // Escape closes; clicking the dimmed backdrop closes. (Number keys 1/2/3 are
  // owned by useEdgeKeys so we don't double-handle them here.)
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      className="dhEmoteScrim"
      style={scrimStyle}
      onPointerDown={(e) => {
        // only the backdrop itself dismisses (not bubbled wedge clicks)
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        ref={panelRef}
        className="dhEmoteWheel dhPanel"
        role="menu"
        aria-label="Emote picker"
        style={wheelStyle}
      >
        <div className="dhKick" style={hubKickStyle}>
          EMOTE
        </div>
        <div style={rowStyle}>
          {EMOTES.map((em, i) => (
            <button
              key={em.key}
              type="button"
              role="menuitem"
              className="dhEmoteWedge dhPanel"
              aria-label={em.label}
              onClick={() => pick(em.key)}
              style={{
                ...wedgeStyle,
                // gentle stagger-in unless reduced motion
                animation: reduced ? 'none' : `dhEmotePop .15s ease ${i * 0.03}s both`,
              }}
            >
              <span style={glyphStyle} aria-hidden="true">
                {em.glyph}
              </span>
              <span style={wedgeLabelStyle}>{em.label}</span>
              <span style={slotStyle} aria-hidden="true">
                {i + 1}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Component-scoped keyframes so we don't depend on hud.css being loaded. */}
      <style>{keyframes}</style>
    </div>
  );
}

// ── Inline styles (token values mirrored from hud.css §6) ────────────────────
const NAV = '#2D8CFF';
const COIN = '#FFC83D';
const GLASS = 'rgba(8,10,14,.66)';
const LINE = 'rgba(255,255,255,.18)';

const scrimStyle = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'flex-end',
  // sit above the bottom-right mobile cluster; safe-area aware
  padding:
    'calc(96px + env(safe-area-inset-bottom,0px)) calc(20px + env(safe-area-inset-right,0px)) calc(96px + env(safe-area-inset-bottom,0px)) 0',
  pointerEvents: 'auto',
};

const wheelStyle = {
  background: GLASS,
  border: `1px solid ${LINE}`,
  borderRadius: 0,
  padding: '12px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '8px',
};

const hubKickStyle = {
  fontFamily: "'Chakra Petch',system-ui,sans-serif",
  fontWeight: 600,
  fontSize: '8px',
  letterSpacing: '.16em',
  textTransform: 'uppercase',
  color: 'rgba(255,255,255,.5)',
};

const rowStyle = { display: 'flex', gap: '8px' };

const wedgeStyle = {
  position: 'relative',
  width: '76px',
  height: '76px',
  background: GLASS,
  border: `1px solid ${LINE}`,
  borderRadius: 0,
  color: '#fff',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '4px',
  cursor: 'pointer',
  transition: 'transform .1s ease, border-color .1s ease',
};

const glyphStyle = { fontSize: '24px', lineHeight: 1 };

const wedgeLabelStyle = {
  fontFamily: "'Chakra Petch',system-ui,sans-serif",
  fontWeight: 600,
  fontSize: '10px',
  letterSpacing: '.08em',
};

const slotStyle = {
  position: 'absolute',
  top: '4px',
  right: '5px',
  fontFamily: "'Chakra Petch',system-ui,sans-serif",
  fontSize: '9px',
  color: COIN,
  opacity: 0.8,
};

const keyframes = `
@keyframes dhEmotePop{from{opacity:0;transform:scale(.8) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}
.dhEmoteWedge:hover{border-color:${NAV} !important}
.dhEmoteWedge:active{transform:scale(.94)}
.dhEmoteWedge:focus-visible{outline:2px solid ${NAV};outline-offset:2px}
`;
