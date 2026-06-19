// Center reticle. Default is a thin 4-stroke ring-gap with a faint dot; it tints
// nav and pulses when a family member is greetable, and punches go for ~180ms on
// a successful greet (driven by the transient 'greetHit' hudEvent, not an atom).

import { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { canGreetAtom, cameraModeAtom, pausedAtom, pointerLockedAtom } from '../state/atoms.js';
import { on } from './hudEvents.js';

export default function Crosshair() {
  const canGreet = useAtomValue(canGreetAtom);
  const cameraMode = useAtomValue(cameraModeAtom);
  const paused = useAtomValue(pausedAtom);
  const locked = useAtomValue(pointerLockedAtom);

  // transient hit punch — a short-lived class toggle, cleared by a timer
  const [hit, setHit] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    const unsub = on('greetHit', () => {
      setHit(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setHit(false), 200);
    });
    return () => {
      unsub();
      clearTimeout(timer.current);
    };
  }, []);

  // Keep the reticle in first-person play. Third-person reads its targets in the
  // world, and a paused/unlocked screen shouldn't draw an aiming dot.
  if (cameraMode === 'third' || paused || !locked) return null;

  const cls = ['dh-crosshair', canGreet && 'is-cangreet', hit && 'is-hit']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} aria-hidden="true">
      <svg viewBox="0 0 26 26">
        {/* four short strokes around a 6px center gap */}
        <line x1="13" y1="2" x2="13" y2="8" />
        <line x1="13" y1="18" x2="13" y2="24" />
        <line x1="2" y1="13" x2="8" y2="13" />
        <line x1="18" y1="13" x2="24" y2="13" />
        <circle className="dh-dot" cx="13" cy="13" r="1" />
      </svg>
    </div>
  );
}
