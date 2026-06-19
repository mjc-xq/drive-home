// Full-screen dusk veil shown until the scene is ready. A ::before dusk gradient,
// the AGC "DA HILG" title, a nav progress bar fed by loadProgressAtom, and a
// cycling sub-line of load phases. Fades out (.is-done) once gamePhase leaves
// 'loading'. The actual progress + phase flip is bridged in ProgressBridge.jsx.

import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { gamePhaseAtom, loadProgressAtom } from '../state/atoms.js';

const PHASES = [
  'Loading the neighborhood…',
  'Waking the family…',
  'Warming up the porch lights…',
  'Almost there…',
];

export default function LoadingVeil() {
  const phase = useAtomValue(gamePhaseAtom);
  const progress = useAtomValue(loadProgressAtom);

  const done = phase !== 'loading';

  // cycle the flavor sub-line every ~2s while loading
  const [phaseIdx, setPhaseIdx] = useState(0);
  useEffect(() => {
    if (done) return undefined;
    const t = setInterval(() => setPhaseIdx((i) => (i + 1) % PHASES.length), 2000);
    return () => clearInterval(t);
  }, [done]);

  const pct = Math.round(Math.max(0, Math.min(100, progress)));

  return (
    <div className={`dh-veil${done ? ' is-done' : ''}`} aria-hidden={done}>
      <h1 className="dh-veil-title">Da Hilg</h1>
      <div className="dh-veil-progress">
        <div className="dh-veil-track">
          <div className="dh-veil-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="dh-veil-pct">{pct}%</span>
      </div>
      <p className="dh-veil-sub">{PHASES[phaseIdx]}</p>
    </div>
  );
}
