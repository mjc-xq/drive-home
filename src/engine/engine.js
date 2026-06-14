import * as THREE from 'three';
import { S, C, W, uvAt, terrainAt, SREC, GRID_ANG } from './data.js';
import { clamp } from './coords.js';
import { merge } from './geom.js';
import { buildWorld } from './world.js';
import { createAnimals, createCharacter, TOOLS, toolAfterScoop, POOP_ACTIVE_CAP } from './animals.js';
import { createCar, loadRealCar, loadParkedCar, loadDrivableCar, cycleVehicle, VEHICLES } from './car.js';
import { installDracoDecoder } from './draco-install.js';
import { createAudio } from './audio.js';
import aerialUrl from '../assets/aerial_opt.jpg';
import carGlbUrl from '../assets/ferrari.glb';
import rav4Url from '../assets/rav4.glb';
import siennaUrl from '../assets/sienna.glb';

// The whole game lives here, imperative three.js — React only renders the HUD.
// Communication: engine -> UI via emit(type, payload) for low-frequency state,
// and direct DOM writes through `ui` refs for per-frame values (mph, compass
// needle, thumbstick knob) so React isn't re-rendering at 60 fps.
export function createEngine({ canvas, ui, emit }) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const toast = (html, ms) => emit('toast', { html, ms: ms || 1800 });

  // ?lite : no shadows + 1x pixel ratio — for older phones and for headless
  //         verification, where software WebGL grinds at 1-5 fps otherwise.
  // ?nocar: skip the GLB swap (fast test loop; procedural car stays).
  const flags = new URLSearchParams(location.search);
  const LITE = flags.has('lite');
  // Phones: cap pixel ratio and lighten shadows. The shadow pass re-renders every
  // caster into the depth map each frame, so this is a real per-frame saving and
  // a defence against GPU-memory pressure on iOS Safari.
  const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  // Upgraded to three r184. The scene's colours and light intensities were all
  // hand-tuned under r128's un-managed, linear-output pipeline, so opt back out
  // of r152+ colour management and keep linear output to preserve that look;
  // the lights are re-scaled below for r155+ physically-correct units.
  THREE.ColorManagement.enabled = false;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LITE, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  // render at up to 2x even on phones (sharper edges/text; framebuffer cost is small
  // next to tile memory, which the lruCache caps separately). LITE stays at 1x.
  renderer.setPixelRatio(LITE ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = !LITE;
  renderer.shadowMap.type = MOBILE ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();   // sharp ground/roads at grazing angles
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc8d6da);
  scene.fog = new THREE.Fog(0xd2dcd6, 460, 1200);
  const camera = new THREE.PerspectiveCamera(46, 1, 0.6, 3000);

  // r155+ uses physically-correct light units; ×π restores the r128 legacy
  // brightness these intensities were tuned for.
  scene.add(new THREE.HemisphereLight(0xd8e8f6, 0xa39a85, 0.6 * Math.PI));
  const sun = new THREE.DirectionalLight(0xfff1d8, 0.95 * Math.PI);
  sun.position.set(-185, 240, 150);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);   // 2048 on mobile too: sharper car/keeper/animal shadows
  const sc2 = sun.shadow.camera;
  // tighter frustum (±170 vs ±300) ~= 3× the texel density where shadows actually
  // land (the scoop sanctuary + driveway); distant procedural shadows aren't missed.
  sc2.left = -170; sc2.right = 170; sc2.top = 170; sc2.bottom = -170; sc2.far = 900;
  sun.shadow.bias = -0.0009;
  scene.add(sun);

  const world = buildWorld(scene, renderer, { S, C, W, uvAt, terrainAt, SREC, GRID_ANG, aerialUrl });
  const { onRoad, house, bldBoxes, bldPolys, treePts, frontPt, frontDir, COMPOST, ring, interiorGroup, labelSprites, waterMat, staticGroup, aerialMat } = world;

  // "Clean patch" under the car (Drive): a flat disc of the REAL aerial imagery
  // that follows the car and fades into the 3D photoreal, masking the melty
  // photogrammetry right around the actor. uvAt is affine, so the aerial UV is
  // computed from world position in-shader — the disc just moves, no UV rebuild.
  let groundPatch = null;
  {
    const A = S.aerial;
    const uS = 1 / (A.E1 - A.E0), uO = (C[0] - A.E0) / (A.E1 - A.E0);
    const vS = -1 / (A.Nt - A.Nb), vO = (C[1] - A.Nb) / (A.Nt - A.Nb);
    const R = 24, geo = new THREE.CircleGeometry(R, 72); geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      // tiny camera-ward depth bias: the patch is co-planar with the photoreal
      // road (same sampled height), so this lets the flat win the road z-fight
      // while the much-taller trees/houses still draw in front of it.
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      uniforms: { map: { value: aerialMat.map }, uA: { value: new THREE.Vector4(uS, uO, vS, vO) }, rInv: { value: 1 / R } },
      vertexShader: `varying vec2 vW; varying float vR;
        void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xz; vR = length(position.xz);
          gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `uniform sampler2D map; uniform vec4 uA; uniform float rInv; varying vec2 vW; varying float vR;
        void main(){ vec2 uv = vec2(vW.x*uA.x + uA.y, vW.y*uA.z + uA.w);
          float a = 1.0 - smoothstep(0.4, 0.96, vR * rInv);
          vec3 c = texture2D(map, uv).rgb;
          c = (c - 0.5) * 1.12 + 0.5; c *= 0.9;        // nudge toward the darker, contrastier Google tiles
          gl_FragColor = vec4(c, a); }`
    });
    groundPatch = new THREE.Mesh(geo, mat);
    groundPatch.renderOrder = 3; groundPatch.visible = false; groundPatch.frustumCulled = false;
    scene.add(groundPatch);
  }

  // Parked cars live in their own group (NOT staticGroup) so they stay visible
  // over the photoreal world — Drew walks up to one in Scoop to start driving.
  const carsGroup = new THREE.Group(); scene.add(carsGroup);
  const parkedSpots = [];

  // Always-visible marker pin above the keeper (Scoop) — drawn on top of the
  // photoreal so Drew is never lost behind a real tree blob.
  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 4),
    new THREE.MeshBasicMaterial({ color: 0xffc21e, depthTest: false, transparent: true, opacity: 0.95 }));
  marker.rotation.x = Math.PI; marker.renderOrder = 20; marker.visible = false; marker.frustumCulled = false;
  scene.add(marker);
  // draw-to-drive target ring (Top-down view)
  const navMarker = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.7, 28),
    new THREE.MeshBasicMaterial({ color: 0xd94f1e, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  navMarker.rotation.x = -Math.PI / 2; navMarker.renderOrder = 19; navMarker.visible = false; navMarker.frustumCulled = false;
  scene.add(navMarker);
  // Scoop walk-to-drive cue: a tall poppy pin that floats high over the nearest
  // parked car (drawn through walls) so the keeper can find it from the backyard.
  const carMarker = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.7, 4),
    new THREE.MeshBasicMaterial({ color: 0xd94f1e, depthTest: false, transparent: true, opacity: 0.92 }));
  carMarker.rotation.x = Math.PI; carMarker.renderOrder = 20; carMarker.visible = false; carMarker.frustumCulled = false;
  scene.add(carMarker);

  // Scoop renders the procedural world, so Drew collides with every visible
  // procedural tree (they sit along the streets, clear of the backyard sanctuary).
  // sancCx/sancCz mark the backyard centre (behind the house toward the creek).
  const sancCx = -16, sancCz = -10;
  const SCOOP_CLEAR_R = 25;
  const scoopTrees = treePts;

  // The scoop backyard: a disc of the REAL procedural ground — true topology
  // (terrainAt heights) + the aerial photo (uvAt on the shared terrain material),
  // not a flat green pad. The photoreal neighborhood streams beyond it.
  let scoopGrass = null;
  {
    const R = SCOOP_CLEAR_R + 4, rings = 24, segs = 60, pos = [], uv = [], idx = [];
    const addV = (x, z) => { pos.push(x, terrainAt(x, z) + 0.05, z); const t = uvAt(x, z); uv.push(t[0], t[1]); };
    addV(sancCx, sancCz);                                   // vertex 0 = centre
    for (let r = 1; r <= rings; r++) {
      const rad = R * r / rings;
      for (let s = 0; s <= segs; s++) { const a = s / segs * Math.PI * 2; addV(sancCx + Math.cos(a) * rad, sancCz + Math.sin(a) * rad); }
    }
    const rowStart = r => 1 + (r - 1) * (segs + 1);
    for (let s = 0; s < segs; s++) idx.push(0, rowStart(1) + s + 1, rowStart(1) + s);
    for (let r = 1; r < rings; r++) {
      const a = rowStart(r), b = rowStart(r + 1);
      for (let s = 0; s < segs; s++) { idx.push(a + s, b + s, a + s + 1); idx.push(a + s + 1, b + s, b + s + 1); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    // lit aerial terrain material (matches the procedural ground) + a radial alpha
    // fade at the rim so the yard blends into the photoreal neighborhood beyond.
    const yardMat = aerialMat.clone();
    yardMat.transparent = true; yardMat.depthWrite = false;
    yardMat.onBeforeCompile = sh => {
      sh.uniforms.uYC = { value: new THREE.Vector2(sancCx, sancCz) };
      sh.uniforms.uYR = { value: R };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPy;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPy = (modelMatrix * vec4(transformed,1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPy; uniform vec2 uYC; uniform float uYR;')
        .replace('#include <dithering_fragment>', 'gl_FragColor.a *= 1.0 - smoothstep(uYR * 0.72, uYR * 0.98, distance(vWPy.xz, uYC));\n#include <dithering_fragment>');
    };
    yardMat.customProgramCacheKey = () => 'scoopYard';
    scoopGrass = new THREE.Mesh(geo, yardMat);
    scoopGrass.renderOrder = 2; scoopGrass.visible = false; scoopGrass.frustumCulled = false;
    scoopGrass.receiveShadow = true;
    scene.add(scoopGrass);
  }

  // Wood fence ring marking the backyard property line (procedural, Scoop only).
  let scoopFence = null;
  {
    const parts = [], woodC = new THREE.Color(0x8a6f49), railC = new THREE.Color(0x9c8259);
    const Rf = SCOOP_CLEAR_R, Np = 60;
    for (let i = 0; i < Np; i++) {
      const a0 = i / Np * Math.PI * 2, a1 = (i + 1) / Np * Math.PI * 2;
      const x0 = sancCx + Math.cos(a0) * Rf, z0 = sancCz + Math.sin(a0) * Rf;
      const x1 = sancCx + Math.cos(a1) * Rf, z1 = sancCz + Math.sin(a1) * Rf;
      const py = terrainAt(x0, z0);
      const post = new THREE.BoxGeometry(0.13, 1.15, 0.13).toNonIndexed(); post.translate(x0, py + 0.57, z0);
      parts.push({ g: post, color: woodC });
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, len = Math.hypot(x1 - x0, z1 - z0), yaw = Math.atan2(x1 - x0, z1 - z0), my = terrainAt(mx, mz);
      for (const ry of [0.42, 0.9]) {
        const rail = new THREE.BoxGeometry(0.05, 0.09, len * 1.04).toNonIndexed();
        rail.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw)); rail.translate(mx, my + ry, mz);
        parts.push({ g: rail, color: railC });
      }
    }
    scoopFence = new THREE.Mesh(merge(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .85 }));
    scoopFence.castShadow = true; scoopFence.visible = false; scoopFence.frustumCulled = false;
    scene.add(scoopFence);
  }
  // Building collision for Scoop. The sanctuary structures (barn/shed/coop) and
  // the house are all rendered procedurally in Scoop now, so Drew should bump
  // them. insideScoopBuilding tests the tight footprint polygon (not the oversized
  // AABB), so keeping every building can't wall off the open lawn.
  const scoopBldPolys = bldPolys;
  function insideScoopBuilding(x, z) {
    for (const b of scoopBldPolys) {
      const bb = b.bb;
      if (x < bb[0] || x > bb[1] || z < bb[2] || z > bb[3]) continue;
      const p = b.p; let inside = false;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const xi = p[i][0], zi = p[i][1], xj = p[j][0], zj = p[j][1];
        if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  // ---------- photoreal Google 3D Tiles (default; ?flat disables) ----------
  // Streams the real, textured neighborhood — every house, fence, tree — and
  // hides the procedural staticGroup once tiles arrive. The procedural world
  // stays the collision + fallback (offline / no key / load failure). Geo:
  // anchor the tileset to the house centroid's lat/lon (origin of the local
  // frame). LAT0/LON0 = the geocode origin; C is the house centroid (orig E/N).
  let p3dtiles = null;
  const DEG = Math.PI / 180;
  // live-tunable photoreal placement (window.__dahill.p3dt; call nudge()).
  // yOffset lifts the photoreal ground to the procedural terrain height; xOffset/
  // zOffset + spin (deg) translate/rotate the photoreal world about the house so
  // it matches the procedural frame (spawns + collision). Spin pivots on origin.
  const P3DT = { yOffset: 32, xOffset: 0, zOffset: 0, spin: 0 };
  const applyP3DT = () => {
    if (!p3dtiles || !p3dtiles.holder) return;
    const h = p3dtiles.holder;
    h.rotation.y = P3DT.spin * DEG;
    h.position.set(P3DT.xOffset, P3DT.yOffset, P3DT.zOffset);
  };
  // ---- ground height authority ----
  // groundAt(x,z) = the photoreal tile surface height under (x,z), via a cheap
  // firstHitOnly down-ray; falls back to the procedural terrain until tiles load.
  // This REPLACES terrainAt for ACTOR + CAMERA height only — collision stays on
  // the data (bldPolys/treePts), so the invariant is untouched.
  const _downRay = new THREE.Raycaster(); _downRay.firstHitOnly = true;
  const _gO = new THREE.Vector3(), _gD = new THREE.Vector3(0, -1, 0), _gHits = [];
  function rawTileY(x, z, fromY) {
    if (!p3dtiles || !p3dtiles.holder.visible) return null;
    // Cast from `fromY` (default high). Casting from just above an actor skips
    // tree canopies / eaves overhead, so we read the ROAD under them, not the
    // canopy — that's what keeps the car from climbing trees.
    const oy = fromY != null ? fromY : 600;
    _downRay.set(_gO.set(x, oy, z), _gD); _downRay.far = oy + 700; _gHits.length = 0;
    p3dtiles.raycast(_downRay, _gHits);
    return _gHits.length ? _gHits[0].point.y : null;
  }
  function groundAt(x, z, fallback, fromY) {
    const y = rawTileY(x, z, fromY);
    if (y != null) return y;
    return fallback != null ? fallback : terrainAt(x, z);
  }
  // Height the actor (car/keeper) AND its clean patch ride: the REAL photoreal
  // ROAD surface, sampled by casting down from just above the actor so it skips
  // tree canopies, and clamped to within ~2 m of the procedural terrain so a
  // photogrammetry blob can never lift the actor off the ground topology. This
  // keeps the flat patch co-planar with the 3D road (so the patch reads as the
  // road surface, not a layer the 3D rises over) while never climbing trees.
  function actorGroundY(x, z, prevY) {
    const tA = terrainAt(x, z);
    if (!p3dtiles || !p3dtiles.holder.visible) return tA;
    const y = rawTileY(x, z, (prevY != null ? prevY : tA) + 3);   // first surface below the actor = road
    if (y == null) return prevY != null ? prevY : tA;             // tile not streamed yet: hold height
    // Far from the procedural neighborhood the terrain grid (±340 m) is just a
    // clamped edge value, so don't tie the car to it — ride the real photoreal
    // road directly. Inside the neighborhood, clamp to topology so the car can
    // never climb a photogrammetry tree.
    if (x * x + z * z > 330 * 330) return y;
    return clamp(y, tA - 2, tA + 2);
  }
  // One-shot vertical align: sample a ring of down-rays in the open yard/street
  // (radius 14 m, away from the house roof), take the median tile height, and
  // set yOffset so it meets terrainAt(0,0). Clamped + single-shot so it can't
  // run away accumulating.
  let alignDone = false;
  function alignP3DT() {
    if (alignDone || !p3dtiles || !p3dtiles.holder) return false;
    const ys = [];
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      const y = rawTileY(Math.cos(a) * 14, Math.sin(a) * 14);
      if (y != null) ys.push(y);
    }
    if (ys.length < 8) return false;          // wait until enough clean samples
    ys.sort((a, b) => a - b);
    const adjust = terrainAt(0, 0) - ys[ys.length >> 1];
    if (Math.abs(adjust) > 18) return false;  // garbage (rays hit roofs/voids/coarse tiles) — retry
    P3DT.yOffset = clamp(P3DT.yOffset + adjust, 8, 56);
    applyP3DT();
    alignDone = true;
    return true;
  }
  // Photoreal is the AERIAL view ONLY: render tiles in Explore; show the clean
  // built (procedural) world at ground level (Drive/Scoop). The groundAt + camera
  // tile probes gate on holder.visible, so ground actors ride smooth terrainAt
  // and never climb the bumpy photogrammetry mesh.
  let tilesReady = false;
  // Photoreal Google tiles are the AERIAL + Drive backdrop only. Scoop plays in
  // the clean procedural world (the real house, the pig barn / iguana shed / duck
  // coop, the compost bin, trees, and the aerial-photo terrain) — Google
  // photogrammetry is unusably melty at a keeper's eye level, so we don't render
  // it in Scoop. This also means no tile-flattening hacks (which used to pancake
  // the house) and pristine tiles in Explore/Drive.
  const photoModes = mode => mode === 'explore' || mode === 'drive';
  function applyModeVisuals() {
    const photoOn = photoModes(mode) && p3dtiles && tilesReady;
    if (p3dtiles) p3dtiles.holder.visible = photoModes(mode);
    staticGroup.visible = mode === 'scoop' || !photoOn;   // procedural in Scoop, or as the no-tiles fallback
    carsGroup.visible = mode === 'drive' || mode === 'scoop';   // parked cars: ground modes only
    if (ring) ring.visible = mode === 'explore';   // marker only makes sense from the air
  }
  if (!flags.has('flat')) {
    const LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * DEG);
    const houseLat = (LAT0 + C[1] / 110540) * DEG;
    const houseLon = (LON0 + C[0] / (COSLAT * 111320)) * DEG;
    import('./tiles3d.js').then(({ createPhotorealTiles }) => {
      p3dtiles = createPhotorealTiles(scene, camera, renderer, {
        // raise errorTarget on phones (coarser tiles) — leaf-tile geometry/texture
        // is the dominant iOS memory cost, and Drive can now roam far and stream more.
        lat: houseLat, lon: houseLon, azimuth: Math.PI, errorTarget: MOBILE ? 16 : 10
      });
      if (!p3dtiles) return;
      applyP3DT();
      let tries = 0;
      p3dtiles.addEventListener('load-model', () => {
        if (!tilesReady) { tilesReady = true; emit('photoreal', true); }
        // Vertically align the photoreal ground to the procedural terrain as the
        // street tiles stream (Explore/Drive only — Scoop never shows tiles).
        if (tries < 24) { tries++; alignP3DT(); }
        applyModeVisuals();          // hide procedural once tiles are up (Explore/Drive)
      });
      // surface auth/quota/referrer failures instead of silently falling back to
      // the procedural world (a baked, referrer-blocked or over-quota key 403s here).
      let warnedErr = false;
      p3dtiles.addEventListener('load-error', e => {
        if (warnedErr) return; warnedErr = true;
        console.warn('[tiles3d] tile load error (check VITE_GOOGLE_MAPS_KEY restrictions/quota)', e && e.error);
        if (!tilesReady) toast('Photoreal map unavailable — showing the built world', 2600);
      });
    }).catch(e => console.warn('[tiles3d] import failed; staying procedural', e));
  }

  // ?debug: tall coloured poles at the procedural reference points (in the scene,
  // not staticGroup, so they show over photoreal) to eyeball alignment.
  if (flags.has('debug')) {
    const pole = (x, z, color) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 80, 8),
        new THREE.MeshBasicMaterial({ color }));
      m.position.set(x, 40, z); scene.add(m);
    };
    pole(house.c[0], house.c[1], 0xff0000);                       // house = red
    if (frontPt) pole(frontPt[0], frontPt[1], 0x00ff00);          // car spawn = green
    pole(SREC.pen[0], SREC.pen[1], 0xff00ff);                     // pigs/pen = magenta
    pole(SREC.coop[0], SREC.coop[1], 0x00ffff);                   // ducks/coop = cyan
    pole(SREC.shed[0], SREC.shed[1], 0xff8800);                   // iguana/shed = orange
  }

  // Car-vs-building test: a point is solid only when it's inside an actual
  // footprint polygon (AABB prefilter keeps it cheap). This is what lets the
  // car drive off-road, across intersections and between houses freely.
  function insideBuilding(x, z) {
    for (const b of bldPolys) {
      const bb = b.bb;
      if (x < bb[0] || x > bb[1] || z < bb[2] || z > bb[3]) continue;
      const p = b.p; let inside = false;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const xi = p[i][0], zi = p[i][1], xj = p[j][0], zj = p[j][1];
        if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  const audio = createAudio();

  let scoopHudDirty = false;
  const animals = createAnimals(scene, { terrainAt, SREC, bldBoxes, onPoopChange: () => { scoopHudDirty = true; } });
  const { ANIMALS, POOPS, updateAnimals, removePoop } = animals;
  const CHAR = createCharacter(scene, SREC);
  const cleanPct = () => Math.max(0, Math.round(100 * (1 - POOPS.length / POOP_ACTIVE_CAP)));

  let disposed = false;
  const car = createCar(scene);
  let cancelCarLoad = null;
  if (!flags.has('nocar')) {
    installDracoDecoder();
    cancelCarLoad = loadRealCar(car, carGlbUrl, () => { if (!disposed) toast('Using fallback car model'); });
    // RAV4 + Sienna join the Ferrari as swappable driven vehicles (🚗 button).
    loadDrivableCar(car, siennaUrl, 0, { length: 5.1, flip: false, black: false, meta: VEHICLES[0] }); // minivan = default (slot 0)
    loadDrivableCar(car, rav4Url, 1, { length: 4.6, flip: true, black: false, meta: VEHICLES[1] });    // RAV4 GLB nose runs -Z
  }
  // Two black Toyotas parked in the driveway (part of the clean ground world;
  // staticGroup, so they show at ground level, not over the photoreal aerial).
  if (frontPt && !flags.has('nocar')) {
    const ux = house.c[0] - frontPt[0], uz = house.c[1] - frontPt[1];
    const ul = Math.hypot(ux, uz) || 1, u = [ux / ul, uz / ul], perp = [-u[1], u[0]];
    const carYaw = Math.atan2(-u[0], -u[1]);            // nose toward the street
    const park = (url, side, len, flip, black = true) => {
      const cx = frontPt[0] + u[0] * 7 + perp[0] * side * 2.4;
      const cz = frontPt[1] + u[1] * 7 + perp[1] * side * 2.4;
      parkedSpots.push({ x: cx, z: cz });          // walk-to-drive targets
      // add the footprint collider only once the car actually loads, so a failed
      // load doesn't leave an invisible wall the driven car bounces off.
      loadParkedCar(carsGroup, url, { x: cx, z: cz, y: terrainAt(cx, cz), yaw: carYaw, length: len, black, flip }, () => {
        const hl = len / 2, hw = 1.05;
        bldPolys.push({ p: [[cx - hl, cz - hw], [cx + hl, cz - hw], [cx + hl, cz + hw], [cx - hl, cz + hw]], bb: [cx - hl, cx + hl, cz - hw, cz + hw] });
      });
    };
    park(rav4Url, 1, 4.6, false, false);  // RAV4 nose runs +Z → carYaw already faces it; black baked in (keeps taillights)
    park(siennaUrl, -1, 5.1, false, false);   // GLB nose runs -Z; black baked in (keeps taillights)
  }
  let showT = 0;

  function showCarCard() {
    const v = car.models[car.modelIdx];
    const meta = v && v.name ? v : VEHICLES[0];     // fallback card while no GLB has loaded yet
    emit('carCard', { name: meta.name, spec: meta.spec, credit: meta.credit || '' });
  }
  function cycleCar() {
    if (!cycleVehicle(car)) { toast('Only one vehicle loaded'); return; }
    showCarCard();
    audio.blip();
  }

  // (Street-view photo billboards removed — they read as odd roadside signs.
  //  Real street imagery now lives on the buildings: photoreal Google 3D Tiles
  //  when enabled, the procedural facade texture otherwise.)

  // "Look inside" (dollhouse) removed — keep the procedural interior hidden.
  interiorGroup.visible = false;
  const setInside = () => {}; // no-op stub for the remaining callers

  // ---------- controls (explore) ----------
  const ctl = {
    tx: house.c[0], ty: house.baseY + 5, tz: house.c[1], az: 0.85, po: 0.72, r: 330,
    gtx: house.c[0], gty: house.baseY + 5, gtz: house.c[1], gaz: 0.45, gpo: 0.92, gr: 185
  };
  if (reduceMotion) { ctl.az = 0.45; ctl.po = 0.92; ctl.r = 185; }
  function applyCam() {
    camera.position.set(
      ctl.tx + ctl.r * Math.sin(ctl.po) * Math.sin(ctl.az),
      ctl.ty + ctl.r * Math.cos(ctl.po),
      ctl.tz + ctl.r * Math.sin(ctl.po) * Math.cos(ctl.az));
    camera.lookAt(ctl.tx, ctl.ty, ctl.tz);
  }

  let mode = 'explore';
  const setMode = m => {
    mode = m;
    // Scoop plays at ground level where the photoreal horizon turns to melt; pull
    // the fog in close (haze color = background) so the distant photogrammetry
    // dissolves softly instead of reading as a melty wall — the play area within
    // ~35 m stays crisp. Other modes keep the far aerial fog.
    if (scene.fog) {
      if (m === 'scoop') { scene.fog.near = 38; scene.fog.far = 92; }
      else { scene.fog.near = 460; scene.fog.far = 1200; }
    }
    emit('mode', m); applyModeVisuals();
  };
  const ptrs = new Map(); let lastPinch = 0, lastMid = null, moved = 0;
  const lookPtrs = new Map();
  const camOrbit = { yaw: 0, pitch: 0, t: 0 };
  let movePtr = null, joyBX = 0, joyBY = 0, pinchD = 0, czoom = 1, szoom = 1;
  // Roblox-style controls: shared look/zoom feel across drive+scoop, a steering
  // stick + gas/brake pedals for touch driving, shift-lock for the keeper, and
  // flick momentum in explore. inp2 mixes stick (j*), keyboard (k*) and the
  // dedicated touch driving inputs (steer/gas/brake).
  const LOOK_SENS = 0.0046, PITCH_SENS = 0.003, ZOOM_RATE = 0.0011, MOVE_DEADZONE = 0.12;
  const inp2 = { jx: 0, jy: 0, kx: 0, ky: 0, steer: 0, gas: 0, brake: 0, navActive: false, navX: 0, navZ: 0 };
  let camYawS = 0, scPitch = 0.34, bagWarned = false, spotless = false, nearCar = false;
  // Experimental "draw to drive": in the Top-down view, a drag projects the finger
  // onto the ground and the car steers toward it + auto-throttles, so you trace its
  // path with one finger. (Joystick/keyboard still drive the other camera views.)
  let navPtr = null;
  const _navRay = new THREE.Raycaster(), _navNDC = new THREE.Vector2();
  const _navPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _navHit = new THREE.Vector3();
  const driveTopDown = () => mode === 'drive' && DRIVE_CAMS[camMode] && DRIVE_CAMS[camMode].topdown;
  function setNavFromPointer(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    _navNDC.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    _navRay.setFromCamera(_navNDC, camera);
    _navPlane.constant = -(car && car.groundY != null ? car.groundY : 0);   // ground plane at the car's height
    if (_navRay.ray.intersectPlane(_navPlane, _navHit)) { inp2.navX = _navHit.x; inp2.navZ = _navHit.z; inp2.navActive = true; }
  }
  let lastLookT = -1e9;   // last manual look-drag time (ms); suppresses scoop follow-cam briefly
  let shiftLock = false, moveMag = 0, azVel = 0, poVel = 0;

  function hideJoy() {
    movePtr = null; inp2.jx = 0; inp2.jy = 0;
    if (ui.joy) ui.joy.style.display = 'none';
  }

  function onPointerDown(e) {
    if (mode !== 'explore') {
      canvas.setPointerCapture(e.pointerId);
      // Top-down "draw to drive": any drag steers the car to the finger.
      if (driveTopDown()) { navPtr = e.pointerId; showT = 0; setNavFromPointer(e.clientX, e.clientY); return; }
      const VW = canvas.clientWidth || innerWidth, VH = canvas.clientHeight || innerHeight;
      // Roblox convention: a press in the lower-left region SPAWNS the
      // thumbstick under the thumb; everything else is camera look.
      if (movePtr === null && e.clientX < VW * 0.46 && e.clientY > VH * 0.30) {
        movePtr = e.pointerId; joyBX = e.clientX; joyBY = e.clientY;
        if (ui.joy) {
          ui.joy.style.display = 'block';
          ui.joy.style.left = (e.clientX - 61) + 'px'; ui.joy.style.top = (e.clientY - 61) + 'px';
        }
        if (ui.knob) ui.knob.style.transform = 'translate(-50%,-50%)';
      } else {
        lookPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (lookPtrs.size === 2) {
          const a = [...lookPtrs.values()];
          pinchD = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        }
      }
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, b: e.button }); moved = 0;
    azVel = poVel = 0;
    canvas.classList.add('dragging');
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      lastPinch = Math.hypot(a.x - b.x, a.y - b.y); lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }

  function onPointerMove(e) {
    if (mode !== 'explore') {
      if (e.pointerId === navPtr) { setNavFromPointer(e.clientX, e.clientY); return; }   // draw-to-drive
      if (e.pointerId === movePtr) {
        let dx = e.clientX - joyBX, dy = e.clientY - joyBY;
        const d = Math.hypot(dx, dy), mx = 46;
        if (d > mx) { dx *= mx / d; dy *= mx / d; }
        inp2.jx = dx / mx; inp2.jy = dy / mx;
        if (ui.knob) ui.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        if (Math.hypot(inp2.jx, inp2.jy) > 0.25) showT = 0;
        return;
      }
      const lp = lookPtrs.get(e.pointerId);
      if (!lp) return;
      const ox = lp.x, oy = lp.y;
      lp.x = e.clientX; lp.y = e.clientY;
      if (lookPtrs.size === 2) {
        const a = [...lookPtrs.values()];
        const nd = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (pinchD > 0 && nd > 0) {
          const f = pinchD / nd;
          if (mode === 'drive') czoom = clamp(czoom * f, 0.55, 2.1);
          else szoom = clamp(szoom * f, 0.55, 2.0);
        }
        pinchD = nd;
        return;
      }
      const dx = e.clientX - ox, dy = e.clientY - oy;
      if (Math.abs(dx) + Math.abs(dy) < 2) return; // look deadzone (kill jitter)
      if (mode === 'drive') {
        camOrbit.yaw -= dx * LOOK_SENS;
        camOrbit.pitch = clamp(camOrbit.pitch + dy * PITCH_SENS, -0.45, 0.8);
        camOrbit.t = performance.now();
        showT = 0;
      } else {
        camYawS -= dx * LOOK_SENS;
        scPitch = clamp(scPitch + dy * PITCH_SENS, -0.3, 0.8);
        lastLookT = performance.now();   // pause follow-cam while the player looks
      }
      return;
    }
    if (!ptrs.has(e.pointerId)) return;
    const p = ptrs.get(e.pointerId);
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    moved += Math.abs(dx) + Math.abs(dy);
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 1) {
      if (p.b === 2 || e.shiftKey) pan(dx, dy);
      else {
        ctl.gaz -= dx * 0.0052; ctl.gpo = clamp(ctl.gpo - dy * 0.0042, 0.14, 1.46);
        azVel = -dx * 0.0052; poVel = -dy * 0.0042; // for flick momentum on release
      }
    } else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const pinch = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (lastPinch) ctl.gr = clamp(ctl.gr * lastPinch / pinch, 14, 640);
      if (lastMid) pan(mid.x - lastMid.x, mid.y - lastMid.y);
      lastPinch = pinch; lastMid = mid;
    }
  }

  function onPointerEnd(e) {
    if (e.pointerId === navPtr) { navPtr = null; inp2.navActive = false; }   // release draw-to-drive: car coasts
    if (e.pointerId === movePtr) hideJoy();
    lookPtrs.delete(e.pointerId);
    if (lookPtrs.size < 2) pinchD = 0;
    ptrs.delete(e.pointerId); lastPinch = 0; lastMid = null;
    if (!ptrs.size) canvas.classList.remove('dragging');
  }

  function onWheel(e) {
    e.preventDefault();
    if (mode === 'explore') ctl.gr = clamp(ctl.gr * Math.exp(e.deltaY * ZOOM_RATE), 14, 640);
    else if (mode === 'drive') czoom = clamp(czoom * Math.exp(e.deltaY * ZOOM_RATE), 0.55, 2.1);
    else if (mode === 'scoop') szoom = clamp(szoom * Math.exp(e.deltaY * ZOOM_RATE), 0.55, 2.0);
  }

  function onContextMenu(e) { e.preventDefault(); }

  function onDblClick() {
    if (mode === 'explore') { ctl.gtx = house.c[0]; ctl.gtz = house.c[1]; ctl.gr = 160; ctl.gpo = 0.95; }
  }

  function pan(dx, dy) {
    const s = ctl.r * 0.0013;
    const rx = Math.cos(ctl.az), rz = -Math.sin(ctl.az);
    const fx = -Math.sin(ctl.az), fz = -Math.cos(ctl.az);
    ctl.gtx = clamp(ctl.gtx - rx * dx * s + fx * dy * s, -310, 310);
    ctl.gtz = clamp(ctl.gtz - rz * dx * s + fz * dy * s, -310, 310);
    ctl.gty = terrainAt(ctl.gtx, ctl.gtz) + 3;
  }

  function focusHouse(close) {
    ctl.gtx = house.c[0]; ctl.gtz = house.c[1]; ctl.gty = house.baseY + 3.5;
    ctl.gr = close ? 48 : 120; ctl.gpo = close ? 0.78 : 0.95;
  }

  // ---------- keyboard ----------
  function onKeyDown(e) {
    if (mode === 'drive' || mode === 'scoop') {
      if (mode === 'scoop' && e.key === 'Shift' && !e.repeat) {
        shiftLock = !shiftLock; emit('shiftLock', shiftLock);
        toast(shiftLock ? 'Shift-lock ON 🔒' : 'Shift-lock off', 900); e.preventDefault(); return;
      }
      if (mode === 'scoop' && (e.key === 'e' || e.key === 'E') && nearCar) { driveFromScoop(); e.preventDefault(); return; }
      const dk = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'Escape'];
      if (dk.indexOf(e.key) < 0) return;
      if (e.key === 'ArrowUp' || e.key === 'w') inp2.ky = -1;
      if (e.key === 'ArrowDown' || e.key === 's') inp2.ky = 1;
      if (e.key === 'ArrowLeft' || e.key === 'a') inp2.kx = -1;
      if (e.key === 'ArrowRight' || e.key === 'd') inp2.kx = 1;
      if (e.key === 'Escape') (mode === 'drive' ? exitDrive : exitScoop)();
      e.preventDefault(); return;
    }
    const step = 0.12;
    if (e.key === 'ArrowLeft') ctl.gaz += step;
    else if (e.key === 'ArrowRight') ctl.gaz -= step;
    else if (e.key === 'ArrowUp') ctl.gpo = clamp(ctl.gpo - step, 0.14, 1.46);
    else if (e.key === 'ArrowDown') ctl.gpo = clamp(ctl.gpo + step, 0.14, 1.46);
    else if (e.key === '+' || e.key === '=') ctl.gr = clamp(ctl.gr * 0.85, 14, 640);
    else if (e.key === '-') ctl.gr = clamp(ctl.gr * 1.18, 14, 640);
    else if (e.key === 'Enter') focusHouse(true);
    else return;
    e.preventDefault();
  }
  function onKeyUp(e) {
    if (mode === 'explore') return;
    if (e.key === 'ArrowUp' || e.key === 'w') inp2.ky = 0;
    if (e.key === 'ArrowDown' || e.key === 's') inp2.ky = 0;
    if (e.key === 'ArrowLeft' || e.key === 'a') inp2.kx = 0;
    if (e.key === 'ArrowRight' || e.key === 'd') inp2.kx = 0;
  }

  // ---------- scoop mode ----------
  function pushScoopHud() {
    emit('scoopHud', {
      lvl: CHAR.lvl, name: TOOLS[CHAR.lvl].name, bag: CHAR.bag,
      cap: TOOLS[CHAR.lvl].cap, total: CHAR.total, clean: cleanPct()
    });
  }
  function setTool(lvl) {
    CHAR.lvl = lvl;
    // voxel scoop props only show on the fallback keeper; Drew has no held tool
    for (let i = 0; i < 3; i++) if (CHAR.scoops[i]) CHAR.scoops[i].visible = !CHAR.drew && i === lvl;
    pushScoopHud();
  }
  function enterScoop() {
    setMode('scoop'); camInit = false; camGroundRef = null; CHAR.groundY = null;
    setInside(false);
    for (const s of labelSprites) s.visible = false;
    CHAR.group.visible = true;
    // Spawn out in the OPEN sanctuary (between the coop and the pen), away from
    // the house, patio and driveway cars so the camera opens onto the play area
    // and animals, not flat house walls.
    CHAR.x = (SREC.coop[0] + SREC.pen[0]) / 2; CHAR.z = (SREC.coop[1] + SREC.pen[1]) / 2;
    CHAR.yaw = Math.atan2(SREC.barn[0] - CHAR.x, SREC.barn[1] - CHAR.z);
    camYawS = CHAR.yaw;
    audio.ensure();
    setTool(CHAR.lvl);
    toast('Scoop the sanctuary poop! 💩<br><small>Empty at the green compost bin · the 📍 pin marks a car you can drive</small>', 3200);
  }
  function exitScoop() {
    setMode('explore');
    camera.up.set(0, 1, 0);                 // symmetry with exitDrive; never leak a tilted up-vector
    if (groundPatch) groundPatch.visible = false;
    if (scoopGrass) scoopGrass.visible = false;
    if (scoopFence) scoopFence.visible = false;
    marker.visible = false; carMarker.visible = false;
    if (nearCar) { nearCar = false; emit('nearCar', false); }
    hideJoy();
    for (const s of labelSprites) s.visible = true;
    CHAR.group.visible = false;
    inp2.jx = inp2.jy = inp2.kx = inp2.ky = 0;
    ctl.gtx = clamp(CHAR.x, -310, 310); ctl.gtz = clamp(CHAR.z, -310, 310);
    ctl.gty = terrainAt(ctl.gtx, ctl.gtz) + 3; ctl.gr = 60; ctl.gpo = 0.85;
    ctl.tx = ctl.gtx; ctl.tz = ctl.gtz;
  }

  function updateScoop(dt, now) {
    let jx = clamp(inp2.jx + inp2.kx, -1, 1), jy = clamp(inp2.jy + inp2.ky, -1, 1);
    const mag = Math.min(1, Math.hypot(jx, jy));
    if (shiftLock) CHAR.yaw = camYawS; // Roblox shift-lock: keeper faces the camera
    if (mag > MOVE_DEADZONE) {
      // camera sits at CHAR - f*dist looking along +f, so screen-right is
      // (-cos, +sin); the old (+cos, -sin) strafe was mirrored left/right
      const fX = Math.sin(camYawS), fZ = Math.cos(camYawS);
      const rX = -Math.cos(camYawS), rZ = Math.sin(camYawS);
      let mx = rX * jx - fX * jy, mz = rZ * jx - fZ * jy;
      const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
      if (!shiftLock) CHAR.yaw = Math.atan2(mx, mz); // else keep facing camera, strafe
      // Roblox-style follow cam: gently trail the camera behind the avatar's
      // heading so the LEFT stick leads and the camera follows — instead of the
      // look-drag defining where "forward" is (the user's "camera also controls
      // direction" complaint). A manual right-side look pauses this for ~1s.
      if (!shiftLock && now - lastLookT > 1000) {
        let dyaw = CHAR.yaw - camYawS;
        while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
        while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
        camYawS += dyaw * Math.min(1, dt * 2.2);
      }
      const sp = 4.4 * mag;
      let nx = CHAR.x + mx * sp * dt, nz = CHAR.z + mz * sp * dt;
      const rad = 0.42;
      // collide against real building/structure footprints (not the oversized
      // AABBs) and slide along the wall — otherwise the house's AABB walls off
      // half the open lawn around the keeper's spawn.
      if (insideScoopBuilding(nx, nz)) {
        if (!insideScoopBuilding(nx, CHAR.z)) nz = CHAR.z;
        else if (!insideScoopBuilding(CHAR.x, nz)) nx = CHAR.x;
        else { nx = CHAR.x; nz = CHAR.z; }
      }
      for (const t of scoopTrees) {
        const dx = nx - t[0], dz = nz - t[1], d2 = dx * dx + dz * dz, rr = 0.55 + rad;
        if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2); nx = t[0] + dx / d * rr; nz = t[1] + dz / d * rr; }
      }
      for (const a of ANIMALS) {
        const dx = nx - a.x, dz = nz - a.z, d2 = dx * dx + dz * dz, rr = a.r + rad;
        if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2); nx = a.x + dx / d * rr; nz = a.z + dz / d * rr; }
      }
      if (Math.hypot(nx, nz) > 314) { const d = Math.hypot(nx, nz); nx *= 314 / d; nz *= 314 / d; }
      CHAR.x = nx; CHAR.z = nz;
      CHAR.bob += dt * 10 * mag;
    } else CHAR.bob += dt * 1.5;
    // Stand on the procedural yard ground (terrain) — reliable, never sinks into
    // the photoreal. The grass lawn + the actor are both at this height.
    const cy = terrainAt(CHAR.x, CHAR.z);
    CHAR.group.position.set(CHAR.x, cy + (CHAR.drew ? 0 : Math.abs(Math.sin(CHAR.bob)) * 0.05), CHAR.z);
    CHAR.group.rotation.y = CHAR.yaw - Math.PI / 2;
    if (CHAR.drew) { CHAR.drew.locomotion(mag > MOVE_DEADZONE ? 4.4 * mag : 0); CHAR.drew.tick(dt); }
    // always-on-top marker so Drew is never lost behind a real tree
    marker.visible = true;
    marker.position.set(CHAR.x, cy + 2.6 + Math.abs(Math.sin(now * 0.004)) * 0.22, CHAR.z);
    marker.rotation.y = now * 0.003;
    // scooping
    const tool = TOOLS[CHAR.lvl];
    for (let i = POOPS.length - 1; i >= 0; i--) {
      const p = POOPS[i];
      if (Math.hypot(CHAR.x - p.x, CHAR.z - p.z) < tool.r) {
        if (CHAR.bag >= tool.cap) {
          if (!bagWarned) { toast('Scoop is full! Empty it at the green bin ♻️'); bagWarned = true; }
          break;
        }
        removePoop(p); CHAR.bag++; CHAR.total++; audio.sfxScoop();
        const nl = toolAfterScoop(CHAR.lvl, CHAR.total);
        if (nl !== CHAR.lvl) {
          setTool(nl);
          audio.sfxChime(nl === 1 ? [523, 659, 784] : [523, 659, 784, 1047]);
          toast(nl === 1 ? 'Bigger scoop unlocked! 🥄✨' : 'MEGA SHOVEL unlocked! 🦾💩');
          if (CHAR.drew) CHAR.drew.react('cheer');     // Drew celebrates the upgrade
        } else pushScoopHud();
      }
    }
    if (COMPOST && CHAR.bag > 0 && Math.hypot(CHAR.x - COMPOST[0], CHAR.z - COMPOST[1]) < 2.3) {
      CHAR.bag = 0; bagWarned = false; audio.sfxChime([392, 523]); pushScoopHud();
      toast('Composted ♻️');
    }
    if (POOPS.length === 0 && !spotless) { spotless = true; toast('Yard is spotless ✨ (for now…)', 2400); if (CHAR.drew) CHAR.drew.react('dance'); }
    if (POOPS.length > 0) spotless = false;
    if (scoopHudDirty) { scoopHudDirty = false; pushScoopHud(); }
    // Scoop renders the full procedural world (its aerial-photo terrain IS the
    // backyard ground, with the real house + sanctuary structures), so the old
    // grass disc / fence ring (workarounds for the photoreal case) are off — they
    // would z-fight the terrain and the ring would cut through the house.
    if (groundPatch) groundPatch.visible = false;
    if (scoopGrass) scoopGrass.visible = false;
    if (scoopFence) scoopFence.visible = false;
    // follow cam — preset (Overhead / Angled / Close), cycled with the 🎥 button.
    const fx = Math.sin(camYawS), fz = Math.cos(camYawS);
    const SC = SCOOP_CAMS[scCam];
    // vertical look = TILT only (raise/lower the camera height); pinch/scroll
    // (szoom) is the sole distance control. Mirrors Drive (pitch->height, zoom->dist)
    // instead of the old dolly that stacked scPitch into both dist AND szoom.
    const dist = SC.dist * szoom, h = (SC.h + scPitch * 9) * Math.max(0.75, szoom);
    camGroundRef = camGroundRef == null ? cy : camGroundRef + (cy - camGroundRef) * Math.min(1, dt * 1.5);
    const camT = _camT.set(CHAR.x - fx * dist, camGroundRef + h, CHAR.z - fz * dist);
    if (!camInit) { camV.copy(camT); camInit = true; }
    camV.lerp(camT, Math.min(1, dt * 6));
    camV.y = Math.max(camV.y, terrainAt(camV.x, camV.z) + 1.2);
    camera.position.copy(camV);
    camera.lookAt(CHAR.x, cy + 1.0, CHAR.z);
    // walk-to-drive: prompt when Drew reaches a parked car in the driveway, and
    // float a pin over the nearest car so the handoff is discoverable from the yard.
    let near = false, best = null, bestD = 1e9;
    for (const s of parkedSpots) {
      const d = Math.hypot(CHAR.x - s.x, CHAR.z - s.z);
      if (d < 3.6) near = true;
      if (d < bestD) { bestD = d; best = s; }
    }
    if (near !== nearCar) { nearCar = near; emit('nearCar', near); }
    carMarker.visible = !!best && !near;
    if (carMarker.visible) carMarker.position.set(best.x, terrainAt(best.x, best.z) + 5.2 + Math.abs(Math.sin(now * 0.005)) * 0.4, best.z);
  }
  // hop from walking straight into driving (the car spawns at the driveway)
  function driveFromScoop() {
    if (mode !== 'scoop' || !nearCar) return;
    nearCar = false; emit('nearCar', false);
    audio.blip();
    enterDrive();
  }

  // ---------- drive mode ----------
  function enterDrive() {
    setMode('drive'); camInit = false;
    setInside(false);
    const sp = frontPt || [house.c[0], house.c[1] + 14];
    car.x = sp[0]; car.z = sp[1];
    if (frontDir) {
      // face whichever direction has the longer drivable run
      const run = sx => {
        let i = 0;
        while (i < 12 && onRoad(sp[0] + frontDir[0] * sx * (i + 1) * 8, sp[1] + frontDir[1] * sx * (i + 1) * 8)) i++;
        return i;
      };
      const sg = run(1) >= run(-1) ? 1 : -1;
      car.yaw = Math.atan2(frontDir[0] * sg, frontDir[1] * sg);
    } else car.yaw = 0;
    car.speed = 0; car.group.visible = true; car.groundY = null;
    camOrbit.yaw = 0; camOrbit.pitch = 0; camGroundRef = null;
    showT = 0;                                   // skip the low cinematic orbit (melty up close)
    for (const s of labelSprites) s.visible = false;
    audio.engineStart();
    showCarCard();
    toast('Free roam — drive anywhere!', 2200);
  }
  function exitDrive() {
    setMode('explore');
    camera.up.set(0, 1, 0);
    hideJoy();
    navPtr = null; inp2.navActive = false; if (navMarker) navMarker.visible = false;
    car.group.visible = false;
    if (groundPatch) groundPatch.visible = false;
    for (const s of labelSprites) s.visible = true;
    inp2.jx = inp2.jy = inp2.kx = inp2.ky = 0;
    audio.engineStop();
    ctl.gtx = clamp(car.x, -310, 310); ctl.gtz = clamp(car.z, -310, 310);
    ctl.gty = terrainAt(ctl.gtx, ctl.gtz) + 3; ctl.gr = 110; ctl.gpo = 0.95;
    ctl.tx = ctl.gtx; ctl.tz = ctl.gtz;
  }

  const camV = new THREE.Vector3();
  const _camT = new THREE.Vector3();      // per-frame camera target scratch (drive/scoop are mutually exclusive)
  let camGroundRef = null;                 // slow-smoothed ground height for a STATIC-feeling drone altitude
  let camMode = 0;
  let camInit = false;
  // Drive cameras. Default "Cruise" is the high chase the user likes: well above
  // the melty ground-level photogrammetry, a little behind the car, looking DOWN
  // THE ROAD AHEAD (ahead = metres in front to aim at). "Close" is the low
  // cinematic chase; "Top-down" looks straight down, heading-up.
  const DRIVE_CAMS = [
    // high + steep like the top-down (so it stays ABOVE the melty ground-level
    // photogrammetry), but pulled a little behind and aimed well down the road.
    { name: 'Cruise', dist: 9, h: 34, ahead: 11, drone: true, topdown: false },
    { name: 'Close', dist: 11, h: 5, ahead: 5, drone: false, topdown: false },
    { name: 'Top-down', dist: 6, h: 52, ahead: 10, drone: true, topdown: true },
  ];
  function cycleCamera() {
    camMode = (camMode + 1) % DRIVE_CAMS.length; camInit = false;
    const td = DRIVE_CAMS[camMode].topdown;
    if (!td) { camera.up.set(0, 1, 0); inp2.navActive = false; navPtr = null; }   // leaving top-down ends draw-to-drive
    toast('Camera: ' + DRIVE_CAMS[camMode].name + (td ? ' · drag to drive 🪄' : ''), td ? 1700 : 1100);
  }
  // Scoop camera presets [dist, height] — cycled with the 🎥 button.
  const SCOOP_CAMS = [
    { name: 'Overhead', dist: 10, h: 19 },   // ~62° down: near top-down
    { name: 'Angled', dist: 14, h: 15 },     // ~47° down: tilts past the melty horizon to the yard
    { name: 'Close', dist: 9, h: 7.5 }       // ~40° down: low follow, still off the horizon
  ];
  let scCam = 0;
  function cycleScoopCamera() {
    scCam = (scCam + 1) % SCOOP_CAMS.length; camInit = false;
    toast('Camera: ' + SCOOP_CAMS[scCam].name, 1100);
  }
  // March the subject->camera segment and pull the camera in before it would
  // enter a building below that building's roofline.
  const _camRayO = new THREE.Vector3(), _camRayD = new THREE.Vector3();
  const camRay = new THREE.Raycaster(); camRay.firstHitOnly = true;
  const _camHits = [];
  function resolveCam(tx, ty, tz, px, py, pz) {
    let g = 1;
    // procedural buildings: march subject->camera, pull in before a wall
    const steps = 14;
    for (let s = 3; s <= steps; s++) {
      const f = s / steps;
      const x = tx + (px - tx) * f, y = ty + (py - ty) * f, z = tz + (pz - tz) * f;
      for (const bb of bldBoxes) {
        if (x > bb[0] && x < bb[1] && z > bb[2] && z < bb[3] && y < (bb[4] || 99)) {
          g = Math.max(0.2, (s - 1.5) / steps); s = steps + 1; break;
        }
      }
    }
    // photoreal tiles: raycast the same segment against the real (tall, dense)
    // tile geometry — the procedural bldBoxes are hidden, so this is what keeps
    // the chase/follow cam from burying itself in real trees & houses.
    if (p3dtiles && p3dtiles.holder.visible) {
      _camRayD.set(px - tx, py - ty, pz - tz);
      const dist = _camRayD.length();
      if (dist > 0.05) {
        _camRayD.multiplyScalar(1 / dist);
        camRay.set(_camRayO.set(tx, ty, tz), _camRayD);
        camRay.far = dist;
        // tiles.raycast prunes by per-tile bounding volume + early-exits on the
        // first hit — far cheaper than intersectObject(group, true), which tested
        // every triangle of every loaded tile each frame.
        _camHits.length = 0;
        p3dtiles.raycast(camRay, _camHits);
        const hit = _camHits[0];
        if (hit) g = Math.min(g, Math.max(0.12, (hit.distance - 0.6) / dist));
      }
    }
    return g;
  }

  function updateDrive(dt, now) {
    // mix stick (jx/jy) + keyboard (kx/ky) + dedicated touch steer/gas/brake
    let jx = clamp(inp2.jx + inp2.kx + inp2.steer, -1, 1), jy = clamp(inp2.jy + inp2.ky, -1, 1);
    let throttle = clamp(Math.max(0, -jy) + inp2.gas, 0, 1), brake = clamp(Math.max(0, jy) + inp2.brake, 0, 1);
    // Top-down draw-to-drive override: steer toward the finger's ground point and
    // auto-throttle, easing off (and braking) as the car reaches it.
    if (inp2.navActive) {
      const dx = inp2.navX - car.x, dz = inp2.navZ - car.z, dd = Math.hypot(dx, dz);
      let dyaw = Math.atan2(dx, dz) - car.yaw;
      while (dyaw > Math.PI) dyaw -= 2 * Math.PI; while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      jx = clamp(-dyaw * 1.6, -1, 1);                       // steer toward the target heading
      throttle = dd > 3 ? clamp(0.45 + (1 - Math.abs(dyaw) / Math.PI) * 0.55, 0, 1) : 0;
      brake = (dd <= 3 && car.speed > 4) ? 0.5 : 0;
    }
    if (throttle > 0.1 || brake > 0.1) showT = 0;
    const road = onRoad(car.x, car.z);
    const maxF = road ? 36 : 20, maxR = -7;
    let acc = (road ? 14 : 10) * throttle;
    if (brake > 0.1) acc = car.speed > 0.5 ? -26 * brake : -9 * brake;
    car.speed += acc * dt;
    car.speed -= car.speed * (road ? 0.55 : 0.95) * dt;
    car.speed = clamp(car.speed, maxR, maxF);
    if (throttle < 0.1 && brake < 0.1 && Math.abs(car.speed) < 0.4) car.speed = 0;
    const steerTarget = (-jx) * 0.5 / (1 + Math.abs(car.speed) * 0.055);
    car.steer += (steerTarget - car.steer) * Math.min(1, dt * 9);
    car.yaw += (car.speed / 2.7) * Math.tan(car.steer) * dt;
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    let nx = car.x + fx * car.speed * dt, nz = car.z + fz * car.speed * dt;
    const rad = 1.25;
    // buildings are solid only at their real footprint; slide along the wall
    // instead of stopping dead so you can scrape past a corner.
    if (insideBuilding(nx, nz)) {
      if (!insideBuilding(nx, car.z)) nz = car.z;
      else if (!insideBuilding(car.x, nz)) nx = car.x;
      else { nx = car.x; nz = car.z; }
      car.speed *= -0.22;
    }
    for (const t of treePts) {
      const dx = nx - t[0], dz = nz - t[1], d2 = dx * dx + dz * dz, rr = 0.75 + rad;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2); nx = t[0] + dx / d * rr; nz = t[1] + dz / d * rr;
        car.speed *= -0.2;
      }
    }
    // sanctuary-safe: animals always bounce the car, never get hurt
    for (const a of ANIMALS) {
      const dx = nx - a.x, dz = nz - a.z, d2 = dx * dx + dz * dz, rr = a.r + rad + 0.5;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2); nx = a.x + dx / d * rr; nz = a.z + dz / d * rr;
        car.speed *= -0.25;
      }
    }
    // Roam far across the streamed Google tiles. The procedural neighborhood (and
    // its collision) only spans ~±340 m; past that the car rides the real
    // photoreal road directly (see actorGroundY), so the only bound is a generous
    // sanity ring at the metro scale where the flat-earth frame stays accurate.
    const lim = 4000;
    if (Math.hypot(nx, nz) > lim) { const d = Math.hypot(nx, nz); nx *= lim / d; nz *= lim / d; car.speed *= 0.4; }  // soft edge: ease to a stop, don't shove back
    car.x = nx; car.z = nz;
    // Ride the real photoreal ROAD surface (canopy-skipped + clamped to topology),
    // low-passed so it's smooth — keeps the car (and its flat patch) sitting ON the
    // road, never climbing trees. Tilt comes from the smooth procedural terrain.
    const yr = actorGroundY(car.x, car.z, car.groundY);
    car.groundY = car.groundY == null ? yr : car.groundY + (yr - car.groundY) * Math.min(1, dt * 5);
    const yC = car.groundY;
    const rxv = Math.cos(car.yaw), rzv = -Math.sin(car.yaw);
    const tF = terrainAt(car.x + fx * 1.4, car.z + fz * 1.4), tB = terrainAt(car.x - fx * 1.4, car.z - fz * 1.4);
    const tR = terrainAt(car.x + rxv * 0.9, car.z + rzv * 0.9), tL = terrainAt(car.x - rxv * 0.9, car.z - rzv * 0.9);
    const pitch = Math.atan2(tB - tF, 2.8), roll = Math.atan2(tR - tL, 1.8);
    car.group.position.set(car.x, yC + 0.06, car.z);
    car.group.rotation.set(0, 0, 0);
    car.group.rotateY(car.yaw - Math.PI / 2);
    car.group.rotateZ(-pitch);
    car.group.rotateX(roll);
    if (navMarker) {
      navMarker.visible = inp2.navActive;
      if (inp2.navActive) navMarker.position.set(inp2.navX, yC + 0.12, inp2.navZ);
    }
    if (groundPatch) {
      const show = !!(p3dtiles && p3dtiles.holder.visible);   // only over the photoreal world
      groundPatch.visible = show;
      if (show) { groundPatch.scale.setScalar(0.62); groundPatch.position.set(car.x, yC + 0.04, car.z); }
    }
    const spin = car.speed * dt / 0.37;
    const active = car.models[car.modelIdx];
    if (active) {
      // GLB vehicle: only the Ferrari has named wheel nodes; others ride static
      if (active.wheels) for (const w of active.wheels) w.rotation.x += spin;
    } else {
      // procedural fallback car
      for (const w of car.wheels) w.rotation.z -= spin;
      for (const f of car.fronts) f.rotation.y = car.steer * 1.6;
    }
    if (showT > 0) {
      // showcase orbit on entry; any input skips it
      showT -= dt;
      const a = car.yaw + 2.4 + (2.8 - showT) * 1.35;
      let cx2 = car.x + Math.sin(a) * 6.6, cy2 = Math.max(yC + 1.7, groundAt(cx2, car.z) + 1.2), cz2 = car.z + Math.cos(a) * 6.6;
      const g = resolveCam(car.x, yC + 1.0, car.z, cx2, cy2, cz2); // don't orbit into real tiles
      cx2 = car.x + (cx2 - car.x) * g; cy2 = yC + 1.0 + (cy2 - yC - 1.0) * g; cz2 = car.z + (cz2 - car.z) * g;
      camera.position.set(cx2, cy2, cz2);
      camera.lookAt(car.x, yC + 0.7, car.z);
    } else if (DRIVE_CAMS[camMode].topdown) {
      const CAM = DRIVE_CAMS[camMode];
      // almost directly overhead, but offset a little behind and aimed a touch
      // forward so you can read the road ahead (not perfectly straight down).
      const camT = _camT.set(car.x - fx * CAM.dist, yC + CAM.h * czoom, car.z - fz * CAM.dist);
      if (!camInit) { camV.copy(camT); camInit = true; }
      camV.lerp(camT, Math.min(1, dt * 5));
      camera.position.copy(camV);
      camera.up.set(fx, 0, fz); // heading-up
      camera.lookAt(car.x + fx * CAM.ahead, yC, car.z + fz * CAM.ahead);
    } else {
      const CAM = DRIVE_CAMS[camMode];
      camera.up.set(0, 1, 0);
      if (now - camOrbit.t > 1400 && Math.abs(car.speed) > 2) camOrbit.yaw *= Math.exp(-dt * 2.2);
      const a = car.yaw + Math.PI + camOrbit.yaw;
      const dist = CAM.dist * czoom, h = (CAM.h + camOrbit.pitch * 4.5) * Math.max(0.7, czoom);
      // hold a STATIC altitude (drone cams): slow-smooth the ground ref so terrain
      // rolls don't bob the high cam; the low Close cam snaps to the ground.
      camGroundRef = camGroundRef == null ? yC : camGroundRef + (yC - camGroundRef) * Math.min(1, dt * (CAM.drone ? 1.2 : 6));
      const camT = _camT.set(car.x + Math.sin(a) * dist, camGroundRef + h, car.z + Math.cos(a) * dist);
      // the low Close cam collides with geometry; the high cams fly above the melt
      // (resolveCam against melty tile blobs would yank them down onto the car).
      if (!CAM.drone) {
        const g = resolveCam(car.x, yC + 1.2, car.z, camT.x, camT.y, camT.z);
        if (g < 1) { camT.set(car.x + (camT.x - car.x) * g, yC + 1.2 + (camT.y - yC - 1.2) * g, car.z + (camT.z - car.z) * g); }
      }
      if (!camInit) { camV.copy(camT); camInit = true; }
      camV.lerp(camT, Math.min(1, dt * 4.6));
      camV.y = Math.max(camV.y, groundAt(camV.x, camV.z) + 1.3);
      camera.position.copy(camV);
      // look DOWN THE ROAD: aim a point ahead of the car along its heading, so you
      // see where you're going instead of the roof of your own car.
      camera.lookAt(car.x + fx * CAM.ahead, yC + 1.0, car.z + fz * CAM.ahead);
    }
    if (ui.mph) ui.mph.textContent = Math.round(Math.abs(car.speed) * 2.237);
    audio.engineUpdate(car.speed, 36);
  }

  // ---------- viewport (critical mobile invariant — do not regress) ----------
  // The Claude app webview reports a layout viewport TALLER than the visible
  // area; size everything from visualViewport or HUD/subject drift offscreen.
  function viewportSize() {
    const vv = window.visualViewport;
    const w = vv ? Math.round(vv.width) : document.documentElement.clientWidth || innerWidth;
    const h = vv ? Math.round(vv.height) : document.documentElement.clientHeight || innerHeight;
    return [Math.max(1, w), Math.max(1, h)];
  }
  function resize() {
    const [w, h] = viewportSize();
    renderer.setSize(w, h, false);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    if (ui.box) { ui.box.style.width = w + 'px'; ui.box.style.height = h + 'px'; }
    camera.aspect = w / h; camera.updateProjectionMatrix();
    if (p3dtiles) p3dtiles.setResolutionFromRenderer(camera, renderer);
  }

  // ---------- loop ----------
  const dirV = new THREE.Vector3();
  let prev = performance.now();
  let raf = 0, paused = false, ctxLost = false;
  // Google 3D Tiles ToS: surface the LIVE data attribution for the tiles currently
  // in view whenever the photoreal world is shown. Throttled; emits only on change.
  const _attrTarget = []; let _attrStr = '', _attrT = 0;
  function updateAttribution(now) {
    if (now - _attrT < 500) return;
    _attrT = now; _attrTarget.length = 0;
    try { p3dtiles.getAttributions(_attrTarget); } catch (e) { return; }
    const s = _attrTarget.filter(a => a && a.type === 'string').map(a => a.value).filter(Boolean).join(' · ');
    if (s !== _attrStr) { _attrStr = s; emit('attribution', s); }
  }
  function loop(now) {
    if (disposed || paused || ctxLost) return;
    const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
    if (waterMat) waterMat.uniforms.uTime.value = now * 0.001; // flowing creek
    updateAnimals(dt, now); // ambient life in every mode
    if (mode === 'drive') {
      updateDrive(dt, now);
    } else if (mode === 'scoop') {
      updateScoop(dt, now);
    } else {
      const k = reduceMotion ? 1 : 0.16;
      if (!reduceMotion && !ptrs.size && (Math.abs(azVel) > 1e-4 || Math.abs(poVel) > 1e-4)) {
        ctl.gaz += azVel; ctl.gpo = clamp(ctl.gpo + poVel, 0.14, 1.46);
        const decay = Math.exp(-dt * 4); azVel *= decay; poVel *= decay; // flick momentum
      }
      ctl.tx += (ctl.gtx - ctl.tx) * k; ctl.ty += (ctl.gty - ctl.ty) * k; ctl.tz += (ctl.gtz - ctl.tz) * k;
      ctl.az += (ctl.gaz - ctl.az) * k; ctl.po += (ctl.gpo - ctl.po) * k; ctl.r += (ctl.gr - ctl.r) * k;
      applyCam();
      camInit = false;
    }
    if (!reduceMotion) {
      const s = 1 + 0.04 * Math.sin(now * 0.0023);
      ring.scale.set(s, s, 1);
      ring.material.opacity = 0.5 + 0.22 * Math.sin(now * 0.0023);
    }
    camera.getWorldDirection(dirV);
    if (ui.needle) ui.needle.style.transform = `rotate(${(Math.atan2(dirV.x, dirV.z) * 180 / Math.PI).toFixed(1)}deg)`;
    if (p3dtiles && photoModes(mode)) { camera.updateMatrixWorld(); p3dtiles.update(); updateAttribution(now); }
    else if (_attrStr) { _attrStr = ''; emit('attribution', ''); }   // no tiles shown → no credit
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  // iOS robustness: don't burn GPU/memory streaming tiles to a backgrounded tab,
  // and survive a WebGL context loss instead of freezing on a black canvas.
  function onVisibility() {
    if (document.hidden) { if (!paused) { paused = true; cancelAnimationFrame(raf); } }
    else if (paused && !disposed && !ctxLost) { paused = false; prev = performance.now(); audio.ensure(); raf = requestAnimationFrame(loop); }
  }
  function onContextLost(e) { e.preventDefault(); ctxLost = true; cancelAnimationFrame(raf); }
  function onContextRestored() { if (!disposed) location.reload(); }   // rebuild streamed GPU state via reload

  // ---------- wire up ----------
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  addEventListener('resize', resize);
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', resize);
    visualViewport.addEventListener('scroll', resize);
  }
  resize();
  const t1 = setTimeout(resize, 400), t2 = setTimeout(resize, 1500);

  emit('subline', `Hayward, CA · ${S.creek ? S.creek.n + ' · ' : ''}sanctuary: 5 🐷 2 🦆 1 🦎`);
  applyCam();
  renderer.render(scene, camera);
  emit('ready');
  raf = requestAnimationFrame(loop);

  function dispose() {
    disposed = true;
    cancelAnimationFrame(raf);
    clearTimeout(t1); clearTimeout(t2);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerEnd);
    canvas.removeEventListener('pointercancel', onPointerEnd);
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('dblclick', onDblClick);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    document.removeEventListener('visibilitychange', onVisibility);
    removeEventListener('keydown', onKeyDown);
    removeEventListener('keyup', onKeyUp);
    removeEventListener('resize', resize);
    if (window.visualViewport) {
      visualViewport.removeEventListener('resize', resize);
      visualViewport.removeEventListener('scroll', resize);
    }
    audio.engineStop();
    if (cancelCarLoad) cancelCarLoad();          // late car load/timeout can't touch a dead scene
    if (p3dtiles && p3dtiles.disposeAll) p3dtiles.disposeAll();
    // free GPU resources the renderer.dispose() alone doesn't reclaim
    scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
        m.dispose();
      }
    });
    renderer.dispose();
    delete window.__dahill;
  }

  const api = {
    enterDrive, exitDrive, enterScoop, exitScoop,
    toggleShiftLock: () => { shiftLock = !shiftLock; emit('shiftLock', shiftLock); },
    focusHouse, cycleCamera, cycleCar, cycleScoopCamera, driveFromScoop, dispose,
    get mode() { return mode; }
  };
  // tiny debug handle for headless verification + on-phone debugging
  window.__dahill = {
    api,
    p3dt: P3DT,                       // mutate {yOffset,xOffset,zOffset,spin} then call nudge()
    nudge: applyP3DT,
    tiles: () => p3dtiles,
    setProcedural: (on) => { staticGroup.visible = on; },
    // sweep spin; score = avg tile height at building centroids − at road points
    // (correct alignment => buildings high/roofs, roads low). Pick the max.
    calibrate: () => {
      const road = [], bld = [];
      for (const r of S.roads) {
        if (r.k !== 'residential' && r.k !== 'tertiary') continue;
        for (const p of r.p) { const w = W(p); if (Math.hypot(w[0], w[1]) < 90) road.push(w); }
      }
      for (const b of bldPolys) {
        const cx = (b.bb[0] + b.bb[1]) / 2, cz = (b.bb[2] + b.bb[3]) / 2;
        if (Math.hypot(cx, cz) < 90) bld.push([cx, cz]);
      }
      // Rotate the SAMPLE POINTS by -s about origin (equivalent to spinning the
      // photoreal +s) and probe the static tiles — avoids stale matrixWorld.
      const out = {};
      for (let s = 0; s < 360; s += 5) {
        const a = -s * DEG, ca = Math.cos(a), sa = Math.sin(a);
        let rs = 0, rn = 0, bs = 0, bn = 0;
        for (const [x, z] of road) { const y = rawTileY(x * ca - z * sa, x * sa + z * ca); if (y != null) { rs += y; rn++; } }
        for (const [x, z] of bld) { const y = rawTileY(x * ca - z * sa, x * sa + z * ca); if (y != null) { bs += y; bn++; } }
        out[s] = (rn && bn) ? +(bs / bn - rs / rn).toFixed(2) : null;
      }
      let best = 0, bestv = -1e9;
      for (const s in out) if (out[s] != null && out[s] > bestv) { bestv = out[s]; best = +s; }
      return { bestSpin: best, bestScore: bestv, scores: out, roadPts: road.length, bldPts: bld.length };
    },
    state: () => ({
      mode, buildings: S.buildings.length, photoreal: !!p3dtiles && !staticGroup.visible,
      poops: POOPS.length, car: { x: +car.x.toFixed(1), z: +car.z.toFixed(1), speed: +car.speed.toFixed(1), glb: !!car.glb },
      char: { x: +CHAR.x.toFixed(1), z: +CHAR.z.toFixed(1), bag: CHAR.bag, total: CHAR.total, lvl: CHAR.lvl }
    })
  };
  return api;
}
