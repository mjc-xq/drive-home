// Drives loadProgressAtom from three's global DefaultLoadingManager. When loading
// completes it flips gamePhase 'loading' -> 'playing' so the veil fades and the
// lock overlay takes over.
//
// Robustness: the manager's onLoad event advances the phase, and a safety timeout
// also advances if everything was cached before mount, so the player is never stuck
// behind the veil.

import { useCallback, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useAtomValue, useSetAtom } from 'jotai';
import { gamePhaseAtom, loadProgressAtom } from '../state/atoms.js';

const SAFETY_MS = 12000; // never leave the player stuck on the veil

export default function ProgressBridge() {
  const setProgress = useSetAtom(loadProgressAtom);
  const setPhase = useSetAtom(gamePhaseAtom);
  const phase = useAtomValue(gamePhaseAtom);
  const lastProgress = useRef(null);
  const advanced = useRef(false);

  const writeProgress = useCallback((value) => {
    const next = Math.round(Math.max(0, Math.min(100, value)));
    if (Object.is(lastProgress.current, next)) return;
    lastProgress.current = next;
    setProgress(next);
  }, [setProgress]);

  const advance = useCallback(() => {
    if (advanced.current) return;
    advanced.current = true;
    lastProgress.current = 100;
    setProgress(100);
    setPhase((p) => (p === 'loading' ? 'playing' : p));
  }, [setPhase, setProgress]);

  // If another flow already moved the game past loading, retire the bridge.
  useEffect(() => {
    if (phase !== 'loading') advanced.current = true;
  }, [phase]);

  // Mirror three's DefaultLoadingManager directly. This avoids a React subscription
  // loop from drei/useProgress while keeping the same loading veil semantics.
  useEffect(() => {
    const manager = THREE.DefaultLoadingManager;
    const prevStart = manager.onStart;
    const prevProgress = manager.onProgress;
    const prevLoad = manager.onLoad;
    const prevError = manager.onError;

    const onStart = (url, loaded, total) => {
      writeProgress(total > 0 ? (loaded / total) * 100 : 0);
      prevStart?.(url, loaded, total);
    };
    const onProgress = (url, loaded, total) => {
      writeProgress(total > 0 ? (loaded / total) * 100 : 100);
      prevProgress?.(url, loaded, total);
    };
    const onLoad = () => {
      advance();
      prevLoad?.();
    };
    const onError = (url) => {
      prevError?.(url);
    };

    manager.onStart = onStart;
    manager.onProgress = onProgress;
    manager.onLoad = onLoad;
    manager.onError = onError;

    return () => {
      if (manager.onStart === onStart) manager.onStart = prevStart;
      if (manager.onProgress === onProgress) manager.onProgress = prevProgress;
      if (manager.onLoad === onLoad) manager.onLoad = prevLoad;
      if (manager.onError === onError) manager.onError = prevError;
    };
  }, [advance, writeProgress]);

  // safety: flip to playing even if the loading manager never reports completion
  useEffect(() => {
    const t = setTimeout(() => {
      advance();
    }, SAFETY_MS);
    return () => clearTimeout(t);
  }, [advance]);

  return null;
}
