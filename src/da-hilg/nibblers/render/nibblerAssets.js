// Loads the per-character Vertex Animation Texture artifacts baked into
// public/da-hilg/nibblers/ — the combined manifest json plus, FOR EACH of the four
// family characters (mike/kelli/cece/drew), the pos/normal VAT PNGs and the real
// baseColor texture — and turns them into data-correct THREE textures. The VAT data
// PNGs use Nearest filtering / NoColorSpace so the packed 0..255 bytes survive
// untouched; the baseColor texture is a real color map (sRGB, mipmapped, repeat-wrap).
// The whole set is loaded ONCE and cached at module scope; assetsReady() is the plain
// bool the sim gate (updateNibblers) reads, useNibblerAssets() is the React hook.
//
// Manifest shape (nibbler.vat.json, version 2):
//   { version, order:[mike,kelli,cece,drew], characters:{ <key>: meta } }
// where each meta carries vertCount/rows/clips/pos+nrm min-max + posTexture/nrmTexture/
// colorTexture/proxy filenames. Everything is read from the json — nothing hardcoded.

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
 * @typedef {Object} NibblerCharMeta
 * @property {number} vertCount
 * @property {number} rows
 * @property {number} frameCount
 * @property {Object} clips  { idle:{row,frames}, run, jump, emote }
 * @property {number[]} posMin
 * @property {number[]} posMax
 * @property {number[]} nrmMin
 * @property {number[]} nrmMax
 * @property {string} posTexture
 * @property {string} nrmTexture
 * @property {string} colorTexture
 * @property {string} proxy
 * @property {string} aVertexId  'attribute' | 'glVertexID'
 */

/**
 * @typedef {Object} NibblerCharAssets
 * @property {string} key
 * @property {THREE.Texture} posTex
 * @property {THREE.Texture} nrmTex
 * @property {THREE.Texture} colorTex
 * @property {NibblerCharMeta} meta
 */

/**
 * @typedef {Object} NibblerAssets
 * @property {string[]} order               charIx 0..3 = mike/kelli/cece/drew
 * @property {Object.<string,NibblerCharAssets>} byChar
 */

/** True once the manifest + every character's textures have loaded (the sim gate reads this). */
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

// Configure a loaded VAT DATA texture for exact, untouched texel fetches.
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

// Configure a loaded COLOR (baseColor) texture: real sRGB photo map, mipmapped, the
// UV is the character's actual UV so wrap/flip match a normal glTF baseColor sampler.
function configureColorTexture(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;            // glTF convention (proxy carries glTF UVs)
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function loadTexture(loader, url, configure) {
  return new Promise((resolve, reject) => {
    if (!url) {
      resolve(null);
      return;
    }
    loader.load(url, (tex) => resolve(configure(tex)), undefined, reject);
  });
}

/**
 * Kick off (or return the in-flight / cached) per-character VAT load. Idempotent.
 * @returns {Promise<NibblerAssets>}
 */
export function loadNibblerAssets() {
  if (cached) return Promise.resolve(cached);
  if (loading) return loading;

  loading = (async () => {
    const res = await fetch(NIBBLER_VAT_JSON_URL);
    if (!res.ok) throw new Error(`nibbler.vat.json HTTP ${res.status}`);
    const manifest = await res.json();

    const order = manifest.order || Object.keys(manifest.characters || {});
    const loader = new THREE.TextureLoader();

    // Load every character's three textures in parallel.
    const entries = await Promise.all(
      order.map(async (key) => {
        const meta = manifest.characters[key];
        const posUrl = resolveTexUrl(meta.posTexture);
        const nrmUrl = resolveTexUrl(meta.nrmTexture);
        const colUrl = resolveTexUrl(meta.colorTexture);
        const [posTex, nrmTex, colorTex] = await Promise.all([
          loadTexture(loader, posUrl, configureVatTexture),
          loadTexture(loader, nrmUrl, configureVatTexture),
          loadTexture(loader, colUrl, configureColorTexture),
        ]);
        return { key, posTex, nrmTex: nrmTex || posTex, colorTex, meta };
      }),
    );

    const byChar = Object.fromEntries(entries.map((e) => [e.key, e]));
    cached = { order, byChar };
    ready = true;
    return cached;
  })();

  return loading;
}

/**
 * React hook: returns the loaded per-character VAT assets, or null until ready.
 * Triggers the one-time load on first mount; safe to call from multiple components.
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
