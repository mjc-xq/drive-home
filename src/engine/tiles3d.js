import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GoogleCloudAuthPlugin, ReorientationPlugin, TileCompressionPlugin,
  TilesFadePlugin, GLTFExtensionsPlugin, TileFlatteningPlugin
} from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

// Google Photorealistic 3D Tiles streamed into the scene. The tileset is in
// geocentric ECEF; ReorientationPlugin re-bases it so the house lat/lon sits at
// the world origin, Y-up — matching this scene's local-meters frame. Tiles are
// Draco-compressed with KTX2 textures, so DRACO + KTX2 decoders are wired in
// (loaded from CDN — fine, since photoreal tiles are an online feature anyway).
const DRACO_CDN = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
const BASIS_CDN = 'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/basis/';

export function createPhotorealTiles(scene, camera, renderer, opts = {}) {
  const key = opts.key || import.meta.env.VITE_GOOGLE_MAPS_KEY;
  if (!key) { console.warn('[tiles3d] no Google Maps key — photoreal disabled'); return null; }

  const draco = new DRACOLoader().setDecoderPath(DRACO_CDN);
  const ktx2 = new KTX2Loader().setTranscoderPath(BASIS_CDN).detectSupport(renderer);

  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true }));
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco, ktxLoader: ktx2 }));
  tiles.registerPlugin(new TileCompressionPlugin());

  // Look cohesion: photoreal tile textures already carry baked lighting, but as
  // MeshStandard they get re-lit by the sun AND double sRGB-decoded (GLTFLoader
  // forces baseColor to sRGB while the rest of the scene runs ColorManagement
  // off). Both darken them. Treat tiles as an UNLIT backdrop: NoColorSpace map +
  // MeshBasic + a small gain so they read like the bright aerial. Registered
  // before TilesFadePlugin so the fade still wraps the final material.
  const tileGain = { value: opts.tileGain ?? 0.82 };
  tiles.tileGain = tileGain;
  // Cap anisotropy on mobile: iOS reports 16, and 16× sampling on the full-screen photoreal
  // ground (the highest-overdraw surface at grazing driving angles) is a big fill-rate cost
  // for little visible gain. 4× keeps nearly all the grazing-angle sharpness.
  const _mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  const maxAniso = _mobile ? Math.min(4, renderer.capabilities.getMaxAnisotropy()) : renderer.capabilities.getMaxAnisotropy();
  tiles.registerPlugin({
    name: 'DAHILL_LOOK',
    processTileModel(scene) {
      scene.traverse(o => {
        if (!o.isMesh || o.isBatchedMesh) return;
        const src = o.material;
        const map = src && src.map ? src.map : null;
        if (map) { map.colorSpace = THREE.NoColorSpace; map.anisotropy = maxAniso; }   // sharp roads/roofs at grazing angles
        const m = new THREE.MeshBasicMaterial({ map, side: THREE.FrontSide });
        m.toneMapped = false;
        m.color.setScalar(tileGain.value);
        o.material = m;
      });
      return Promise.resolve();
    }
  });
  tiles.registerPlugin(new TilesFadePlugin());
  tiles.registerPlugin(new ReorientationPlugin({
    lat: opts.lat, lon: opts.lon, height: opts.height ?? 0,
    azimuth: opts.azimuth ?? 0, recenter: true
  }));
  // flatten the play-area ground (driveway/yard) — shapes added by the engine
  // once alignment settles. Vertices are flattened in the TILESET LOCAL frame.
  const flatten = new TileFlatteningPlugin();
  tiles.registerPlugin(flatten);
  tiles.flatten = flatten;

  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  tiles.errorTarget = opts.errorTarget ?? 16;          // pixel error; higher = lighter
  tiles.displayActiveTiles = true;                      // keep off-camera tiles for ground raycasts
  // Cap resident tile memory below the iOS Safari WebGL budget — driving dwells
  // at ground level pull many leaf tiles; defaults (~430/322 MB) can OOM mobile.
  tiles.lruCache.minBytesSize = 120 * 1024 * 1024;
  tiles.lruCache.maxBytesSize = 200 * 1024 * 1024;

  // ReorientationPlugin owns tiles.group's transform (anchors the lat/lon to
  // the origin), so the scene-space offset that aligns the photoreal ground to
  // the procedural terrain height goes on a parent holder instead.
  const holder = new THREE.Group();
  holder.add(tiles.group);
  scene.add(holder);
  tiles.holder = holder;

  // Full teardown for engine.dispose(): frees all streamed tile geom/textures,
  // the Draco/KTX2 worker pools, and detaches the holder. The biggest GPU pool
  // in the app, so this is what actually returns memory on iOS.
  tiles.disposeAll = () => {
    try { tiles.dispose(); } catch (e) { /* renderer may already be gone */ }
    try { draco.dispose(); ktx2.dispose(); } catch (e) { /* idempotent */ }
    if (holder.parent) holder.parent.remove(holder);
  };
  return tiles;
}
