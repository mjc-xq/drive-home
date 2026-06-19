// LookHint — a one-time "swipe to look" affordance shown over the right dead-space
// on touch devices. It fades out after ~7s (or could be dismissed by a first look
// drag elsewhere), then never shows again — remembered in localStorage. Honors
// settings.showHints so the user can disable hints entirely.

import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { settingsAtom } from '../../state/atoms.js';

const STORAGE_KEY = 'dahilg.lookHintSeen';
const VISIBLE_MS = 7000;

function alreadySeen() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* private mode — just skip persistence */
  }
}

export default function LookHint() {
  const settings = useAtomValue(settingsAtom);
  const showHints = settings?.showHints !== false;
  // Decide once on mount whether this hint should appear at all.
  const [visible, setVisible] = useState(() => showHints && !alreadySeen());

  useEffect(() => {
    if (!visible) return undefined;
    const t = setTimeout(() => {
      setVisible(false);
      markSeen();
    }, VISIBLE_MS);
    return () => clearTimeout(t);
  }, [visible]);

  if (!visible || !showHints) return null;

  return (
    <div className="dhLookHint" style={wrapStyle} aria-hidden="true">
      <div className="dhPanel" style={chipStyle}>
        <span style={glyphStyle}>👆</span>
        <span style={textStyle}>Swipe here to look</span>
      </div>
      <style>{keyframes}</style>
    </div>
  );
}

const GLASS = 'rgba(8,10,14,.66)';
const LINE = 'rgba(255,255,255,.18)';
const FONT = "'Chakra Petch',system-ui,sans-serif";

const wrapStyle = {
  position: 'absolute',
  right: '0',
  top: '0',
  width: '50vw',
  height: '60vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
  zIndex: 3,
};

const chipStyle = {
  background: GLASS,
  border: `1px solid ${LINE}`,
  borderRadius: 0,
  padding: '10px 14px',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  color: 'rgba(255,255,255,.85)',
  animation: 'dhHintFade 7s ease forwards',
};

const glyphStyle = { fontSize: '20px', animation: 'dhHintNudge 1.6s ease-in-out infinite' };

const textStyle = { fontFamily: FONT, fontSize: '13px', letterSpacing: '.04em' };

const keyframes = `
@keyframes dhHintFade{0%{opacity:0}10%{opacity:1}80%{opacity:1}100%{opacity:0}}
@keyframes dhHintNudge{0%,100%{transform:translateX(-6px)}50%{transform:translateX(6px)}}
`;
