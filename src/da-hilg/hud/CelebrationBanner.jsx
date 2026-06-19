// CelebrationBanner — the win payoff. On wonAtom flipping true it shows a gold
// "FAMILY REUNITED" AGC banner with lightweight CSS confetti (static glow under
// reduced motion) and a "Play again" button that resets the objective and keeps
// you exploring. ARIA live=assertive so the win is announced.

import { useMemo } from 'react';
import { useAtom } from 'jotai';
import { wonAtom, settingsAtom, scoreAtom, greetedAtom } from '../state/atoms.js';
import { CHARACTERS } from '../constants.js';

const charMap = (v) => Object.fromEntries(CHARACTERS.map((id) => [id, v]));
const COIN = '#FFC83D';
const GO = '#2BE84F';
const CONFETTI_COLORS = [COIN, GO, '#2D8CFF', '#9B7BFF'];

export default function CelebrationBanner() {
  const [won, setWon] = useAtom(wonAtom);
  const [settings] = useAtom(settingsAtom);
  const [, setScore] = useAtom(scoreAtom);
  const [, setGreeted] = useAtom(greetedAtom);
  const reduced = !!settings?.reducedMotion;

  // Pre-compute confetti particle styles once (stable across renders).
  const confetti = useMemo(
    () =>
      Array.from({ length: 28 }, (_, i) => ({
        left: `${(i * 37) % 100}%`,
        delay: `${(i % 10) * 0.12}s`,
        duration: `${2.2 + (i % 5) * 0.3}s`,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        size: 6 + (i % 3) * 3,
      })),
    [],
  );

  if (!won) return null;

  function playAgain() {
    setGreeted(charMap(false));
    setScore(0);
    setWon(false);
  }

  return (
    <div className="dhCelebrate" style={wrapStyle} aria-live="assertive" role="alert">
      {/* Confetti layer (purely decorative). Static glow when reduced motion. */}
      {!reduced && (
        <div style={confettiLayerStyle} aria-hidden="true">
          {confetti.map((c, i) => (
            <span
              key={i}
              style={{
                position: 'absolute',
                top: '-12px',
                left: c.left,
                width: `${c.size}px`,
                height: `${c.size}px`,
                background: c.color,
                opacity: 0.9,
                animation: `dhConfettiFall ${c.duration} linear ${c.delay} infinite`,
              }}
            />
          ))}
        </div>
      )}

      <div style={cardStyle}>
        <div style={titleStyle}>FAMILY REUNITED</div>
        <div style={subStyle}>You greeted everyone. Da Hilg is whole again.</div>
        <button type="button" onClick={playAgain} style={btnStyle}>
          Play again
        </button>
      </div>

      <style>{keyframes}</style>
    </div>
  );
}

const wrapStyle = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
  zIndex: 6,
};

const confettiLayerStyle = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  pointerEvents: 'none',
};

const cardStyle = {
  position: 'relative',
  pointerEvents: 'auto',
  background: 'rgba(8,10,14,.72)',
  border: `1px solid rgba(255,200,61,.5)`,
  borderRadius: 0,
  boxShadow: '0 16px 60px rgba(0,0,0,.6), 0 0 40px rgba(255,200,61,.25)',
  backdropFilter: 'blur(18px) saturate(1.3)',
  WebkitBackdropFilter: 'blur(18px) saturate(1.3)',
  padding: '28px 40px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '12px',
  textAlign: 'center',
};

const titleStyle = {
  fontFamily: "'AGC',system-ui,sans-serif",
  fontWeight: 900,
  fontSize: 'clamp(28px, 6vw, 56px)',
  letterSpacing: '.08em',
  color: COIN,
  textShadow: '0 0 24px rgba(255,200,61,.5)',
};

const subStyle = {
  fontFamily: "'Chakra Petch',system-ui,sans-serif",
  fontSize: '14px',
  color: 'rgba(255,255,255,.8)',
};

const btnStyle = {
  marginTop: '8px',
  padding: '10px 22px',
  background: 'rgba(43,232,79,.16)',
  border: `1px solid ${GO}`,
  borderRadius: 0,
  color: GO,
  fontFamily: "'Chakra Petch',system-ui,sans-serif",
  fontWeight: 700,
  fontSize: '14px',
  letterSpacing: '.04em',
  cursor: 'pointer',
};

const keyframes = `
@keyframes dhConfettiFall{
  0%{transform:translateY(0) rotate(0deg);opacity:1}
  100%{transform:translateY(110vh) rotate(540deg);opacity:.2}
}
`;
