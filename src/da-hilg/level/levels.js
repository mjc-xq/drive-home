// Level registry + current-level selection.
//
// LAZY BY CONSTRUCTION: only the SELECTED level's heavy assets (GLB / meta / minimap)
// are ever referenced — the other levels' files are never fetched. Switching levels is a
// full page reload (?level=<slug>), so the current level is COMPLETELY unloaded (GPU
// buffers, textures, physics colliders, the whole JS heap) before the next one loads —
// the two are never in memory at once. Selection persists in localStorage.
//
// This module imports NOTHING from within da-hilg (constants.js reads from it), so it
// must stay dependency-free to avoid an import cycle.

export const LEVELS = {
  dahill: {
    slug: 'dahill',
    label: '1840 Dahill',
    sub: 'Home neighborhood',
    glb: '/da-hilg/level.glb',
    meta: '/da-hilg/level.meta.json',
    minimap: '/da-hilg/minimap.json',
  },
  canyon: {
    slug: 'canyon',
    label: 'Canyon Middle',
    sub: 'Castro Valley',
    glb: '/da-hilg/canyon.glb',
    meta: '/da-hilg/canyon.meta.json',
    minimap: '/da-hilg/canyon.minimap.json',
  },
  stanton: {
    slug: 'stanton',
    label: 'Stanton Elementary',
    sub: 'Castro Valley',
    glb: '/da-hilg/stanton.glb',
    meta: '/da-hilg/stanton.meta.json',
    minimap: '/da-hilg/stanton.minimap.json',
  },
};

export const LEVEL_ORDER = ['dahill', 'canyon', 'stanton'];

const STORE_KEY = 'dahilg:level';
const DEFAULT_LEVEL = 'dahill';

/**
 * Resolve the active level ONCE at module load: a `?level=<slug>` query wins (and is
 * persisted), else the last-chosen localStorage value, else the default.
 * @returns {string} slug
 */
function resolveLevel() {
  if (typeof window === 'undefined') return DEFAULT_LEVEL;
  try {
    const q = new URLSearchParams(window.location.search).get('level');
    if (q && LEVELS[q]) {
      window.localStorage.setItem(STORE_KEY, q);
      return q;
    }
    const stored = window.localStorage.getItem(STORE_KEY);
    if (stored && LEVELS[stored]) return stored;
  } catch {
    /* private mode / storage disabled — fall through to default */
  }
  return DEFAULT_LEVEL;
}

export const CURRENT_LEVEL = resolveLevel();
export const currentLevel = LEVELS[CURRENT_LEVEL];

/**
 * Switch to another level. Persists the choice and RELOADS to `?level=<slug>` so the
 * current level is fully torn down before the next is fetched — never both in memory.
 * @param {string} slug
 */
export function setLevel(slug) {
  if (typeof window === 'undefined' || !LEVELS[slug] || slug === CURRENT_LEVEL) return;
  try {
    window.localStorage.setItem(STORE_KEY, slug);
  } catch {
    /* ignore */
  }
  const url = new URL(window.location.href);
  url.searchParams.set('level', slug);
  window.location.assign(url.toString());
}
