// useLevelMeta() — load the level's metadata JSON (offset, ground height, house
// bounds, spawn points) into the plain-mutable refs.levelMeta singleton, once,
// at mount. The rest of the app reads refs.levelMeta directly (it's per-frame
// truth, not React state); this hook only owns the fetch + the loaded flag.
//
// On any failure (missing file, bad JSON, DEV_RAW_LEVEL with no meta) it writes
// sensible defaults and still flips loaded=true, so the scene always comes up.

import { useEffect, useState } from 'react';
import { levelMeta } from '../state/refs.js';
import { LEVEL_META_URL } from '../constants.js';

// Defaults used when the meta JSON can't be loaded. Recentered space: a single
// spawn just above origin, a handful of NPC spawns scattered nearby, a small
// house box at origin. Keeps the game playable even without a built level.
const FALLBACK = {
  offset: [0, 0, 0],
  groundY: 0,
  houseCenter: [0, 0, 0],
  houseBox: { min: [-12, 0, -9], max: [12, 4.5, 9] },
  spawns: [[0, 0.1, 0]],
  npcSpawns: [
    [6, 0.1, 6],
    [-6, 0.1, 6],
    [6, 0.1, -6],
  ],
};

/**
 * Copy a meta payload (or the fallback) into refs.levelMeta and mark it loaded.
 * Each field is guarded so a partial JSON still produces a usable meta.
 * @param {Object} src
 */
function applyMeta(src) {
  levelMeta.offset = Array.isArray(src.offset) ? src.offset : FALLBACK.offset;
  levelMeta.groundY = typeof src.groundY === 'number' ? src.groundY : FALLBACK.groundY;
  levelMeta.houseCenter = Array.isArray(src.houseCenter) ? src.houseCenter : FALLBACK.houseCenter;
  levelMeta.houseBox = src.houseBox && src.houseBox.min && src.houseBox.max ? src.houseBox : FALLBACK.houseBox;
  levelMeta.spawns = Array.isArray(src.spawns) && src.spawns.length ? src.spawns : FALLBACK.spawns;
  levelMeta.npcSpawns = Array.isArray(src.npcSpawns) ? src.npcSpawns : FALLBACK.npcSpawns;
  levelMeta.loaded = true;
}

/**
 * React hook: load LEVEL_META_URL into refs.levelMeta exactly once.
 * @returns {boolean} whether the meta has finished loading (success or fallback)
 */
export function useLevelMeta() {
  const [loaded, setLoaded] = useState(levelMeta.loaded);

  useEffect(() => {
    // Already populated (e.g. remounted) — nothing to fetch.
    if (levelMeta.loaded) {
      setLoaded(true);
      return;
    }

    let cancelled = false;

    fetch(LEVEL_META_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`level meta HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (cancelled) return;
        applyMeta(json);
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        // Missing/invalid meta (or DEV_RAW_LEVEL with no meta) — fall back so the
        // scene still loads. Log once for visibility.
        console.warn('[levelMeta] using defaults:', err?.message ?? err);
        applyMeta(FALLBACK);
        setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return loaded;
}
