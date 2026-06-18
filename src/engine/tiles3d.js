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

const CUTAWAY_VERTEX_PARS = `
varying vec3 vDahillCutawayWorldPos;
varying vec3 vDahillCutawayWorldNormal;
`;

const CUTAWAY_VERTEX_BODY = `
vDahillCutawayWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vDahillCutawayWorldNormal = normalize(mat3(modelMatrix) * normal);
`;

const CUTAWAY_FRAGMENT_PARS = `
varying vec3 vDahillCutawayWorldPos;
varying vec3 vDahillCutawayWorldNormal;
uniform vec3 dahillCutawayEye;
uniform vec3 dahillCutawayTarget;
uniform vec4 dahillCutawayScreen;
uniform float dahillCutawayBaseY;
uniform float dahillCutawayMinOpacity;
uniform float dahillCutawayFlatMinOpacity;
uniform float dahillCutawayFlatFadeHeight;
uniform float dahillCutawayDepthPad;
uniform float dahillCutawayGroundPad;
uniform float dahillCutawayMinHeight;
uniform float dahillCutawayColumnRadius;
uniform float dahillCutawayColumnSoftness;

float dahillBayer4(vec2 p) {
  vec2 q = floor(mod(p, 4.0));
  float x = q.x;
  float y = q.y;
  float v = 0.0;
  if (y < 0.5) {
    if (x < 0.5) v = 0.0;
    else if (x < 1.5) v = 8.0;
    else if (x < 2.5) v = 2.0;
    else v = 10.0;
  } else if (y < 1.5) {
    if (x < 0.5) v = 12.0;
    else if (x < 1.5) v = 4.0;
    else if (x < 2.5) v = 14.0;
    else v = 6.0;
  } else if (y < 2.5) {
    if (x < 0.5) v = 3.0;
    else if (x < 1.5) v = 11.0;
    else if (x < 2.5) v = 1.0;
    else v = 9.0;
  } else {
    if (x < 0.5) v = 15.0;
    else if (x < 1.5) v = 7.0;
    else if (x < 2.5) v = 13.0;
    else v = 5.0;
  }
  return (v + 0.5) / 16.0;
}

void dahillApplyCutaway() {
  if (dahillCutawayScreen.z <= 1.0 || dahillCutawayScreen.w <= 1.0) return;

  vec3 eyeToTarget = dahillCutawayTarget - dahillCutawayEye;
  float targetDist = length(eyeToTarget);
  if (targetDist <= 0.001) return;
  vec3 dir = eyeToTarget / targetDist;
  float along = dot(vDahillCutawayWorldPos - dahillCutawayEye, dir);
  if (along <= dahillCutawayDepthPad || along >= targetDist - dahillCutawayDepthPad) return;

  float heightAboveBase = vDahillCutawayWorldPos.y - dahillCutawayBaseY;
  if (heightAboveBase < dahillCutawayMinHeight) return;

  float lineY = mix(dahillCutawayEye.y, dahillCutawayBaseY, clamp(along / targetDist, 0.0, 1.0));
  if (vDahillCutawayWorldPos.y < lineY - dahillCutawayGroundPad) return;

  vec2 ellipse = (gl_FragCoord.xy - dahillCutawayScreen.xy) / dahillCutawayScreen.zw;
  float fade = 1.0 - smoothstep(0.78, 1.14, length(ellipse));
  if (dahillCutawayColumnRadius > 0.0) {
    float columnDist = length(vDahillCutawayWorldPos.xz - dahillCutawayTarget.xz);
    fade *= 1.0 - smoothstep(dahillCutawayColumnRadius, dahillCutawayColumnRadius + dahillCutawayColumnSoftness, columnDist);
  }
  if (fade <= 0.0) return;
  float upness = abs(normalize(vDahillCutawayWorldNormal).y);
  float flatness = smoothstep(0.72, 0.9, upness);
  float elevatedFlat = smoothstep(
    dahillCutawayMinHeight + 0.35,
    dahillCutawayMinHeight + max(0.36, dahillCutawayFlatFadeHeight),
    heightAboveBase
  );
  float flatFloor = mix(dahillCutawayFlatMinOpacity, dahillCutawayMinOpacity, elevatedFlat);
  float floor = mix(dahillCutawayMinOpacity, flatFloor, flatness);
  float keep = mix(1.0, floor, fade);
  if (dahillBayer4(gl_FragCoord.xy) > keep) discard;
}
`;

