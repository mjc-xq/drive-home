// Small shared UI hooks used by more than one route page.

import { useEffect, useRef, useState } from 'react';

/** Track portrait/landscape, the way MobileControls wants it. Both Drive and
    Scoop render the on-screen joystick, so this lives here rather than in either
    page. */
export function useOrientation() {
  const [orientation, setOrientation] = useState(() =>
    (typeof window !== 'undefined' && window.innerHeight > window.innerWidth) ? 'portrait' : 'landscape');
  useEffect(() => {
    const onR = () => setOrientation(window.innerHeight > window.innerWidth ? 'portrait' : 'landscape');
    window.addEventListener('resize', onR);
    window.addEventListener('orientationchange', onR);
    return () => { window.removeEventListener('resize', onR); window.removeEventListener('orientationchange', onR); };
  }, []);
  return orientation;
}

/** Close a popover when a pointer goes down outside `ref`. Capture-phase +
    pointerdown = snappy, touch-first dismissal; taps on the trigger inside `ref`
    (and drags on sliders inside it) count as "inside" and don't close. Active
    only while `open`. */
export function useOutsideDismiss(open, ref, onClose) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { const r = ref.current; if (r && !r.contains(e.target)) onClose(); };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, ref, onClose]);
}

/** A localStorage-backed number state: reads once on mount (clamped/validated by
    `parse`), writes through on every set. Used for the Drive sliders (speed
    multiplier, densities, auto-drive cap) so a page reload keeps your settings.
    `parse(raw)` returns the value to use, or undefined to fall back to
    `fallback`. */
export function usePersistentNumber(key, fallback, parse) {
  const [value, setValue] = useState(() => {
    try { const v = parse(localStorage.getItem(key)); return v === undefined ? fallback : v; }
    catch (e) { return fallback; }
  });
  const set = (v) => { setValue(v); try { localStorage.setItem(key, String(v)); } catch (e) { } };
  return [value, set];
}
