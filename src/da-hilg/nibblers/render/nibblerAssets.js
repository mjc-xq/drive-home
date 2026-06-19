// Loads the Vertex Animation Texture artifacts baked into
// public/da-hilg/nibblers/ — the metadata json plus the pos/normal PNGs — and
// turns the PNGs into data-correct THREE textures (Nearest filtering, no mipmaps,
// flipY=false, linear/no color management so the packed 0..255 bytes survive
// untouched). The VAT is loaded ONCE for the whole horde and cached at module
// scope; assetsReady() is the plain bool the sim gate (updateNibblers) reads, and
// useNibblerAssets() is the React hook the renderer mounts on.
//
// Robustness: we read everything (vertCount/rows/clip bands/pos+nrm min-max,
// texture URLs, separate-vs-combined layout) from nibbler.vat.json at runtime —
// nothing is hardcoded. The current bake emits separate pos/nrm PNGs; this loader
// also tolerates a combined single-PNG layout (meta.layout / meta.combined).

import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { NIBBLER_VAT_JSON_URL } from '../constants.js';

// ── Module-level cache (load once, share across mounts) ─────────────────────
/** @type {NibblerAssets|null} */
let cached = null;
/** @type {Promise<NibblerAssets>|null} */
let loading = null;
let ready = false;

/**
 * @typedef {Object} NibblerMeta
 * @property {number} vertCount
 * @property {number} rows
 * @property {number} frameCount
 * @property {Object} clips  { idle:{row,frames}, run, jump, emote }
 * @property {number[]} posMin
 * @property {number[]} posMax
 * @property {number[]} nrmMin
 * @property {number[]} nrmMax
 * @property {string} [layout]
 * @property {number} textureWidth
 * @property {number} textureHeight
 * @property {string} aVertexId  'attribute' | 'glVertexID'
 * @property {string} [attributeName]
 */

/**
 * @typedef {Object} NibblerAssets
 * @property {THREE.Texture} posTex
 * @property {THREE.Texture} nrmTex
 * @property {NibblerMeta} meta
 */

/** True once the VAT json + textures have finished loading (the sim gate reads this). */
export function assetsReady() {
  return ready;
}

/** The loaded assets, or null until ready. Imperative read for non-React callers. */
export function getNibblerAssets() {
  return cached;
}

// Resolve a possibly-relative texture URL (from the json) against the json's URL.
function resolveTexUrl(name) {
  if (!name) return null;
  if (/^(https?:)?\/\//.test(name) || name.startsWith('/')) return name;
  const base = NIBBLER_VAT_JSON_URL.slice(0, NIBBLER_VAT_JSON_URL.lastIndexOf('/') + 1);
  return base + name;
}

// Configure a loaded VAT texture for exact, untouched texel fetches.
function configureVatTexture(tex) {
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  // The PNG bytes are PACKED DATA (val-min)/(max-min), not color — keep them linear
  // so three never applies an sRGB→linear decode. NoColorSpace = raw passthrough.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function loadTexture(loader, url) {
  return new Promise((resolve, reject) => {
    if (!url) {
      resolve(null);
      return;
    }
    loader.load(url, (tex) => resolve(configureVatTexture(tex)), undefined, reject);
  });
}

/**
 * Kick off (or return the in-flight / cached) VAT load. Idempotent.
 * @returns {Promise<NibblerAssets>}
 */
export function loadNibblerAssets() {
  if (cached) return Promise.resolve(cached);
  if (loading) return loading;

  loading = (async () => {
    const res = await fetch(NIBBLER_VAT_JSON_URL);
    if (!res.ok) throw new Error(`nibbler.vat.json HTTP ${res.status}`);
    /** @type {NibblerMeta} */
    const meta = await res.json();

    // Texture URLs: read from the json when present, else fall back to the
    // canonical names sitting beside the json.
    const posUrl = resolveTexUrl(meta.posTexture || 'nibbler.vat.pos.png');
    // Combined layout: pos + normal packed into one PNG → no separate nrm fetch.
    const combined =
      meta.combined === true || /combined/i.test(meta.layout || '');
    const nrmUrl = combined
      ? null
      : resolveTexUrl(meta.nrmTexture || 'nibbler.vat.nrm.png');

    const loader = new THREE.TextureLoader();
    const [posTex, nrmTexLoaded] = await Promise.all([
      loadTexture(loader, posUrl),
      loadTexture(loader, nrmUrl),
    ]);

    // In a combined layout the normal half lives in the same texture; the material
    // reads the band offset from meta. Expose posTex as nrmTex so callers always
    // have a valid sampler to bind.
    const nrmTex = nrmTexLoaded || posTex;

    cached = { posTex, nrmTex, meta };
    ready = true;
    return cached;
  })();

  return loading;
}

/**
 * React hook: returns the loaded VAT assets, or null until ready. Triggers the
 * one-time load on first mount; safe to call from multiple components.
 * @returns {NibblerAssets|null}
 */
export function useNibblerAssets() {
  const [assets, setAssets] = useState(/** @type {NibblerAssets|null} */ (cached));

  useEffect(() => {
    if (cached) {
      if (!assets) setAssets(cached);
      return;
    }
    let alive = true;
    loadNibblerAssets()
      .then((a) => {
        if (alive) setAssets(a);
      })
      .catch((err) => {
        // Assets missing/not baked yet — stay null; the sim gate stays closed.
        console.warn('[nibblers] VAT assets failed to load:', err);
      });
    return () => {
      alive = false;
    };
    // Load-once; intentionally no deps beyond mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return assets;
}

// Warm the load as soon as this module is imported so the first SwarmRenderer
// mount doesn't stall (mirrors useGLTF.preload for the rest of the assets).
loadNibblerAssets().catch(() => {
  /* swallowed: surfaced again via the hook's catch */
});
