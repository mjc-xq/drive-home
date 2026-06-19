// Dev-only Nibblers toggles for fast iteration. NEVER on by default — these read the
// URL query (or localStorage) once at load, so a normal build/play is unaffected.
//
//   ?fastmark        → auto-mark the player anywhere outside a safe zone, so the swarm
//                      spawns immediately without hunting for a danger zone.
//   localStorage     → dahilg:fastmark = '1' (persists across reloads)
//
// Example: open  /da-hilg?fastmark  to start getting nibbled within ~1 second.

function readFlag(name) {
  if (typeof window === 'undefined') return false;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.has(name)) {
      const v = q.get(name);
      return v !== '0' && v !== 'false';
    }
    return window.localStorage.getItem('dahilg:' + name) === '1';
  } catch {
    return false;
  }
}

/** Auto-mark the player outside safe zones so nibblers spawn at once (dev only). */
export const DEV_FAST_MARK = readFlag('fastmark');
