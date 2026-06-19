// SafeBanner — the relief payoff. On entering a safe zone the swarm panics and
// scatters; this washes the screen --go with a "SAFE" banner that auto-dismisses
// (~2.2s, the CSS handles the fade-out). It's the visual half of the scatter.
//
// Two triggers, deduped by a single show token:
//   - a 'safeReached' hudEvent (the explicit transient pulse), and
//   - a rising edge of currentSafeZoneAtom (null → a zone label) as a fallback,
//     which also gives us the label to subtitle the wash.
// Whichever fires first arms the banner; the label (if known) names the zone.

import { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { currentSafeZoneAtom } from '../state/nibblerAtoms.js';
import { on } from '../../hud/hudEvents.js';

const SHOW_MS = 2200; // matches the nb-safe-out keyframe duration

export default function SafeBanner() {
  const zone = useAtomValue(currentSafeZoneAtom);
  const [banner, setBanner] = useState(null); // { id, label } | null
  const idRef = useRef(0);
  const labelRef = useRef(null);
  const timerRef = useRef(null);
  const prevZoneRef = useRef(zone);

  const fire = (label) => {
    const id = ++idRef.current;
    setBanner({ id, label: label || labelRef.current || null });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      // only clear if no newer banner superseded this one
      setBanner((b) => (b && b.id === id ? null : b));
    }, SHOW_MS);
  };

  // Explicit pulse from the safe-zone system.
  useEffect(() => {
    const handler = (payload) => fire(payload?.label);
    const offFn = on('safeReached', handler);
    return () => {
      offFn();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Fallback: rising edge null → zone (also captures the label for the subtitle).
  useEffect(() => {
    const prev = prevZoneRef.current;
    if (zone) labelRef.current = zone;
    if (zone && !prev) fire(zone);
    prevZoneRef.current = zone;
  }, [zone]);

  if (!banner) return null;

  return (
    <div className="nb-safe" key={banner.id} aria-live="assertive" role="status">
      <span className="nb-safe-word">Safe</span>
      <span className="nb-safe-sub">
        {banner.label ? `${banner.label} — Nibblers scattered` : 'Nibblers scattered'}
      </span>
    </div>
  );
}