function installTileCutawayDither(material, cutaway) {
  material.onBeforeCompile = shader => {
    shader.uniforms.dahillCutawayEye = cutaway.eye;
    shader.uniforms.dahillCutawayTarget = cutaway.target;
    shader.uniforms.dahillCutawayScreen = cutaway.screen;
    shader.uniforms.dahillCutawayBaseY = cutaway.baseY;
    shader.uniforms.dahillCutawayMinOpacity = cutaway.minOpacity;
    shader.uniforms.dahillCutawayFlatMinOpacity = cutaway.flatMinOpacity;
    shader.uniforms.dahillCutawayFlatFadeHeight = cutaway.flatFadeHeight;
    shader.uniforms.dahillCutawayDepthPad = cutaway.depthPad;
    shader.uniforms.dahillCutawayGroundPad = cutaway.groundPad;
    shader.uniforms.dahillCutawayMinHeight = cutaway.minHeight;
    shader.uniforms.dahillCutawayColumnRadius = cutaway.columnRadius;
    shader.uniforms.dahillCutawayColumnSoftness = cutaway.columnSoftness;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CUTAWAY_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CUTAWAY_VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CUTAWAY_FRAGMENT_PARS}`)
      .replace('#include <alphatest_fragment>', 'dahillApplyCutaway();\n#include <alphatest_fragment>');
  };
  material.customProgramCacheKey = () => 'dahill-tile-screen-cutaway-v3';
}

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
  // for little visible gain. 4× keeps nearly all the grazing-angle sharpness. The engine
  // already detects mobile (incl. iPadOS-13+ desktop UA) and passes it in; fall back to the
  // same check so the module still works standalone.
  const isMobile = opts.mobile ?? (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)));
  const maxAniso = isMobile ? Math.min(4, renderer.capabilities.getMaxAnisotropy()) : renderer.capabilities.getMaxAnisotropy();
  // Shared Drive cutaway uniforms. The engine updates these once per frame after placing the
  // camera; every streamed tile material points at the same objects, so new tiles inherit the live
  // oval visibility window immediately.
  const clipPlanes = [];
  tiles.clipPlanes = clipPlanes;
  tiles.cutaway = {
    eye: { value: new THREE.Vector3() },
    target: { value: new THREE.Vector3() },
    screen: { value: new THREE.Vector4(0, 0, 0, 0) },
    baseY: { value: 0 },
    minOpacity: { value: 0.18 },
    flatMinOpacity: { value: 0.8 },
    flatFadeHeight: { value: 2.8 },
    depthPad: { value: 0.35 },
    groundPad: { value: 0.28 },
    minHeight: { value: 0.9 },
    columnRadius: { value: 0 },
    columnSoftness: { value: 1 },
  };
  tiles.registerPlugin({
    name: 'DAHILL_LOOK',
    processTileModel(scene) {
      scene.traverse(o => {
        if (!o.isMesh || o.isBatchedMesh) return;
        const src = o.material;
        const map = src && src.map ? src.map : null;
        if (map) { map.colorSpace = THREE.NoColorSpace; map.anisotropy = maxAniso; }   // sharp roads/roofs at grazing angles
        const m = new THREE.MeshBasicMaterial({ map, side: THREE.FrontSide });
        installTileCutawayDither(m, tiles.cutaway);   // shared uniforms → soft Drive cutaway without alpha sorting
        m.toneMapped = false;
        m.color.setScalar(tileGain.value);
        o.material = m;
        if (src && src !== m) src.dispose();   // free the orphaned GLTF MeshStandardMaterial (the map texture lives on in m)
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
