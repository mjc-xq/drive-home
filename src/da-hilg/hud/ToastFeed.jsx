// ToastFeed — bottom-left stack of transient notices. Subscribes to the tiny
// event emitter in hud/hudEvents.js (NOT a Jotai atom array — transient pulses
// must not thrash the store). Each toast auto-dismisses; the left accent bar is
// colored per kind. The list is an ARIA polite live region for screen readers.

import { useEffect, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { settingsAtom } from '../state/atoms.js';
import { on, off } from './hudEvents.js';

// Accent color per toast kind (kinds defined in hudEvents.js ToastKind):
// greet=--go, zone=--nav, celebrate=--coin, system=neutral. A few extra aliases
// are tolerated; any unknown kind falls back to neutral.
const KIND_COLOR = {
  greet: '#2BE84F',
  zone: '#2D8CFF',
  celebrate: '#FFC83D',
  celebration: '#FFC83D', // alias tolerance
  tag: '#FF5247',
  system: 'rgba(255,255,255,.4)',
};

const DISMISS_MS = 3200;
const MAX_VISIBLE = 3;

let nextId = 1;

export default function ToastFeed() {
  const [toasts, setToasts] = useState([]);
  const [settings] = useAtom(settingsAtom);
  const reduced = !!settings?.reducedMotion;
  // Track timers so we can clear them on unmount.
  const timers = useRef(new Map());

  useEffect(() => {
    // hudEvents emits {text, kind} on the 'toast' channel via pushToast().
    const handler = (payload) => {
      const text = typeof payload === 'string' ? payload : payload?.text;
      if (!text) return;
      const kind = (typeof payload === 'object' && payload?.kind) || 'system';
      const id = nextId++;
      setToasts((prev) => {
        const next = [...prev, { id, text, kind }];
        // keep only the most recent MAX_VISIBLE
        return next.slice(-MAX_VISIBLE);
      });
      const t = setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== id));
        timers.current.delete(id);
      }, DISMISS_MS);
      timers.current.set(id, t);
    };
    on('toast', handler);
    return () => {
      off('toast', handler);
      timers.current.forEach((t) => clearTimeout(t));
      timers.current.clear();
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="dhToastFeed" style={feedStyle} aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="dhToast dhPanel"
          style={{
            ...toastStyle,
            borderLeft: `3px solid ${KIND_COLOR[t.kind] || KIND_COLOR.system}`,
            animation: reduced ? 'dhToastFadeIn .12s ease both' : 'dhToastIn .14s ease both',
          }}
        >
          {t.text}
        </div>
      ))}
      <style>{keyframes}</style>
    </div>
  );
}

const GLASS = 'rgba(8,10,14,.66)';
const LINE = 'rgba(255,255,255,.18)';
const FONT = "'Chakra Petch',system-ui,sans-serif";

const feedStyle = {
  position: 'absolute',
  left: 'calc(12px + env(safe-area-inset-left,0px))',
  bottom: 'calc(96px + env(safe-area-inset-bottom,0px))',
  display: 'flex',
  flexDirection: 'column-reverse', // newest on top, stack grows upward
  gap: '6px',
  pointerEvents: 'none',
  maxWidth: 'min(64vw, 320px)',
};

const toastStyle = {
  background: GLASS,
  border: `1px solid ${LINE}`,
  borderRadius: 0,
  boxShadow: '0 16px 40px rgba(0,0,0,.5)',
  backdropFilter: 'blur(18px) saturate(1.3)',
  WebkitBackdropFilter: 'blur(18px) saturate(1.3)',
  padding: '8px 12px',
  color: '#fff',
  fontFamily: FONT,
  fontSize: '14px',
  lineHeight: 1.3,
};

const keyframes = `
@keyframes dhToastIn{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:translateX(0)}}
@keyframes dhToastFadeIn{from{opacity:0}to{opacity:1}}
`;
