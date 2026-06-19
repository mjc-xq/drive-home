// Drives loadProgressAtom from drei's useProgress (which reads three's global
// DefaultLoadingManager — it works OUTSIDE the Canvas, anywhere under React). When
// loading completes it flips gamePhase 'loading' → 'playing' so the veil fades and
// the lock overlay takes over.
//
// Robustness: drei reports `active` + `progress`; once active goes false with
// progress at 100 we consider the level ready. A safety timeout also advances the
// phase if the manager never reports (e.g. everything was cached before mount), so
// the player is never stuck behind the veil.

import { useEffect, useRef } from 'react';
import { useProgress } from '@react-three/drei';
import { useAtomValue, useSetAtom } from 'jotai';
import { gamePhaseAtom, loadProgressAtom } from '../state/atoms.js';

const SAFETY_MS = 12000; // never leave the player stuck on the veil

export default function ProgressBridge() {
  const { active, progress, loaded, total } = useProgress();
  const setProgress = useSetAtom(loadProgressAtom);
  const setPhase = useSetAtom(gamePhaseAtom);
  const phase = useAtomValue(gamePhaseAtom);

  // mirror raw progress into the atom (clamped, integer-ish for the veil readout)
  useEffect(() => {
    setProgress(Math.max(0, Math.min(100, progress)));
  }, [progress, setProgress]);

  // advance to 'playing' when the manager settles at full, or after the safety net
  const advanced = useRef(false);
  useEffect(() => {
    if (advanced.current) return;
    if (phase !== 'loading') {
      advanced.current = true;
      return;
    }
    // settled = not actively loading AND we've reported 100% (or had ≥1 item finish)
    const settled = !active && progress >= 100 && (total === 0 || loaded >= total);
    if (settled) {
      advanced.current = true;
      setProgress(100);
      setPhase('playing');
    }
  }, [active, progress, loaded, total, phase, setPhase, setProgress]);

  // safety: flip to playing even if the loading manager never reports completion
  useEffect(() => {
    const t = setTimeout(() => {
      if (advanced.current) return;
      advanced.current = true;
      setProgress(100);
      setPhase((p) => (p === 'loading' ? 'playing' : p));
    }, SAFETY_MS);
    return () => clearTimeout(t);
  }, [setPhase, setProgress]);

  return null;
}
