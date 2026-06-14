import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GoogleCloudAuthPlugin, ReorientationPlugin, TileCompressionPlugin,
  TilesFadePlugin, GLTFExtensionsPlugin
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
  tiles.registerPlugin(new TilesFadePlugin());
  tiles.registerPlugin(new ReorientationPlugin({
    lat: opts.lat, lon: opts.lon, height: opts.height ?? 0,
    azimuth: opts.azimuth ?? 0, recenter: true
  }));

  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  tiles.errorTarget = opts.errorTarget ?? 16;          // pixel error; higher = lighter

  // ReorientationPlugin owns tiles.group's transform (anchors the lat/lon to
  // the origin), so the scene-space offset that aligns the photoreal ground to
  // the procedural terrain height goes on a parent holder instead.
  const holder = new THREE.Group();
  holder.add(tiles.group);
  scene.add(holder);
  tiles.holder = holder;
  return tiles;
}
