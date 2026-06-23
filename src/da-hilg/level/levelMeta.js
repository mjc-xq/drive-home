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
  const off = Array.isArray(src.offset) ? src.offset : FALLBACK.offset;
  levelMeta.offset = off;
  // groundY + houseCenter ship in RAW source coords; recenter them (subtract the
  // offset) so every consumer reads the SAME recentered space as spawns/houseBox
  // (which the build already emits recentered). Without this, POI/AI Y lands ~37 m off.
  const rawGround = typeof src.groundY === 'number' ? src.groundY : FALLBACK.groundY;
  levelMeta.groundY = rawGround - off[1];
  const hc = Array.isArray(src.houseCenter) ? src.houseCenter : FALLBACK.houseCenter;
  levelMeta.houseCenter = [hc[0] - off[0], hc[1] - off[1], hc[2] - off[2]];
  // houseBox already ships RECENTERED — use as-is (do NOT subtract offset again).
  levelMeta.houseBox = src.houseBox && src.houseBox.min && src.houseBox.max ? src.houseBox : FALLBACK.houseBox;
  levelMeta.spawns = Array.isArray(src.spawns) && src.spawns.length ? src.spawns : FALLBACK.spawns;
  levelMeta.npcSpawns = Array.isArray(src.npcSpawns) ? src.npcSpawns : FALLBACK.npcSpawns;
  // streetSpawn (e.g. xq's high-rise block): an exporter-computed OPEN street position.
  // Used as the player's primary spawn when present so the player never starts boxed
  // inside a building footprint (the default front-of-building spawn can land inside a
  // neighboring tower). Absent on the house levels => null (they keep spawns[0]).
  levelMeta.streetSpawn = Array.isArray(src.streetSpawn) ? src.streetSpawn : null;
  // Grass occlusion: the paved-mask sidecar (bare filename) + the recentered DEM rect it covers.
  // Resolve the filename against the meta URL's directory (both live in /da-hilg/). Both ship
  // already recentered, so they're used as-is. Absent => null (the web grass occlusion stays off).
  levelMeta.pavedMask = src.pavedMask ? resolveSidecar(src.pavedMask) : null;
  levelMeta.pavedMaskRect =
    src.pavedMaskRect && Array.isArray(src.pavedMaskRect.min) && Array.isArray(src.pavedMaskRect.size)
      ? src.pavedMaskRect
      : null;
  levelMeta.loaded = true;
}

/** Resolve a bare sidecar filename against the meta URL's directory (e.g. /da-hilg/). */
function resolveSidecar(name) {
  const dir = LEVEL_META_URL.slice(0, LEVEL_META_URL.lastIndexOf('/') + 1);
  return dir + name;
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
