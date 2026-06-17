import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { S, C, W, uvAt, terrainAt, SREC, GRID_ANG } from './data.js';
import { clamp, makeGeoENU } from './coords.js';
import { asNonIndexed, merge } from './geom.js';
import { buildWorld } from './world.js';
import { createAnimals, createCharacter, TOOLS, toolAfterScoop, POOP_ACTIVE_CAP } from './animals.js';
import { loadCeceCrowd, loadDrewCrowd, loadDadCrowd, loadMomCrowd } from './crowd.js';
import { createInterior } from './interior.js';
import { loadDadController } from './dad.js';
import { loadMomController } from './mom.js';
import { DREW_HEIGHT_M, CECE_HEIGHT_M } from './drew.js';
import { createCar, loadRealCar, loadParkedCar, loadDrivableCar, loadCarProto, cycleVehicle, setVehicle, vehicleList, VEHICLES, setCarAniso } from './car.js';
import { installDracoDecoder } from './draco-install.js';
import { createAudio } from './audio.js';
import aerialUrl from '../assets/aerial_opt.jpg';
import carGlbUrl from '../assets/ferrari.glb';
import rav4Url from '../assets/rav4.glb';
import siennaUrl from '../assets/sienna.glb';
import granviaUrl from '../assets/granvia.glb';
import mustangUrl from '../assets/mustang.glb';
import miniUrl from '../assets/mini.glb';
import corvetteUrl from '../assets/corvette.glb';
import rollsroyceUrl from '../assets/rollsroyce.glb';
import scgUrl from '../assets/scg.glb';
import battistaUrl from '../assets/battista.glb';
import murcielagoUrl from '../assets/murcielago.glb';
import caspitaUrl from '../assets/caspita.glb';
import mustang65Url from '../assets/mustang65.glb';
import mini65Url from '../assets/mini65.glb';
import hotrodUrl from '../assets/hotrod.glb';
import ratrodUrl from '../assets/ratrod.glb';

// The whole game lives here, imperative three.js — React only renders the HUD.
// Communication: engine -> UI via emit(type, payload) for low-frequency state,
// and direct DOM writes through `ui` refs for per-frame values (mph, compass
// needle, thumbstick knob) so React isn't re-rendering at 60 fps.
export function createEngine({ canvas, ui, emit }) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const toast = (html, ms) => emit('toast', { html, ms: ms || 1800 });
  // The toast is rendered via dangerouslySetInnerHTML, so any dynamic value that can carry
  // user/network text (geocoded addresses, place names) MUST be escaped before it goes in.
  // Static literals in toast() calls don't need this; only interpolated place/address text does.
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ?lite : no shadows + 1x pixel ratio — for older phones and for headless
  //         verification, where software WebGL grinds at 1-5 fps otherwise.
  // ?nocar: skip the GLB swap (fast test loop; procedural car stays).
  const flags = new URLSearchParams(location.search);
  // Phones: cap pixel ratio and lighten shadows. The shadow pass re-renders every
  // caster into the depth map each frame, so this is a real per-frame saving and
  // a defence against GPU-memory pressure on iOS Safari. Also catch iPadOS-13+, which
  // reports a desktop "Macintosh" UA but has touch — it was getting the heaviest path.
  const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  // Auto-LITE on low-end phones (few cores / little RAM) — previously LITE only triggered
  // with ?lite in the URL, so every DPR/AA/shadow mitigation below was dead code on a real
  // phone opened normally. This flips a weak device to DPR1 / no-AA / no-shadows.
  const LITE = flags.has('lite') ||
    (MOBILE && ((navigator.hardwareConcurrency || 4) <= 4 || (navigator.deviceMemory || 4) <= 3));
  document.documentElement.classList.toggle('lite3d', LITE || MOBILE);
  const renderPixelRatio = () => LITE ? 1 : Math.min(window.devicePixelRatio || 1, MOBILE ? 1.25 : 2);

  // Upgraded to three r184. The scene's colours and light intensities were all
  // hand-tuned under r128's un-managed, linear-output pipeline, so opt back out
  // of r152+ colour management and keep linear output to preserve that look;
  // the lights are re-scaled below for r155+ physically-correct units.
  THREE.ColorManagement.enabled = false;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LITE && !MOBILE, powerPreference: 'high-performance' });   // skip the MSAA resolve on mobile (fill-rate bound)
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  // Cap pixel ratio: 1.25 on phones (the fill-rate dial — at DPR 2 a 3x phone draws ~2.6×
  // the fragments of the full-screen photoreal tiles for little visible gain; 1.25 supersampling
  // still softens edges), 2 on desktop. LITE stays at 1x.
  renderer.setPixelRatio(renderPixelRatio());   // 1.25² vs 2² ≈ 30% fewer fragments on the full-screen photoreal tiles
  renderer.shadowMap.enabled = !LITE;
  renderer.shadowMap.type = MOBILE ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.localClippingEnabled = true;   // Drive-mode tile cutaway: only the photoreal tile materials carry clip planes, so the car/HUD/guide stay unclipped (see updateTileClip + tiles3d.clipPlanes)
  const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();   // sharp ground/roads at grazing angles
  setCarAniso(Math.min(8, MAX_ANISO));   // give the car textures the same anisotropic filtering as the tiles (de-grains the models)
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc8d6da);
  scene.fog = new THREE.Fog(0xd2dcd6, 460, 1200);
  const camera = new THREE.PerspectiveCamera(46, 1, 0.6, 3000);

  // r155+ uses physically-correct light units; ×π restores the r128 legacy
  // brightness these intensities were tuned for.
  scene.add(new THREE.HemisphereLight(0xd8e8f6, 0xa39a85, 0.6 * Math.PI));
  const sun = new THREE.DirectionalLight(0xfff1d8, 0.95 * Math.PI);
  sun.position.set(-185, 240, 150);
  sun.castShadow = true;                 // gated to Scoop at runtime (see applyModeVisuals)
  sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);   // casters sit in a tight frustum; 1024 is plenty on a phone
  const sc2 = sun.shadow.camera;
  // tighter frustum (±170 vs ±300) ~= 3× the texel density where shadows actually
  // land (the scoop sanctuary + driveway); distant procedural shadows aren't missed.
  sc2.left = -170; sc2.right = 170; sc2.top = 170; sc2.bottom = -170; sc2.far = 900;
  sun.shadow.bias = -0.0009;
  scene.add(sun);
  const vehicleFillTarget = new THREE.Object3D();
  scene.add(vehicleFillTarget);
  const vehicleFill = new THREE.DirectionalLight(0xeaf4ff, 0.62 * Math.PI);
  vehicleFill.castShadow = false;
  vehicleFill.visible = false;
  vehicleFill.target = vehicleFillTarget;
  scene.add(vehicleFill);
  // Image-based lighting so the cars stop looking flat/"poopy": a metallic body (metalness ~0.45)
  // has NOTHING to reflect without an environment, so it renders near-black. A cheap procedural
  // studio (RoomEnvironment, baked once via PMREM) gives the paint + glass soft reflections and a
  // clear key/fill falloff that reads as a real sun direction. Tiles are MeshBasic (toneMapped:false,
  // no env) so the photoreal world is untouched; only the PBR actors (cars, characters) pick it up.
  // Intensity is dialled back for this legacy linear (ColorManagement-off) pipeline so it adds gloss
  // without washing out the body colour.
  {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    scene.environment = pmrem.fromScene(room, 0.04).texture;
    if ('environmentIntensity' in scene) scene.environmentIntensity = 0.42;
    room.dispose && room.dispose();   // free the throwaway studio's geometries/materials
    pmrem.dispose();
  }

  const world = buildWorld(scene, renderer, { S, C, W, uvAt, terrainAt, SREC, GRID_ANG, aerialUrl });
  const { onRoad, house, bldBoxes, bldPolys, treePts, frontPt, frontDir, COMPOST, ring, interiorGroup, labelSprites, waterMat, staticGroup, aerialMat } = world;

  // ---- minimap + address navigation ----
  // World-frame road segments for the minimap (drawn as a 2D map).
  const roadSegs = [];
  for (const r of S.roads) {
    if (r.k !== 'residential' && r.k !== 'tertiary' && r.k !== 'service') continue;
    for (let k = 0; k < r.p.length - 1; k++) roadSegs.push([W(r.p[k]), W(r.p[k + 1])]);
  }
  // EVERY mapped road (any type) for the off-road auto-correct + reset-to-road: the
  // drivable-only roadSegs above (used by the minimap/traffic/crowd) miss roads the car
  // can still wander off, so nearestRoadPoint/resetToRoad search this wider graph instead.
  const allRoadSegs = [];
  for (const r of S.roads) for (let k = 0; k < r.p.length - 1; k++) allRoadSegs.push([W(r.p[k]), W(r.p[k + 1])]);
  // geo <-> world, anchored at 1840 Dahill Lane. CURVATURE-CORRECT local ENU (East/North metres) so
  // routes / jumps / the road-snap line up with the real photoreal-tile roads even far from home —
  // the old flat-tangent version drifted ~d²/2R from the (curved-earth) tiles (~a lane at 5 km,
  // ~30 m at 20 km). Identical to the flat math within a millimetre near home, so nothing local
  // changes. Axis convention unchanged: world x = East, world z = -North, centred on C.
  const GEO0 = { lat: 37.6835313, lon: -122.0686199 };
  const _enu = makeGeoENU(GEO0.lat, GEO0.lon);
  function geoToWorld(lat, lon) {
    const en = _enu.toEN(lat, lon);
    return [en[0] - C[0], -(en[1] - C[1])];
  }
  function worldToGeo(x, z) {
    return _enu.toGeo(x + C[0], C[1] - z);
  }
  let DEST = null;        // { x, z, label }
  let soundOn = (() => { try { return localStorage.getItem('dahill.sound') !== '0'; } catch (e) { return true; } })();   // master sound on by default
  let autoSteer = (() => { try { return localStorage.getItem('dahill.autosteer') !== '0'; } catch (e) { return true; } })();   // road/lane-keep assist, on by default
  let roadLifeOn = (() => { try { return localStorage.getItem('dahill.roadlife') !== '0'; } catch (e) { return true; } })();   // pedestrians + traffic on by default
  let trafficDensity = (() => { try { const v = parseFloat(localStorage.getItem('dahill.trafficdensity')); return Number.isFinite(v) ? clamp(v, 0, 2) : 1; } catch (e) { return 1; } })();   // traffic amount slider (0..2, 1 = default)
  const TRAFFIC_MAX = 18;   // hard pool ceiling (perf); density scales how many are ACTIVE
  const trafficActiveCount = () => Math.round(clamp(trafficDensity, 0, 2) / 2 * TRAFFIC_MAX);   // d:0→0, d:1→9, d:2→18
  // Soft-wall / gravity-well that keeps the car on the street: past LANE_HALF metres off the
  // nearest road it gets pulled back, ramping in softly and clamped to WALL_MAX m/s so it never
  // overpowers a deliberate drive (and fades as the player steers).
  const LANE_HALF = 4.2, WALL_GAIN = 3.5, WALL_MAX = 9.0;
  let offRoadT = 0;       // seconds the car has been stranded off the road (drives the auto-recover snap-back)
  let recoverCooldown = 0;   // grace after a reset so the auto-recover can't immediately re-fire (no ping-pong → no "hidden car")
  let ROUTE = null;       // [{x,z}, ...] road-following path from Google Directions
  let routeIdx = 0;       // current target waypoint along ROUTE
  // FAR-FROM-HOME road graph: the procedural roadSegs only cover the ~±330 m hood, so out on the open
  // photoreal tiles the lane-keep assist had nothing to hug. Instead of a fragile 1-D "route ahead",
  // fetch the REAL road NETWORK from OpenStreetMap (Overpass) in a box around the car, projected
  // through the same ENU geoToWorld as the tiles, and re-fetch as you drive into new areas. This is a
  // true graph (segments on every side), so nearestRoadPoint / roadTargetAhead / the soft-wall / reset
  // all work EVERYWHERE, exactly like they do at home. Degrades to no-assist if Overpass is unreachable.
  let osmRoadSegs = [];          // world-space road segments fetched around the car ([[ax,az],[bx,bz]])
  let _osmCenter = null, _osmFetching = false, _osmT = 0;
  // Overpass mirrors, tried in order — the main de host throttles (429/504) under load, so fall
  // through to the public mirrors before giving up. Rotates start point so we don't always hammer #0.
  const OVERPASS_MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let _osmMirror = 0;
  let autoDrive = false;
  let _railRoute = null;   // the ROUTE the auto-drive rail's arc-length (car.railS) was acquired for; re-acquire when it changes

  // ---- drive collectibles: gold coins scattered along the neighbourhood roads ----
  const coins = [];
  let coinsGot = 0;
  {
    const coinGeo = new THREE.CylinderGeometry(0.95, 0.95, 0.16, 18); coinGeo.rotateX(Math.PI / 2);
    const coinMat = new THREE.MeshStandardMaterial({ color: 0xffcb2e, metalness: 0.85, roughness: 0.22, emissive: 0x6b4a00, emissiveIntensity: 0.5 });
    const near = roadSegs.filter(s => Math.hypot(s[0][0], s[0][1]) < 250);
    const step = Math.max(1, Math.floor(near.length / 18));
    for (let i = 0; i < near.length && coins.length < 18; i += step) {
      const s = near[i], mx = (s[0][0] + s[1][0]) / 2, mz = (s[0][1] + s[1][1]) / 2;
      const m = new THREE.Mesh(coinGeo, coinMat); m.castShadow = true; m.frustumCulled = false; m.visible = false;
      m.position.set(mx, terrainAt(mx, mz) + 1.1, mz);
      scene.add(m); coins.push({ mesh: m, x: mx, z: mz, got: false, groundY: null });
    }
  }
  let coinGroundCursor = 0;

  // ---- drive particles: skid decals + tyre smoke + coin sparks (all pooled) ----
  const FX = { skids: [], smoke: [], sparks: [], si: 0, mi: 0, pi: 0 };
  {
    const skidGeo = new THREE.PlaneGeometry(0.42, 1.5); skidGeo.rotateX(-Math.PI / 2);  // lies flat on the ground
    for (let i = 0; i < 110; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x16120f, transparent: true, opacity: 0, depthWrite: false });
      const m = new THREE.Mesh(skidGeo, mat); m.visible = false; m.frustumCulled = false; m.renderOrder = 2;
      scene.add(m); FX.skids.push({ mesh: m, born: -1e9 });
    }
    const smokeBase = new THREE.SpriteMaterial({ color: 0xc8c8c8, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    for (let i = 0; i < 34; i++) {
      const s = new THREE.Sprite(smokeBase.clone()); s.visible = false; s.frustumCulled = false;
      scene.add(s); FX.smoke.push({ spr: s, born: -1e9, vx: 0, vz: 0 });
    }
    const sparkBase = new THREE.SpriteMaterial({ color: 0xffd34d, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    for (let i = 0; i < 28; i++) {
      const s = new THREE.Sprite(sparkBase.clone()); s.visible = false; s.frustumCulled = false;
      scene.add(s); FX.sparks.push({ spr: s, born: -1e9, vx: 0, vy: 0, vz: 0 });
    }
  }
  let lastSkidT = 0;
  function spawnSkid(x, z, y, yaw, now) {
    const s = FX.skids[FX.si++ % FX.skids.length];
    s.born = now; s.mesh.visible = true;
    s.mesh.position.set(x, y + 0.035, z);
    s.mesh.rotation.set(0, yaw, 0);
    s.mesh.material.opacity = 0.5;
  }
  function spawnSmoke(x, z, y, now, onRoad) {
    const p = FX.smoke[FX.mi++ % FX.smoke.length];
    p.born = now; p.spr.visible = true;
    p.spr.position.set(x, y + 0.3, z);
    p.vx = (FX.mi % 7 - 3) * 0.25; p.vz = (FX.mi % 5 - 2) * 0.25;
    p.spr.scale.setScalar(1.1);
    p.spr.material.color.setHex(onRoad === false ? 0xb89066 : 0xc8c8c8);   // brown dust off-road, grey tyre smoke on tarmac
    p.spr.material.opacity = 0.32;
  }
  function spawnCoinBurst(x, z, y, now) {
    for (let i = 0; i < 6; i++) {
      const p = FX.sparks[FX.pi++ % FX.sparks.length];
      const a = i / 6 * Math.PI * 2;
      p.born = now; p.spr.visible = true;
      p.spr.position.set(x, y + 0.8, z);
      p.vx = Math.cos(a) * 3.2; p.vz = Math.sin(a) * 3.2; p.vy = 4 + (i % 3);
      p.spr.scale.setScalar(0.7);
      p.spr.material.opacity = 0.95;
    }
  }
  function tickParticles(now, dt) {
    for (const s of FX.skids) {
      if (!s.mesh.visible) continue;
      const age = (now - s.born) / 1000;
      if (age > 6) { s.mesh.visible = false; continue; }
      s.mesh.material.opacity = 0.5 * (1 - age / 6);
    }
    for (const p of FX.smoke) {
      if (!p.spr.visible) continue;
      const age = (now - p.born) / 1000;
      if (age > 0.85) { p.spr.visible = false; continue; }
      p.spr.position.x += p.vx * dt; p.spr.position.z += p.vz * dt;
      p.spr.position.y += (2.2 - age) * dt;
      p.spr.scale.setScalar(1.1 + age * 5);
      p.spr.material.opacity = 0.32 * (1 - age / 0.85);
    }
    for (const p of FX.sparks) {
      if (!p.spr.visible) continue;
      const age = (now - p.born) / 1000;
      if (age > 0.6) { p.spr.visible = false; continue; }
      p.vy -= 14 * dt;
      p.spr.position.x += p.vx * dt; p.spr.position.y += p.vy * dt; p.spr.position.z += p.vz * dt;
      p.spr.material.opacity = 0.95 * (1 - age / 0.6);
    }
  }
  function resetParticles() {
    for (const s of FX.skids) s.mesh.visible = false;
    for (const p of FX.smoke) p.spr.visible = false;
    for (const p of FX.sparks) p.spr.visible = false;
  }

  // ---- drive run: a coin-rally clock, a quick-chain combo, and a saved best time ----
  let runStart = 0, runActive = false, lastRunMs = 0, comboExpired = true;
  let combo = 0, comboExpire = 0;
  const BEST_KEY = 'dahill.drive.bestMs';
  let bestMs = parseInt((typeof localStorage !== 'undefined' && localStorage.getItem(BEST_KEY)) || '0', 10) || 0;
  const fmtTime = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function startRun(now) { if (!runActive && coinsGot < coins.length) { runActive = true; runStart = now; } }
  function emitScore(extra) { emit('driveScore', Object.assign({ got: coinsGot, total: coins.length, best: bestMs, bestStr: bestMs ? fmtTime(bestMs) : '', combo, trip: tripScore }, extra)); }
  function collectCoin(now) {
    if (audio.sfxChime) audio.sfxChime(combo >= 2 ? [784, 1047, 1319] : [784, 1047]);
    startRun(now);
    combo = (!comboExpired && now < comboExpire) ? combo + 1 : 1;   // chain within 4s to ramp it
    comboExpire = now + 4000; comboExpired = false;
    comboFx(now);
    // First coin teaches the loop: tell the kid what the coins are FOR (a time trial).
    if (coinsGot === 1 && coins.length > 1) toast('💛 First coin! Grab them all for a time trial 🏁', 1600);
    let finishMs = 0;
    if (coinsGot >= coins.length) {                                // rally complete → stop clock, save best
      runActive = false; lastRunMs = now - runStart; finishMs = lastRunMs;
      if (!bestMs || lastRunMs < bestMs) { bestMs = lastRunMs; try { localStorage.setItem(BEST_KEY, String(bestMs)); } catch (e) { } }
    }
    emitScore({ finishMs });
  }
  // combo crescendo: a chain that's BUILDING should look and sound like it (was silent
  // — x7 read the same as x2). Escalates at 3 and 5+.
  let comboPeak = 0;
  function comboFx(now) {
    if (combo <= comboPeak) { if (combo < 2) comboPeak = 0; return; }
    comboPeak = combo;
    if (combo === 3) { toast('🔥 Combo ×3!', 1100); if (audio.sfxWhoosh) audio.sfxWhoosh(0.6); }
    else if (combo === 5) { toast('🔥🔥 ON FIRE! ×5', 1500); if (audio.sfxChime) audio.sfxChime([784, 988, 1319, 1568]); if (ui.fx && !reduceMotion) { ui.fx.classList.add('arrive'); setTimeout(() => ui.fx && ui.fx.classList.remove('arrive'), 420); } }
    else if (combo >= 8 && combo % 3 === 2) { toast('🔥🔥🔥 UNSTOPPABLE! ×' + combo, 1500); }
  }
  function resetRun() { runActive = false; runStart = 0; lastRunMs = 0; combo = 0; comboExpired = true; tripScore = 0; }   // tripScore resets per drive so combo/score chips start clean (was carrying over)
  // close-call reward: skim a tree/animal/car at speed without hitting it → ramp the
  // same combo, a whoosh, and a 'Close!' beat. Turns every hazard into a thrill.
  let lastNearT = -1e9, driftState = false, driftAccum = 0;
  function nearMiss(now) {
    if (now - lastNearT < 650) return;
    lastNearT = now;
    combo = (!comboExpired && now < comboExpire) ? combo + 1 : 1;
    comboExpire = now + 4000; comboExpired = false;
    tripScore += 40 + combo * 20; addBoost(0.13);
    if (audio.sfxWhoosh) audio.sfxWhoosh(0.8);
    toast('💨 Close one!' + (combo > 1 ? ' ×' + combo : ''), 850);
    comboFx(now);
    emitScore({});
  }

  // ---- neighbourhood landmarks: the 5 real places, doubling as a "visit them all"
  // meta-goal. Driving within 45 m calls it out AND ticks lasting progress, so the
  // marquee fantasy (drive to Meemaw's / your school) finally pays off + persists. ----
  const poiSeen = new Set();   // per-session (suppress repeat toasts)
  const POI_KEY = 'dahill.drive.poisFound';
  const poiFound = new Set((() => { try { return JSON.parse(localStorage.getItem(POI_KEY) || '[]'); } catch (e) { return []; } })());
  const homeGeo = worldToGeo(house.c[0], house.c[1]);
  const POIS = [{ key: 'home', x: house.c[0], z: house.c[1], lat: homeGeo.lat, lon: homeGeo.lon, icon: '🏠', label: 'your house', msg: "👋 That's YOUR house — welcome home!" }].concat(
    [['meemaw', 37.6995618, -122.0639216, '🏡', "Meemaw's", "🏡 Meemaw's house!"],
     ['canyon', 37.7046462, -122.0524363, '🏫', 'Canyon Middle', '🏫 Canyon Middle School!'],
     ['stanton', 37.7005734, -122.0940411, '🏫', 'Stanton Elem', '🏫 Stanton Elementary!'],
     ['dad', 37.8004778, -122.2739559, '💼', 'XQ', "💼 XQ — Mike's work!"]
    ].map(([key, lat, lon, icon, label, msg]) => { const w = geoToWorld(lat, lon); return { key, x: w[0], z: w[1], lat, lon, icon, label, msg }; }));
  let tripScore = 0;
  let boost = 0, boostWas = false;                // 0..1 nitro meter — fills on skill, spends for a speed surge
  function addBoost(amt) { boost = clamp(boost + amt, 0, 1); }
  function emitPOIs() { emit('poiProgress', { found: poiFound.size, total: POIS.length }); }
  // Route the player to the nearest place they HAVEN'T found yet — turns 5 one-shot
  // discoveries into a chained road trip ("now drive to the next place!").
  function chainToNextPOI(now) {
    let best = null, bd = 1e18;
    for (const p of POIS) { if (poiFound.has(p.key)) continue; const d = Math.hypot(p.x - car.x, p.z - car.z); if (d < 35) continue; if (d < bd) { bd = d; best = p; } }   // skip the one you're at
    if (!best) return;
    autoDrive = false;
    setDestination(best.lat, best.lon, best.label, true);
    if (DEST) DEST.poiKey = best.key;   // tag so the chain only continues for places you chose
    toast('🏁 Next stop: floor it to ' + esc(best.label) + ' — follow the pink beam! 🏁', 2600);
  }
  function checkPOIs(now) {
    for (const poi of POIS) {
      if (poiSeen.has(poi.key)) continue;
      if (Math.hypot(car.x - poi.x, car.z - poi.z) < 45) {
        poiSeen.add(poi.key);
        const fresh = !poiFound.has(poi.key);
        poiFound.add(poi.key);
        try { localStorage.setItem(POI_KEY, JSON.stringify([...poiFound])); } catch (e) { }
        // fare score: a base + a speed bonus + the running combo (rewards a brisk trip)
        if (fresh && poi.key !== 'home') {
          const pts = 250 + Math.round(Math.abs(car.speed) * 4) + combo * 50;
          tripScore += pts;
          combo = (!comboExpired && now < comboExpire) ? combo + 1 : 1; comboExpire = now + 6000; comboExpired = false;
          arriveCelebrate(poi.label, pts, now);   // the finish-line moment
        } else {
          toast(poi.msg + (fresh ? '  ·  🏆 ' + poiFound.size + '/' + POIS.length : ''), 2600);
          if (audio.sfxChime) audio.sfxChime(fresh ? [659, 988, 1319] : [659, 988]);
        }
        emitScore({}); emitPOIs();
        if (poiFound.size === POIS.length && fresh) {
          checkFerrariUnlock();
          toast('🏆 ALL 5 places found! Trip score ' + tripScore + ' 🎉', 3800);
        } else if (fresh && DEST && poi.key === (DEST.poiKey || '') ) {
          // only chain the road-trip if THIS was the place you were navigating to (you
          // opted in) — never force a new route line on a free-roam drive-by.
          chainToNextPOI(now);
        }
      }
    }
  }

  // ---- POI beacons: a tall light-pillar over each real place, drawn THROUGH the world
  // (depthTest off) so you can literally SEE your school / Meemaw's from across the
  // neighbourhood and drive toward it. Pink = still to find, green = found; the nearest
  // un-found one pulses. Only in Drive, faded in by distance. ----
  const poiBeacons = POIS.map(poi => {
    const geo = new THREE.CylinderGeometry(1.6, 3.4, 160, 16, 1, true);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff5ad0, transparent: true, opacity: 0, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const m = new THREE.Mesh(geo, mat); m.position.set(poi.x, 74, poi.z); m.frustumCulled = false; m.renderOrder = 998; m.visible = false;
    scene.add(m);
    return { poi, mesh: m, mat };
  });
  // floating name-plate over each real place, so arriving somewhere has identity in-world
  function makeLabelTex(text) {
    const c = document.createElement('canvas'); c.width = 640; c.height = 140;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(10,12,16,0.62)';
    const rw = 620, rh = 110, rx = 10, ry = 15, rr = 26;   // rounded pill
    ctx.beginPath(); ctx.moveTo(rx + rr, ry); ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, rr); ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, rr); ctx.arcTo(rx, ry + rh, rx, ry, rr); ctx.arcTo(rx, ry, rx + rw, ry, rr); ctx.closePath(); ctx.fill();
    ctx.font = '700 60px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff'; ctx.fillText(text, 320, 72);
    const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4; return tex;
  }
  const poiLabels = POIS.map(poi => {
    const mat = new THREE.SpriteMaterial({ map: makeLabelTex(poi.icon + '  ' + poi.label.toUpperCase()), transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    const s = new THREE.Sprite(mat); s.position.set(poi.x, 13, poi.z); s.scale.set(26, 5.7, 1); s.frustumCulled = false; s.renderOrder = 999; s.visible = false;
    scene.add(s);
    return { poi, spr: s, mat };
  });

  // ---- ambient TRAFFIC: simple cars roaming the neighbourhood roads, so there's
  // finally something alive to weave through. They feed the near-miss/combo economy
  // and bounce on contact. Lives only on the ±330 m procedural street network. ----
  const modelLoadCancels = [];
  const traffic = [];
  {
    const tSegs = roadSegs.filter(s => Math.hypot((s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2) < 700 && Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) > 3);   // wider radius so the bigger pool covers outer streets too
    const cols = [0xb53a32, 0x2f5fb0, 0xd9d9d9, 0x2a2a2a, 0xd6a52e, 0x3f9e63, 0x8a8f96];
    const bodyGeo = new THREE.BoxGeometry(1.9, 1.0, 4.0), cabGeo = new THREE.BoxGeometry(1.6, 0.72, 1.9);
    // shared materials: one cab + 7 body colours, reused across all cars (was 22 clones)
    const bodyMats = cols.map(c => new THREE.MeshStandardMaterial({ color: c, metalness: 0.35, roughness: 0.55 }));
    const cabMat = new THREE.MeshStandardMaterial({ color: 0x1b2735, metalness: 0.2, roughness: 0.35 });
    for (let i = 0; i < TRAFFIC_MAX && tSegs.length; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, bodyMats[i % bodyMats.length]); body.position.y = 0.6; body.castShadow = true;
      const cab = new THREE.Mesh(cabGeo, cabMat); cab.position.set(0, 1.18, -0.25);
      g.add(body); g.add(cab); g.frustumCulled = false; g.visible = false; scene.add(g);
      const seg = tSegs[(i * 9 + 3) % tSegs.length];
      traffic.push({ group: g, box: [body, cab], a: seg[0], b: seg[1], t: (i * 0.21) % 1, speed: 6 + (i % 4) * 2.0, near: false, ti: i });
    }
    traffic._segs = tSegs;
    // upgrade the placeholder boxes to REAL (cloned) car models once they load — a few
    // normal neighbourhood cars spread across the fleet; clones share geometry (cheap).
    // flip:false → the proto's nose sits at +Z so the group's atan2(dx,dz) points it
    // ALONG travel (flip:true pointed every NPC backwards). KEEP each model's real textured
    // paint — just lift it OUT of the dim photogrammetry so it isn't near-black: drop the
    // metalness (metal with no env map renders black) and add a self-emissive copy of the
    // surface (emissiveMap = the texture) so the car reads bright while keeping ALL its
    // texture detail. (The earlier flat-colour recolour is exactly what looked "lame".)
    [[rav4Url, 4.6], [miniUrl, 3.85], [granviaUrl, 5.1]].forEach((def, mi, defs) => {
      modelLoadCancels.push(loadCarProto(def[0], def[1], false, proto => {
        for (let i = mi; i < traffic.length; i += defs.length) {
          const c = traffic[i];
          for (const m of c.box) c.group.remove(m);     // drop the box
          const inst = proto.clone(true);
          inst.traverse(o => {
            if (!o.isMesh) return;
            o.castShadow = false;
            const single = !Array.isArray(o.material);
            const arr = single ? [o.material] : o.material;
            const out = arr.map(m => {
              if (!m) return m;
              const mm = m.clone();                       // own material (cheap; keeps the texture map)
              if (mm.metalness !== undefined) mm.metalness = Math.min(mm.metalness, 0.25);   // not env-map-dependent black
              if (mm.emissive) {
                if (mm.map) { mm.emissiveMap = mm.map; mm.emissive.setHex(0x8a8a8a); mm.emissiveIntensity = 0.5; }   // glow the TEXTURE itself
                else if (mm.color) { mm.emissive.copy(mm.color).multiplyScalar(0.45); mm.emissiveIntensity = 0.55; }   // no texture → lift its own colour
              }
              return mm;
            });
            o.material = single ? out[0] : out;
          });
          c.group.add(inst);
        }
      }));
    });
  }
  function nextTrafficSeg(c) {
    const segs = traffic._segs, cand = [];
    for (const s of segs) {
      for (const pr of [[s[0], s[1]], [s[1], s[0]]]) {
        if (Math.hypot(pr[0][0] - c.b[0], pr[0][1] - c.b[1]) < 3.5 && Math.hypot(pr[1][0] - c.a[0], pr[1][1] - c.a[1]) > 4) cand.push(pr);
      }
    }
    if (cand.length) { const n = cand[Math.floor(Math.random() * cand.length)]; c.a = n[0]; c.b = n[1]; }
    else { const tmp = c.a; c.a = c.b; c.b = tmp; }   // dead end → U-turn
    c.t = 0;
  }
  let trafficTick = 0;
  function updateTraffic(dt, now) {
    if (!roadLifeOn) { hideTraffic(); return; }
    const active = trafficActiveCount();
    trafficTick++;
    for (let ci = 0; ci < traffic.length; ci++) {
      const c = traffic[ci];
      if (ci >= active) { if (c.group.visible) c.group.visible = false; continue; }   // parked by the density slider
      const dx = c.b[0] - c.a[0], dz = c.b[1] - c.a[1], len = Math.hypot(dx, dz) || 1;
      const fdx = dx / len, fdz = dz / len, rgx = fdz, rgz = -fdx;   // forward + right (for lanes)
      let cxp = c.a[0] + dx * c.t, czp = c.a[1] + dz * c.t;          // centreline point
      // YIELD: when the player is close and roughly ahead, the car slows right down (and
      // swings wide, below) so it's never an unavoidable head-on — you always have room.
      const toP = Math.hypot(car.x - cxp, car.z - czp);
      const ahead = (car.x - cxp) * fdx + (car.z - czp) * fdz;
      const yielding = toP < 28 && ahead > -6;
      const spdMul = yielding ? clamp((toP - 7) / 20, 0.06, 1) : 1;
      c.t += (c.speed * spdMul * dt) / len;
      if (c.t >= 1) { nextTrafficSeg(c); continue; }
      cxp = c.a[0] + dx * c.t; czp = c.a[1] + dz * c.t;
      // keep to the RIGHT of the centreline (a passable lane); if the player is bearing
      // down in this car's lane, swing wide to the OTHER side to clear a path.
      const pPerp = (car.x - cxp) * rgx + (car.z - czp) * rgz;       // >0 = player on the car's right
      const off = (yielding && pPerp > -1.2) ? -2.0 : 1.5;
      const x = cxp + rgx * off, z = czp + rgz * off;
      c.x = x; c.z = z;
      // GATE: cars far from the player are off-screen — hide them and skip the costly tile
      // raycast entirely (these 8 unthrottled casts were the biggest per-frame CPU chunk).
      if ((car.x - x) * (car.x - x) + (car.z - z) * (car.z - z) > 200 * 200) { c.group.visible = false; continue; }
      c.group.visible = true;
      // Use the SAME height authority as the player car. Raw groundAt follows the
      // bumpy photogrammetry mesh near home while the player rides the smooth
      // terrain road, which made traffic visibly float/sink on a different surface.
      // Keep the staggered refresh so only a few traffic cars sample tiles per frame.
      if (c.gy === undefined || (trafficTick + c.ti) % 4 === 0) c.gyT = actorGroundY(x, z, c.gy) + 0.05;
      c.gy = c.gy === undefined ? c.gyT : c.gy + (c.gyT - c.gy) * Math.min(1, dt * 6);
      c.group.position.set(x, c.gy, z);
      c.group.rotation.set(0, Math.atan2(dx, dz), 0);
    }
  }
  function hideTraffic() { for (const c of traffic) c.group.visible = false; }
  function updateBeacons(now) {
    let nearestKey = null, nd = 1e18;
    for (const b of poiBeacons) { if (poiFound.has(b.poi.key)) continue; const d = Math.hypot(b.poi.x - car.x, b.poi.z - car.z); if (d < nd) { nd = d; nearestKey = b.poi.key; } }
    for (const b of poiBeacons) {
      const d = Math.hypot(b.poi.x - car.x, b.poi.z - car.z);
      const show = d > 16 && d < 1200;                // hide once you're basically there
      b.mesh.visible = show;
      if (!show) continue;
      const found = poiFound.has(b.poi.key);
      b.mat.color.setHex(found ? 0x6dffa8 : 0xff7ad8);
      const fade = clamp((d - 16) / 55, 0, 1) * clamp(1 - (d - 260) / 940, 0.3, 1);   // strong near, fades far
      const pulse = (b.poi.key === nearestKey && !reduceMotion) ? 0.7 + 0.3 * Math.sin(now * 0.006) : 0.8;
      b.mat.opacity = fade * 0.95 * pulse;
    }
    // name-plates: legible only when you're close enough to actually be AT the place
    for (const l of poiLabels) {
      const d = Math.hypot(l.poi.x - car.x, l.poi.z - car.z);
      const show = d < 170;
      l.spr.visible = show;
      if (!show) continue;
      l.mat.color.setHex(poiFound.has(l.poi.key) ? 0x9bf3bb : 0xffffff);
      l.mat.opacity = clamp(1 - (d - 60) / 110, 0, 1);
    }
  }
  function hideBeacons() { for (const b of poiBeacons) b.mesh.visible = false; for (const l of poiLabels) l.spr.visible = false; }

  // the finish-line moment: a big gold burst, a fanfare, a beat of slow-mo + flash, and
  // an 'ARRIVED' card. Fires for reaching a real place (or any nav destination).
  let arriveCenterT = 0;   // while now < this, the drive cams zero their look-ahead so the car frames dead-centre on arrival
  function arriveCelebrate(label, points, now) {
    arriveCenterT = now + 2600;
    const y = car.group ? car.group.position.y : 1;
    for (let k = 0; k < 4; k++) spawnCoinBurst(car.x + (k - 1.5) * 1.2, car.z, y, now);   // ~24 sparks
    if (audio.sfxChime) audio.sfxChime([523, 659, 784, 1047, 1319]);
    addBoost(0.5);                                     // arriving fills a big chunk of nitro for the next leg
    if (!reduceMotion) {
      timeScale = 0.4; slowmoHold = 0.32;             // HELD slow-mo (then it eases back) — a real beat, not a blink
      if (ui.fx) { ui.fx.classList.add('arrive'); setTimeout(() => ui.fx && ui.fx.classList.remove('arrive'), 850); }
    }
    // a second triumphant spark wave a beat later
    setTimeout(() => {
      if (mode !== 'drive') return;
      const y2 = car.group ? car.group.position.y : 1;
      for (let k = 0; k < 3; k++) spawnCoinBurst(car.x + (k - 1) * 1.6, car.z, y2, performance.now());
      if (audio.sfxChime) audio.sfxChime([784, 1047, 1319, 1568]);
    }, 280);
    emit('arrived', { label, points: points || 0, trip: tripScore });
  }

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
  // Compost pin: a green pin over the compost bin shown while the keeper is carrying
  // poop, so the empty-here loop is obvious (drawn through walls from anywhere).
  const compostMarker = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.7, 4),
    new THREE.MeshBasicMaterial({ color: 0x3a7d44, depthTest: false, transparent: true, opacity: 0.92 }));
  compostMarker.rotation.x = Math.PI; compostMarker.renderOrder = 20; compostMarker.visible = false; compostMarker.frustumCulled = false;
  scene.add(compostMarker);
  // ---- House interior (Scoop sub-scene) ----
  // The interior loads lazily and is mounted FAR from the yard (~2 km). Scoop's tight fog
  // (near 38 / far 92) hides the distant yard so the indoor camera only ever frames the room —
  // no per-object yard hide needed. scoopScene forks updateScoop between 'yard' and 'interior'.
  let scoopScene = 'yard', interior = null, doorT = 0, entryArmed = true, exitArmed = false;
  let npcs = [], npcsLoadStarted = false;   // non-playable house NPCs (dad, mom) — walk out of rooms + dance, never playable
  const NPC_LOADERS = [loadDadController, loadMomController];
  let _syncDance = false, _syncDanceUntil = 0, _syncDanceNext = 0;   // periodic in-house "everybody dance the SAME thing" moment
  const SYNC_DANCES = ['All_Night_Dance'];   // clip Dad + Mom both carry, so a pose() on all of them actually lines up
  const INT_CX = 0, INT_CZ = 3000, INT_FLOOR = 0;
  // Blue glowing pads: the front-yard "enter" pad and the indoor "exit" pad (drawn through walls).
  const doorMarker = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.7, 4),
    new THREE.MeshBasicMaterial({ color: 0x49b0ff, depthTest: false, transparent: true, opacity: 0.92 }));
  doorMarker.rotation.x = Math.PI; doorMarker.renderOrder = 20; doorMarker.visible = false; doorMarker.frustumCulled = false;
  scene.add(doorMarker);
  const exitMarker = new THREE.Mesh(doorMarker.geometry, doorMarker.material.clone());
  exitMarker.rotation.x = Math.PI; exitMarker.renderOrder = 20; exitMarker.visible = false; exitMarker.frustumCulled = false;
  scene.add(exitMarker);
  // Flat blue "exit pad" ring on the floor (the floating cone sits overhead, easy to miss when you
  // spawn standing on it) — drawn through walls so it's findable from anywhere inside.
  const exitRing = new THREE.Mesh(new THREE.RingGeometry(0.55, 1.05, 32),
    new THREE.MeshBasicMaterial({ color: 0x49b0ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: false }));
  exitRing.rotation.x = -Math.PI / 2; exitRing.renderOrder = 19; exitRing.visible = false; exitRing.frustumCulled = false;
  scene.add(exitRing);
  // Address guide: a ground-draped ribbon that FOLLOWS THE ROUTE through its turns — a
  // real navigation line over the road, not a single rotating bar. The geometry is a
  // triangle-strip rebuilt each frame from the route polyline just ahead of the car,
  // resampled + draped to the ground and drawn on top so road bumps don't hide it.
  const GUIDE_N = 90;                                   // max cross-sections (~5 m apart)
  const guidePos = new Float32Array(GUIDE_N * 2 * 3);
  const guideGeo = new THREE.BufferGeometry();
  guideGeo.setAttribute('position', new THREE.BufferAttribute(guidePos, 3).setUsage(THREE.DynamicDrawUsage));
  { const idx = []; for (let i = 0; i < GUIDE_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } guideGeo.setIndex(idx); }
  // depthTest TRUE so the solid CAR (and hills/buildings) occlude the ribbon — the car
  // drives OVER the line, the line never paints on top of the car. depthWrite stays off so
  // it doesn't disturb other transparent sorting.
  const guideLine = new THREE.Mesh(guideGeo, new THREE.MeshBasicMaterial({ color: 0x28c9ff, transparent: true, opacity: 0.82, depthWrite: false, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide }));
  guideLine.renderOrder = 6; guideLine.visible = false; guideLine.frustumCulled = false;
  scene.add(guideLine);
  const destPin = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.4, 4),
    new THREE.MeshBasicMaterial({ color: 0xffc21e, depthTest: false, transparent: true, opacity: 0.95 }));
  destPin.rotation.x = Math.PI; destPin.renderOrder = 21; destPin.visible = false; destPin.frustumCulled = false;
  scene.add(destPin);
  // "You are here" locator — a bright downward chevron + halo bobbing over the car, drawn
  // on top, so you can FIND the car in the high aerial / top-down views where it's tiny.
  const carLocator = new THREE.Group();
  { const cone = new THREE.Mesh(new THREE.ConeGeometry(1.9, 3.6, 4), new THREE.MeshBasicMaterial({ color: 0x3ad6ff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.92 }));
    cone.rotation.x = Math.PI; cone.renderOrder = 1001;
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.4, 28), new THREE.MeshBasicMaterial({ color: 0x3ad6ff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = -3.2; ring.renderOrder = 1000;
    carLocator.add(cone); carLocator.add(ring); }
  carLocator.frustumCulled = false; carLocator.visible = false; scene.add(carLocator);

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
      const post = asNonIndexed(new THREE.BoxGeometry(0.13, 1.15, 0.13)); post.translate(x0, py + 0.57, z0);
      parts.push({ g: post, color: woodC });
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, len = Math.hypot(x1 - x0, z1 - z0), yaw = Math.atan2(x1 - x0, z1 - z0), my = terrainAt(mx, mz);
      for (const ry of [0.42, 0.9]) {
        const rail = asNonIndexed(new THREE.BoxGeometry(0.05, 0.09, len * 1.04));
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
  let _tilesUpdT = 0;   // throttle the (expensive, full-tree) tiles LOD traversal to ~18 Hz
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
    // Inside the procedural neighborhood (±330 m) the FLAT heightfield is ground
    // truth — ride it DIRECTLY. That's the whole point of the game: keep the
    // photoreal tiles fully VISIBLE for the high-res look, but drive on smooth,
    // aligned terrain with no photogrammetry bumps — no lumps under parked cars,
    // no climbing trees/curbs/roofs. (Bonus: skips the per-sample tile raycasts in
    // the common near-home case, so it's cheaper too.)
    if (x * x + z * z <= 330 * 330) return tA;
    // Far out, beyond the heightfield, there's no procedural topology to ride, so
    // follow the real photoreal ROAD. Cast DOWN from just above the actor's roof:
    // a tree canopy / eave ABOVE the car is skipped (the ray starts beneath it), so
    // we read the road under the foliage, not the leaves. Retry from progressively
    // higher only when that misses — i.e. the road climbed above the car (steep
    // hill / onto a bridge), the one case we DO want to follow upward.
    const base = prevY != null ? prevY : tA;
    let y = rawTileY(x, z, base + 2.2);
    if (y == null) y = rawTileY(x, z, base + 10);
    if (y == null && prevY != null) y = rawTileY(x, z, base + 26);
    if (y == null && prevY == null) y = rawTileY(x, z);
    if (y == null) return prevY != null ? prevY : tA;             // tile not streamed yet: hold height
    // Out here terrainAt is just a clamped edge value — useless as a reference — so
    // bound by CONTINUITY instead: a real road never steps UP more than ~1.5 m
    // between samples, but a photogrammetry tree/roof blob does, so reject the
    // sudden climb (ride the surface beneath it) while letting the car settle
    // downhill freely. This is what keeps the car off the treetops out on the open
    // road, where there's no procedural topology to clamp against.
    return prevY != null ? clamp(y, prevY - 6, prevY + 1.5) : y;
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
  // ---- tile prefetch ----------------------------------------------------------
  // A small, low-res "scout" camera swept ALONG the active route ahead of the car so the
  // Google tiles for where you're GOING stream into the cache before you arrive (and the
  // ground-height probe ahead has data). Only on while a destination is set — exactly when
  // you're driving somewhere far — so free-roam near home pays nothing. Low resolution means
  // it warms only cheap COARSE tiles, filling the LRU cache without blowing the mobile budget.
  const scoutCam = new THREE.PerspectiveCamera(60, 1.5, 1, 4000);
  let scoutOn = false, _scoutT = 0, _scoutPhase = 0;
  function pointAlongRoute(dist) {
    if (!ROUTE || ROUTE.length < 2) return null;
    let px = car.x, pz = car.z, acc = 0;
    for (let i = Math.max(0, routeIdx); i < ROUTE.length; i++) {
      const dx = ROUTE[i].x - px, dz = ROUTE[i].z - pz, seg = Math.hypot(dx, dz) || 1e-3;
      if (acc + seg >= dist) { const t = (dist - acc) / seg; return { x: px + dx * t, z: pz + dz * t }; }
      acc += seg; px = ROUTE[i].x; pz = ROUTE[i].z;
    }
    return { x: px, z: pz };
  }
  function setScout(on) {
    if (on === scoutOn || !p3dtiles) return;
    scoutOn = on;
    if (on) { p3dtiles.setCamera(scoutCam); p3dtiles.setResolution(scoutCam, 360, 240); }
    else if (p3dtiles.deleteCamera) p3dtiles.deleteCamera(scoutCam);
  }
  function updateTilePrefetch(now) {
    if (!p3dtiles || mode !== 'drive' || !p3dtiles.holder.visible || !DEST || !ROUTE || ROUTE.length < 2) { setScout(false); return; }
    if (now - _scoutT < 220) return;                       // ~4.5 Hz
    _scoutT = now;
    setScout(true);
    _scoutPhase = (_scoutPhase + 1) % 6;                   // sweep the aim through the corridor ahead…
    const p = pointAlongRoute(90 + _scoutPhase * 135);     // …≈90–765 m along the route (reach matches the faster rail cruise)
    if (!p) { setScout(false); return; }
    const gy = car.groundY != null ? car.groundY : 0;
    scoutCam.up.set(0, 0, -1);
    scoutCam.position.set(p.x, gy + 260, p.z);             // high, straight down → warms the ground tiles ahead
    scoutCam.lookAt(p.x, gy, p.z);
    scoutCam.updateMatrixWorld(true);
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
    if (p3dtiles && p3dtiles.clipPlanes && mode !== 'drive') p3dtiles.clipPlanes.length = 0;   // R8 cutaway is Drive-only; never slice the Explore high-orbit / Scoop
    staticGroup.visible = mode === 'scoop' || !photoOn;   // procedural in Scoop, or as the no-tiles fallback
    carsGroup.visible = mode === 'drive' || mode === 'scoop';   // parked cars: ground modes only
    if (ring) ring.visible = mode === 'explore';   // marker only makes sense from the air
    // SHADOWS only in Scoop: in Drive/Explore the procedural receivers are hidden and the
    // Google tiles are MeshBasicMaterial (can't receive), so a full extra depth pass each
    // frame would render onto nothing. Gate the whole shadow pass off there.
    sun.castShadow = (mode === 'scoop') && !LITE;
    vehicleFill.visible = mode === 'drive';
    renderer.shadowMap.enabled = sun.castShadow;
    if (sun.castShadow) renderer.shadowMap.needsUpdate = true;
  }
  function delayedTileFallbackToast(msg) {
    setTimeout(() => { if (!disposed && photoModes(mode) && !tilesReady) toast(msg, 2600); }, 6100);
  }
  if (!flags.has('flat')) {
    if (!import.meta.env.VITE_GOOGLE_MAPS_KEY) delayedTileFallbackToast('Photoreal map key missing — showing the built world');
    const LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * DEG);
    const houseLat = (LAT0 + C[1] / 110540) * DEG;
    const houseLon = (LON0 + C[0] / (COSLAT * 111320)) * DEG;
    import('./tiles3d.js').then(({ createPhotorealTiles }) => {
      if (disposed) return;
      p3dtiles = createPhotorealTiles(scene, camera, renderer, {
        // raise errorTarget on phones (coarser tiles) — leaf-tile geometry/texture
        // is the dominant iOS memory cost, and Drive can now roam far and stream more.
        lat: houseLat, lon: houseLon, azimuth: Math.PI, errorTarget: MOBILE ? 16 : 10, mobile: MOBILE
      });
      if (!p3dtiles) { if (import.meta.env.VITE_GOOGLE_MAPS_KEY) delayedTileFallbackToast('Photoreal map unavailable — showing the built world'); return; }
      if (disposed) { if (p3dtiles.disposeAll) p3dtiles.disposeAll(); p3dtiles = null; return; }
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
    }).catch(e => { console.warn('[tiles3d] import failed; staying procedural', e); delayedTileFallbackToast('Photoreal map unavailable — showing the built world'); });
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

  // ---- CROWD: dancing CeCe + Drew characters. Yard dancers liven up Scoop; street
  // dancers + clusters at every preset destination liven up Drive. Visibility is mode- and
  // distance-gated so only a handful animate at once (skinned meshes aren't cheap).
  let ceceCrowd = null, drewCrowd = null, dadCrowd = null, momCrowd = null;
  // Pick a street/scatter pedestrian: mostly the CeCe/Drew kids, with the occasional grown-up Dad/Mom
  // mixed in (taller, distinct models). Falls back to the kids if the adult rigs haven't loaded.
  const pickPed = (i) => { const r = Math.random(); if (dadCrowd && r < 0.09) return dadCrowd; if (momCrowd && r < 0.18) return momCrowd; return (i & 1) ? ceceCrowd : drewCrowd; };
  const crowdSpots = [];   // { rec, zone }
  // Pedestrian density (settings slider): scales the spread-out pool size. 1 = default.
  let CROWD_DENSITY = (() => { try { const v = parseFloat(localStorage.getItem('dahill.peddensity')); return Number.isFinite(v) ? clamp(v, 0, 2) : 1; } catch (e) { return 1; } })();
  const CROWD_VIS_CAP = 20;       // max pedestrians visible/animating at once (skinned meshes are costly) — bounds per-frame cost no matter the pool size
  const SIDEWALK_OFF = 3.0;       // metres from the road centre out to the sidewalk
  const CROWD_POOL_CAP = 120;     // SINGLE hard cap on total persistent clones at density 1 (×D): sidewalk+scatter take POOL = cap − RESERVED, the POI/cluster/meemaw dancers take RESERVED. Visibility cap animates only the nearest 20. Bounds total boot-time SkeletonUtils.clone cost.
  let _crowdReplaceT = 0, _crowdVisT = 0;   // debounce the slider re-pool; throttle the nearest-N visibility scan
  function placeCrowd() {
    const put = (crowd, x, z, zone, onRoadHt, opts = {}) => {
      if (!crowd) return;
      // FINITE Y always: far POI clusters (schools) are placed before their photoreal tiles stream in,
      // so actorGroundY() there returns NaN. A NaN baseY is sticky (settle's lerp keeps it NaN forever),
      // so those dancers never appeared. Fall back to a finite height now; settleCrowdSpot snaps them to
      // the real ground the moment you arrive and the tiles are loaded.
      const gy = onRoadHt ? actorGroundY(x, z) : terrainAt(x, z);
      const y = (Number.isFinite(gy) ? gy : (car.groundY ?? 0)) + 0.02;
      const yaw = opts.yaw != null ? opts.yaw : Math.random() * Math.PI * 2;
      crowdSpots.push({ rec: crowd.add(scene, { x, y, z, yaw, clip: opts.clip }), zone, onRoadHt: !!onRoadHt, settleT: 0 });
    };
    const hx = house.c[0], hz = house.c[1];
    // Keep a yard dancer out of any building footprint: if the ring spot lands inside a
    // wall (the house/garage), walk it OUTWARD from the yard centre until it's on open
    // ground (CeCe was spawning inside the houses).
    const clearYard = (x, z) => {
      if (!insideScoopBuilding(x, z)) return [x, z];
      let dx = x - hx, dz = z - hz; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
      for (let r = d + 2; r < d + 22; r += 1.5) { const nx = hx + dx * r, nz = hz + dz * r; if (!insideScoopBuilding(nx, nz)) return [nx, nz]; }
      return [x, z];
    };
    // YARD (Scoop): a few CeCes + Drews dancing around the front yard (clear of the walls)
    for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2 + 0.5, r = 6 + i * 1.6; const [px, pz] = clearYard(hx + Math.cos(a) * r, hz + Math.sin(a) * r); put(ceceCrowd, px, pz, 'yard', false); }
    for (let i = 0; i < 2; i++) { const a = i * 2.3 + 1.6; const [px, pz] = clearYard(hx + Math.cos(a) * 8.5, hz + Math.sin(a) * 8.5); put(drewCrowd, px, pz, 'yard', false, { clip: 'dance' }); }
    // STREETS (Drive): walk EVERY drivable road segment and drop pedestrians along its whole
    // length, on randomized sidewalk offsets and either side — so they line the sidewalks
    // across the WHOLE neighbourhood, not just near home. Denser slider → smaller spacing.
    const D = CROWD_DENSITY;
    const cn = Math.min(20, Math.round(16 * D));                 // school-cluster size (also used below); hoisted so it counts against the cap
    const RESERVED = (D > 0 ? 18 : 0) + cn * 2 + Math.min(8, cn) + (D > 0 ? 2 : 0);   // POI dancers (18) + 2 school clusters + XQ Mike cluster + meemaw pair — reserved out of the single cap
    const POOL = Math.max(0, Math.round(CROWD_POOL_CAP * D) - RESERVED);   // sidewalk+scatter share of ONE hard clone cap (keeps total boot clones ≈ CROWD_POOL_CAP×D)
    let placed = 0;
    if (D > 0 && POOL > 0) {
      // Spacing is derived from the TOTAL curb length so the sidewalk pass spreads its share
      // EVENLY across the whole hood instead of clustering near the first segments and hitting
      // the cap there. ~70% of the pool lines sidewalks; the rest scatters on open ground.
      const sidewalkTarget = Math.round(POOL * 0.7);
      let totalCurb = 0;
      for (const s of roadSegs) { const L = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]); if (L >= 6) totalCurb += L; }
      const step = totalCurb > 0 ? Math.max(12, totalCurb / Math.max(1, sidewalkTarget)) : 1e9;
      for (const s of roadSegs) {
        if (placed >= sidewalkTarget) break;
        const ax = s[0][0], az = s[0][1], bx = s[1][0], bz = s[1][1];
        const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
        if (L < 6) continue;                                         // skip stubs
        const ux = dx / L, uz = dz / L, nx = -uz, nz = ux;           // unit-along + unit-normal
        for (let t = step * 0.5; t < L && placed < sidewalkTarget; t += step) {
          const jt = clamp(t + (Math.random() - 0.5) * step * 0.5, 0, L);   // jitter along the curb
          const cx = ax + ux * jt, cz = az + uz * jt;
          const side = Math.random() < 0.5 ? 1 : -1;                 // random side each time
          const off = SIDEWALK_OFF + Math.random() * 1.4;
          const px = cx + nx * side * off, pz = cz + nz * side * off;
          if (insideBuilding(px, pz) || insideScoopBuilding(px, pz)) continue;
          const crowd = pickPed(placed);
          put(crowd, px, pz, 'street', true, { yaw: Math.atan2(-nx * side, -nz * side) });   // face the road
          placed++;
        }
      }
      // SCATTER: fill the rest of the pool with random open-ground spots across the whole hood
      // (yards/parks/verges) so pedestrians aren't only on the curb. Bounded by the same POOL.
      for (let i = 0; placed < POOL && i < POOL * 3; i++) {
        const px = (Math.random() - 0.5) * 600, pz = (Math.random() - 0.5) * 600;   // ≤ ±300 = the flat field
        if (Math.hypot(px, pz) < 28) continue;                       // not on top of the house
        if (insideBuilding(px, pz) || insideScoopBuilding(px, pz)) continue;
        put(pickPed(placed), px, pz, 'street', false);
        placed++;
      }
    }
    // DESTINATIONS (Drive): every preset stop gets Drew/Cece right on or beside
    // the arrival point, so there is something visible and hittable when you get there.
    POIS.forEach((p, pi) => {
      const count = p.key === 'home' ? 2 : 4;
      for (let i = 0; i < count; i++) {
        const a = pi * 0.7 + i / count * Math.PI * 2 + 0.35;
        const r = p.key === 'home' ? 5.5 + i * 1.4 : 1.3 + (i % 2) * 2.9;
        const crowd = (i + pi) % 2 ? ceceCrowd : drewCrowd;
        put(crowd, p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, p.key, true, {
          yaw: a + Math.PI,
          clip: crowd === drewCrowd ? (i % 2 ? 'dance' : 'cheer') : undefined
        });
      }
    });
    // FEATURE CLUSTERS: CeCe takes over Stanton, Drew takes over Canyon — TONS of them spread
    // ALL OVER each school: actorGroundY rides whatever photoreal surface is under each spot, so a
    // tight spawn lands them up ON THE ROOF, a mid radius fills the PARKING LOT / grounds, and the
    // wide edge reaches the ROAD nearby. They auto-cycle their dance pool once visible.
    const scatterCluster = (crowd, p, n, clip) => {
      if (!crowd || !p) return;
      for (let i = 0; i < n; i++) {
        const onRoof = i % 5 === 0;                                       // ~1 in 5 lands on the building itself → up on the roof
        const r = onRoof ? Math.random() * 8 : 10 + Math.random() * 78;   // roof cluster ↔ grounds ↔ all the way out to the ROAD frontage (~80 m) where the car parks
        const a = i * 2.39996323 + (Math.random() - 0.5) * 0.7;           // golden-angle spread so they ring the whole site
        put(crowd, p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, p.key, true, { yaw: a + Math.PI, clip });
      }
    };
    scatterCluster(ceceCrowd, POIS.find(q => q.key === 'stanton'), cn, 'All_Night_Dance');   // CeCe all over Stanton Elementary (cn hoisted above, counted against the cap)
    scatterCluster(drewCrowd, POIS.find(q => q.key === 'canyon'), cn, 'dance');               // Drew all over Canyon Middle
    scatterCluster(dadCrowd, D > 0 ? POIS.find(q => q.key === 'dad') : null, Math.min(8, cn), 'Bass_Beats');   // a few Mikes hanging around XQ (Dad's work)
    // MEEMAW: a CeCe + Drew pair dancing together right out front of the house.
    const meemaw = D > 0 ? POIS.find(q => q.key === 'meemaw') : null;
    if (meemaw) {
      const a = Math.PI / 2, r = 7;   // out the front, side by side, facing back toward the house
      const fx = meemaw.x + Math.cos(a) * r, fz = meemaw.z + Math.sin(a) * r;
      put(ceceCrowd, fx - 1.2, fz, 'meemaw', true, { yaw: a + Math.PI, clip: 'All_Night_Dance' });
      put(drewCrowd, fx + 1.2, fz, 'meemaw', true, { yaw: a + Math.PI, clip: 'dance' });
    }
    placeInteriorDancers();   // the decorative Drew + CeCe inside the house (survives a density re-pool)
  }
  // Remove every placed pedestrian (stop mixers, detach groups, drop the clone pool) so a
  // density change can re-place from scratch without leaking clones/mixers.
  function clearCrowd() {
    for (const sp of crowdSpots) { if (sp.rec.grp.parent) sp.rec.grp.parent.remove(sp.rec.grp); sp.rec.mixer.stopAllAction(); }
    crowdSpots.length = 0;
    if (ceceCrowd) ceceCrowd.removeAll(); if (drewCrowd) drewCrowd.removeAll();
    if (dadCrowd) dadCrowd.removeAll(); if (momCrowd) momCrowd.removeAll();
  }
  function setCrowdDensity(v) {
    CROWD_DENSITY = clamp(+v || 0, 0, 2);
    try { localStorage.setItem('dahill.peddensity', String(CROWD_DENSITY)); } catch (e) { }
    // DEBOUNCE the re-pool: a slider drag fires every step, and clearCrowd()+placeCrowd()
    // re-clones the whole pedestrian pool (skinned-mesh clones) — doing that per step stalls the
    // main thread. Re-pool once, ~220 ms after the drag settles.
    clearTimeout(_crowdReplaceT);
    _crowdReplaceT = setTimeout(() => { if (!disposed && ceceCrowd && drewCrowd) { clearCrowd(); placeCrowd(); } }, 220);
    return CROWD_DENSITY;
  }
  let _crowdN = 0, _crowdPlaced = false, _placedNoAdults = false;
  const _doPlace = () => { if (disposed || _crowdPlaced || !(ceceCrowd && drewCrowd)) return; _crowdPlaced = true; _placedNoAdults = !(dadCrowd && momCrowd); placeCrowd(); geocodePOIs(); };
  const _onCrowd = () => {
    if (disposed) return;
    _crowdN++;
    if (!_crowdPlaced) { if (_crowdN >= 4) _doPlace(); return; }   // wait for all four rigs so Dad/Mom are mixed in from the FIRST placement (no slider needed)
    // If the 9 s fallback placed a kids-only crowd before the adult rigs loaded, re-pool ONCE (debounced,
    // same path as the density slider) when both Dad + Mom finally arrive so they aren't absent all session.
    if (_placedNoAdults && dadCrowd && momCrowd) { _placedNoAdults = false; clearTimeout(_crowdReplaceT); _crowdReplaceT = setTimeout(() => { if (!disposed && ceceCrowd && drewCrowd) { clearCrowd(); placeCrowd(); } }, 220); }
  };
  if (!flags.has('nochar')) {
    loadCeceCrowd(c => { if (!disposed) ceceCrowd = c; _onCrowd(); }, () => _onCrowd());
    loadDrewCrowd(c => { if (!disposed) drewCrowd = c; _onCrowd(); }, () => _onCrowd());
    loadDadCrowd(c => { if (!disposed) dadCrowd = c; _onCrowd(); }, () => _onCrowd());
    loadMomCrowd(c => { if (!disposed) momCrowd = c; _onCrowd(); }, () => _onCrowd());
    setTimeout(() => _doPlace(), 9000);   // …but don't let a slow Dad/Mom rig hold the whole crowd hostage
  } else geocodePOIs();
  let _crowdHitT = 0;
  function hideCrowd() {
    for (const sp of crowdSpots) sp.rec.grp.visible = false;
  }
  function settleCrowdSpot(sp, dt) {
    if (!sp.onRoadHt || sp.rec.vel) return;
    sp.settleT = (sp.settleT || 0) + dt;
    if (sp.settleT < 0.25) return;   // pedestrians barely move; re-raycast ground height ~4 Hz, not ~12 Hz — cuts the per-frame tile-raycast cost on mobile (the big snap on relocate/arrival is instant regardless)
    sp.settleT = 0;
    const y = actorGroundY(sp.rec.x, sp.rec.z, sp.rec.baseY) + 0.02;
    if (!Number.isFinite(y)) return;
    // SNAP on the first valid ground (baseY was a NaN/placeholder) or a big jump (just relocated /
    // arrived at a far cluster); otherwise ease, to smooth small bumps. Without the snap a placeholder
    // baseY never converged (NaN) and the dancers stayed invisible underground.
    if (!Number.isFinite(sp.rec.baseY) || Math.abs(y - sp.rec.baseY) > 5) sp.rec.baseY = y;
    else sp.rec.baseY += (y - sp.rec.baseY) * Math.min(1, dt * 5);
    if (!sp.rec.vel) sp.rec.grp.position.y = sp.rec.baseY;
  }
  // Re-home a culled STREET pedestrian onto a local road near the car, so the street pool FOLLOWS the
  // car and pedestrians populate every street as the map streams in (instead of all sitting back at
  // home, culled). Uses the OSM road graph far from home, the procedural roads near it; scatters on open
  // ground if no road is handy. No raycast here — settleCrowdSpot snaps the height when it turns visible.
  function relocateStreetSpot(sp) {
    const fromHome = Math.hypot(car.x, car.z);
    const segs = (fromHome < 340 && roadSegs.length) ? roadSegs : (osmRoadSegs.length ? osmRoadSegs : roadSegs);
    let nx = null, nz = null;
    if (segs && segs.length) {
      for (let tr = 0; tr < 8; tr++) {
        const s = segs[(Math.random() * segs.length) | 0];
        const ax = s[0][0], az = s[0][1], bx = s[1][0], bz = s[1][1];
        const sdx = bx - ax, sdz = bz - az, L = Math.hypot(sdx, sdz); if (L < 6) continue;
        const t = Math.random(), cx = ax + sdx * t, cz = az + sdz * t;
        const d = Math.hypot(cx - car.x, cz - car.z);
        if (d < 45 || d > 230) continue;                                   // not on top of you, within the cull radius
        const ux = sdx / L, uz = sdz / L, side = Math.random() < 0.5 ? 1 : -1;
        const off = SIDEWALK_OFF + Math.random() * 1.4;
        nx = cx + (-uz) * side * off; nz = cz + ux * side * off; break;     // out to the sidewalk
      }
    }
    if (nx == null) { const a = Math.random() * Math.PI * 2, r = 70 + Math.random() * 150; nx = car.x + Math.cos(a) * r; nz = car.z + Math.sin(a) * r; }
    const rec = sp.rec;
    rec.x = nx; rec.z = nz; rec.baseX = nx; rec.baseZ = nz;
    rec.grp.position.x = nx; rec.grp.position.z = nz;
    rec.baseY = (Number.isFinite(car.groundY) ? car.groundY : 0) + 0.02;    // rough; settle snaps to the real tile ground when visible. Number.isFinite guards a NaN groundY (?? lets NaN through → ped stuck underground forever)
    rec.grp.position.y = rec.baseY;
    rec.vel = null; rec.respawnAt = 0; sp.onRoadHt = true; sp.settleT = 0;
  }
  function updateCrowd(dt, now) {
    if (!crowdSpots.length) return;
    const inDrive = mode === 'drive', inScoop = mode === 'scoop';
    const wantInt = inScoop && scoopScene === 'interior';
    if (!roadLifeOn) {
      // "People + traffic" OFF hides street/yard pedestrians — but the in-house companion is gameplay,
      // not road life, so keep showing + ticking it.
      for (const sp of crowdSpots) sp.rec.grp.visible = wantInt && sp.zone === 'interior' && sp.char !== CHAR.avatar;
      if (wantInt) { if (ceceCrowd) ceceCrowd.tick(dt, now); if (drewCrowd) drewCrowd.tick(dt, now); if (dadCrowd) dadCrowd.tick(dt, now); if (momCrowd) momCrowd.tick(dt, now); }
      return;
    }
    if (inScoop) {
      for (const sp of crowdSpots) {
        // indoors: show only the companion you're NOT playing (one at a time); outdoors: the yard pair
        if (sp.zone === 'interior') sp.rec.grp.visible = wantInt && sp.char !== CHAR.avatar;
        else sp.rec.grp.visible = !wantInt && sp.zone === 'yard';
      }
    } else if (inDrive) {
      // VISIBILITY CAP: with a spread-out pool we can't animate them all (skinned meshes are
      // costly). Show only the nearest CROWD_VIS_CAP within a cull radius — bounds the per-frame
      // mixer work to N. The scan/sort itself is throttled to ~9 Hz (pedestrians barely move).
      if (now - _crowdVisT > 110) {
        _crowdVisT = now;
        const CULL2 = 240 * 240;
        const cand = [], prio = [];   // prio = POI-cluster dancers (Stanton/Canyon/XQ/Meemaw) near you — shown FIRST so the
        let _reloc = 0;               // street peds that follow the car don't eat all the slots and hide the cluster you drove to.
        for (const sp of crowdSpots) {
          if (sp.zone === 'yard' || sp.zone === 'interior') { sp.rec.grp.visible = false; continue; }
          const d2 = (sp.rec.x - car.x) ** 2 + (sp.rec.z - car.z) ** 2;
          if (d2 < CULL2) { (sp.zone === 'street' ? cand : prio).push({ sp, d2 }); continue; }
          sp.rec.grp.visible = false;
          if (sp.zone === 'street' && _reloc < 8) { relocateStreetSpot(sp); _reloc++; }   // budgeted: a few culled street peds follow you onto local roads each scan
        }
        prio.sort((a, b) => a.d2 - b.d2); cand.sort((a, b) => a.d2 - b.d2);
        let _shown = 0;
        for (const c of prio) { const v = _shown < CROWD_VIS_CAP; c.sp.rec.grp.visible = v; if (v) _shown++; }   // POI clusters first
        for (const c of cand) { const v = _shown < CROWD_VIS_CAP; c.sp.rec.grp.visible = v; if (v) _shown++; }   // then the nearest street peds
      }
      for (const sp of crowdSpots) if (sp.rec.grp.visible) settleCrowdSpot(sp, dt);   // settle ground height each frame for the visible few
    } else {
      for (const sp of crowdSpots) sp.rec.grp.visible = false;
    }
    // COMEDY: plough into a pedestrian and they cartwheel off the road (then pop back up).
    if (inDrive && Math.abs(car.speed) > 6 && now - _crowdHitT > 250) {
      const dir = Math.sign(car.speed) || 1, vx = Math.sin(car.yaw) * dir, vz = Math.cos(car.yaw) * dir, sp = Math.abs(car.speed);
      const hit = (ceceCrowd && ceceCrowd.launchNear(car.x, car.z, vx, vz, sp)) || (drewCrowd && drewCrowd.launchNear(car.x, car.z, vx, vz, sp)) || (dadCrowd && dadCrowd.launchNear(car.x, car.z, vx, vz, sp)) || (momCrowd && momCrowd.launchNear(car.x, car.z, vx, vz, sp));
      if (hit) { _crowdHitT = now; if (audio.sfxThunk) audio.sfxThunk(0.5); toast('🎳 WHEEE!', 700); if (navigator.vibrate) { try { navigator.vibrate(22); } catch (e) { } } }
    }
    if (ceceCrowd) ceceCrowd.tick(dt, now);   // tick() advances visible mixers + any in-flight launch
    if (drewCrowd) drewCrowd.tick(dt, now);
    if (dadCrowd) dadCrowd.tick(dt, now);
    if (momCrowd) momCrowd.tick(dt, now);
  }

  let disposed = false;
  const car = createCar(scene);
  function clearRouteRail() {
    car.railS = null;
    car.railSpeed = null;
    car.railEndT = 0;
    _railRoute = null;
  }
  car.group.scale.setScalar(1.1);   // the player car renders ~10% bigger
  let cancelCarLoad = null;
  // LAZY vehicle roster: each slot's GLB is only fetched when that car is actually driven (the
  // random start car at boot, or a garage pick). Unpicked cars never download — so a big garage
  // doesn't weigh down a session. Slot 2 (Ferrari) is the Draco loadRealCar path; the rest are
  // loadDrivableCar. All these GLBs run nose -Z, so flip:true points them forward.
  const CAR_DEFS = {
    0: { url: granviaUrl, length: 5.1 },
    1: { url: rav4Url, length: 4.6 },
    3: { url: mustangUrl, length: 4.9 },
    4: { url: miniUrl, length: 3.85 },
    5: { url: corvetteUrl, length: 4.6 },
    6: { url: rollsroyceUrl, length: 5.4 },
    7: { url: scgUrl, length: 4.5 },
    8: { url: battistaUrl, length: 4.8 },
    9: { url: murcielagoUrl, length: 4.7 },
    10: { url: caspitaUrl, length: 4.6 },
    11: { url: mustang65Url, length: 4.8 },                          // nose -Z like the rest → default flip
    12: { url: mini65Url, length: 3.4 },
    13: { url: hotrodUrl, length: 4.5, flip: false, extraYaw: Math.PI / 2 },   // this GLB's length runs on X → a +quarter-turn aligns the nose to travel (−π/2 pointed it backwards; +π/2 is forward)
    14: { url: ratrodUrl, length: 4.6 },
  };
  const vehLoading = new Set();
  let ferrariLoadStarted = false;
  function ensureVehicle(slot) {
    if (flags.has('nocar') || disposed) return;
    if (slot === 2) {   // Ferrari — Draco, lazy on first need (its own fallback toast)
      if (ferrariLoadStarted) return;
      ferrariLoadStarted = true;
      installDracoDecoder();
      cancelCarLoad = loadRealCar(car, carGlbUrl, () => { if (!disposed) toast('Using fallback car model'); });
      return;
    }
    if (car.models[slot] || vehLoading.has(slot)) return;   // already loaded / in flight
    const def = CAR_DEFS[slot];
    if (!def) return;
    vehLoading.add(slot);
    modelLoadCancels.push(loadDrivableCar(car, def.url, slot, {
      length: def.length, flip: def.flip !== false, black: false, extraYaw: def.extraYaw || 0, meta: VEHICLES[slot],   // default nose -Z (flip:true); extraYaw is a per-car quarter-turn for odd model axes
      onReady: (s) => { vehLoading.delete(s); emit('cars', getCars()); if (car.modelIdx === s) showCarCard(); }
    }));
  }
  if (!flags.has('nocar')) {
    installDracoDecoder();
    // START ON A RANDOM CAR: pick a random non-Ferrari roster slot as this session's default,
    // load ONLY that one (others stay lazy), and hold the reveal until it arrives.
    const startable = Object.keys(CAR_DEFS).map(Number);
    car.defaultSlot = startable[(Math.random() * startable.length) | 0];
    car.heldForDefault = true;
    // fallback: if the random default is slow/fails, after ~2.8 s show whatever HAS loaded
    setTimeout(() => { if (!disposed && car.heldForDefault) { car.heldForDefault = false; const f = car.models.findIndex(Boolean); if (f >= 0) setVehicle(car, f); else ensureVehicle(0); } }, 2800);
    ensureVehicle(car.defaultSlot);
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
      modelLoadCancels.push(loadParkedCar(carsGroup, url, { x: cx, z: cz, y: terrainAt(cx, cz), yaw: carYaw, length: len, black, flip }, () => {
        const hl = len / 2, hw = 1.05, yaw = carYaw + (flip ? Math.PI : 0);
        const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const p = [
          [cx + fx * hl + rx * hw, cz + fz * hl + rz * hw],
          [cx + fx * hl - rx * hw, cz + fz * hl - rz * hw],
          [cx - fx * hl - rx * hw, cz - fz * hl - rz * hw],
          [cx - fx * hl + rx * hw, cz - fz * hl + rz * hw],
        ];
        const xs = p.map(q => q[0]), zs = p.map(q => q[1]);
        bldPolys.push({ p, bb: [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)] });
      }));
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
    if (!cycleVehicle(car)) { toast('Open the garage (☰ → Cars) to pick another ride'); return; }
    showCarCard();
    audio.blip();
  }
  // The Ferrari (slot 2) is the reward for finding all 5 neighbourhood places.
  let ferrariUnlocked = (() => { try { return localStorage.getItem('dahill.drive.ferrari') === '1'; } catch (e) { return false; } })();
  function checkFerrariUnlock() {
    if (ferrariUnlocked || poiFound.size < POIS.length) return;
    ferrariUnlocked = true;
    try { localStorage.setItem('dahill.drive.ferrari', '1'); } catch (e) { }
    toast('🏎️ You earned the Ferrari 458! Tap 🚗 to drive it', 4000);
    if (audio.sfxChime) audio.sfxChime([523, 659, 784, 1047]);
    emit('cars', getCars());
  }
  function getCars() { return vehicleList(car).map(v => v.slot === 2 ? Object.assign({}, v, { locked: !ferrariUnlocked }) : v); }
  function pickCar(slot) {
    if (slot === 2 && !ferrariUnlocked) { toast('🔒 Find all 5 neighbourhood places to unlock the Ferrari!', 2400); return; }
    ensureVehicle(slot);                              // lazy: fetch its GLB now if it isn't loaded yet
    if (setVehicle(car, slot)) { showCarCard(); audio.blip(); }
    else { car.pendingPick = slot; toast('Loading ' + (VEHICLES[slot] ? esc(VEHICLES[slot].name) : 'car') + '…', 1500); }   // it swaps in (registerVehicle) the moment it arrives
  }

  // (Street-view photo billboards removed — they read as odd roadside signs.
  //  Real street imagery now lives on the buildings: photoreal Google 3D Tiles
  //  when enabled, the procedural facade texture otherwise.)

  // "Look inside" (dollhouse) removed — keep the procedural interior hidden.
  interiorGroup.visible = false;   // legacy procedural dollhouse stays hidden; the GLB interior replaces it

  // Inward normal from the curb toward the house (frontDir is the ROAD TANGENT — never inward),
  // and a back-door pad on the yard/patio side (near where Scoop is played).
  // Put the "go inside" pad on the house side FACING the Scoop play area (the sanctuary spawn), so
  // the player walks straight into it. entryU points from the house centre toward that spawn.
  const _spawnPt = [(SREC.coop[0] + SREC.pen[0]) / 2, (SREC.coop[1] + SREC.pen[1]) / 2];
  const _toSpawn = [_spawnPt[0] - house.c[0], _spawnPt[1] - house.c[1]];
  const _uL = Math.hypot(_toSpawn[0], _toSpawn[1]) || 1;
  const entryU = [_toSpawn[0] / _uL, _toSpawn[1] / _uL];
  const _halfExt = 0.5 * (Math.abs(entryU[0]) * (house.bbox[1] - house.bbox[0]) + Math.abs(entryU[1]) * (house.bbox[3] - house.bbox[2]));
  const entryPt = [house.c[0] + entryU[0] * (_halfExt + 1.6), house.c[1] + entryU[1] * (_halfExt + 1.6)];

  if (!flags.has('nointerior')) {
    modelLoadCancels.push(createInterior(scene, { cx: INT_CX, cz: INT_CZ, floorY: INT_FLOOR },
      mod => { interior = mod; interior.group.visible = scoopScene === 'interior'; placeInteriorDancers(); emit('house', { inside: scoopScene === 'interior', ready: true }); },
      () => { /* fail-soft: the door pad just stays inert */ }));
  }

  // Show/hide the interior. The yard is NOT hidden object-by-object — it's 2 km away and fogged
  // out — so this only flips the scene flag, the interior group, and yard-only pins.
  function setInside(on) {
    scoopScene = on ? 'interior' : 'yard';
    if (interior) interior.group.visible = on;
    if (on) { marker.visible = false; carMarker.visible = false; compostMarker.visible = false; doorMarker.visible = false; if (nearCar) { nearCar = false; emit('nearCar', false); } }
    else { exitMarker.visible = false; exitRing.visible = false; for (const npc of npcs) npc.group.visible = false; }
    emit('house', { inside: on, ready: !!interior });
  }
  function enterHouse(now) {
    if (!interior) return;
    setInside(true);
    const sp = interior.spawn;
    CHAR.x = sp.x; CHAR.z = sp.z; CHAR.yaw = sp.yaw; camYawS = sp.yaw;
    CHAR.airY = 0; CHAR.vy = 0; camInit = false; szoom = 1; scPitch = 0.2; camGroundRef = null;   // reset tilt so indoor entry framing is consistent (not pinned to the ceiling)
    doorT = now + 1200; exitArmed = false;
    // House NPCs (dad, mom): lazy-load on first entry, then have each walk out of a room and dance.
    if (!npcsLoadStarted) {
      npcsLoadStarted = true;
      for (const load of NPC_LOADERS) load(ctrl => { if (disposed) return; const g = new THREE.Group(); g.add(ctrl.group); g.visible = false; scene.add(g); npcs.push({ ctrl, group: g, x: 0, z: 0, yaw: 0, state: 'act', act: 'idle', actUntil: 0 }); resetNpcs(); }, () => {});
    } else resetNpcs();
    if (audio.blip) audio.blip();
    toast('🏠 Inside the house! Open the ☰ menu (top-right) for characters &amp; actions · tap "Leave house 🚪" to head back out', 3600);
  }
  // ---- House NPCs: a small behaviour FSM (dad, mom) ------------------------------------------
  // They WANDER room to room — collision-checked (interior.collide, so no walking through walls /
  // furniture) and door-routed — with a bias to share the player's room. On arrival they pick an
  // activity: cycle dances, sprinkle one-shot emote beats, idle, or (if they have a sit clip) SIT
  // down on a couch. State per NPC: 'travel' | 'act'.
  const NPC_RAD = 0.34, NPC_SPD = 1.35;
  function playerRoomIndex() {
    const rs = interior.rooms;
    if (!rs || !rs.length) return 0;
    for (let i = 0; i < rs.length; i++) { const r = rs[i]; if (CHAR.x >= r.minX && CHAR.x <= r.maxX && CHAR.z >= r.minZ && CHAR.z <= r.maxZ) return i; }
    let best = 0, bd = Infinity; rs.forEach((r, i) => { const d = (r.x - CHAR.x) ** 2 + (r.z - CHAR.z) ** 2; if (d < bd) { bd = d; best = i; } }); return best;
  }
  // ---- ROOM-GRAPH NAVIGATION: NPCs PLAN a path room-to-room (BFS through doorways) instead of walking
  // a straight line into a wall and jamming. The rooms + doorways are static, so the connectivity graph
  // is built once and cached on `interior`. Each doorway connects the two rooms whose AABBs it sits on.
  function roomGraph() {
    if (interior._navGraph) return interior._navGraph;
    const rooms = interior.rooms || [], dws = interior.doorways || [];
    const adj = rooms.map(() => []);
    // Connect rooms whose floor AABBs ABUT (share a wall) — NOT by door-mesh containment, which left
    // most rooms isolated (the scan's door_* meshes are sparse + several openings have no door mesh).
    // The waypoint is the shared-border midpoint, snapped to a real doorway if one lines up within 1.5 m.
    const PAD = 0.6;   // ~wall thickness
    for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i], b = rooms[j];
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);   // overlap on X
      const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);   // overlap on Z
      const gapX = Math.max(a.minX - b.maxX, b.minX - a.maxX);          // >0 = separated on X
      const gapZ = Math.max(a.minZ - b.maxZ, b.minZ - a.maxZ);
      if (!((oz > 0.5 && gapX <= PAD) || (ox > 0.5 && gapZ <= PAD))) continue;   // not adjacent
      const bx = (Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2;
      const bz = (Math.max(a.minZ, b.minZ) + Math.min(a.maxZ, b.maxZ)) / 2;
      let door = { x: bx, z: bz }, bd = 1.5 * 1.5;                      // prefer a real door within 1.5 m of the shared border
      for (const d of dws) { const dd = (d.x - bx) ** 2 + (d.z - bz) ** 2; if (dd < bd) { bd = dd; door = d; } }
      adj[i].push({ to: j, door }); adj[j].push({ to: i, door });
    }
    return (interior._navGraph = adj);
  }
  function roomIndexAt(x, z) {
    const rooms = interior.rooms || [];
    // Prefer the CONTAINING room whose centroid is nearest — room AABBs can overlap in the scan, so the
    // first container isn't necessarily the right one. Fall back to the nearest centroid if none contains it.
    let best = -1, bd = Infinity, hit = false;
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i], inside = x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
      if (hit && !inside) continue;                       // once we've seen a container, only rank containers
      if (inside && !hit) { hit = true; bd = Infinity; }  // first container found — reset best to rank among containers only
      const d = (r.x - x) ** 2 + (r.z - z) ** 2; if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // The doorway to head for FIRST on the shortest room-path from `from` to `to` (BFS), or null if same
  // room / unreachable. Recomputed each frame: as the NPC clears one door its room index advances and
  // the next door takes over, so multi-room routes work without storing a path.
  function routeDoor(from, to) {
    if (from < 0 || to < 0 || from === to) return null;
    const adj = roomGraph(); if (!adj[from]) return null;
    const prev = new Array(adj.length).fill(-2); prev[from] = -1;
    const prevDoor = new Array(adj.length).fill(null);
    const q = [from];
    for (let qi = 0; qi < q.length; qi++) { const u = q[qi]; if (u === to) break; for (const e of adj[u]) if (prev[e.to] === -2) { prev[e.to] = u; prevDoor[e.to] = e.door; q.push(e.to); } }
    if (prev[to] === -2) return null;
    let cur = to, door = null;
    while (prev[cur] !== -1) { if (prev[cur] === from) door = prevDoor[cur]; cur = prev[cur]; }
    return door;
  }
  function startTravel(npc, tx, tz) {
    npc.state = 'travel'; npc.target = [tx, tz];   // door routing is recomputed each frame in updateNpcs
    npc.stuckT = 0;
  }
  function triggerMove(npc, now) {
    const pool = npc.act === 'emote' && npc.ctrl.emotes.length ? npc.ctrl.emotes : npc.ctrl.dances;
    if (pool && pool.length && npc.ctrl.react) npc.ctrl.react(pool[(Math.random() * pool.length) | 0]);
    npc.nextMove = now + 3500 + Math.random() * 2500;
  }
  function enterActivity(npc, now) {
    npc.state = 'act';
    // Sit only if we actually reached the couch we set out for (a wall-jam arrival shouldn't teleport us).
    if (npc.wantSeat && npc.ctrl.sitClip && npc.ctrl.pose && Math.hypot(npc.wantSeat.x - npc.x, npc.wantSeat.z - npc.z) < 1.5) {
      const s = npc.wantSeat; npc.x = s.x; npc.z = s.z; npc.baseY = s.y; npc.yaw = s.yaw; npc.seat = s;
      npc.act = 'sit'; npc.ctrl.pose(npc.ctrl.sitClip); npc.actUntil = now + 8000 + Math.random() * 9000; npc.wantSeat = null; return;
    }
    npc.wantSeat = null; npc.baseY = interior.floorY;
    const roll = Math.random();
    if (roll < 0.45 && npc.ctrl.dances.length) { npc.act = 'dance'; npc.nextMove = 0; triggerMove(npc, now); }
    else if (roll < 0.78 && (npc.ctrl.emotes.length || npc.ctrl.dances.length)) { npc.act = 'emote'; npc.nextMove = 0; triggerMove(npc, now); }
    else { npc.act = 'idle'; npc.ctrl.locomotion(0); }
    npc.actUntil = now + 5000 + Math.random() * 7000;
  }
  function pickNextRoom(npc, now) {
    if (npc.ctrl.reset) npc.ctrl.reset();   // stand up from a sit / end any dance cleanly before walking
    npc.seat = null; npc.baseY = interior.floorY;
    const rs = interior.rooms;
    if (!rs || !rs.length) { npc.state = 'act'; npc.act = 'idle'; npc.actUntil = now + 4000; return; }   // no rooms (GLB w/o floors) — just idle
    const room = (Math.random() < 0.55 ? rs[playerRoomIndex()] : rs[(Math.random() * rs.length) | 0]) || rs[0];
    let wantSeat = null;   // sometimes go sit on a free couch
    if (npc.ctrl.sitClip && interior.seats && interior.seats.length && Math.random() < 0.4) {
      const taken = new Set(npcs.map(n => n.seat).filter(Boolean));
      let bs = Infinity; for (const s of interior.seats) { if (taken.has(s)) continue; const d = (s.x - room.x) ** 2 + (s.z - room.z) ** 2; if (d < bs) { bs = d; wantSeat = s; } }
    }
    npc.wantSeat = wantSeat;
    let tx, tz;
    if (wantSeat) { const ap = interior.clearAt(wantSeat.x + Math.sin(wantSeat.yaw) * 0.75, wantSeat.z + Math.cos(wantSeat.yaw) * 0.75, NPC_RAD, true); tx = ap.x; tz = ap.z; }
    else { const p = interior.clearAt(room.minX + 0.6 + Math.random() * Math.max(0.2, room.maxX - room.minX - 1.2), room.minZ + 0.6 + Math.random() * Math.max(0.2, room.maxZ - room.minZ - 1.2), NPC_RAD, true); tx = p.x; tz = p.z; }
    startTravel(npc, tx, tz);
  }
  // Each NPC starts in a distinct far room and heads for the main room, then wanders.
  function resetNpcs() {
    if (!interior || !interior.rooms || !interior.rooms.length || !npcs.length) return;
    _syncDance = false; _syncDanceNext = 0;   // re-arm the dance-party timer fresh on entry, so it doesn't fire instantly every time you step back inside
    const main = interior.spawn, now = performance.now();
    npcs.forEach((npc, i) => {
      if (npc.ctrl.reset) npc.ctrl.reset();
      // START clustered around the MAIN room (where the player enters) so they're together near you, not
      // scattered into far bedrooms they then get stuck pathing out of. They idle a beat, then wander off.
      const a = i / Math.max(1, npcs.length) * Math.PI * 2 + 0.4;
      const from = interior.clearAt(main.x + Math.cos(a) * 1.5, main.z + Math.sin(a) * 1.5, NPC_RAD, true);
      npc.x = from.x; npc.z = from.z; npc.yaw = Math.atan2(main.x - from.x, main.z - from.z); npc.seat = null; npc.wantSeat = null; npc.baseY = interior.floorY;
      npc.state = 'act'; npc.act = 'idle'; npc.actUntil = now + 2200 + Math.random() * 3500; npc.ctrl.locomotion(0);
      npc.group.visible = true; npc.group.position.set(npc.x, npc.baseY, npc.z);
    });
  }
  function updateNpcs(dt, now) {
    // SYNCHRONIZED DANCE PARTY: every ~30-55 s the whole house stops what it's doing and dances the
    // SAME clip together (pose() loops it, started on the same frame for all, so they stay in lockstep).
    if (!_syncDanceNext) _syncDanceNext = now + 20000 + Math.random() * 16000;
    if (_syncDance && now > _syncDanceUntil) { _syncDance = false; _syncDanceNext = now + 30000 + Math.random() * 25000; for (const npc of npcs) pickNextRoom(npc, now); }
    else if (!_syncDance && now > _syncDanceNext && npcs.length > 1 && interior) {
      _syncDance = true; _syncDanceUntil = now + 11000 + Math.random() * 6000;
      const clip = SYNC_DANCES[(Math.random() * SYNC_DANCES.length) | 0];
      for (const npc of npcs) {
        npc.state = 'act'; npc.act = 'dance'; npc.seat = null; npc.wantSeat = null; npc.baseY = interior.floorY;
        npc.yaw = Math.atan2(interior.spawn.x - npc.x, interior.spawn.z - npc.z);   // turn in toward the middle → a little dance circle
        if (npc.ctrl.pose) npc.ctrl.pose(clip);
      }
    }
    for (const npc of npcs) {
      npc.group.visible = true;
      // GREET: when the player walks up, turn to face them and throw a quick move (not mid-party).
      if (!_syncDance && npc.state === 'act' && now > (npc.greetT || 0)) {
        const dpx = CHAR.x - npc.x, dpz = CHAR.z - npc.z;
        if (dpx * dpx + dpz * dpz < 2.7 * 2.7) {
          npc.greetT = now + 6500;
          if (npc.seat) { if (npc.ctrl.reset) npc.ctrl.reset(); npc.seat = null; npc.baseY = interior.floorY; }   // get up off the couch first, else she'd "stand" floating at seat height + hog the seat
          npc.yaw = Math.atan2(dpx, dpz);                                          // look at the player
          const pool = (npc.ctrl.emotes && npc.ctrl.emotes.length) ? npc.ctrl.emotes : npc.ctrl.dances;
          if (pool && pool.length && npc.ctrl.react) { npc.ctrl.react(pool[(Math.random() * pool.length) | 0]); npc.act = 'emote'; npc.nextMove = now + 2600; npc.actUntil = Math.max(npc.actUntil || 0, now + 2600); }
        }
      }
      let speed = 0;
      if (_syncDance) { npc.group.position.set(npc.x, npc.baseY, npc.z); npc.group.rotation.y = npc.yaw - Math.PI / 2; npc.ctrl.tick(dt); continue; }   // partying: hold position, the pose() loops
      if (npc.state === 'travel') {
        const gx = npc.target[0], gz = npc.target[1], finalD = Math.hypot(gx - npc.x, gz - npc.z);
        if (finalD < 0.5) enterActivity(npc, now);
        else {
          // PLAN the path: find our room + the goal's room and head for the next DOORWAY on the BFS route
          // (not a straight line into a wall). Re-evaluated every frame, so clearing one door hands off to
          // the next. Far from the door → aim at it; close → aim at the goal so we step THROUGH it.
          let tx = gx, tz = gz;
          const cur = roomIndexAt(npc.x, npc.z), goalRoom = roomIndexAt(gx, gz);
          if (cur !== goalRoom) {
            let door = routeDoor(cur, goalRoom);
            if (!door) { let bd = Infinity; for (const dw of (interior.doorways || [])) { const dd = (dw.x - npc.x) ** 2 + (dw.z - npc.z) ** 2; if (dd < bd) { bd = dd; door = dw; } } }   // graph said nothing → at least aim at the NEAREST opening, never a wall
            if (door && Math.hypot(door.x - npc.x, door.z - npc.z) > 0.3) { const px = gx - door.x, pz = gz - door.z, pl = Math.hypot(px, pz) || 1; tx = door.x + px / pl * 0.4; tz = door.z + pz / pl * 0.4; }   // aim ~0.4 m PAST the door toward the goal so the heading carries straight THROUGH the opening, not into the jamb
          }
          const dx = tx - npc.x, dz = tz - npc.z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d, want = NPC_SPD * dt;
          const r = interior.collide(npc.x, npc.z, npc.x + ux * want, npc.z + uz * want, NPC_RAD, true);
          const moved = Math.hypot(r.x - npc.x, r.z - npc.z);
          npc.x = r.x; npc.z = r.z; npc.yaw = Math.atan2(ux, uz); speed = moved / Math.max(dt, 1e-3);
          // "stuck" = collision is eating the step (a wall-jam) — judged by ACTUAL displacement, NOT
          // progress toward the final target, so routing to a side doorway waypoint can't false-trigger.
          if (moved < want * 0.35) { npc.stuckT += dt; if (npc.stuckT > 1.5) enterActivity(npc, now); } else npc.stuckT = 0;
        }
        npc.baseY = interior.floorY; npc.ctrl.locomotion(speed);
      } else {   // 'act' — staying put; sit holds, dance/emote cycle, idle just loops
        if (now > npc.actUntil) pickNextRoom(npc, now);
        else if ((npc.act === 'dance' || npc.act === 'emote') && now > (npc.nextMove || 0)) triggerMove(npc, now);
      }
      npc.group.position.set(npc.x, npc.baseY, npc.z);
      npc.group.rotation.y = npc.yaw - Math.PI / 2;
      npc.ctrl.tick(dt);
    }
  }
  function leaveHouse(now) {
    setInside(false);
    if (entryPt) { CHAR.x = entryPt[0] + entryU[0] * 1.6; CHAR.z = entryPt[1] + entryU[1] * 1.6; CHAR.yaw = Math.atan2(entryU[0], entryU[1]); }
    camYawS = CHAR.yaw; CHAR.airY = 0; CHAR.vy = 0; camInit = false; szoom = 1; camGroundRef = null;
    doorT = now + 1200; entryArmed = false;
    if (audio.blip) audio.blip();
  }
  // A Drew + a CeCe hanging out inside (the original "a drew and cece inside") — decorative crowd
  // dancers, distinct from the playable avatar, gated to the interior scene. Re-added after a
  // pedestrian-density re-pool (placeCrowd calls this) so the slider doesn't wipe them.
  function placeInteriorDancers() {
    if (!interior || !ceceCrowd || !drewCrowd) return;
    if (crowdSpots.some(s => s.zone === 'interior')) return;
    const sp = interior.spawn, fwd = [Math.sin(sp.yaw), Math.cos(sp.yaw)];
    const c = interior.clearAt(sp.x + fwd[0] * 2.6, sp.z + fwd[1] * 2.6);   // open floor, not embedded in a sofa/table
    // Both stand at the same (cleared) spot; updateCrowd shows only the ONE you're not currently playing.
    const add = (crowd, charName, h, clip) => {
      crowdSpots.push({ rec: crowd.add(scene, { x: c.x, y: interior.floorY, z: c.z, yaw: sp.yaw + Math.PI, targetH: h, clip }), zone: 'interior', char: charName, onRoadHt: false, settleT: 0 });
    };
    add(drewCrowd, 'drew', DREW_HEIGHT_M, 'dance');
    add(ceceCrowd, 'cece', CECE_HEIGHT_M);
  }

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
  const LOOK_YAW_PER_SCREEN = 2.8, LOOK_PITCH_PER_SCREEN = 2.4, ZOOM_RATE = 0.0011, MOVE_DEADZONE = 0.10;   // screen-normalized free-look
  const JOY_R = 66, JOY_MAX = 52;
  const inp2 = { jx: 0, jy: 0, kx: 0, ky: 0, steer: 0, gas: 0, brake: 0, navActive: false, navX: 0, navZ: 0, hbrake: false, boost: false };
  let camYawS = 0, scPitch = 0.34, bagWarned = false, spotless = false, nearCar = false;
  let scoopMoveYaw = 0, scoopMoveActive = false;
  // Experimental "draw to drive": in the Top-down view, a drag projects the finger
  // onto the ground and the car steers toward it + auto-throttles, so you trace its
  // path with one finger. (Joystick/keyboard still drive the other camera views.)
  let navPtr = null, navDownX = 0, navDownY = 0, navMoved = false, navCurX = 0, navCurY = 0;   // tap (route along roads) vs drag (freeform draw-to-drive); navCur tracks the live finger for overhead pinch
  const _navRay = new THREE.Raycaster(), _navNDC = new THREE.Vector2();
  const _navPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _navHit = new THREE.Vector3();
  // drag-to-drive ("trace") is available in the overhead-style views (Top-down AND Aerial)
  const driveTopDown = () => mode === 'drive' && DRIVE_CAMS[camMode] && DRIVE_CAMS[camMode].dragdrive;
  // Overhead/Aerial zoom-out slider support: czoom is the altitude/orbit multiplier. Map it log-wise to
  // a 0..1 slider and push the value to the UI whenever it changes (pinch, wheel, view switch, slider).
  const driveZoomRange = () => (driveTopDown() ? [0.14, 7] : [0.4, 3.4]);
  function emitDriveZoom() { const [lo, hi] = driveZoomRange(); emit('driveZoom', { norm: clamp(Math.log(clamp(czoom, lo, hi) / lo) / Math.log(hi / lo), 0, 1), overhead: driveTopDown() }); }
  function setDriveZoom(norm) { const [lo, hi] = driveZoomRange(); czoom = lo * Math.pow(hi / lo, clamp(norm, 0, 1)); emitDriveZoom(); }
  function setNavFromPointer(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    _navNDC.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    _navRay.setFromCamera(_navNDC, camera);
    _navPlane.constant = -(car && car.groundY != null ? car.groundY : 0);   // ground plane at the car's height
    if (_navRay.ray.intersectPlane(_navPlane, _navHit)) { inp2.navX = _navHit.x; inp2.navZ = _navHit.z; inp2.navActive = true; }
  }
  let lastLookT = -1e9;   // last manual look-drag time (ms); suppresses scoop follow-cam briefly
  let shiftLock = false, azVel = 0, poVel = 0;

  function lookDelta(dx, dy) {
    const w = Math.max(320, canvas.clientWidth || innerWidth || 800);
    const h = Math.max(320, canvas.clientHeight || innerHeight || 600);
    return { yaw: dx / w * LOOK_YAW_PER_SCREEN, pitch: dy / h * LOOK_PITCH_PER_SCREEN };
  }
  function scaledDeadzoneMagnitude(x, y) {
    const m = Math.min(1, Math.hypot(x, y));
    return m <= MOVE_DEADZONE ? 0 : (m - MOVE_DEADZONE) / (1 - MOVE_DEADZONE);
  }

  function hideJoy() {
    movePtr = null; inp2.jx = 0; inp2.jy = 0;
    if (mode === 'scoop') scoopMoveActive = false;
    if (ui.joy) ui.joy.style.display = 'none';
  }

  function clearLiveInput() {
    navPtr = null; lookPtrs.clear(); ptrs.clear();
    lastPinch = 0; lastMid = null; pinchD = 0; moved = 0;
    inp2.jx = inp2.jy = inp2.kx = inp2.ky = 0;
    inp2.steer = inp2.gas = inp2.brake = 0;
    inp2.hbrake = false; inp2.boost = false; inp2.navActive = false;
    scoopMoveActive = false;
    if (ui.joy) ui.joy.style.display = 'none';
    canvas.classList.remove('dragging');
  }

  function onPointerDown(e) {
    if (mode !== 'explore') {
      canvas.setPointerCapture(e.pointerId);
      // Overhead views: ONE finger draws-to-drive; a SECOND finger is a pinch-zoom (the
      // phone-native way to zoom the map the user asked for) which suspends steering until
      // you lift back to one finger.
      if (driveTopDown()) {
        if (navPtr === null && lookPtrs.size === 0) {
          navPtr = e.pointerId; navDownX = navCurX = e.clientX; navDownY = navCurY = e.clientY; navMoved = false; showT = 0; setNavFromPointer(e.clientX, e.clientY);
        } else {
          if (navPtr !== null) { lookPtrs.set(navPtr, { x: navCurX, y: navCurY }); navPtr = null; inp2.navActive = false; }   // 2nd finger → stop driving, pinch instead
          lookPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (lookPtrs.size === 2) { const a = [...lookPtrs.values()]; pinchD = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); }
        }
        return;
      }
      const VW = canvas.clientWidth || innerWidth, VH = canvas.clientHeight || innerHeight;
      // Roblox touch convention, identical in drive + scoop: the LEFT HALF is the
      // movement zone — a press there SPAWNS the dynamic thumbstick under the thumb
      // (drag farther = move faster: full throttle / a run). The RIGHT HALF is dead
      // space for the camera — a single-finger drag there rotates (horizontal) and
      // tilts (vertical) the view; two fingers anywhere pinch-zoom. We reserve the
      // top strip from the move zone so a drag that begins up near the HUD reads as
      // a look, and so the thumbstick never spawns under the top bar.
      const steerZoneW = MOBILE ? 0.5 : 0.44;          // left half = move (slightly narrower with a mouse)
      const steerZoneTop = mode === 'drive' ? 0.14 : 0.18;
      if (movePtr === null && e.clientX < VW * steerZoneW && e.clientY > VH * steerZoneTop) {
        movePtr = e.pointerId; joyBX = e.clientX; joyBY = e.clientY;
        if (mode === 'scoop') { scoopMoveYaw = camYawS; scoopMoveActive = true; }
        if (ui.joy) {
          ui.joy.style.display = 'block';
          ui.joy.style.left = (e.clientX - JOY_R) + 'px'; ui.joy.style.top = (e.clientY - JOY_R) + 'px';
        }
        if (ui.knob) ui.knob.style.transform = 'translate(-50%,-50%)';
      } else {
        lookPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (mode === 'drive') camOrbit.t = performance.now();   // count a look-start as activity so the hold timer doesn't snap a resting finger back
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
      if (e.pointerId === navPtr) { navCurX = e.clientX; navCurY = e.clientY; if (Math.hypot(e.clientX - navDownX, e.clientY - navDownY) > 12) navMoved = true; setNavFromPointer(e.clientX, e.clientY); return; }   // draw-to-drive
      if (e.pointerId === movePtr) {
        let dx = e.clientX - joyBX, dy = e.clientY - joyBY;
        const d = Math.hypot(dx, dy), mx = JOY_MAX;
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
          if (mode === 'drive') { czoom = clamp(czoom * f, driveTopDown() ? 0.14 : 0.4, driveTopDown() ? 7 : 3.4); emitDriveZoom(); }   // overhead gets a much wider+finer range (read one intersection ↔ neighbourhood overview)
          else szoom = clamp(szoom * f, 0.32, 2.6);                   // close over-the-shoulder → wide yard overview
        }
        pinchD = nd;
        return;
      }
      const dx = e.clientX - ox, dy = e.clientY - oy;
      if (Math.abs(dx) + Math.abs(dy) < 4) return; // look deadzone (kill resting-finger jitter on high-DPI screens)
      const ld = lookDelta(dx, dy);
      if (mode === 'drive') {
        camOrbit.yaw = clamp(camOrbit.yaw - ld.yaw, -2.4, 2.4);   // clamp so a hard drag can't orbit under the map / lose the car
        camOrbit.pitch = clamp(camOrbit.pitch + ld.pitch, -0.45, 0.8);
        camOrbit.t = performance.now();
        showT = 0;
      } else {
        camYawS -= ld.yaw;
        scPitch = clamp(scPitch + ld.pitch, -0.3, 0.8);
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
    if (e.pointerId === navPtr) {
      navPtr = null;
      // A TAP (no drag) on a road point → route there ALONG the roads and auto-drive, not a
      // straight line off-road. A DRAG was the freeform draw-to-drive, so release just coasts.
      if (!navMoved) setDriveTarget(inp2.navX, inp2.navZ);
      else inp2.navActive = false;
    }
    if (e.pointerId === movePtr) hideJoy();
    lookPtrs.delete(e.pointerId);
    if (lookPtrs.size < 2) pinchD = 0;
    ptrs.delete(e.pointerId); lastPinch = 0; lastMid = null;
    if (!ptrs.size) canvas.classList.remove('dragging');
  }

  function onWheel(e) {
    e.preventDefault();
    if (mode === 'explore') ctl.gr = clamp(ctl.gr * Math.exp(e.deltaY * ZOOM_RATE), 14, 640);
    else if (mode === 'drive') { czoom = clamp(czoom * Math.exp(e.deltaY * ZOOM_RATE), driveTopDown() ? 0.14 : 0.4, driveTopDown() ? 7 : 3.4); emitDriveZoom(); }
    else if (mode === 'scoop') szoom = clamp(szoom * Math.exp(e.deltaY * ZOOM_RATE), 0.32, 2.6);
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
  // True while the user is typing in a form field (the address search, etc.).
  // The game's key handler preventDefault()s Space + WASD + arrows; without this
  // guard those keystrokes never reach a focused <input>, so addresses with
  // spaces ("Circle Ave", "Castro Valley") couldn't be typed at all.
  function isEditable(t) {
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }
  function onKeyDown(e) {
    if (isEditable(e.target)) return;   // let typing through — never hijack form input
    if (mode === 'drive' || mode === 'scoop') {
      if (mode === 'scoop' && e.key === 'Shift' && !e.repeat) {
        shiftLock = !shiftLock; emit('shiftLock', shiftLock);
        toast(shiftLock ? 'Shift-lock ON 🔒' : 'Shift-lock off', 900); e.preventDefault(); return;
      }
      if (mode === 'scoop' && (e.key === 'e' || e.key === 'E') && nearCar) { driveFromScoop(); e.preventDefault(); return; }
      if (mode === 'scoop' && e.key === ' ' && !e.repeat) { api.jump(); e.preventDefault(); return; }   // Space = hop
      if (mode === 'drive' && e.key === ' ') { inp2.hbrake = true; e.preventDefault(); return; }        // Space = handbrake
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
    // No editable-guard here on purpose: keyup never preventDefault()s (so it can't
    // block typing) and CLEARING a movement flag is always safe — guarding it could
    // strand a held key as "down" if focus moved to an input mid-press.
    if (mode === 'explore') return;
    if (e.key === 'ArrowUp' || e.key === 'w') inp2.ky = 0;
    if (e.key === 'ArrowDown' || e.key === 's') inp2.ky = 0;
    if (e.key === 'ArrowLeft' || e.key === 'a') inp2.kx = 0;
    if (e.key === 'ArrowRight' || e.key === 'd') inp2.kx = 0;
    if (e.key === ' ') inp2.hbrake = false;
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
    setMode('scoop'); camInit = false; szoom = 1; camGroundRef = null; CHAR.groundY = null;   // fresh framing per scoop entry (pinch-zoom shouldn't leak in)
    setInside(false);
    for (const s of labelSprites) s.visible = false;
    CHAR.group.visible = true;
    // Spawn out in the OPEN sanctuary (between the coop and the pen), away from
    // the house, patio and driveway cars so the camera opens onto the play area
    // and animals, not flat house walls.
    CHAR.x = (SREC.coop[0] + SREC.pen[0]) / 2; CHAR.z = (SREC.coop[1] + SREC.pen[1]) / 2;
    CHAR.yaw = Math.atan2(SREC.barn[0] - CHAR.x, SREC.barn[1] - CHAR.z);
    camYawS = CHAR.yaw; scoopMoveYaw = camYawS; scoopMoveActive = false;
    scoopScene = 'yard'; entryArmed = true; exitArmed = false; doorMarker.visible = false; exitMarker.visible = false; exitRing.visible = false;
    emit('avatar', { name: CHAR.avatar, actions: CHAR.getActions() });
    audio.ensure();
    setTool(CHAR.lvl);
    toast('Scoop the sanctuary poop! 💩<br><small>Empty at the green compost bin · the 🚪 pad takes you inside the house</small>', 3200);
  }
  function exitScoop() {
    setMode('explore');
    camera.up.set(0, 1, 0);                 // symmetry with exitDrive; never leak a tilted up-vector
    setInside(false);                       // back to the yard scene (hide the interior if we left from inside)
    if (groundPatch) groundPatch.visible = false;
    if (scoopGrass) scoopGrass.visible = false;
    if (scoopFence) scoopFence.visible = false;
    marker.visible = false; carMarker.visible = false; compostMarker.visible = false; doorMarker.visible = false; exitMarker.visible = false; exitRing.visible = false;
    if (nearCar) { nearCar = false; emit('nearCar', false); }
    hideJoy();
    for (const s of labelSprites) s.visible = true;
    CHAR.group.visible = false;
    inp2.jx = inp2.jy = inp2.kx = inp2.ky = 0; scoopMoveActive = false;
    ctl.gtx = clamp(CHAR.x, -310, 310); ctl.gtz = clamp(CHAR.z, -310, 310);
    ctl.gty = terrainAt(ctl.gtx, ctl.gtz) + 3; ctl.gr = 60; ctl.gpo = 0.85;
    ctl.tx = ctl.gtx; ctl.tz = ctl.gtz;
  }

  function updateScoop(dt, now) {
    const inside = scoopScene === 'interior' && interior;
    // Keyboard Left/Right TURN the keeper (tank-style) instead of strafing sideways; the touch
    // joystick still strafes camera-relative. (Walking sideways on arrow keys felt wrong.)
    if (inp2.kx) { camYawS -= inp2.kx * 2.6 * dt; CHAR.yaw = camYawS; scoopMoveYaw = camYawS; lastLookT = now; }
    let jx = clamp(inp2.jx, -1, 1), jy = clamp(inp2.jy + inp2.ky, -1, 1);
    const rawMag = Math.min(1, Math.hypot(jx, jy));
    const mag = scaledDeadzoneMagnitude(jx, jy);
    if (shiftLock) CHAR.yaw = camYawS; // Roblox shift-lock: keeper faces the camera
    if (mag > 0) {
      if (!scoopMoveActive) { scoopMoveYaw = camYawS; scoopMoveActive = true; }
      // Capture the movement camera when the stick engages. Right-side look can
      // orbit freely while a walk is held without re-aiming that active walk.
      const basisYaw = shiftLock ? camYawS : scoopMoveYaw;
      const fX = Math.sin(basisYaw), fZ = Math.cos(basisYaw);
      const rX = -Math.cos(basisYaw), rZ = Math.sin(basisYaw);
      let mx = rX * jx - fX * jy, mz = rZ * jx - fZ * jy;
      const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
      if (!shiftLock) CHAR.yaw = Math.atan2(mx, mz); // else keep facing camera, strafe
      // Roblox follow cam: your right-side swipe OWNS the camera. We only add a very
      // gentle drift to bring it back behind the keeper, and only after you've left
      // the camera alone for a good while (2.5 s) — so looking around actually holds
      // instead of being yanked back the instant you start walking. Shift-lock opts
      // out entirely (the camera leads and the keeper strafes).
      if (!shiftLock && now - lastLookT > 2500) {
        let dyaw = CHAR.yaw - camYawS;
        while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
        while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
        camYawS += dyaw * Math.min(1, dt * 0.8);   // ~1.2 s settle, barely noticeable
      }
      const sp = 4.4 * mag;
      let nx = CHAR.x + mx * sp * dt, nz = CHAR.z + mz * sp * dt;
      const rad = 0.42;
      if (inside) {
        // per-wall + furniture pushout/slide with passable doorways (interior.collide)
        const r = interior.collide(CHAR.x, CHAR.z, nx, nz, 0.34); nx = r.x; nz = r.z;   // slimmer radius so doorways/tight spots pass
      } else {
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
      }
      CHAR.x = nx; CHAR.z = nz;
      CHAR.bob += dt * 10 * mag;
    } else { scoopMoveActive = false; CHAR.bob += dt * 1.5; }
    // ground on the fixed interior floor, or the procedural yard terrain
    const cy = inside ? interior.floorY : terrainAt(CHAR.x, CHAR.z);
    // jump arc: integrate vertical velocity under gravity; land back on the ground
    if (CHAR.vy !== 0 || CHAR.airY > 0) {
      CHAR.airY += CHAR.vy * dt; CHAR.vy -= 22 * dt;
      if (CHAR.airY <= 0) { CHAR.airY = 0; CHAR.vy = 0; }
    }
    const bobY = (CHAR.airY > 0 || CHAR.drew) ? 0 : Math.abs(Math.sin(CHAR.bob)) * 0.05;
    CHAR.group.position.set(CHAR.x, cy + CHAR.airY + bobY, CHAR.z);
    CHAR.group.rotation.y = CHAR.yaw - Math.PI / 2;
    if (CHAR.drew) { CHAR.drew.locomotion(rawMag > MOVE_DEADZONE ? 4.4 * mag : 0); CHAR.drew.tick(dt); }
    if (inside) { updateScoopInterior(dt, now); return; }
    // ===== YARD =====
    // door ENTRY: stand on the front-yard pad to walk inside the house
    if (interior && entryPt) {
      doorMarker.visible = true;
      doorMarker.position.set(entryPt[0], terrainAt(entryPt[0], entryPt[1]) + 2.6 + Math.abs(Math.sin(now * 0.005)) * 0.3, entryPt[1]);
      const din = Math.hypot(CHAR.x - entryPt[0], CHAR.z - entryPt[1]);
      if (din > 4.0) entryArmed = true;
      if (entryArmed && din < 2.6 && now > doorT) { enterHouse(now); updateScoopInterior(dt, now); return; }   // run the interior frame now — no 1-frame yard flash
    } else doorMarker.visible = false;
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
    if (COMPOST) {
      // green pin over the bin whenever you're carrying — makes the dump-off obvious
      compostMarker.visible = CHAR.bag > 0;
      if (compostMarker.visible) compostMarker.position.set(COMPOST[0], terrainAt(COMPOST[0], COMPOST[1]) + 3.2 + Math.abs(Math.sin(now * 0.005)) * 0.4, COMPOST[1]);
      if (CHAR.bag > 0 && Math.hypot(CHAR.x - COMPOST[0], CHAR.z - COMPOST[1]) < 3) {
        const dumped = CHAR.bag; CHAR.bag = 0; bagWarned = false; audio.sfxChime([392, 523]); pushScoopHud();
        toast('Composted ' + dumped + ' ♻️');
      }
    }
    if (POOPS.length === 0 && !spotless) { spotless = true; toast('Yard is spotless ✨ (for now…)', 2400); if (CHAR.drew) CHAR.drew.react('dance'); _syncDanceNext = now; }   // clean yard → the house throws a dance party next time you step inside
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
  // Indoor follow cam + the exit pad (movement/grounding/collision already ran in updateScoop).
  const _wallRay = new THREE.Raycaster(); const _wallDir = new THREE.Vector3();
  let _wallCutT = 0;
  function updateScoopInterior(dt, now) {
    marker.visible = false; carMarker.visible = false; compostMarker.visible = false; doorMarker.visible = false;
    exitMarker.visible = false; exitRing.visible = false;   // no blue indicators inside — exit via the "Leave house" button
    updateNpcs(dt, now);
    // small indoor follow cam: pull IN before it pokes a wall (but never collapse onto the avatar),
    // and rise toward overhead when forced close; clamp under the ceiling.
    const fx = Math.sin(camYawS), fz = Math.cos(camYawS);
    const szi = clamp(szoom, 0.7, 1.35), ra = interior.roomAABB, MIND = 1.6;
    let dist = (4.0 + Math.max(0, scPitch) * 1.2) * szi;
    let camX = CHAR.x - fx * dist, camZ = CHAR.z - fz * dist;
    for (let k = 0; k < 6 && dist > MIND && (camX < ra[0] + 0.3 || camX > ra[1] - 0.3 || camZ < ra[2] + 0.3 || camZ > ra[3] - 0.3); k++) {
      dist = Math.max(MIND, dist * 0.78); camX = CHAR.x - fx * dist; camZ = CHAR.z - fz * dist;
    }
    const camY = interior.floorY + 2.1 + scPitch * 3.4 * Math.max(0.75, szi);
    const cc = interior.clampCam(camX, camY, camZ, 0.3);
    const camT = _camT.set(cc.x, cc.y, cc.z);
    if (!camInit) { camV.copy(camT); camInit = true; }
    camV.lerp(camT, Math.min(1, dt * 6));
    const cl = interior.clampCam(camV.x, camV.y, camV.z, 0.28);
    camV.set(cl.x, Math.max(cl.y, interior.floorY + 0.7), cl.z);
    // if an outer-wall corner clamped the camera in close, rise toward overhead so we look DOWN at the
    // kid instead of zooming into their head.
    const pd = Math.hypot(camV.x - CHAR.x, camV.z - CHAR.z);
    if (pd < MIND) camV.y = Math.min(interior.ceilingY - 0.3, Math.max(camV.y, interior.floorY + 1.1 + (MIND - pd) * 2.0 + 1.2));
    camera.position.copy(camV);
    camera.lookAt(CHAR.x, interior.floorY + 1.1, CHAR.z);
    // SEE-THROUGH: hide any non-floor mesh between the camera and a BOUNDARY around the avatar — not just
    // the one dead-centre ray (which left walls covering the kid's body/sides in the way). Cast a small fan
    // to the torso, head, and a ring around them, so a wall blocking ANY part of the kid (or right around
    // them) is cut — a clean cutout boundary. Collision still uses precomputed AABBs, so hidden walls block.
    const occ = interior.occluders;
    if (occ && now - _wallCutT > (MOBILE ? 75 : 45)) {
      _wallCutT = now;
      for (const w of occ) if (!w.userData.permaHidden) w.visible = true;
      const cp = camera.position, fy = interior.floorY;
      const hideAlong = (tx, ty, tz) => {
        const dx = tx - cp.x, dy = ty - cp.y, dz = tz - cp.z, len = Math.hypot(dx, dy, dz) || 1;
        _wallRay.set(cp, _wallDir.set(dx / len, dy / len, dz / len)); _wallRay.far = Math.max(0.1, len - 0.5);
        const hits = _wallRay.intersectObjects(occ, false);
        for (const h of hits) h.object.visible = false;
      };
      hideAlong(CHAR.x, fy + 1.1, CHAR.z);                                                            // torso
      hideAlong(CHAR.x, fy + 1.75, CHAR.z);                                                           // head
      // Ring boundary — clears walls right around the kid. SKIP ring points that fall outside the room
      // shell: when the kid hugs a perimeter wall the 0.85 radius overshoots PAST the outer wall, so a
      // camera->outside ray would punch through (hide) the exterior wall/window and expose the skybox.
      const RING = MOBILE ? 4 : 6;   // fewer perimeter rays on phones — intersectObjects has no BVH, so each cast is O(tris)
      for (let i = 0; i < RING; i++) {
        const a = i / RING * Math.PI * 2, rx = CHAR.x + Math.cos(a) * 0.85, rz = CHAR.z + Math.sin(a) * 0.85;
        if (rx > ra[0] + 0.2 && rx < ra[1] - 0.2 && rz > ra[2] + 0.2 && rz < ra[3] - 0.2) hideAlong(rx, fy + 0.9, rz);
      }
    }
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
    clearDestination();
    if (navMarker) navMarker.visible = false;
    // Default to the Roblox-style CHASE cam ('Close') so driving leads with the
    // dynamic thumbstick + swipe-to-look controls — that IS the Roblox feel the
    // player expects. The overhead drag-to-drive map stays one tap away on the VIEW
    // cycle for anyone who prefers steering by tapping the map. We only honour a cam
    // the player chose themselves on a previous drive (driveCamUserPicked).
    if (!driveCamUserPicked) {
      const i = DRIVE_CAMS.findIndex(c => c.name === 'Close');
      if (i >= 0) camMode = i;
    }
    czoom = 1;                                            // fresh zoom (pinch shouldn't leak between drives)
    poiSeen.clear();                                      // re-arm the neighbourhood callouts
    for (const c of coins) { c.got = false; c.groundY = null; } coinsGot = 0;   // fresh coins each drive
    resetRun(); resetParticles();
    emitScore({ finishMs: 0 });
    emit('driveCam', DRIVE_CAMS[camMode].name);
    // FREE ROAM by default — no auto-destination, so the route line is OFF until you
    // choose somewhere (🧭 / tap the map). The pink POI beacons still point the way.
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
    car.speed = 0; car.throttle = 0; car.brakeAmt = 0; car.pitchDyn = 0; car.kSteer = 0; car.revArmT = 0; boost = 0; car.group.visible = true; car.groundY = null;
    camOrbit.yaw = 0; camOrbit.pitch = 0; camGroundRef = null;
    showT = 0;                                   // skip the low cinematic orbit (melty up close)
    for (const s of labelSprites) s.visible = false;
    audio.engineStart();
    if (soundOn && audio.startMusic) audio.startMusic();
    showCarCard();
    // TRUE free roam: never auto-set a destination on entry. The pink POI beacons still
    // point the way; pick a place with 🧭 or by tapping the map when YOU want a route+ETA.
    if (poiFound.size >= POIS.length) toast('🏆 All places found — free roam, beat your times!', 2400);
  }
  function exitDrive() {
    setMode('explore');
    stopFollow();
    camera.up.set(0, 1, 0);
    hideJoy();
    navPtr = null; inp2.navActive = false; if (navMarker) navMarker.visible = false;
    guideLine.visible = false; destPin.visible = false;
    if (ui.fx) ui.fx.classList.remove('on');
    if (camera.fov !== 46) { camera.fov = 46; camera.updateProjectionMatrix(); }
    for (const c of coins) c.mesh.visible = false;
    resetParticles();
    hideBeacons();
    hideTraffic();
    carLocator.visible = false;
    car.group.visible = false;
    if (groundPatch) groundPatch.visible = false;
    for (const s of labelSprites) s.visible = true;
    inp2.jx = inp2.jy = inp2.kx = inp2.ky = 0;
    audio.engineStop();
    if (audio.stopMusic) audio.stopMusic();
    ctl.gtx = clamp(car.x, -310, 310); ctl.gtz = clamp(car.z, -310, 310);
    ctl.gty = terrainAt(ctl.gtx, ctl.gtz) + 3; ctl.gr = 110; ctl.gpo = 0.95;
    ctl.tx = ctl.gtx; ctl.tz = ctl.gtz;
  }
  // Unstick: snap the car to the nearest point ON a drivable road segment, facing
  // along it, stopped. Projects onto each segment (not just vertices) for accuracy.
  function resetToRoad() {
    if (mode !== 'drive') return;
    // Build the candidate segment list: the live Google route (real roads, works
    // even far from home) if we have one, else EVERY mapped road (any type) near the
    // neighbourhood — the old residential/tertiary-only filter missed the road the
    // car was actually on, so it teleported you somewhere random.
    let bx = car.x, bz = car.z, bd = Infinity, dirX = 0, dirZ = 1, found = false;
    const consider = (ax, az, bx2, bz2) => {
      const vx = bx2 - ax, vz = bz2 - az, len2 = vx * vx + vz * vz || 1;
      let t = ((car.x - ax) * vx + (car.z - az) * vz) / len2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t, pz = az + vz * t;
      const d = (px - car.x) * (px - car.x) + (pz - car.z) * (pz - car.z);
      if (d < bd) { bd = d; bx = px; bz = pz; const L = Math.sqrt(len2); dirX = vx / L; dirZ = vz / L; found = true; }
    };
    const far = Math.hypot(car.x, car.z) > 320;
    if (ROUTE && ROUTE.length > 1) {
      for (let i = 0; i < ROUTE.length - 1; i++) consider(ROUTE[i].x, ROUTE[i].z, ROUTE[i + 1].x, ROUTE[i + 1].z);
    } else if (far) {
      // far from home: snap ONLY to the fetched OSM (Google-map) road network — NEVER the hood graph,
      // which would teleport the car all the way back to the neighbourhood (the reported bug).
      for (const s of osmRoadSegs) consider(s[0][0], s[0][1], s[1][0], s[1][1]);
    } else {
      for (const r of S.roads) for (let k = 0; k < r.p.length - 1; k++) { const a = W(r.p[k]), b = W(r.p[k + 1]); consider(a[0], a[1], b[0], b[1]); }
    }
    // Far from home with only sparse OSM coverage: if the nearest fetched road is still a long way off
    // (≥120 m), don't fling the car all the way onto it — force a fresh fetch and leave it put (below).
    const usedOSM = far && !(ROUTE && ROUTE.length > 1);
    if (found && usedOSM && bd > 120 * 120) found = false;
    if (!found) {
      if (far) {
        // No local road data yet (the OSM fetch hasn't landed). Force a fetch now and LEAVE THE CAR PUT
        // rather than flinging it home; the next tap snaps onto the real nearest road once it arrives.
        updateAreaRoads(performance.now(), true);
        toast('Finding the nearest road… try again in a sec 🛰️', 1600);
        return;
      }
      // Near home: nearestRoadPoint consults the ROUTE + every mapped road, so it returns SOMETHING.
      const p = nearestRoadPoint(car.x, car.z);
      bx = p.x; bz = p.z; found = true;
      dirX = Math.sin(car.yaw); dirZ = Math.cos(car.yaw);   // no segment tangent on this path — keep the car's current facing rather than snapping it to due-south
    }
    car.x = bx; car.z = bz; car.speed = 0; car.steer = 0; car.vlat = 0; car.revArmT = 0; car.groundY = null; car.yaw = Math.atan2(dirX, dirZ);
    clearRouteRail();   // if auto-drive is still on, reacquire rail arc from the snapped road point
    camInit = false; camGroundRef = null; camFloorRef = null; inp2.navActive = false; recoverCooldown = 1.8;   // re-seat the chase/orbit cam at the new spot; grace so auto-recover can't immediately re-fire
    audio.blip && audio.blip();
    toast('Back on the road 🛣️', 1000);
  }
  // ---- destination / routing / auto-drive ----
  // Real road route from Google Directions (via the Maps JS SDK, which works in the
  // browser — the Directions web service is CORS-blocked). Falls back to a straight
  // line if the SDK/Directions API isn't enabled on the key.
  let _mapsSDK = null;
  let routeReqId = 0, _quietRoute = false;
  function loadMapsSDK() {
    if (window.google && window.google.maps && window.google.maps.DirectionsService) return Promise.resolve(window.google.maps);
    if (_mapsSDK) return _mapsSDK;
    const key = import.meta.env.VITE_GOOGLE_MAPS_KEY;
    if (!key) return Promise.reject(new Error('no key'));
    _mapsSDK = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + key + '&libraries=places&loading=async';   // places = address autocomplete
      s.async = true; s.defer = true;
      s.onload = () => (window.google && window.google.maps) ? res(window.google.maps) : rej(new Error('maps unavailable'));
      s.onerror = () => rej(new Error('maps script failed'));
      document.head.appendChild(s);
    });
    return _mapsSDK;
  }
  // Shift a centreline route into the correct travel lane (US = right-hand side) so the guide
  // line sits in the lane you actually drive, not on the centre divider — most noticeable on
  // wide/divided roads. Right-of-travel in this frame (x=east, z=south, north-up) is (-tz, tx)
  // for unit tangent t; endpoints reuse their neighbour's tangent.
  function laneOffsetRoute(pts, off) {
    if (!pts || pts.length < 2 || !off) return pts;
    const out = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      out[i] = { x: pts[i].x + (-tz) * off, z: pts[i].z + tx * off };
    }
    return out;
  }
  const LANE_OFFSET = 2.8;   // metres right of centreline ≈ middle of the right-hand lane

  function fetchRoute(destLat, destLon) {
    const reqId = ++routeReqId;
    loadMapsSDK().then(maps => {
      const o = worldToGeo(car.x, car.z);
      new maps.DirectionsService().route(
        { origin: { lat: o.lat, lng: o.lon }, destination: { lat: destLat, lng: destLon }, travelMode: 'DRIVING' },
        (result, status) => {
          if (reqId !== routeReqId || !DEST || !DEST.geo ||
            Math.abs(DEST.geo.lat - destLat) > 1e-7 || Math.abs(DEST.geo.lon - destLon) > 1e-7) return;
          if (status === 'OK' && result.routes && result.routes[0]) {
            const route = result.routes[0];
            const stepPath = [];
            for (const leg of route.legs || []) for (const step of leg.steps || []) for (const p of step.path || []) stepPath.push(p);
            const src = stepPath.length ? stepPath : route.overview_path;
            const pts = src.map(p => { const w = geoToWorld(p.lat(), p.lng()); return { x: w[0], z: w[1] }; });
            if (pts.length > 1) {
              ROUTE = laneOffsetRoute(pts, LANE_OFFSET); routeIdx = 0;   // ride the correct lane, not the divider
              snapDestinationToRouteEnd(ROUTE);
              if (autoDrive && Math.abs(car.speed) < 6) faceRouteStart();   // just set off / was holding → aim down the real route
              if (!_quietRoute) toast('🗺️ Route ready — follow the line', 1500);
            }
          } else console.warn('[directions] no route:', status);
        }
      );
    }).catch(e => console.warn('[maps sdk] route unavailable, using straight line —', e && e.message));
  }
  function snapDestinationToRouteEnd(pts) {
    if (!DEST || !pts || pts.length < 2) return;
    const end = pts[pts.length - 1];
    const rawX = DEST.rawX == null ? DEST.x : DEST.rawX;
    const rawZ = DEST.rawZ == null ? DEST.z : DEST.rawZ;
    // Google geocodes addresses to parcels/rooftops, but cars need to arrive at
    // the drivable road endpoint. Keep the raw geo for retries; move the in-world
    // pin/arrival target to the route's curb-side finish when it is plausibly close.
    const maxSnap = DEST.celebrate ? 450 : 240;
    if (Math.hypot(end.x - rawX, end.z - rawZ) > maxSnap) return;
    DEST.rawX = rawX; DEST.rawZ = rawZ;
    DEST.x = end.x; DEST.z = end.z;
    destPin.userData.groundY = null;
  }
  // fromSearch = the player explicitly chose this place from the GO address search;
  // only THOSE arrivals earn the "Arrived" banner (a casual map tap does not).
  function setDestination(lat, lon, label, isChain, fromSearch, opts = {}) {
    stopFollow();   // picking a new destination ends an active "follow me"
    const w = geoToWorld(lat, lon);
    let seedRoute = null;
    if (opts.drive) {
      seedRoute = localRoadRoute(car.x, car.z, w[0], w[1]);
      if (!seedRoute) {
        const np = nearestRoadPoint(w[0], w[1]);
        if (np && np.d < 90) seedRoute = localRoadRoute(car.x, car.z, np.x, np.z);
      }
    }
    DEST = { x: w[0], z: w[1], rawX: w[0], rawZ: w[1], label: label || 'Destination', geo: { lat, lon }, celebrate: (!!fromSearch || !!opts.celebrate) && !opts.quiet };   // geo kept so a failed route can self-retry
    ROUTE = seedRoute || null; routeIdx = 0;
    if (ROUTE) snapDestinationToRouteEnd(ROUTE);
    destPin.userData.groundY = null;
    emit('dest', { label: DEST.label });
    _quietRoute = !!opts.quiet;   // suppress the follow-up "Route ready" toast on quiet (follow-mode) re-routes
    if (!isChain && !opts.quiet) { const km = (Math.hypot(DEST.x - car.x, DEST.z - car.z) / 1000).toFixed(1); toast('📍 ' + esc(DEST.label) + ' · ' + km + ' km — routing…', 2200); }
    fetchRoute(lat, lon);
    if (opts.drive) {
      autoDrive = true; inp2.navActive = false;
      emit('autodrive', true);
      faceRouteStart();
    }
  }
  function clearDestination() {
    routeReqId++; DEST = null; ROUTE = null; routeIdx = 0; autoDrive = false; inp2.navActive = false;
    clearRouteRail(); clearRouteCaches();
    guideLine.visible = false; destPin.visible = false; destPin.userData.groundY = null;
    emit('dest', null); emit('autodrive', false);
  }
  // ---- address search (Google JS SDK — the Geocoder + Places run IN-BROWSER where the REST
  // Geocoding/Directions endpoints are CORS-blocked, which is why the old fetch box failed) ----
  function geocodeAddress(text) {
    return loadMapsSDK().then(maps => new Promise((res, rej) => {
      new maps.Geocoder().geocode({ address: text }, (r, status) => {
        if (status === 'OK' && r && r[0]) { const l = r[0].geometry.location; res({ lat: l.lat(), lon: l.lng(), label: r[0].formatted_address }); }
        else rej(new Error('geocode ' + status));
      });
    }));
  }
  // Correct the preset POIs to their REAL coordinates via Google geocoding (the hardcoded
  // lat/lons were approximate). Updates each POI's world position so proximity/'found' and
  // the in-world beacon+label point at the actual place; shifts the Stanton dancers along.
  const POI_ADDR = {
    meemaw: '4311 Circle Ave, Castro Valley, CA 94546',
    canyon: 'Canyon Middle School, Castro Valley, CA',
    stanton: 'Stanton Elementary School, Castro Valley, CA',
    dad: '807 Broadway, Oakland, CA 94607',
  };
  function geocodePOIs() {
    for (const p of POIS) {
      const addr = POI_ADDR[p.key];
      if (!addr) continue;
      geocodeAddress(addr).then(g => {
        const w = geoToWorld(g.lat, g.lon), ox = p.x, oz = p.z;
        p.x = w[0]; p.z = w[1]; p.lat = g.lat; p.lon = g.lon;
        const b = poiBeacons.find(x => x.poi.key === p.key); if (b) { b.mesh.position.x = p.x; b.mesh.position.z = p.z; }
        const lb = poiLabels.find(x => x.poi.key === p.key); if (lb) { lb.spr.position.x = p.x; lb.spr.position.z = p.z; }
        for (const sp of crowdSpots) if (sp.zone === p.key) {
          const dx = p.x - ox, dz = p.z - oz;
          sp.rec.grp.position.x += dx; sp.rec.grp.position.z += dz;
          sp.rec.x += dx; sp.rec.z += dz;
          sp.rec.baseX += dx; sp.rec.baseZ += dz;
        }   // shift this POI's dancers with the corrected geocode location
      }).catch(() => { });
    }
  }
  // ---- live Google minimap (always shows real streets, even far from the procedural
  // neighbourhood where the canvas minimap goes blank). Centres on the car, draws the route,
  // and a tap drives there. Sits OVER the procedural canvas, which stays as the fallback. ----
  const DARK_MAP_STYLE = [
    { elementType: 'geometry', stylers: [{ color: '#1b2027' }] },
    { elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#3a4350' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#55617a' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#16202b' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#222831' }] },
  ];
  let _gmap = null, _gmapCar = null, _gmapRoute = null, _gmapClick = null, _gmapT = 0, _gmapDiv = null, _gmapRouteFor = null, _gmaps = null, _gmapOverviewUntil = 0, _gmapHeading = 0, _gmapRot = 0, _gmapScale = 1;
  function disposeMiniMap() {
    if (_gmapDiv) _gmapDiv.style.transform = '';   // drop any heading-up rotation so a re-mount starts clean
    if (_gmapClick) { _gmapClick.remove(); _gmapClick = null; }
    if (_gmapCar) { _gmapCar.setMap(null); _gmapCar = null; }
    if (_gmapRoute) { _gmapRoute.setMap(null); _gmapRoute = null; }
    if (_gmaps && _gmap) _gmaps.event.clearInstanceListeners(_gmap);
    _gmap = null; _gmapDiv = null; _gmapRouteFor = null; _gmapOverviewUntil = 0;
  }
  function initMiniMap(div) {
    if (!div || _gmapDiv === div) return;
    disposeMiniMap();
    _gmapDiv = div;
    div.style.transformOrigin = '50% 50%'; div.style.willChange = 'transform';   // spin the heading-up map about its centre (the car)
    loadMapsSDK().then(maps => {
      if (disposed || _gmapDiv !== div) return;
      _gmaps = maps;
      const o = worldToGeo(car.x, car.z);
      _gmap = new maps.Map(div, {
        center: { lat: o.lat, lng: o.lon }, zoom: 12, disableDefaultUI: true,   // zoomed-out district view (~10 km across) so fast cross-town drives stay on the map
        gestureHandling: 'none', keyboardShortcuts: false, clickableIcons: false,
        styles: DARK_MAP_STYLE, backgroundColor: '#1b2027', isFractionalZoomEnabled: true,
      });
      _gmapCar = new maps.Marker({ position: { lat: o.lat, lng: o.lon }, map: _gmap, zIndex: 5,
        icon: { path: 'M0,-10 L7,8 L0,3 L-7,8 Z', fillColor: '#2D8CFF', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1.5, scale: 1.05, rotation: 0, anchor: new maps.Point(0, 0) } });
      _gmapRoute = new maps.Polyline({ map: _gmap, strokeColor: '#2D8CFF', strokeOpacity: 0.95, strokeWeight: 4, path: [], zIndex: 3 });
      // TAP-TO-DRIVE on the heading-up map: Google's own click→latLng is computed from the click's
      // offset within the container, which a CSS rotate()+scale() DISTORTS (taps land in the wrong
      // place). So handle the tap ourselves: undo the scale + rotation we applied, then convert the
      // map-local pixel offset to a world point via the live metres-per-pixel. Capture phase so it
      // beats any inner Google handler.
      const onTap = (e) => {
        if (!_gmap) return;
        const r = div.getBoundingClientRect();
        const fcx = r.left + r.width / 2, fcy = r.top + r.height / 2;   // rotate/scale are about centre → bbox centre stays on the car
        const ox = (e.clientX - fcx) / _gmapScale, oy = (e.clientY - fcy) / _gmapScale;   // undo fill scale → layout px from centre
        const ar = _gmapRot * Math.PI / 180, c = Math.cos(ar), s = Math.sin(ar);          // undo the heading-up rotation
        const mx = ox * c - oy * s, my = ox * s + oy * c;
        const lat = _gmap.getCenter().lat(), z = _gmap.getZoom();
        const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);        // Web-Mercator metres per layout px
        setDriveTarget(car.x + mx * mpp, car.z + my * mpp);   // screen x→east(+x), screen y(down)→south(+z)
      };
      div.addEventListener('click', onTap, true);
      _gmapClick = { remove: () => div.removeEventListener('click', onTap, true) };   // disposeMiniMap calls _gmapClick.remove()
    }).catch(() => { });
  }
  function updateMiniMap(now) {
    if (!_gmap || now - _gmapT < 200) return;   // ~5 Hz pan
    _gmapT = now;
    const o = worldToGeo(car.x, car.z);
    // HEADING-UP: spin the whole map so the car's heading points UP — oriented like the driver/user,
    // the way a phone GPS does. World is x=east, z=-north and car.yaw=atan2(east,-north), so the
    // compass bearing (cw from north) = 180°−yaw. We counter-rotate the map div by that bearing (and
    // scale up to fill the corners the rotation exposes), then point the car marker the same way so it
    // sits pointing straight up. During a route OVERVIEW the map isn't car-centred, so stay north-up.
    const bearing = 180 - car.yaw * 180 / Math.PI;
    const overview = now < _gmapOverviewUntil;
    if (!overview) { const d = ((bearing - _gmapHeading + 180) % 360 + 360) % 360 - 180; _gmapHeading += d * 0.35; }   // smoothed, unwrapped → no shimmer / no 360° spin
    _gmapRot = overview ? 0 : _gmapHeading; _gmapScale = overview ? 1 : 1.62;   // kept in sync with the transform below so the tap handler can invert it exactly
    if (_gmapDiv) _gmapDiv.style.transform = overview ? 'none' : `rotate(${(-_gmapHeading).toFixed(2)}deg) scale(${_gmapScale})`;
    if (_gmapCar) {
      _gmapCar.setPosition({ lat: o.lat, lng: o.lon });
      const ic = _gmapCar.getIcon(); ic.rotation = overview ? bearing : _gmapHeading; _gmapCar.setIcon(ic);   // north-up: along bearing; heading-up: same as the div's counter-rotation → points UP
    }
    if (_gmapRoute) {
      if (ROUTE && ROUTE.length && _gmapRouteFor !== ROUTE) {
        _gmapRouteFor = ROUTE;
        const pts = ROUTE.map(p => { const g = worldToGeo(p.x, p.z); return { lat: g.lat, lng: g.lon }; });
        _gmapRoute.setPath(pts);
        // ROUTE OVERVIEW: fit the whole start→finish into view for a few seconds when a new
        // route is set, then resume following the car (the user asked to see the full route).
        if (_gmaps) { const b = new _gmaps.LatLngBounds(); b.extend({ lat: o.lat, lng: o.lon }); for (const p of pts) b.extend(p); _gmap.fitBounds(b, 12); _gmapOverviewUntil = now + 3500; }
      } else if (!ROUTE && _gmapRouteFor) { _gmapRouteFor = null; _gmapRoute.setPath([]); }
    }
    if (now >= _gmapOverviewUntil) { _gmap.setCenter({ lat: o.lat, lng: o.lon }); if (_gmap.getZoom() !== 12) _gmap.setZoom(12); }   // follow the car zoomed out (~10 km across); settle back to 12 after any route overview
  }
  function geocodePlaceId(placeId, fallbackLabel) {
    return loadMapsSDK().then(maps => new Promise((res, rej) => {
      new maps.Geocoder().geocode({ placeId }, (r, status) => {
        if (status === 'OK' && r && r[0]) { const l = r[0].geometry.location; res({ lat: l.lat(), lon: l.lng(), label: fallbackLabel || r[0].formatted_address }); }
        else rej(new Error('geocode ' + status));
      });
    }));
  }
  let _acSvc = null, _acTok = null;
  const _acCache = new Map();
  function placeSuggest(text) {
    const q = (text || '').trim().replace(/\s+/g, ' ');
    if (q.length < 4) return Promise.resolve([]);
    const key = q.toLowerCase();
    if (_acCache.has(key)) return Promise.resolve(_acCache.get(key));
    return loadMapsSDK().then(maps => new Promise(res => {
      if (!maps.places) { res([]); return; }
      if (!_acSvc) _acSvc = new maps.places.AutocompleteService();
      if (!_acTok) _acTok = new maps.places.AutocompleteSessionToken();
      _acSvc.getPlacePredictions({ input: q, sessionToken: _acTok, componentRestrictions: { country: 'us' } }, (preds, status) => {
        const out = (status === 'OK' && preds) ? preds.slice(0, 4).map(p => ({ description: p.description, placeId: p.place_id })) : [];
        _acCache.set(key, out);
        if (_acCache.size > 40) _acCache.delete(_acCache.keys().next().value);
        res(out);
      });
    })).catch(() => []);
  }
  // Relocate the START: teleport the car to an address, land it on a ROAD (so it matches
  // where Drive-to arrives — Google geocodes to a rooftop/parcel, not the curb), clear any
  // destination, re-settle the camera. Lets you start anywhere on the map.
  let jumpReqId = 0;
  // Full post-teleport reset in ONE place: zero the car's motion, force a fresh ground
  // sample, and RE-SEAT every camera reference (camGroundRef/camFloorRef were the ones the
  // old jump paths forgot — leaving the orbit cam floating at the OLD altitude for seconds,
  // which read as "we lost the car"). Short cooldown so a bad landing still recovers fast.
  function settleAfterTeleport() {
    car.speed = 0; car.vlat = 0; car.steer = 0; car.assistRate = 0; car.revArmT = 0; car.groundY = null;
    camInit = false; camGroundRef = null; camFloorRef = null; inp2.navActive = false; recoverCooldown = 0.6;
  }
  function jumpTo(lat, lon, label) {
    const ox = car.x, oz = car.z;                         // origin for the road-end query (captured before we teleport)
    const w = geoToWorld(lat, lon);
    car.x = w[0]; car.z = w[1];
    // Snap onto the local street graph when one is near (the generous radius matches the
    // tap-to-drive snap, so jumps inside the neighborhood land in the street like a drive).
    // Even if no road is "near", if the rooftop geocode dropped us INSIDE a building, nudge
    // to the nearest road so the car never lands wedged (can't move in any gear).
    const np = nearestRoadPoint(car.x, car.z);
    const onLocalRoad = np && np.d < 90;
    if (onLocalRoad) { car.x = np.x; car.z = np.z; }
    else if (np && insideBuilding(car.x, car.z)) { car.x = np.x; car.z = np.z; }
    clearDestination();
    settleAfterTeleport();
    toast('📍 Jumped to ' + esc(label || 'there'), 1500);
    // Far from the neighborhood there's no local road graph, so the geocode rooftop would
    // strand the car ON a building. Match Drive-to EXACTLY: ask Google for the route and slide
    // the car to the route's curb-side end when it resolves (a few-metre nudge onto the road).
    if (!onLocalRoad) snapJumpToRoad(ox, oz, lat, lon, ++jumpReqId);
  }
  // One-shot road-snap for a FAR jump: route origin→destination and move the car to the
  // route's final point — the same curb Drive-to arrives at. Bails if a newer jump fired or
  // the player has since set a destination, so it never yanks the car out from under them.
  function snapJumpToRoad(ox, oz, lat, lon, reqId) {
    loadMapsSDK().then(maps => {
      const o = worldToGeo(ox, oz);
      new maps.DirectionsService().route(
        { origin: { lat: o.lat, lng: o.lon }, destination: { lat, lng: lon }, travelMode: 'DRIVING' },
        (result, status) => {
          if (reqId !== jumpReqId || DEST) return;
          if (status !== 'OK' || !result.routes || !result.routes[0]) return;
          const path = [];
          for (const leg of result.routes[0].legs || []) for (const step of leg.steps || []) for (const p of step.path || []) path.push(p);
          const src = path.length ? path : result.routes[0].overview_path;
          if (!src || !src.length) return;
          const end = src[src.length - 1], e = geoToWorld(end.lat(), end.lng());
          car.x = e[0]; car.z = e[1];
          // de-wedge: if the route end still sits inside a footprint, slide to the nearest road
          const np = nearestRoadPoint(car.x, car.z);
          if (np && (np.d < 90 || insideBuilding(car.x, car.z))) { car.x = np.x; car.z = np.z; }
          settleAfterTeleport();   // re-seat camera/ground refs (was leaving camGroundRef stale → floating cam)
        }
      );
    }).catch(() => {});
  }
  // Destination by address / place — geocode then route there (and auto-drive on request).
  function setDestinationByText(text, drive) {
    return geocodeAddress(text).then(g => { setDestination(g.lat, g.lon, g.label, false, true, { drive, celebrate: true }); return g; });
  }
  function setDestinationByPlace(placeId, label, drive) {
    return geocodePlaceId(placeId, label).then(g => { _acTok = null; setDestination(g.lat, g.lon, g.label, false, true, { drive, celebrate: true }); return g; });
  }
  function driveHome() {
    setDestination(homeGeo.lat, homeGeo.lon, 'Home', false, true, { drive: true, celebrate: true });
    return Promise.resolve({ lat: homeGeo.lat, lon: homeGeo.lon, label: 'Home' });
  }
  function jumpHome() {   // TELEPORT home (the "Jump there" button) — driveHome() chauffeur-drives, which is wrong for Jump
    jumpTo(homeGeo.lat, homeGeo.lon, 'Home');
    return Promise.resolve({ lat: homeGeo.lat, lon: homeGeo.lon, label: 'Home' });
  }
  function driveToLatLon(lat, lon, label, quiet) {
    setDestination(lat, lon, label, false, true, { drive: true, celebrate: true, quiet });
    return Promise.resolve({ lat, lon, label: label || 'Destination' });
  }
  // FOLLOW = track the user's real GPS position EXACTLY: glide straight to the live point (NO Google
  // routing — that snapped to the "wrong street" and overshot short hops) and orient the car to the
  // phone's compass heading. "Drive to me" (non-follow) still routes there once for the scenic drive.
  let _geoWatch = null, followMode = false, _followGeo = null, _followHeading = null;
  let _headingOn = false, _headingOff = null;
  function startHeading() {
    if (_headingOn) return;
    const onOrient = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;   // iOS: degrees clockwise from true north
      else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;                                          // others: alpha rises counter-clockwise from north
      if (h != null) _followHeading = Math.PI - h * Math.PI / 180;   // → world yaw (x=E, z=-N, forward=(sin,cos)): yaw = π − heading
    };
    const attach = () => {
      _headingOn = true;
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
      _headingOff = () => { window.removeEventListener('deviceorientationabsolute', onOrient, true); window.removeEventListener('deviceorientation', onOrient, true); };
    };
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') DOE.requestPermission().then(s => { if (s === 'granted') attach(); }).catch(() => { });   // iOS 13+: gesture-gated permission
    else attach();
  }
  function stopHeading() { if (_headingOff) { try { _headingOff(); } catch (e) { } } _headingOff = null; _headingOn = false; _followHeading = null; }
  function stopFollow() {
    const was = followMode || _geoWatch != null;
    if (_geoWatch != null) { try { navigator.geolocation.clearWatch(_geoWatch); } catch (e) { } _geoWatch = null; }
    followMode = false; _followGeo = null; stopHeading();
    if (was) emit('follow', false);
  }
  function driveToMyLocation(follow) {
    if (!navigator.geolocation) { toast('📍 Location unavailable on this device', 1800); return Promise.reject(new Error('no-geo')); }
    stopFollow();
    if (mode !== 'drive') enterDrive();
    if (follow) {
      startHeading();                                                  // request the compass NOW, inside the button-tap gesture (iOS requires that)
      followMode = true; autoDrive = false; clearRouteRail(); clearDestination();   // exact-follow OWNS the car — kill any rail/route
      emit('autodrive', false); emit('follow', true);
      toast('📍 Following you — the car tracks your location', 1700);
    }
    return new Promise((resolve, reject) => {
      let done = false;
      navigator.geolocation.getCurrentPosition(
        pos => {
          const lat = pos.coords.latitude, lon = pos.coords.longitude;
          if (Number.isFinite(lat) && Number.isFinite(lon) && mode === 'drive') {
            const w = geoToWorld(lat, lon);
            if (follow) _followGeo = { x: w[0], z: w[1] };               // updateDrive glides the car here, overshoot-free
            else { driveToLatLon(lat, lon, '📍 Your location'); toast('📍 Driving to you', 1500); }
          }
          if (!done) { done = true; resolve({ lat, lon }); }
        },
        err => { stopFollow(); toast('📍 Could not get your location (allow access?)', 2200); if (!done) { done = true; reject(err); } },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 2000 });
      if (follow) {
        _geoWatch = navigator.geolocation.watchPosition(pos => {
          const lat = pos.coords.latitude, lon = pos.coords.longitude;
          if (!followMode || mode !== 'drive' || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
          if (pos.coords.accuracy != null && pos.coords.accuracy > 60) return;   // drop junk fixes — those caused the "wrong street" jumps
          const w = geoToWorld(lat, lon);
          _followGeo = { x: w[0], z: w[1] };                            // just move the target; the glide in updateDrive smooths jitter + can't overshoot
        }, () => { }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 });
      }
    });
  }
  // Autodrive max-speed cap (mph; 0 = uncapped). Persisted; applied in autoDriveTargetSpeed.
  let autoMaxMph = (() => { try { return parseInt(localStorage.getItem('dahill.automax') || '0', 10) || 0; } catch (e) { return 0; } })();
  function setAutoMaxMph(mph) { autoMaxMph = Math.max(0, mph | 0); try { localStorage.setItem('dahill.automax', String(autoMaxMph)); } catch (e) { } emit('automax', autoMaxMph); }
  // Global driving-speed/accel multiplier (settings slider). Scales top speed AND accel so the
  // whole envelope slows together — a parent can dial it down for little kids on tight streets.
  let speedMul = (() => { try { const v = parseFloat(localStorage.getItem('dahill.speedmul')); return v >= 0.3 && v <= 2 ? v : 1; } catch (e) { return 1; } })();
  function setSpeedMul(v) { speedMul = clamp(+v || 1, 0.3, 2); try { localStorage.setItem('dahill.speedmul', String(speedMul)); } catch (e) { } }
  // Tap-to-drive from the minimap: set a raw world point as the destination and let
  // the robot drive there (no Google route needed for a nearby local point). Reuses
  // DEST + auto-drive, so the guide ribbon, pin, ETA and arrival all just work.
  // Aim the car down the START of the route so auto-drive sets off FORWARD instead of a
  // rough U-turn / spin-around (the user's idea: "when autodrive starts it can just point
  // the car in the right direction"). Snaps the heading toward the first route point a few
  // metres out (or the destination if a route isn't ready yet).
  function faceRouteStart() {
    let tx = null, tz = null;
    if (ROUTE && ROUTE.length) {
      let i = Math.max(0, routeIdx);
      while (i < ROUTE.length - 1 && Math.hypot(ROUTE[i].x - car.x, ROUTE[i].z - car.z) < 6) i++;
      tx = ROUTE[i].x; tz = ROUTE[i].z;
    } else if (DEST) { tx = DEST.x; tz = DEST.z; }
    if (tx == null || Math.hypot(tx - car.x, tz - car.z) < 1) return;
    car.yaw = Math.atan2(tx - car.x, tz - car.z);
    car.steer = 0; car.vlat = 0; car.assistRate = 0; camInit = false;   // re-settle the chase cam behind the new heading
  }
  function setDriveTarget(wx, wz) {
    // ALWAYS follow a real ROAD path to the point — NEVER a straight line across the land.
    // Seed an instant on-road route from the local street graph so the car sets off at once,
    // and fetch the Google Directions path to refine/extend it. If neither is ready the car
    // simply HOLDS (idles) until a road route exists — it never cuts across the grass. Then
    // point the car down the route so it doesn't have to turn itself around.
    const g = worldToGeo(wx, wz);
    let route = localRoadRoute(car.x, car.z, wx, wz);
    if (!route) { const np = nearestRoadPoint(wx, wz); if (np && np.d < 90) route = localRoadRoute(car.x, car.z, np.x, np.z); }
    DEST = { x: wx, z: wz, rawX: wx, rawZ: wz, label: 'the map point', geo: g }; ROUTE = route || null; routeIdx = 0; destPin.userData.groundY = null;   // geo kept so a failed route can self-retry
    if (ROUTE) snapDestinationToRouteEnd(ROUTE);
    fetchRoute(g.lat, g.lon);                            // Google road path (async) → overwrites the seed when ready
    autoDrive = true; inp2.navActive = false;
    emit('dest', { label: DEST.label }); emit('autodrive', true);
    faceRouteStart();
    toast(route ? '🤖 Cruising the streets' : '🗺️ Finding a road route…', 1200);
  }
  // Live nav target: a look-ahead point ~32 m along the route from the car (so the
  // guide ribbon + auto-drive follow the road smoothly instead of snapping between
  // dense waypoints). Falls back to the destination (straight line) with no route.
  function navTarget() {
    if (!ROUTE || routeIdx >= ROUTE.length) return DEST;
    // SPEED-SCALED look-ahead: tight at low speed so the car HUGS the route (sticks to
    // the road through turns), longer at speed for a smooth line. A fixed 32 m look-ahead
    // cut every corner.
    const look = clamp(Math.abs(car.speed) * 0.42, 11, 42);   // tight at low speed (HUGS corners), longer at speed so the chauffeur can anticipate the next bend far from home
    let acc = 0, px = car.x, pz = car.z;
    for (let i = routeIdx; i < ROUTE.length; i++) {
      acc += Math.hypot(ROUTE[i].x - px, ROUTE[i].z - pz); px = ROUTE[i].x; pz = ROUTE[i].z;
      if (acc >= look) return laneOffset(i);
    }
    return DEST;
  }
  // LANE: aim ~1.7 m to the RIGHT of the route centreline so the car drives IN A LANE
  // instead of straddling the middle of the road (it follows the right perpendicular of the
  // local route direction). Only kicks in on faster/wider roads where lane-keeping reads.
  function laneOffset(i) {
    const a = ROUTE[Math.max(0, i - 1)], b = ROUTE[Math.min(ROUTE.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    // Lane offset only at highway speed, and SMALLER on the tight procedural
    // neighbourhood streets (onRoad mask, or within the ~340 m home block) so it
    // hugs the lane out on the wide real roads without scraping the curb in town.
    const narrow = onRoad(ROUTE[i].x, ROUTE[i].z) || Math.hypot(ROUTE[i].x, ROUTE[i].z) < 340;
    const off = clamp((Math.abs(car.speed) - 22) / 30, 0, 1) * (narrow ? 0.45 : 1.1);
    return { x: ROUTE[i].x + dz * off, z: ROUTE[i].z - dx * off };   // right perpendicular = (dz, -dx)
  }
  // distance along the route to the next real TURN (>~25° heading change) — lets the
  // chauffeur run FAST on long straights and only slow for corners/arrival.
  function distToNextTurn() {
    if (!ROUTE || routeIdx >= ROUTE.length - 1) return 40;
    let acc = 0, px = car.x, pz = car.z;
    let hx = ROUTE[routeIdx].x - px, hz = ROUTE[routeIdx].z - pz; let hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
    for (let i = routeIdx; i < ROUTE.length - 1 && acc < 500; i++) {
      acc += Math.hypot(ROUTE[i].x - px, ROUTE[i].z - pz); px = ROUTE[i].x; pz = ROUTE[i].z;
      let nx = ROUTE[i + 1].x - px, nz = ROUTE[i + 1].z - pz; const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
      if (hx * nx + hz * nz < 0.9) break;   // ~25°+ bend ahead
      hx = nx; hz = nz;
    }
    return acc;
  }
  // ---- auto-drive RAIL: a chauffeur is not a physics sim. Glue the car to the route polyline and
  // advance it by arc-length at a fast cruise, so a cross-town trip takes ~30-90 s and it can never
  // overshoot a bend or ping-pong off the route, no matter the speed. (Supernatural traction by design.)
  let _routeLenFor = null, _routeLen = 0;
  function routeTotalLen() {
    if (!ROUTE) return 0;
    if (_routeLenFor === ROUTE) return _routeLen;
    _routeLenFor = ROUTE; _routeLen = 0;
    for (let i = 0; i < ROUTE.length - 1; i++) _routeLen += Math.hypot(ROUTE[i + 1].x - ROUTE[i].x, ROUTE[i + 1].z - ROUTE[i].z);
    return _routeLen;
  }
  function railArcAt(x, z) {   // arc-length (m from ROUTE[0]) of the nearest point on the route to (x,z)
    let bestS = 0, bd = 1e18, acc = 0;
    for (let i = 0; i < ROUTE.length - 1; i++) {
      const ax = ROUTE[i].x, az = ROUTE[i].z, vx = ROUTE[i + 1].x - ax, vz = ROUTE[i + 1].z - az, L = Math.hypot(vx, vz) || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / (L * L); t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t, pz = az + vz * t, d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bd) { bd = d; bestS = acc + t * L; }
      acc += L;
    }
    return bestS;
  }
  function railPointAt(s) {   // { x, z, yaw, i } at arc-length s along the route
    let acc = 0;
    for (let i = 0; i < ROUTE.length - 1; i++) {
      const ax = ROUTE[i].x, az = ROUTE[i].z, vx = ROUTE[i + 1].x - ax, vz = ROUTE[i + 1].z - az, L = Math.hypot(vx, vz) || 1;
      if (acc + L >= s || i === ROUTE.length - 2) {
        const t = clamp((s - acc) / L, 0, 1);
        return { x: ax + vx * t, z: az + vz * t, yaw: Math.atan2(vx, vz), i };
      }
      acc += L;
    }
    const last = ROUTE[ROUTE.length - 1], prev = ROUTE[ROUTE.length - 2];
    return { x: last.x, z: last.z, yaw: Math.atan2(last.x - prev.x, last.z - prev.z), i: ROUTE.length - 2 };
  }
  function autoDriveTargetSpeed(dDest) {
    const turn = distToNextTurn();
    const straight = clamp((turn - 12) / 95, 0, 1);          // reach full speed on shorter straights
    const far = clamp((dDest - 35) / 220, 0, 1);
    const cruise = 34 + straight * 250 + far * 30;          // up to ~700 mph on a long open straight
    const approach = dDest < 85 ? clamp(14 + dDest * 0.52, 14, 54) : cruise;
    let s = Math.min(cruise, approach);
    // HARD turn cap: never go faster than you can comfortably slow for the next bend, scaled
    // by distance to it. Without this the chauffeur blasts a highway at 450 mph and overshoots
    // the onramp/exit, looping the interchange. ~40 u/s near a turn → ~400 on a long straight.
    s = Math.min(s, 16 + turn * 1.25);   // reuse the `turn` computed above — don't walk the route twice
    if (autoMaxMph) s = Math.min(s, autoMaxMph / 2.237);   // user's autodrive speed-limit slider (mph → world u/s)
    return s;
  }
  function toggleAutoDrive() { if (!DEST) return; autoDrive = !autoDrive; clearRouteRail(); if (!autoDrive) inp2.navActive = false; else faceRouteStart(); emit('autodrive', autoDrive); toast(autoDrive ? '🤖 Fast auto-drive ON' : 'Auto-drive off', 1100); }
  // nearest road-segment direction (oriented to the car's heading) for the lane-keep
  // assist — returns null when you're >9 m off any road (so it never drags you off a lawn).
  // Free-roam auto-steer aim point. Instead of just aligning heading to the nearest road
  // tangent (which gives up at sharp corners and never reels you back to the centre), we
  // project a point LOOKAHEAD metres ahead of the car onto the road and return it as a
  // target to steer toward. That single point does three jobs at once: it anticipates the
  // bend (the probe lands on the post-corner segment), it pulls you back to the centreline
  // when you run wide, and it needs no wide-angle gate to survive a 90° street corner.
  // Returns null when the car is >10 m off any road (don't tug you around a lawn).
  function roadTargetAhead(x, z, yaw, speed) {
    const segs = (x * x + z * z < 330 * 330) ? roadSegs : osmRoadSegs;   // hood graph near home, the fetched OSM graph everywhere else
    let carD = 1e18;                                 // how far the car is from the road right now
    for (const s of segs) {
      const ax = s[0][0], az = s[0][1], vx = s[1][0] - ax, vz = s[1][1] - az, L2 = vx * vx + vz * vz || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + vx * t - x, ez = az + vz * t - z, d = ex * ex + ez * ez;
      if (d < carD) carD = d;
    }
    if (carD > 100) return null;                     // >10 m off any road → no assist
    const La = clamp(Math.abs(speed) * 0.55, 7, 40); // look further ahead the faster you go
    const px = x + Math.sin(yaw) * La, pz = z + Math.cos(yaw) * La;
    let btx = 0, btz = 0, bd = 1e18; let found = false;
    for (const s of segs) {
      const ax = s[0][0], az = s[0][1];
      const mx = (ax + s[1][0]) / 2 - x, mz = (az + s[1][1]) / 2 - z;
      if (mx * mx + mz * mz > 900) continue;         // only roads within ~30 m (stay on THIS road)
      const vx = s[1][0] - ax, vz = s[1][1] - az, L2 = vx * vx + vz * vz || 1;
      let t = ((px - ax) * vx + (pz - az) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + vx * t, cz = az + vz * t, ex = cx - px, ez = cz - pz, d = ex * ex + ez * ez;
      if (d < bd) { bd = d; btx = cx; btz = cz; found = true; }
    }
    return found ? [btx, btz] : null;
  }
  // Nearest point on any neighbourhood road to (x,z), with its distance in metres. Drives
  // both the off-road steer-back (aim straight at it) and the auto-recover snap.
  function nearestRoadPoint(x, z) {
    let bx = x, bz = z, bd = 1e18;
    const tryAB = (ax, az, b0, b1) => {
      const vx = b0 - ax, vz = b1 - az, L2 = vx * vx + vz * vz || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t, pz = az + vz * t, d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bd) { bd = d; bx = px; bz = pz; }
    };
    // Live Google route first (real roads), then the OSM road network fetched around the car (works
    // far from the procedural hood), then EVERY mapped neighbourhood road. So the steer-back + soft
    // wall + reset always have a real road to aim at, anywhere on the map.
    if (ROUTE && ROUTE.length > 1) for (let i = 0; i < ROUTE.length - 1; i++) tryAB(ROUTE[i].x, ROUTE[i].z, ROUTE[i + 1].x, ROUTE[i + 1].z);
    for (const s of osmRoadSegs) tryAB(s[0][0], s[0][1], s[1][0], s[1][1]);
    for (const s of allRoadSegs) tryAB(s[0][0], s[0][1], s[1][0], s[1][1]);
    return { x: bx, z: bz, d: Math.sqrt(bd) };
  }
  // Live "where am I" readout: reverse-geocode the car's position to a rough STREET · CITY, ST and push
  // it to the subline. Throttled hard (every ~4 s, and only after moving ~140 m) to stay well within the
  // geocoder quota; falls back silently on any error.
  let _geoT = 0, _geoBusy = false, _geoLabel = '', _geoLast = null;
  function updateLocationLabel(now) {
    if (_geoBusy && now - _geoT > 12000) _geoBusy = false;   // watchdog: a Geocoder callback that never fires must not wedge the readout dead for the session
    if (mode !== 'drive' || _geoBusy || now - _geoT < 4000) return;
    if (_geoLast && Math.hypot(car.x - _geoLast.x, car.z - _geoLast.z) < 140) return;
    _geoT = now; _geoLast = { x: car.x, z: car.z };
    const g = worldToGeo(car.x, car.z);
    _geoBusy = true;
    loadMapsSDK().then(maps => {
      new maps.Geocoder().geocode({ location: { lat: g.lat, lng: g.lon } }, (res, status) => {
        _geoBusy = false;
        if (status !== 'OK' || !res || !res.length) return;
        let route = '', locality = '', hood = '', state = '';
        for (const r of res) for (const c of (r.address_components || [])) {
          if (!route && c.types.includes('route')) route = c.short_name || c.long_name;
          if (!locality && c.types.includes('locality')) locality = c.long_name;            // the actual CITY (preferred)
          if (!hood && (c.types.includes('neighborhood') || c.types.includes('sublocality'))) hood = c.long_name;   // fallback only when there's no locality
          if (!state && c.types.includes('administrative_area_level_1')) state = c.short_name;
        }
        const place = [locality || hood, state].filter(Boolean).join(', ');
        const label = [route, place].filter(Boolean).join(' · ');
        if (label && label !== _geoLabel) { _geoLabel = label; emit('subline', label); }
      });
    }).catch(() => { _geoBusy = false; });
  }
  // Fetch the REAL road network around the car from OpenStreetMap (Overpass) in a ~2.6 km box,
  // projected through the same ENU geoToWorld as the photoreal tiles, and refresh it as you drive
  // into new areas. This gives the lane-keep assist + soft-wall + reset a true road GRAPH everywhere,
  // not just the procedural hood — so road-hugging works far from home exactly like it does at home.
  // Self-throttled (one request at a time, ≥4 s apart, only when the car leaves the last box), and
  // fully graceful: if Overpass is unreachable it just keeps whatever roads it had (or none).
  function updateAreaRoads(now, force) {
    if (mode !== 'drive') return;
    if (Math.hypot(car.x, car.z) < 300) return;                                  // the hood's own roadSegs already cover here
    if (_osmFetching) return;                                                    // one fetch at a time
    if (!force) {
      if (now - _osmT < 4000) return;                                            // min 4 s apart (unless forced, e.g. by Return-to-road)
      if (_osmCenter && Math.hypot(car.x - _osmCenter.x, car.z - _osmCenter.z) < 850) return;   // the current box still covers us
    }
    _osmFetching = true; _osmT = now;
    const fx = car.x, fz = car.z, R = 1300;                                      // ~2.6 km box around the car
    const cs = [worldToGeo(fx - R, fz - R), worldToGeo(fx + R, fz - R), worldToGeo(fx - R, fz + R), worldToGeo(fx + R, fz + R)];
    const lats = cs.map(c => c.lat), lons = cs.map(c => c.lon);
    const s = Math.min(...lats).toFixed(6), n = Math.max(...lats).toFixed(6), w = Math.min(...lons).toFixed(6), e = Math.max(...lons).toFixed(6);
    const q = `[out:json][timeout:25];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${s},${w},${n},${e});out geom;`;
    const body = 'data=' + encodeURIComponent(q);
    const tryMirror = (n) => {
      if (n >= OVERPASS_MIRRORS.length) { _osmFetching = false; return; }   // all mirrors down: keep the last roads, retry next box
      const url = OVERPASS_MIRRORS[(_osmMirror + n) % OVERPASS_MIRRORS.length];
      // Hard 12 s cap per mirror: an overloaded Overpass host hangs ~48 s before its 504, which would
      // pin _osmFetching and starve the road graph. Abort early and fall through to the next mirror.
      const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 12000);
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: ac.signal })
        .then(r => { clearTimeout(to); return r.ok ? r.json() : Promise.reject(r.status); })
        .then(data => {
          const segs = [];
          for (const el of (data.elements || [])) {
            const g = el.geometry; if (el.type !== 'way' || !g || g.length < 2) continue;
            for (let i = 0; i < g.length - 1; i++) {
              const a = geoToWorld(g[i].lat, g[i].lon), b = geoToWorld(g[i + 1].lat, g[i + 1].lon);
              segs.push([[a[0], a[1]], [b[0], b[1]]]);
            }
          }
          if (segs.length) { osmRoadSegs = segs; _osmCenter = { x: fx, z: fz }; _osmMirror = (_osmMirror + n) % OVERPASS_MIRRORS.length; }   // stick with the mirror that worked
          _osmFetching = false;
        })
        .catch(() => { clearTimeout(to); tryMirror(n + 1); });   // this host is throttling/down — fall through to the next mirror
    };
    tryMirror(0);
  }
  // Local street fallback for minimap/tap auto-drive. Google Directions handles real
  // address trips; this keeps nearby "drive there" pins on neighborhood roads instead
  // of aiming a straight line across yards.
  function localRoadRoute(sx, sz, dx, dz) {
    if (!roadSegs.length) return null;
    const nodes = [], byKey = new Map(), edges = [];
    const segPts = roadSegs.map(() => []);
    const keyOf = (x, z) => Math.round(x * 10) / 10 + ',' + Math.round(z * 10) / 10;
    const addNode = (x, z) => {
      const key = keyOf(x, z);
      let id = byKey.get(key);
      if (id == null) { id = nodes.length; byKey.set(key, id); nodes.push({ x, z }); edges[id] = []; }
      return id;
    };
    const project = (x, z) => {
      let best = null, bd = 1e18;
      for (let i = 0; i < roadSegs.length; i++) {
        const s = roadSegs[i], ax = s[0][0], az = s[0][1], bx = s[1][0], bz = s[1][1];
        const vx = bx - ax, vz = bz - az, L2 = vx * vx + vz * vz || 1;
        let t = ((x - ax) * vx + (z - az) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + vx * t, pz = az + vz * t, d = (px - x) * (px - x) + (pz - z) * (pz - z);
        if (d < bd) { bd = d; best = { seg: i, t, x: px, z: pz, d: Math.sqrt(d) }; }
      }
      return best;
    };
    const start = project(sx, sz), finish = project(dx, dz);
    if (!start || !finish || start.d > 90 || finish.d > 90) return null;   // generous snap so taps near a road still route
    for (let i = 0; i < roadSegs.length; i++) {
      const s = roadSegs[i];
      segPts[i].push({ id: addNode(s[0][0], s[0][1]), t: 0 });
      segPts[i].push({ id: addNode(s[1][0], s[1][1]), t: 1 });
    }
    const sid = addNode(start.x, start.z), fid = addNode(finish.x, finish.z);
    segPts[start.seg].push({ id: sid, t: start.t });
    segPts[finish.seg].push({ id: fid, t: finish.t });
    const link = (a, b) => {
      if (a === b) return;
      const na = nodes[a], nb = nodes[b], w = Math.hypot(nb.x - na.x, nb.z - na.z);
      edges[a].push([b, w]); edges[b].push([a, w]);
    };
    for (let i = 0; i < segPts.length; i++) {
      const pts = segPts[i].sort((a, b) => a.t - b.t);
      for (let k = 0; k < pts.length - 1; k++) link(pts[k].id, pts[k + 1].id);
    }
    const dist = Array(nodes.length).fill(Infinity), prev = Array(nodes.length).fill(-1), used = Array(nodes.length).fill(false);
    dist[sid] = 0;
    for (let n = 0; n < nodes.length; n++) {
      let u = -1, bd = Infinity;
      for (let i = 0; i < nodes.length; i++) if (!used[i] && dist[i] < bd) { bd = dist[i]; u = i; }
      if (u < 0 || u === fid) break;
      used[u] = true;
      for (const [v, w] of edges[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
    }
    if (!isFinite(dist[fid])) return null;
    const out = [];
    for (let u = fid; u >= 0; u = prev[u]) { out.push({ x: nodes[u].x, z: nodes[u].z }); if (u === sid) break; }
    return out.length > 1 ? out.reverse() : null;
  }
  // Rebuild the guide ribbon along the route polyline ahead of the car: gather the next
  // ~170 m of route (its real turns), resample to ~5 m steps, drape each cross-section
  // to the ground (relative to the car's road height so it sits ON the street), and
  // write the triangle-strip vertices. Falls back to a straight line to a routeless DEST.
  // Cached canopy-skipped ROAD height per ROUTE point. Fallback heights retry until
  // tiles stream, so a route line never gets stuck forever at a procedural/clamped y.
  let _routeYFor = null, _routeY = [];
  function clearRouteCaches() {
    _routeLenFor = null; _routeLen = 0;
    _routeYFor = null; _routeY = [];
  }
  function guideHeightAt(i) {
    if (_routeYFor !== ROUTE) { _routeYFor = ROUTE; _routeY = []; }
    const p = ROUTE[i], tA = terrainAt(p.x, p.z), nowMs = performance.now();
    let rec = _routeY[i];
    if (!rec || (!rec.confirmed && nowMs >= (rec.retryAt || 0))) {
      const base = rec ? rec.y : tA;
      let y = rawTileY(p.x, p.z, base + 8);
      if (y == null && rec) y = rawTileY(p.x, p.z, base + 24);
      if (y == null && !rec) y = rawTileY(p.x, p.z);
      if (y != null) {
        const inHood = p.x * p.x + p.z * p.z <= 330 * 330;
        rec = { y: inHood ? clamp(y, tA - 2, tA + 2) : y, confirmed: true, retryAt: 0 };
      } else if (!rec) rec = { y: tA, confirmed: false, retryAt: nowMs + 350 };
      else rec.retryAt = nowMs + 350;
      _routeY[i] = rec;
    }
    return rec.y;
  }
  function updateGuide(yC) {
    // Rebuild EVERY frame (no move-throttle) so the ribbon GLIDES forward instead of
    // stepping in 1.5 m jumps. It's cheap now: the per-point road heights are cached, so a
    // frame is just interpolation + a tiny 540-float VBO upload — no per-frame raycasts.
    // start the ribbon ~6 m AHEAD of the car so the line never tints the car itself.
    const raw = [[car.x + Math.sin(car.yaw) * 6, car.z + Math.cos(car.yaw) * 6, yC]];
    if (ROUTE && routeIdx < ROUTE.length) {
      let acc = 0, px = car.x, pz = car.z;
      for (let i = routeIdx; i < ROUTE.length && acc < 170; i++) { acc += Math.hypot(ROUTE[i].x - px, ROUTE[i].z - pz); raw.push([ROUTE[i].x, ROUTE[i].z, guideHeightAt(i)]); px = ROUTE[i].x; pz = ROUTE[i].z; }
    } else { guideLine.visible = false; return; }   // ONLY ever follow a real road ROUTE — never a straight line across the land
    // resample to ~5 m steps, carrying the draped height through so each cross-section sits
    // on the road surface (interpolated between cached route-point heights).
    const pts = [raw[0]];
    for (let i = 1; i < raw.length && pts.length < GUIDE_N; i++) {
      const a = pts[pts.length - 1], b = raw[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.min(GUIDE_N - pts.length, Math.round(L / 5)));
      for (let s = 1; s <= steps; s++) { const t = s / steps; pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
    }
    if (pts.length < 2) { guideLine.visible = false; return; }
    const hw = 1.55;
    for (let i = 0; i < GUIDE_N; i++) {
      const k = Math.min(i, pts.length - 1), p = pts[k];
      const pp = pts[Math.max(0, k - 1)], pn = pts[Math.min(pts.length - 1, k + 1)];
      let tx = pn[0] - pp[0], tz = pn[1] - pp[1]; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const nx = -tz, nz = tx, y = p[2] + 0.38, o = i * 6;
      guidePos[o] = p[0] + nx * hw; guidePos[o + 1] = y; guidePos[o + 2] = p[1] + nz * hw;
      guidePos[o + 3] = p[0] - nx * hw; guidePos[o + 4] = y; guidePos[o + 5] = p[1] - nz * hw;
    }
    guideGeo.attributes.position.needsUpdate = true;
    guideGeo.setDrawRange(0, (Math.min(pts.length, GUIDE_N) - 1) * 6);   // only the built segments
    guideLine.visible = true;
  }
  // 2D minimap (HEADING-UP, centred on the car): roads, house, destination + line, car. The map
  // rotates so the car's forward is always "up" — oriented like the driver / user, the way a phone
  // GPS does. A small N tick shows where north is; tapMinimap inverts the SAME rotation so taps land.
  function drawMinimap(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, range = 620, scale = (w / 2) / range;   // wider view to match the live map zoom-out
    let _d = car.yaw - _miniYaw; while (_d > Math.PI) _d -= 2 * Math.PI; while (_d < -Math.PI) _d += 2 * Math.PI;
    _miniYaw += _d * 0.2;                                                  // ease the map's rotation so steering jitter doesn't shimmer the whole map
    const ca = Math.cos(_miniYaw), sa = Math.sin(_miniYaw);
    const toPx = (wx, wz) => { const dx = wx - car.x, dz = wz - car.z; return [cx + (-dx * ca + dz * sa) * scale, cy + (-dx * sa - dz * ca) * scale]; };   // heading-up rotation: forward → screen-up
    ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.beginPath();
    for (const s of roadSegs) {
      const a = toPx(s[0][0], s[0][1]), b = toPx(s[1][0], s[1][1]);
      if ((a[0] < -10 && b[0] < -10) || (a[0] > w + 10 && b[0] > w + 10) || (a[1] < -10 && b[1] < -10) || (a[1] > h + 10 && b[1] > h + 10)) continue;
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    const hp = toPx(0, 0); ctx.fillStyle = '#4ea1ff'; ctx.beginPath(); ctx.arc(hp[0], hp[1], 3, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffcb2e';                            // uncollected coins
    for (const c of coins) { if (c.got) continue; const p = toPx(c.x, c.z); if (p[0] > 0 && p[0] < w && p[1] > 0 && p[1] < h) { ctx.beginPath(); ctx.arc(p[0], p[1], 2, 0, 7); ctx.fill(); } }
    // neighbourhood landmarks — your 5 real places. On-map = dot; off-map = clamped to
    // the edge as a "that way" hint. Pink = still to find, green = found.
    for (const poi of POIS) {
      const p = toPx(poi.x, poi.z);
      const m = 7, edge = p[0] < m || p[0] > w - m || p[1] < m || p[1] > h - m;
      const px = clamp(p[0], m, w - m), py = clamp(p[1], m, h - m);
      const found = poiFound.has(poi.key);
      ctx.fillStyle = found ? '#3ad17a' : '#ff5ad0';
      ctx.beginPath(); ctx.arc(px, py, edge ? 2.6 : 3.4, 0, 7); ctx.fill();
      if (!found && !edge) { ctx.strokeStyle = 'rgba(255,90,208,0.8)'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.arc(px, py, 5.4, 0, 7); ctx.stroke(); }
    }
    if (DEST) {
      // draw the route from the CAR forward (not from ROUTE[0]) so the already-driven
      // part doesn't whip around the car-centred map during auto-drive.
      ctx.strokeStyle = '#2f8bff'; ctx.lineWidth = 2.6; ctx.lineJoin = 'round'; ctx.beginPath();
      ctx.moveTo(cx, cy);
      if (ROUTE && ROUTE.length > 1) for (let i = Math.max(0, routeIdx); i < ROUTE.length; i++) { const p = toPx(ROUTE[i].x, ROUTE[i].z); ctx.lineTo(p[0], p[1]); }
      else { const dp = toPx(DEST.x, DEST.z); ctx.lineTo(dp[0], dp[1]); }
      ctx.stroke();
      const dp = toPx(DEST.x, DEST.z);
      ctx.fillStyle = '#ffc21e'; ctx.beginPath(); ctx.arc(Math.max(5, Math.min(w - 5, dp[0])), Math.max(5, Math.min(h - 5, dp[1])), 4, 0, 7); ctx.fill();
    }
    // CAR: on a heading-up map the car always points straight UP (forward).
    ctx.fillStyle = '#d94f1e'; ctx.beginPath();
    ctx.moveTo(cx, cy - 7); ctx.lineTo(cx + 4, cy + 5); ctx.lineTo(cx - 4, cy + 5);
    ctx.closePath(); ctx.fill();
    // NORTH tick: world north (-z) maps to screen dir (-sin, cos) of the map heading — so the user can
    // still orient even as the whole map spins under them.
    const nlen = Math.min(cx, cy) - 8, nNx = cx - sa * nlen, nNy = cy + ca * nlen;
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.font = 'bold 9px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', nNx, nNy);
  }

  // collision feedback: a thunk, a kick of camera shake, and a haptic buzz, scaled
  // by impact speed — so hits read as intentional, not a silent invisible-wall ping.
  let shakeMag = 0, lastHitT = -1e9, timeScale = 1, slowmoHold = 0;
  // Returns true only when a FRESH hit registers (past the 200ms cooldown). The
  // caller gates its speed-scrub on that so a car overlapping geometry for several
  // frames isn't scrubbed to a dead stop every frame — the position push-out ejects
  // it while it keeps most of its momentum.
  function carHit(impact, kind) {
    const tnow = performance.now();
    if (impact < 4 || tnow - lastHitT < 200) return false;
    lastHitT = tnow;
    shakeMag = Math.max(shakeMag, clamp(impact * 0.05, 0.15, 1.4));
    if (audio.sfxThunk) audio.sfxThunk(clamp(impact / 60, 0.2, 1));
    if (navigator.vibrate) { try { navigator.vibrate(Math.round(clamp(impact * 1.4, 10, 55))); } catch (e) { } }
    if (kind === 'animal') toast('🦆 Watch the critters!', 900);
    // BIG hit → a celebrated moment: a beat of slow-mo, a white flash, a CRUNCH. It also
    // BREAKS your combo — that's the risk that makes near-misses worth the reward.
    else if (impact > 40) {
      if (!reduceMotion) { timeScale = 0.32; if (ui.fx) { ui.fx.classList.add('crash'); setTimeout(() => ui.fx && ui.fx.classList.remove('crash'), 320); } }
      // halve the combo (not a full wipe) — a hard knock on an invisible footprint
      // shouldn't erase a whole chain, but it should sting.
      const lost = combo > 2 ? '  ·  combo halved' : '';
      if (combo > 2) { combo = Math.floor(combo / 2); comboExpired = false; comboExpire = tnow + 4000; emitScore({}); }
      toast('💥 CRUNCH! ' + Math.round(impact * 2.237) + ' mph' + lost, 1200);
    }
    return true;
  }

  const camV = new THREE.Vector3();
  const _camT = new THREE.Vector3();      // per-frame camera target scratch (drive/scoop are mutually exclusive)
  const _lookT = new THREE.Vector3();     // desired chase look point (scratch)
  let _lookV = null;                       // smoothed chase look point — lags so the car whips toward frame edge
  let camGroundRef = null;                 // slow-smoothed ground height for a STATIC-feeling drone altitude
  let camFloorRef = null;                   // low-passed anti-clip floor so per-bump groundAt spikes don't POP the cam
  let _camFloorT = 0, _camFloorRaw = 0;     // throttle the floor raycast (~14 Hz) — its output is low-passed to ~3 Hz anyway
  let camMode = 0;
  let camInit = false;
  let driveCamUserPicked = false;
  // Drive cameras. Default "Cruise" is the high chase the user likes: well above
  // the melty ground-level photogrammetry, a little behind the car, looking DOWN
  // THE ROAD AHEAD (ahead = metres in front to aim at). "Close" is the low
  // cinematic chase; "Top-down" looks straight down, heading-up.
  const DRIVE_CAMS = [
    // order = 🎥 cycle order. Cruise (clean high chase) is the default; Close (low,
    // cinematic, gets the full whip+roll) is now SECOND so the most speed-rich view is
    // one tap away; Top-down (drag-to-drive) third; Aerial (Explore orbit) last.
    // Cruise leans a little lower/more-forward than before for speed feel, but stays
    // high enough to clear the melty ground-level photogrammetry (the user's preferred
    // clean look — NOT the low 'eye-level horror' of Close).
    { name: 'Cruise', dist: 14, h: 22, ahead: 6, drone: true, topdown: false },
    { name: 'Close', dist: 19, h: 12.5, ahead: 12, drone: false, topdown: false },   // Roblox chase: sit back + look well down the road so you SEE where you're going (not just the roof of the car)
    { name: 'Top-down', dist: 10, h: 122, ahead: 16, drone: true, topdown: true, dragdrive: true },   // higher overhead map view
    { name: 'Aerial', aerial: true, dragdrive: true },   // the Explore look (high orbit), drag to drive there
  ];
  function cycleCamera() {
    driveCamUserPicked = true;
    camMode = (camMode + 1) % DRIVE_CAMS.length; camInit = false;
    czoom = 1; camOrbit.yaw = 0; camOrbit.pitch = 0;   // fresh framing per view (pinch-zoom/look don't leak)
    const dd = DRIVE_CAMS[camMode].dragdrive;
    if (!DRIVE_CAMS[camMode].topdown) camera.up.set(0, 1, 0);   // only top-down is heading-up
    if (!dd) { inp2.navActive = false; navPtr = null; }         // leaving a drag-to-drive view ends it
    emit('driveCam', DRIVE_CAMS[camMode].name); emitDriveZoom();
    toast('Camera: ' + DRIVE_CAMS[camMode].name + (dd ? ' · drag to drive 🪄' : ''), dd ? 1700 : 1100);
  }
  // Jump straight to the one-finger draw-to-drive (top-down) view — the most phone-native
  // control, otherwise buried behind the 🎥 cycle.
  function traceDrive() {
    driveCamUserPicked = true;
    const i = DRIVE_CAMS.findIndex(c => c.topdown);
    if (i < 0) return;
    if (camMode === i) {
      camMode = 0; camInit = false; czoom = 1; camOrbit.yaw = 0; camOrbit.pitch = 0;
      inp2.navActive = false; navPtr = null; camera.up.set(0, 1, 0);
      emit('driveCam', DRIVE_CAMS[camMode].name); emitDriveZoom();   // keep the overhead zoom slider's show/hide + value in sync with the view (mirrors cycleCamera)
      toast('Camera: ' + DRIVE_CAMS[camMode].name, 1100);
      return;
    }
    camMode = i; camInit = false; czoom = 1; camOrbit.yaw = 0; camOrbit.pitch = 0;
    emit('driveCam', DRIVE_CAMS[i].name); emitDriveZoom();   // entering top-down → show the overhead zoom slider (mirrors cycleCamera)
    toast('🪄 Trace a path — drag your finger to drive!', 2000);
  }
  // Scoop camera presets [dist, height] — cycled with the 🎥 button.
  // Roblox-style follow cams, cycled with the 🎥 button. The DEFAULT (index 0) is a
  // behind-the-shoulder angled view like Roblox's default camera — so a right-side
  // swipe orbits AROUND the keeper and you actually see the world turn, instead of
  // just spinning a top-down map. 'Overhead' is kept as an option for precise
  // scooping (it reads the poops better from straight above). pitch (vertical look)
  // raises/lowers the height; pinch (szoom) is the distance dolly.
  const SCOOP_CAMS = [
    { name: 'Follow', dist: 13, h: 8 },      // ~32° down: over-the-shoulder, the Roblox default
    { name: 'Angled', dist: 14, h: 15 },     // ~47° down: tilts past the melty horizon to the yard
    { name: 'Overhead', dist: 10, h: 19 }    // ~62° down: near top-down for precise scooping
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

  // R8 — un-hide the car from trees/eaves/wires WITHOUT gouging the road AND without truncating
  // anything away from the car. The cut is a LOCAL CORRIDOR from the camera to the car, not a global
  // half-space: a fragment is removed only when it is (a) above the line of sight (so the road + every
  // hill below the sightline stay), (b) camera-side of the car (so the forward scene + the car stay),
  // AND (c) inside a thin cone whose apex is the CAMERA and which is only ~±W wide AT the car — so the
  // strip that actually occludes the car is carved clean (whole trees, not just their tops), while a
  // tree even a few metres off the line of sight is left fully intact. Built from clip planes +
  // clipIntersection=true on the tile materials (removed = BEHIND every plane); the car/HUD carry none.
  //   Height gate is a tilted SIGHTLINE plane (contains the camera→car ray, lifted by a small
  // clearance, normal up): "above" = a real occluder poking over the line of sight; "below" = ground
  // and any lower hill → KEPT (this is what fixed the "white middle" — we never cut below terrain).
  //   Cone gate (the locality fix): two planes through the camera bounding a wedge that is a POINT at
  // the camera and ±W at the car, so the removed region is the car's screen silhouette swept back to
  // the lens — nothing off to the side is touched.
  //   Overhead/near-vertical views can't form that cone (the sightline is ~vertical), so they use a
  // vertical COLUMN instead: a flat canopy cap boxed to ±W around the car in x/z. Same outcome — the
  // canopy right over the car/road is cut, trees away from the road are untouched.
  const _clipHoriz = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);   // kept side: BELOW the (tilted) sightline + clearance
  const _clipDepth = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);    // kept side: AT/BEYOND the car along the camera→car axis
  const _clipConeA = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);    // cone wall (+lateral): kept side = outside the wedge
  const _clipConeB = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);   // cone wall (−lateral)
  const _clipBox = [new THREE.Plane(), new THREE.Plane(), new THREE.Plane(), new THREE.Plane()];   // overhead column walls (±x, ±z)
  const _clipN = new THREE.Vector3(), _clipP = new THREE.Vector3();
  function updateTileClip(carX, carY, carZ, view) {
    const planes = p3dtiles && p3dtiles.clipPlanes;
    if (!planes) return;
    // eye→car vector d; dist = |d|, dh = its horizontal extent (how horizontal the view is).
    const ex = camera.position.x, ey = camera.position.y, ez = camera.position.z;
    const dx = carX - ex, dy = carY - ey, dz = carZ - ez;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-3) { planes.length = 0; return; }
    const dh = Math.hypot(dx, dz);
    if (view.topdown || dh < dist * 0.25) {
      // OVERHEAD COLUMN: cap the canopy just above the car and box it to ±W around the car so the
      // cut is a tight column over the road, never spreading to trees off to the sides.
      const W = 7, clearance = 2.5;                          // clearance ≥ tallest car roof (~2 m van) so the car never clips
      _clipHoriz.normal.set(0, -1, 0); _clipHoriz.constant = carY + clearance;   // kept BELOW carY+clearance
      // Box walls point INWARD so "behind EVERY plane" (clipIntersection) = inside the column. (Outward
      // normals made the four behind-halves mutually exclusive → empty cut → overhead clipped nothing.)
      _clipBox[0].normal.set(-1, 0, 0); _clipBox[0].constant = (carX - W);    // behind ⇔ x > carX−W
      _clipBox[1].normal.set(1, 0, 0);  _clipBox[1].constant = -(carX + W);   // behind ⇔ x < carX+W
      _clipBox[2].normal.set(0, 0, -1); _clipBox[2].constant = (carZ - W);    // behind ⇔ z > carZ−W
      _clipBox[3].normal.set(0, 0, 1);  _clipBox[3].constant = -(carZ + W);   // behind ⇔ z < carZ+W
      planes.length = 0; planes.push(_clipHoriz, _clipBox[0], _clipBox[1], _clipBox[2], _clipBox[3]);
      return;
    }
    // OBLIQUE (chase / cruise / aerial): a constant-width CORRIDOR from the camera to the car.
    const W = 6, clearance = 2.5;                            // ±W slab around the look axis; flat-cap height above the car
    // (1) FLAT height cap at carY + clearance. The earlier TILTED sightline rose to CAMERA height near
    // the lens, so near-camera foreground sat below it and was never cut — it "reappeared right before
    // your eyes" as you drove forward. A flat cap stays low ALL the way back to the camera, so the whole
    // corridor (lens → car) is cleared. It can't gouge distant hills (the old "white middle") because the
    // ±W slab below bounds the cut to the road strip, which is ~flat; the car itself is kept by the depth
    // gate, not this cap, so the clearance only needs to tolerate the road's grade over the corridor.
    _clipHoriz.normal.set(0, -1, 0);
    _clipHoriz.constant = carY + clearance;                 // kept BELOW carY + clearance
    // (2) depth gate: keep everything at/beyond (car − 2.6 m) along the eye→car axis. 2.6 m (not less)
    // because the car's own tail sits ~2.25 m behind its centre along this axis in chase/cruise; a
    // tighter band would clip the car's rear.
    const fx = dx / dist, fy = dy / dist, fz = dz / dist;
    _clipN.set(fx, fy, fz);
    _clipP.set(carX, carY, carZ).addScaledVector(_clipN, -2.6);
    _clipDepth.normal.copy(_clipN);
    _clipDepth.constant = -_clipN.dot(_clipP);
    // (3) corridor walls — a constant-width slab, NOT an apex cone (a cone is a point at the lens and
    // only ±W/2 at mid-corridor, which leaves the SIDES of the trees). u = horizontal ⊥ the look axis
    // = normalize(f.z,0,−f.x); two VERTICAL planes ±W along u bound a ±W strip around the WHOLE eye→car
    // line. Removed (behind both) = within W m either side of the line of sight — "a few metres each side".
    const ul = Math.hypot(fz, fx) || 1, ux = fz / ul, uz = -fx / ul;   // unit horizontal ⊥ f
    const ue = ux * ex + uz * ez;                                      // u·E (u has no y component)
    _clipConeA.normal.set(ux, 0, uz);   _clipConeA.constant = -ue - W;   // behind ⇔ u·P < u·E + W
    _clipConeB.normal.set(-ux, 0, -uz); _clipConeB.constant = ue - W;    // behind ⇔ u·P > u·E − W
    planes.length = 0; planes.push(_clipHoriz, _clipDepth, _clipConeA, _clipConeB);
  }

  function updateDrive(dt, now) {
    // Mix stick (jx/jy), keyboard (kx/ky), and legacy pedal inputs. The left
    // thumbstick is a Roblox-style move stick: X steers, up is gas, down is
    // brake/reverse. Just steering gently auto-accelerates so kids still cruise.
    // keyboard arrows are binary ±1 — ramp them over ~0.15 s so desktop steering eases
    // in like the touch stick instead of snapping (kSteer feeds jx; touch jx stays direct).
    car.kSteer = (car.kSteer || 0) + (inp2.kx - (car.kSteer || 0)) * Math.min(1, dt * 7);
    let jx = clamp(inp2.jx + car.kSteer + inp2.steer, -1, 1);
    let throttleTarget = 0, brake = 0, reverse = false;
    // TWIN-STICK MOVE: the left stick's vertical axis IS the throttle/brake now.
    //   jy < 0 (push up)   → gas, proportional to how far up
    //   jy > 0 (pull down) → brake / reverse
    // (setGasAmount/setBrake still feed inp2.gas/inp2.brake for back-compat.)
    const jyGas = inp2.jy < -MOVE_DEADZONE ? clamp((-inp2.jy - MOVE_DEADZONE) / (1 - MOVE_DEADZONE), 0, 1) : 0;
    const jyBrake = inp2.jy > MOVE_DEADZONE;
    // BRAKE vs REVERSE — the fix for "too easy to end up backwards": a light/partial down-pull only
    // BRAKES (stop + hold at 0). Reverse needs a DELIBERATE near-full pull-down (or full brake button /
    // held down-arrow) AND the car already stopped for a moment, so steering with a little downward
    // drift — or a hard brake-to-stop — can no longer fling the car into reverse.
    const wantReverse = (inp2.jy > 0.62 || inp2.brake > 0.85 || inp2.ky > 0);
    if (wantReverse && Math.abs(car.speed) < 1.4) car.revArmT = (car.revArmT || 0) + dt; else if (!wantReverse) car.revArmT = 0;
    reverse = wantReverse && (car.revArmT || 0) > 0.32;
    if (inp2.brake || inp2.ky > 0 || jyBrake) brake = 1;
    else if (inp2.ky < 0) throttleTarget = 1;                  // keyboard = full
    else if (jyGas > 0) throttleTarget = jyGas;                // left stick up = analog gas
    else if (inp2.gas > 0) throttleTarget = inp2.gas;          // touch gas (analog 0..1)
    // Stick-only "auto-creep": cruise GENTLY toward ~18 u/s (≈40 mph) instead of
    // flooring it — a kid who only steers should roll at a corner-able pace, never
    // pin to the 220 mph top end. Push up for the real speed.
    else if (Math.abs(jx) > 0.05) throttleTarget = clamp((13 - car.speed) / 13, 0, 0.42);   // steer-only: roll at a gentle, corner-able pace
    // ANALOG pedal: squeeze the throttle up over ~0.4 s and bleed it off faster, so the
    // gas feels like a pedal you press (feather power out of a slide), not a switch.
    const cur = car.throttle || 0;
    const tRate = throttleTarget > cur ? 2.6 : 5.4;
    car.throttle = cur + (throttleTarget - cur) * Math.min(1, dt * tRate);
    let throttle = car.throttle;
    // GRAB THE WHEEL: any real steer/gas/brake input drops auto-drive so the player
    // instantly takes over instead of fighting the robot.
    const _userInput = Math.abs(inp2.jx + inp2.kx + inp2.steer) > 0.2 || Math.abs(inp2.jy) > MOVE_DEADZONE || inp2.gas || inp2.brake || inp2.ky;
    if (autoDrive && _userInput) {
      autoDrive = false; inp2.navActive = false; clearRouteRail(); stopFollow(); emit('autodrive', false); toast('🕹️ You took the wheel!', 900);
    }
    // FOLLOW runs with autoDrive OFF, so the grab-wheel check above won't catch it — let real input end it too.
    if (followMode && _userInput) { stopFollow(); toast('🕹️ You took the wheel!', 900); }
    // advance the route waypoint as the car passes it. Advance by PROJECTION (how far the car
    // has travelled along the current segment), not just proximity — at high speed the car
    // overshoots a 16 m radius without ever entering it, so routeIdx would stick and the car
    // would circle the same point. The while-loop clears several waypoints in one fast frame.
    while (ROUTE && routeIdx < ROUTE.length - 1) {
      const a = ROUTE[routeIdx], b = ROUTE[routeIdx + 1];
      const vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz || 1;
      const t = ((car.x - a.x) * vx + (car.z - a.z) * vz) / L2;
      if (t > 0.8 || Math.hypot(a.x - car.x, a.z - car.z) < 16) routeIdx++; else break;
    }
    // auto-drive: follow the road ROUTE. Arrival is reaching the END OF THE ROUTE (the road
    // point nearest the target) — NOT the raw target, so a tap that lands off-road doesn't
    // make the car circle forever trying to reach a point with no road. While no route is
    // ready it simply HOLDS (idles) rather than cutting straight across the land.
    if (autoDrive && DEST) {
      const end = ROUTE && ROUTE.length ? ROUTE[ROUTE.length - 1] : null;
      const atEnd = end && (routeIdx >= ROUTE.length || Math.hypot(end.x - car.x, end.z - car.z) < 12);
      if (!ROUTE) { inp2.navActive = false; if (DEST.geo && now - (DEST._retryT || 0) > 4000) { DEST._retryT = now; fetchRoute(DEST.geo.lat, DEST.geo.lon); } }   // hold + self-retry the route every 4 s (transient API/network blip → self-heals)
      else if (atEnd) {
        if (!DEST.reached) { DEST.reached = true; if (DEST.celebrate && !POIS.some(p => Math.hypot(p.x - DEST.x, p.z - DEST.z) < 50)) arriveCelebrate(DEST.label, 0, now); }
        clearDestination();   // arrived — drop the nav card + route line (was sticking on "arriving…") and end auto-drive
      } else { const t = navTarget(); inp2.navActive = true; inp2.navX = t.x; inp2.navZ = t.z; }
    }
    // Reached a self-driven destination: clear the route either way, but only show the
    // ARRIVAL banner for a place chosen from the GO address search (DEST.celebrate). A
    // casual tap-to-trace is not an "arrival" worth a banner (the user: only show it if
    // you pick an address from GO). POIs run their own richer celebration via checkPOIs.
    else if (DEST && !DEST.reached && Math.hypot(DEST.x - car.x, DEST.z - car.z) < 14) {
      DEST.reached = true;
      if (DEST.celebrate && !POIS.some(p => Math.hypot(p.x - DEST.x, p.z - DEST.z) < 50)) arriveCelebrate(DEST.label, 0, now);
      clearDestination();
    }
    // Point-and-drive override (Top-down drag + auto-drive): steer toward the target
    // ground point. Speed scales with DISTANCE (drag far = floor it, near = creep),
    // and if the target is BEHIND the car it reverses toward it instead of looping.
    let autoTurnLimit = Infinity;   // robot's heading-error speed governor; also feeds the autoCap below
    if (inp2.navActive) {
      const dx = inp2.navX - car.x, dz = inp2.navZ - car.z, dd = Math.hypot(dx, dz);
      let dyaw = Math.atan2(dx, dz) - car.yaw;
      while (dyaw > Math.PI) dyaw -= 2 * Math.PI; while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      const farT = clamp(dd / (autoDrive ? 52 : 40), 0, 1); // 0 near → 1 far; robot looks further ahead
      const robot = autoDrive && DEST;
      if (dd < 2.5) { jx = 0; throttle = 0; brake = Math.abs(car.speed) > 2 ? 0.7 : 0; }
      else if (Math.abs(dyaw) > 1.95 && (!robot || dd < 13)) {   // behind & (manual, or robot at close range) → reverse to it
        const rdyaw = dyaw > 0 ? dyaw - Math.PI : dyaw + Math.PI;
        jx = clamp(rdyaw * 2.0, -1, 1);
        throttle = 0; brake = clamp(0.35 + farT * 0.45, 0, 0.85); reverse = true;   // deliberately backing toward a behind-target → allow reverse past the stop gate
      } else {                                             // drive forward toward it — a robot with a FAR
        // target behind it arcs around (forward U-turn) at full steering lock instead of
        // reversing the whole way across lawns into whatever's behind it.
        jx = clamp(-dyaw * (robot ? 1.6 : 2.0), -1, 1);   // gentler robot gain → no overshoot/wobble on angled (non-90°) turns
        const align = clamp(1 - Math.abs(dyaw) / 1.7, robot ? 0.42 : 0.22, 1); // robot keeps pace through bends
        if (robot) {
          const dDest = Math.hypot(DEST.x - car.x, DEST.z - car.z);
          // HEADING-ERROR GOVERNOR: the sharper the angle to the aim point, the slower the car
          // must be to actually make the turn. Without this the chauffeur blasts straight
          // through bends at top speed and leaves the route — "autodrive breaks when fast".
          autoTurnLimit = clamp(64 - Math.abs(dyaw) * 80, 12, 64);
          // ...and slow BEFORE the bend, not at it: cap to a speed we can brake down to a corner-able
          // pace by the time we reach the next turn (distToNextTurn looks ~500 m ahead). This is what
          // actually keeps the chauffeur on the route far from home instead of blasting past corners.
          const _turnDist = distToNextTurn();
          autoTurnLimit = Math.min(autoTurnLimit, 26 + Math.sqrt(Math.max(0, 2 * 30 * (_turnDist - 18))));
          const want = Math.min(autoDriveTargetSpeed(dDest), autoTurnLimit);
          const gap = want - Math.abs(car.speed);
          throttle = clamp(0.42 + gap / Math.max(22, want) * 0.95, 0, 1) * align;
          brake = gap < -6 ? clamp((-gap - 4) / 22, 0, 0.85) : 0;   // brake sooner + harder when overspeed for the bend
          if (brake > 0.05) throttle = 0;
        } else {
          throttle = clamp((0.22 + farT * 0.78) * align, 0, 1);
          brake = 0;
        }
      }
    }
    if (throttle > 0.1 || brake > 0.1) showT = 0;
    if (throttle > 0.1) startRun(now);                 // first gas starts the coin-rally clock
    const road = onRoad(car.x, car.z);
    // "Open road" = on a procedural street OR out past the neighbourhood block
    // (±340 m), where the only surface is the real photoreal road — let it rip there
    // so a cross-town blast to Meemaw's can hit triple digits. WITHIN the block,
    // off the streets means lawns: a real penalty so the pavement is the fast line.
    const fromHome = Math.hypot(car.x, car.z);
    const openRoad = road || fromHome > 340;
    const highway = fromHome > 340;   // the real open road / cross-town — let it RIP (way faster)
    // Per-car handling profile (Sienna heavy+grippy, Ferrari fast+slidey, Toy twitchy).
    const profActive = car.models[car.modelIdx];
    const prof = (profActive && profActive.profile) || { accel: 1, top: 1, grip: 1, slip: 0.7 };
    // High top speed on the open road (maxF 100 u/s ≈ 224 mph × per-car). Lawns cap
    // ~44 mph with heavy drag so you slow right down and steer back to the street.
    // NITRO: spend the meter (built from near-misses / drifts / arrivals) for a surge —
    // routes the skill economy into raw speed, the addictive part of an arcade loop.
    // auto-fire: flooring the throttle (or the Shift/🚀 input) with charge dumps nitro —
    // no spare thumb is free for a manual button (left=steer, right=pedals).
    const boosting = (inp2.boost || throttle > 0.92) && boost > 0.02 && Math.abs(car.speed) > 1.5;
    if (boosting) { boost = Math.max(0, boost - dt * 0.4); if (!boostWas) { if (audio.sfxWhoosh) audio.sfxWhoosh(1); toast('🚀 NITRO!', 700); if (!reduceMotion) { shakeMag = Math.max(shakeMag, 0.6); if (ui.fx) { ui.fx.classList.add('boost'); setTimeout(() => ui.fx && ui.fx.classList.remove('boost'), 160); } } } }   // hard-earned nitro gets a real punch: camera kick + a brief flash
    boostWas = boosting;
    const boostMul = boosting ? 1.34 : 1;
    let maxF = (highway ? 250 : openRoad ? 115 : 38) * prof.top * boostMul * speedMul; const maxR = -11;   // highway = supersonic; lawns crawl
    if (autoDrive && (highway || openRoad)) maxF = Math.max(maxF, 440 * boostMul * speedMul);   // let the chauffeur RIP — it follows the route on rails (see the rail block), so it can't overshoot; a cross-town trip should take ~30-90 s
    // SENSE-OF-SPEED reference — deliberately MUCH lower than the real top (maxF
    // 100·top). All the rush (FOV kick, speed-lines, gauge fill, engine rev) saturates
    // around ~60 mph so normal neighbourhood driving FEELS fast, while you can still
    // pin the real 180-220 mph on the open road (it just stays maxed up there).
    const feelRef = 27 * prof.top;
    // ACCELERATION CURVE — the pedal maps to a TARGET speed through a curve that's gentle at
    // the bottom (a feather of gas = a slow, accurate crawl you can hold) and reaches the
    // full top only when floored. Accel CHASES that target: firm pull when you're below it,
    // a soft coast when you lift above it. So light pedal SETTLES at a low cruise (precise
    // manoeuvring) while flooring it pulls hard to the top (fast) — and because it eases in
    // as you approach the target, it never overshoots off the road.
    // Driving BY HAND gets a steeper pedal curve (a feather of gas = a true slow crawl you can
    // hold on a residential street) and a softer accel cap, so building speed takes longer and
    // is controllable; flooring it still reaches the same top. Auto-drive keeps the snappier
    // numbers so the chauffeur still makes good time.
    const manual = !autoDrive;
    // FINE-CONTROL low band: by hand, the first ~18% of pedal maps to a gentle linear crawl
    // (up to ~7 u/s ≈ 15 mph) you can HOLD for precise manoeuvring, instead of the cube curve's
    // near-zero-then-lunge bottom. Above that the cube curve takes over toward the top; floored
    // (throttle=1) the cube far exceeds the crawl band, so top speed is untouched.
    const fine = manual ? Math.min(throttle, 0.18) / 0.18 * Math.min(7, maxF * 0.5) : 0;   // cap the crawl band under maxF so a tiny lawn/slow-car maxF doesn't flat-line the upper pedal
    const pedalTgt = Math.max(fine, Math.pow(throttle, manual ? 3.4 : 2.4) * maxF);  // curved pedal → target speed; steeper manual = easier SLOW crawl at the bottom
    const aGap = pedalTgt - car.speed;
    const aMax = (highway ? 62 : openRoad ? 32 : 13) * prof.accel * boostMul * speedMul * (manual ? 0.50 : 1);   // peak engine pull (cap); manual builds speed more gradually (gentler off the line)
    let acc = clamp(aGap * (aGap > 0 ? (manual ? 1.25 : 2.6) : 0.9), -aMax, aMax);     // chase target; softer manual pull eases toward target (precision) + lift-off coast
    if (aGap > 0) acc *= 0.75 + 0.25 * clamp(Math.abs(car.speed) / 6, 0, 1);   // gentle off-the-line ramp — keeps a floored stab feeling punchy, not sluggish
    // PROGRESSIVE brake: ramp the brake force in over ~0.25 s so a quick tap trail-brakes
    // lightly (corner-entry finesse) while a long hold still hauls it down hard.
    const braking = brake > 0.1;
    const bcur = car.brakeAmt || 0;
    car.brakeAmt = bcur + ((braking ? 1 : 0) - bcur) * Math.min(1, dt * (braking ? 4 : 9));
    if (braking) acc = car.speed > 0.5 ? -32 * car.brakeAmt : car.speed < -0.5 ? 32 * car.brakeAmt : (reverse ? -13 : 0);   // forward → brake; rolling backward → brake forward to a stop; stopped → back up only on a DELIBERATE reverse
    // (engine-braking is now implicit: lifting off drops the pedal target below your speed,
    // so the curve above coasts you down on its own.)
    // LOAD TRANSFER: the body dives forward under braking and squats back under power —
    // gives the car visible weight (a Sienna wallows, a Ferrari is crisp via prof.grip).
    car.pitchDyn = (car.pitchDyn || 0) + (clamp(-acc * 0.012, -0.2, 0.2) / (0.6 + prof.grip * 0.5) - (car.pitchDyn || 0)) * Math.min(1, dt * 6);
    // Auto-drive cap scales with distance to the next turn / the destination — long
    // straight legs of a cross-town route run fast (up to maxF), only corners and the
    // final approach slow the chauffeur down, so the trip isn't a crawl.
    let autoCap = 200;
    if (autoDrive) {
      const dDest = DEST ? Math.hypot(DEST.x - car.x, DEST.z - car.z) : 1e9;
      // FAST on the straights, still turn-aware. The throttle controller above aims at this
      // pace; this cap is the guardrail. The old +70 highway bonus let the cap stay high right
      // at a bend (so it blew the turn) — keep it modest, and ALSO respect the heading-error
      // governor so the cap actually drops as the route bends ahead.
      autoCap = Math.min(autoDriveTargetSpeed(dDest) + 20, autoTurnLimit + 16);
    }
    car.speed += acc * dt;
    car.speed -= car.speed * (highway ? 0.06 : openRoad ? 0.1 : 0.28) * dt;   // highway = slippery-fast, lawns drag
    car.speed = clamp(car.speed, maxR, maxF);
    if (autoDrive && car.speed > autoCap) car.speed += (autoCap - car.speed) * Math.min(1, dt * 7);   // brake to the cap FAST so a fast leg can still slow for the next turn (was dt*3.2 → too slow, overshot)
    if (throttle < 0.1 && brake < 0.1 && Math.abs(car.speed) < 0.4) car.speed = 0;
    // tighter turns at speed (makes corners) but softened up high so the open-road blast
    // the design invites stays pointable instead of going numb.
    const steerTarget = (-jx) * 0.5 / (1 + Math.abs(car.speed) * 0.05);   // tame yaw authority up top so the blast stays pointable
    car.steer += (steerTarget - car.steer) * Math.min(1, dt * 12);   // snappier wheel — less lag between thumb and tyres
    // brake-to-drift: stab the brake while turning fast (or the Space handbrake) and
    // the tail steps out; a handbrake yaw kick helps rotate through tight corners.
    const hb = (inp2.hbrake || (brake > 0.1 && Math.abs(car.speed) > 8)) ? 1 : 0;
    // High-speed yaw DAMPER: without this the speed/2.7 term overwhelms the steer-angle
    // falloff and net yaw rate climbs all the way up, making the flat-out blast twitchier
    // the faster you go. Authority now peaks ~mid-speed (~35 mph) and tapers above so a
    // 200 mph straight tracks with small corrections.
    const yawDamp = clamp(1 - (Math.abs(car.speed) - 20) * 0.008, 0.55, 1);   // keep enough authority to DODGE at speed
    car.yaw += (car.speed / 2.7) * Math.tan(car.steer) * (0.8 + prof.grip * 0.25) * (1 + hb * 0.4) * yawDamp * dt;
    // Distance to the nearest road, ALWAYS measured at the car's EXACT current position
    // (nearestRoadPoint now consults the live ROUTE + free-roam snap + every mapped road, so it's
    // valid even far from the procedural hood). inHood still gates the discrete snap-back below.
    const inHood = Math.hypot(car.x, car.z) < 330;
    const nrp = nearestRoadPoint(car.x, car.z);
    const offRoadDist = nrp.d;
    updateAreaRoads(now);   // fetch/refresh the OSM road network around the car so the assist has real roads to hug far from home
    updateLocationLabel(now);   // live STREET · CITY, ST readout in the subline
    // AUTO-STEER assist: aim the car along the ROUTE (when navigating), or — in free-roam —
    // along the nearest road via a look-ahead point that takes street corners for you. When
    // you've drifted OFF the road it switches to RECOVERY: aim straight back at the nearest
    // tarmac from any angle, strongly, so it actively steers you home. Your steering always
    // overrides the corner/track assist (fades to 0 as you push the stick).
    let assistTargetRate = 0;
    if (autoSteer && !inp2.navActive && !hb && Math.abs(car.speed) > 4) {
      let dir = null, recover = false; const onRoute = !!(ROUTE && routeIdx < ROUTE.length);
      if (onRoute) { const t = navTarget(); dir = [t.x - car.x, t.z - car.z]; }
      else if (offRoadDist > 8 && offRoadDist < 60) { dir = [nrp.x - car.x, nrp.z - car.z]; recover = true; }   // drifted off → steer straight back to the nearest road (hood OR the fetched OSM graph)
      else { const tp = roadTargetAhead(car.x, car.z, car.yaw, car.speed); if (tp) dir = [tp[0] - car.x, tp[1] - car.z]; }   // hug the road ahead (roadTargetAhead uses the OSM graph far from home)
      if (dir && (dir[0] || dir[1])) {
        let d = Math.atan2(dir[0], dir[1]) - car.yaw;
        while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        // Wide gate: a street corner bends the road ~90° vs your heading, so a narrow gate
        // would switch the assist OFF exactly at the turn. Recovery uses the FULL circle so
        // it can haul you back even if you're pointed straight away from the road.
        // Recovery gate capped (not the full circle) so the assist never tries to spin you
        // ALL the way around — it nudges you back toward the road, you stay in control.
        const gate = recover ? 2.0 : (onRoute ? 1.6 : 1.45);
        if (Math.abs(d) < gate) {
          // Gentler everywhere: it HELPS you hug the road, it doesn't wrestle the wheel. Even
          // recovery now yields to your input instead of ignoring it.
          const yours = clamp(Math.abs(jx) * (recover ? 1.4 : onRoute ? 1.8 : 1.7), 0, 1);
          const k = (1 - yours) * clamp(Math.abs(car.speed) / 16, 0.5, 1) * (recover ? 2.8 : (onRoute ? 3.0 : 2.6));
          assistTargetRate = clamp(d, -1.1, 1.1) * k;
        }
      }
    }
    // SMOOTH the assist: low-pass the correction rate so a jump in the aim point (a segment
    // switch or a waypoint advance) eases in over a few frames instead of snapping the wheel
    // — this kills the "jerky road assist". Decays to 0 when the assist isn't engaged.
    car.assistRate = (car.assistRate || 0) + (assistTargetRate - (car.assistRate || 0)) * (1 - Math.exp(-dt * 7));
    car.yaw += car.assistRate * dt;
    // AUTO-RECOVER: if you're stranded well off the road — drove deep into a yard, or
    // crashed and stopped out there — the steer-back can't reach you, so snap to the
    // nearest road automatically (assist on, in the hood, not mid-route). While a ROUTE is
    // active the Google line need not lie on the procedural roadSegs, so measuring off-road
    // distance against roadSegs would ping-pong the reset (snap to route → "off roadSegs" →
    // snap again) and the camera never settles — that was the "crash hides the car". The
    // route-autosteer handles staying on a route; a cooldown blocks any immediate re-fire.
    recoverCooldown = Math.max(0, recoverCooldown - dt);
    const onRouteNow = !!(ROUTE && routeIdx < ROUTE.length);
    if (autoSteer && inHood && !onRouteNow && recoverCooldown <= 0) {
      if (offRoadDist > 14) offRoadT += dt; else offRoadT = 0;
      const stuck = Math.abs(car.speed) < 3;
      if (offRoadDist > 42 || (offRoadT > 1.5 && offRoadDist > 22) || (offRoadT > 2.2 && stuck)) { offRoadT = 0; resetToRoad(); }
    } else if (autoDrive && onRouteNow && recoverCooldown <= 0) {
      // The chauffeur wandered off the ROUTE line — snap back so it re-syncs. Require PERSISTENCE
      // (off for a beat, or way off) so a single momentary overshoot on a bend doesn't teleport-loop.
      if (offRoadDist > 30) offRoadT += dt; else offRoadT = 0;
      if (offRoadDist > 80 || (offRoadT > 1.2 && offRoadDist > 45)) { offRoadT = 0; resetToRoad(); }
    } else offRoadT = 0;
    // HARD UNSTICK: a bad teleport/landing can bury the car inside a building footprint, where
    // the collision below collapses every move candidate to its own spot (can't budge in any
    // gear). If we're already inside one, snap back to the road now (resetToRoad uses the live
    // route far from home); the heading is re-derived from the corrected state just below.
    // Gate on recoverCooldown so it can't 60 Hz-spam (blip/toast/reset) if a snap point ever
    // lands back inside a footprint — it retries at most every ~1.8 s instead.
    if (recoverCooldown <= 0 && insideBuilding(car.x, car.z)) resetToRoad();
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    // arcade drift: tail-out lateral slip — readable even WITHOUT the handbrake now;
    // grip recovers it. On THROTTLE the rear stays out (a power-slide you can hold on
    // exit), so we ease grip recovery while you're on the gas instead of killing it.
    const slip = prof.slip * (1 + hb * 1.9);
    car.vlat = (car.vlat || 0) + car.steer * Math.abs(car.speed) * slip * 1.4 * dt;
    // POWER-SLIDE reward: on the gas, at speed, while turning → the throttle actively
    // pushes the tail out (positive exit-yaw), so flooring it through a corner holds a
    // satisfying drift instead of just leaning on grip recovery being eased.
    if (throttle > 0.4 && !hb && Math.abs(car.speed) > 10) car.vlat += car.steer * throttle * prof.slip * 18 * dt;
    const gripK = (prof.grip * (hb ? 1.4 : 3.5)) * (throttle > 0.5 && !hb ? 0.55 : 1);
    car.vlat *= Math.exp(-gripK * dt);
    // spin-recovery assist: tail way out + you're NOT actively steering or handbraking
    // → it tucks back in faster, so an over-rotation is catchable, not a full spin-out.
    if (!hb && Math.abs(jx) < 0.3 && Math.abs(car.vlat) > 7) car.vlat *= Math.exp(-2.2 * dt);
    car.vlat = clamp(car.vlat, -26, 26);
    const rpx = Math.cos(car.yaw), rpz = -Math.sin(car.yaw);   // car's right vector
    let nx = car.x + (fx * car.speed + rpx * car.vlat) * dt, nz = car.z + (fz * car.speed + rpz * car.vlat) * dt;
    // SOFT WALL / gravity-well: once the car strays past the lane edge, pull it back toward the
    // nearest road point. A positional nudge folded into THIS frame's move (so the building/tree
    // collision below still clamps it) — works even stopped or pointed away, where the yaw assist
    // can't. Ramps in over a few metres (soft edge), clamps under driving speed (never yanks), and
    // fades as you steer, so it reads like an invisible berm on the shoulder. Only where a road
    // graph exists (the hood or a live route) so it never tugs you back into town from the open road.
    if (autoSteer && !hb && (inHood || onRouteNow || osmRoadSegs.length) && offRoadDist > LANE_HALF && offRoadDist < 120) {
      const over = offRoadDist - LANE_HALF;
      const ramp = clamp(over / 6, 0, 1);                       // ease in over the first 6 m
      const yours = clamp(Math.abs(jx) * 1.5, 0, 1);            // fade out as the player steers hard
      let ux = nrp.x - car.x, uz = nrp.z - car.z; const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
      const pull = Math.min(WALL_MAX, over * WALL_GAIN) * ramp * (1 - yours);
      nx += ux * pull * dt; nz += uz * pull * dt;
    }
    updateTraffic(dt, now);   // move the ambient cars (positions feed the collision below)
    const rad = 1.25;
    let hitThisFrame = false, nearThisFrame = false;
    const fast = Math.abs(car.speed) > 14;
    // buildings are solid only at their real footprint; slide along the wall
    // instead of stopping dead so you can scrape past a corner.
    if (insideBuilding(nx, nz)) {
      if (!insideBuilding(nx, car.z)) nz = car.z;
      else if (!insideBuilding(car.x, nz)) nx = car.x;
      else { nx = car.x; nz = car.z; }
      if (carHit(Math.abs(car.speed), 'wall')) car.speed *= 0.38;   // scrub only on a fresh hit (else position push-out frees you)
      hitThisFrame = true;
    }
    for (const t of treePts) {
      const dx = nx - t[0], dz = nz - t[1], d2 = dx * dx + dz * dz, rr = 0.75 + rad;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2); nx = t[0] + dx / d * rr; nz = t[1] + dz / d * rr;
        if (carHit(Math.abs(car.speed), 'tree')) car.speed *= 0.42;
        hitThisFrame = true;
      } else if (fast && d2 < (rr + 1.6) * (rr + 1.6)) nearThisFrame = true;   // skimmed it
    }
    // sanctuary-safe: animals always bounce the car, never get hurt
    for (const a of ANIMALS) {
      const dx = nx - a.x, dz = nz - a.z, d2 = dx * dx + dz * dz, rr = a.r + rad + 0.5;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2); nx = a.x + dx / d * rr; nz = a.z + dz / d * rr;
        if (carHit(Math.abs(car.speed), 'animal')) car.speed *= 0.5;   // deflect, don't fling backward
        hitThisFrame = true;
      } else if (fast && d2 < (rr + 1.6) * (rr + 1.6)) nearThisFrame = true;
    }
    // TRAFFIC: weave past it for a near-miss combo, clip it for a soft deflect (it yields
    // + keeps its lane, so a tap is a glancing bump you keep rolling through, not a wall).
    if (roadLifeOn) {
      for (const c of traffic) {
        if (c.x === undefined) continue;
        const dx = nx - c.x, dz = nz - c.z, d2 = dx * dx + dz * dz, rr = 1.9 + rad;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2); nx = c.x + dx / d * rr; nz = c.z + dz / d * rr;
          if (carHit(Math.abs(car.speed), 'car')) car.speed *= 0.72;
          hitThisFrame = true;
        } else if (fast && d2 < (rr + 2.4) * (rr + 2.4)) nearThisFrame = true;
      }
    }
    if (nearThisFrame && !hitThisFrame) nearMiss(now);   // Burnout-style close-call reward
    // Roam far across the streamed Google tiles. The procedural neighborhood (and
    // its collision) only spans ~±340 m; past that the car rides the real
    // photoreal road directly (see actorGroundY), so the only bound is a generous
    // sanity ring at the metro scale where the flat-earth frame stays accurate.
    const lim = 30000;   // 30 km: reach the East Bay address presets (Oakland ≈ 22 km) across the streamed tiles
    if (Math.hypot(nx, nz) > lim) { const d = Math.hypot(nx, nz); nx *= lim / d; nz *= lim / d; car.speed *= 0.4; }  // soft edge: ease to a stop, don't shove back
    if (!followMode) { car.x = nx; car.z = nz; }   // in follow the glide below OWNS position — don't let the physics step creep the car forward each frame (it caused a ~1.5 m steady-state drift past the target)
    // AUTO-DRIVE RAIL: when the chauffeur has a route, ignore the physics result and glide the car
    // ALONG the route by arc-length at a fast cruise — so it follows the road EXACTLY (no overshoot,
    // no ping-pong) and a cross-town trip takes ~30-90 s. Position is overridden here (after the
    // collision step), so it phases through obstacles on the route — that's the point.
    if (followMode && _followGeo) {
      // EXACT FOLLOW: glide straight to the live GPS point. The exponential approach CAN'T overshoot;
      // a per-frame cap turns a big initial gap into a quick straight glide instead of a teleport. No
      // routing/rail here — those snapped to the "wrong street" and ran short hops in too hot.
      const dx = _followGeo.x - car.x, dz = _followGeo.z - car.z;
      const k = 1 - Math.exp(-dt * 3);
      let mx = dx * k, mz = dz * k;
      const step = Math.hypot(mx, mz), MAXSTEP = 520 * speedMul * dt;
      if (step > MAXSTEP && step > 1e-4) { const s = MAXSTEP / step; mx *= s; mz *= s; }
      car.x += mx; car.z += mz; car.groundY = null; car.vlat = 0; car.steer = 0;
      car.speed = Math.hypot(mx, mz) / Math.max(dt, 1e-3);   // for cam framing / wheel spin
      car.railS = null; car.railSpeed = null;
      // ORIENT to the phone compass when we have a heading; otherwise face the way we're gliding.
      let tgtYaw = _followHeading;
      if (tgtYaw == null) tgtYaw = Math.hypot(dx, dz) > 0.5 ? Math.atan2(dx, dz) : car.yaw;
      let _fd = tgtYaw - car.yaw; while (_fd > Math.PI) _fd -= 2 * Math.PI; while (_fd < -Math.PI) _fd += 2 * Math.PI;
      car.yaw += _fd * (1 - Math.exp(-dt * (_followHeading != null ? 8 : 5)));
    } else if (autoDrive && ROUTE && ROUTE.length > 1) {
      if (car.railS == null || _railRoute !== ROUTE) { car.railS = railArcAt(car.x, car.z); _railRoute = ROUTE; car.railSpeed = Math.abs(car.speed); }
      const total = routeTotalLen(), remain = total - car.railS;
      // MUCH FASTER on the way: scale hard with the open road ahead (up to ~520 m/s), easing only for
      // real bends. distToNextTurn looks ~500 m ahead, so long straights peg the cap. The rail OWNS the
      // speed via its own railSpeed (and overwrites car.speed) so the physics autodrive governor (autoCap,
      // pulled hard at dt*7 above) can't clamp it down — safe because the rail glues the car to the
      // polyline by arc-length, so it can't leave the route at ANY speed.
      const _cruise = clamp(150 + distToNextTurn() * 3.4, 150, 520 * speedMul);
      car.railSpeed += (_cruise - car.railSpeed) * Math.min(1, dt * 3);           // smooth ACCEL toward the cruise
      // GUARANTEED STOP AT THE DESTINATION: HARD-cap the speed to the fastest you could still brake to 0
      // within the distance left (v = √(2·a·d)) — a hard clamp, NOT a lagged ease. With the old ease the
      // speed stayed ABOVE this cap and the car ran in too hot and overshot; clamped, the car can always
      // stop in `remain` and decelerates at exactly BRAKE_A to rest at the end. Super-braking decel (~26 g,
      // it's on rails) so it never needs to start slowing early to make the stop.
      const BRAKE_A = 260;
      const stopCap = Math.sqrt(Math.max(0, 2 * BRAKE_A * remain));
      if (car.railSpeed > stopCap) car.railSpeed = stopCap;                       // hard clamp → always able to stop by the destination
      if (car.railSpeed < 0) car.railSpeed = 0;
      car.speed = car.railSpeed;
      car.railS = Math.min(total, car.railS + car.speed * dt);                    // never roll past the destination
      // Don't mistake the end of a still-loading route for ARRIVAL: if the real destination is still far
      // away (the full Directions route lands a beat after the seed/local route we set off on), hold at
      // the route end and let the rail re-acquire when the longer route arrives — give up after ~6 s so a
      // route that never comes can't soft-lock the car.
      if (remain <= 1.5) car.railEndT = (car.railEndT || 0) + dt; else car.railEndT = 0;
      const farFromDest = DEST && Math.hypot(DEST.x - car.x, DEST.z - car.z) > 150;
      if (remain <= 1.5 && car.speed < 6 && (!farFromDest || car.railEndT > 6)) {  // braked to a near-stop AT the destination → arrive
        if (DEST) { const bx = DEST.rawX != null ? DEST.rawX : DEST.x, bz = DEST.rawZ != null ? DEST.rawZ : DEST.z; if (Math.hypot(bx - car.x, bz - car.z) > 1) car.yaw = Math.atan2(bx - car.x, bz - car.z); }   // PARK facing the actual BUILDING (rawX/rawZ), not the snapped curb point (≈ the car)
        car.speed = 0; car.railS = null; car.railSpeed = null; car.railEndT = 0;
        if (DEST && !DEST.reached) { DEST.reached = true; if (DEST.celebrate && !POIS.some(p => Math.hypot(p.x - DEST.x, p.z - DEST.z) < 50)) arriveCelebrate(DEST.label, 0, now); }
        clearDestination();
      } else {
        const rp = railPointAt(car.railS);
        car.x = rp.x; car.z = rp.z; routeIdx = rp.i;
        // PARK IN FRONT: over the last few metres, turn from the route tangent to FACE the actual
        // address so the car pulls up looking at the building instead of stopping mid-lane.
        let aimYaw = rp.yaw;
        if (DEST && remain < 9) { const bx = DEST.rawX != null ? DEST.rawX : DEST.x, bz = DEST.rawZ != null ? DEST.rawZ : DEST.z; if (Math.hypot(bx - car.x, bz - car.z) > 1.5) { const fy = Math.atan2(bx - car.x, bz - car.z); let d = fy - rp.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; aimYaw = rp.yaw + d * clamp(1 - remain / 9, 0, 1); } }   // turn to face the actual BUILDING (rawX/rawZ) on the final approach; the >1.5 m guard avoids atan2 noise
        let _dy = aimYaw - car.yaw; while (_dy > Math.PI) _dy -= 2 * Math.PI; while (_dy < -Math.PI) _dy += 2 * Math.PI;
        car.yaw += _dy * Math.min(1, dt * 12);                                    // ease the heading onto the route tangent / toward the address on arrival
        car.vlat = 0; car.steer = 0;                                             // no physics slide while on rails
      }
    }
    // Ride the real photoreal ROAD surface (canopy-skipped + clamped to topology),
    // tracked ASYMMETRICALLY: settle DOWN gently (smooth on descents + bumps) but catch
    // UP quickly, and never let the smoothed height sink more than a hair below the real
    // surface. A symmetric low-pass used to lag BELOW a road that climbs faster than it
    // can track (uphill/onto a bridge at speed) — and once the car was under the surface,
    // the canopy-skipping down-ray (cast from just above the car) could no longer see the
    // road ABOVE it, so it stayed buried. The hard floor keeps that from ever happening.
    const yr = actorGroundY(car.x, car.z, car.groundY);
    if (car.groundY == null) car.groundY = yr;
    else { const rate = yr > car.groundY ? dt * 18 : dt * 9; car.groundY += (yr - car.groundY) * Math.min(1, rate); }
    if (yr != null && car.groundY < yr - 0.8) car.groundY = yr - 0.8;   // anti-bury backstop, loose enough that a brief canopy/roof spike can't snap the car up
    const yC = car.groundY;
    const rxv = Math.cos(car.yaw), rzv = -Math.sin(car.yaw);
    // The 4 corner probes feed only the visual pitch/roll, which tolerates a lower rate, so
    // refresh these tile raycasts ~every 3rd frame and reuse the result between. (These were
    // the single biggest per-frame CPU cost on mobile — 4 brute-force tile casts every frame.)
    if ((car._tiltTick = (car._tiltTick | 0) + 1) % 3 === 0 || car._pitchS == null) {
      const tF = actorGroundY(car.x + fx * 1.4, car.z + fz * 1.4, car.groundY), tB = actorGroundY(car.x - fx * 1.4, car.z - fz * 1.4, car.groundY);
      const tR = actorGroundY(car.x + rxv * 0.9, car.z + rzv * 0.9, car.groundY), tL = actorGroundY(car.x - rxv * 0.9, car.z - rzv * 0.9, car.groundY);
      car._pitchS = Math.atan2(tB - tF, 2.8); car._rollS = Math.atan2(tR - tL, 1.8);
    }
    const pitch = car._pitchS, roll = car._rollS;
    car.group.position.set(car.x, yC + 0.06, car.z);
    car.group.rotation.set(0, 0, 0);
    // point the body slightly into the slide so drifts read visually
    const driftYaw = clamp(Math.atan2(car.vlat || 0, Math.max(6, Math.abs(car.speed))) * 0.7, -0.5, 0.5);
    car.group.rotateY(car.yaw - Math.PI / 2 + driftYaw);
    car.group.rotateZ(-pitch + (car.pitchDyn || 0));   // terrain pitch + dynamic load-transfer dive/squat
    car.group.rotateX(roll);
    // AERIAL / OVERHEAD: blow the car up so it's easy to spot from way up high and more fun
    // — roughly street-sized on the map. Purely cosmetic: collision uses fixed radii, never
    // this scale. Lerp so cycling views doesn't pop; aerial floats highest so it gets biggest.
    const _camV = DRIVE_CAMS[camMode] || {};
    const dispTarget = _camV.aerial ? 4.4 : _camV.topdown ? 2.9 : 1.3;   // chase bumped 1.18→1.3 so the car reads clearly when you orbit out; overhead big enough to spot from up high
    car.dispScale = car.dispScale == null ? dispTarget : car.dispScale + (dispTarget - car.dispScale) * (1 - Math.exp(-dt * 6));
    car.group.scale.setScalar(car.dispScale);
    const overhead = _camV.aerial || _camV.topdown;
    // On arrival, briefly ease the camera's look-ahead to 0 so the car frames DEAD-CENTRE
    // (the constant look-ahead otherwise leaves it offset toward the bottom even when stopped).
    const aheadScale = 1 - (arriveCenterT && now < arriveCenterT ? clamp((arriveCenterT - now) / 1400, 0, 1) : 0);
    carLocator.visible = overhead;
    if (overhead) {
      carLocator.position.set(car.x, yC + (_camV.aerial ? 13 : 8) + Math.abs(Math.sin(now * 0.004)) * 0.5, car.z);
      carLocator.scale.setScalar(_camV.aerial ? 1.25 : 0.9);
      if (carLocator.children[0]) carLocator.children[0].material.opacity = _camV.aerial ? 0.75 : 0.55;
      if (carLocator.children[1]) carLocator.children[1].material.opacity = _camV.aerial ? 0.5 : 0.34;
    }
    // collectible coins: spin + bob, picked up by driving over them
    coinGroundCursor = coins.length ? (coinGroundCursor + 1) % coins.length : 0;
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      c.mesh.visible = !c.got;
      if (c.got) continue;
      c.mesh.rotation.y += dt * 3.2;
      if (c.groundY == null || i === coinGroundCursor) c.groundY = actorGroundY(c.x, c.z, c.groundY);
      const coinY = c.groundY != null ? c.groundY : terrainAt(c.x, c.z);
      c.mesh.position.y = coinY + 1.15 + Math.abs(Math.sin(now * 0.004 + c.x)) * 0.35;
      if (Math.hypot(car.x - c.x, car.z - c.z) < 3.4) {
        c.got = true; coinsGot++;
        spawnCoinBurst(c.x, c.z, coinY, now);
        const wasBest = !bestMs || (now - runStart) <= bestMs;
        collectCoin(now);
        if (coinsGot === coins.length) {
          toast('💛 All ' + coins.length + ' coins in ' + fmtTime(lastRunMs) + '! ' + (wasBest ? '🏆 New best!' : 'Best ' + fmtTime(bestMs)), 3600);
          if (ui.fx && !reduceMotion) { ui.fx.classList.add('arrive'); setTimeout(() => ui.fx && ui.fx.classList.remove('arrive'), 650); }
        }
      }
    }
    // tyre marks + smoke + screech while the tail is out (drift or handbrake) and moving
    const slipping = (Math.abs(car.vlat) > 6 || hb) && Math.abs(car.speed) > 5;
    if (slipping && now - lastSkidT > 26) {
      lastSkidT = now;
      const bx = car.x - fx * 1.5, bz = car.z - fz * 1.5;           // rear axle
      const rpx2 = Math.cos(car.yaw), rpz2 = -Math.sin(car.yaw);    // right vector
      spawnSkid(bx - rpx2 * 0.7, bz - rpz2 * 0.7, yC, car.yaw, now);
      spawnSkid(bx + rpx2 * 0.7, bz + rpz2 * 0.7, yC, car.yaw, now);
      if (FX.si % 2 === 0) spawnSmoke(bx, bz, yC, now, openRoad);
    }
    // ride the tyre-screech: louder the more the tail is out (and on the handbrake)
    if (audio.screech) audio.screech(slipping ? clamp((Math.abs(car.vlat) - 3) / 13, 0.18, 1) * (hb ? 1.1 : 1) : 0);
    // brake squeal: a tyre chirp on a hard stop, gated so it's silent when coasting/parked
    if (audio.brakeSqueech) audio.brakeSqueech((car.brakeAmt || 0) * clamp((Math.abs(car.speed) - 5) / 15, 0, 1));
    // DRIFT reward: a held slide glows the ✋ button + a 'DRIFT' chip, and every ~0.9 s of
    // sustained drift ticks the combo + trip score — the best mechanic finally pays out.
    const drifting = Math.abs(car.vlat) > 6 && Math.abs(car.speed) > 9;
    if (drifting !== driftState) { driftState = drifting; emit('drift', drifting); }
    if (drifting) {
      driftAccum += dt;
      if (driftAccum > 0.9) {
        driftAccum = 0;
        combo = (!comboExpired && now < comboExpire) ? combo + 1 : 1; comboExpire = now + 4000; comboExpired = false;
        tripScore += 30 + combo * 15; addBoost(0.09); comboFx(now); emitScore({});
      }
    } else driftAccum = 0;
    tickParticles(now, dt);
    checkPOIs(now);
    updateBeacons(now);
    // live rally clock (direct DOM, no React churn) + combo expiry
    if (ui.runTime) ui.runTime.textContent = fmtTime(runActive ? now - runStart : lastRunMs);
    if (!comboExpired && now > comboExpire) { comboExpired = true; combo = 0; emitScore({}); }
    // reverse tell-tales: 'R' in the speedo + the STOP pedal flips to REV
    const reversing = car.speed < -0.4;
    if (ui.rev) ui.rev.style.opacity = reversing ? '1' : '0';
    if (ui.brakeLbl && ui.brakeLbl.textContent !== (reversing ? 'REV' : 'STOP')) ui.brakeLbl.textContent = reversing ? 'REV' : 'STOP';
    // GEAR readout for the dash cluster: R reverse · P parked · N coasting · D driving.
    if (ui.gear) {
      const g = reversing ? 'R' : (Math.abs(car.speed) < 0.4 && throttle < 0.1) ? 'P' : (throttle > 0.05 ? 'D' : 'N');
      if (ui.gear.textContent !== g) { ui.gear.textContent = g; ui.gear.dataset.gear = g; }
    }
    if (ui.eta) {
      if (DEST) {
        const dd = Math.hypot(DEST.x - car.x, DEST.z - car.z);
        const etaMs = dd / Math.max(9, Math.abs(car.speed)) * 1000;
        ui.eta.textContent = dd < 18 ? 'arriving…'
          : (dd > 950 ? (dd / 1000).toFixed(1) + ' km' : Math.round(dd) + ' m') + ' · ~' + fmtTime(etaMs);
      } else ui.eta.textContent = '';
    }
    if (navMarker) {
      navMarker.visible = inp2.navActive && !autoDrive;   // hide the finger ring during auto-drive
      if (navMarker.visible) {
        navMarker.userData.groundY = actorGroundY(inp2.navX, inp2.navZ, navMarker.userData.groundY);
        navMarker.position.set(inp2.navX, navMarker.userData.groundY + 0.16, inp2.navZ);
      } else navMarker.userData.groundY = null;
    }
    // address guide: a continuous line along the actual ROUTE (every turn), draped on
    // the road just ahead of the car; + a pin at the destination when near.
    if (DEST) {
      updateGuide(yC);
      const ddDest = Math.hypot(DEST.x - car.x, DEST.z - car.z);
      destPin.visible = ddDest < 700;
      if (destPin.visible) {
        destPin.userData.groundY = actorGroundY(DEST.x, DEST.z, destPin.userData.groundY);
        destPin.position.set(DEST.x, destPin.userData.groundY + 6 + Math.abs(Math.sin(now * 0.004)) * 0.6, DEST.z);
      }
    } else { guideLine.visible = false; destPin.visible = false; }
    // The flat aerial patch under the car read as an ugly disc (a different, lower-res
    // texture than the Google tiles). Keep the car riding the same sampled road
    // HEIGHT (actorGroundY), but leave the patch hidden so only the photoreal shows.
    if (groundPatch) groundPatch.visible = false;
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
    } else if (DRIVE_CAMS[camMode].aerial) {
      // Explore's look while driving: the same high orbit framing (az/polar/range as
      // the page-load Explore view), just centred on the car. Drag orbits it, pinch
      // zooms, and the altitude is slow-smoothed so it floats like the aerial view.
      camera.up.set(0, 1, 0);
      const sp = clamp(Math.abs(car.speed) / feelRef, 0, 1);          // gentle speed breathe (keep the Explore feel)
      const a = 0.45 + camOrbit.yaw;
      const po = clamp(0.92 - camOrbit.pitch * 0.45, 0.18, 1.4);
      const r = (185 + sp * 38) * czoom;                             // float higher/further as you wind it out
      camGroundRef = camGroundRef == null ? yC : camGroundRef + (yC - camGroundRef) * Math.min(1, dt * 1.0);
      const camT = _camT.set(car.x + r * Math.sin(po) * Math.sin(a), camGroundRef + r * Math.cos(po), car.z + r * Math.sin(po) * Math.cos(a));
      if (!camInit) { camV.copy(camT); camInit = true; }
      // track TIGHTER the faster you go so a 700 mph autodrive never outruns the orbit cam
      camV.lerp(camT, 1 - Math.exp(-(4.6 + clamp(Math.abs(car.speed) / 16, 0, 13)) * dt));
      // hard backstop: never let the camera trail the orbit target by more than ~45% of the
      // range, so a hard turn at top speed can't swing the car out of frame (invisible car).
      const lagMax = r * 0.45, dxc = camV.x - camT.x, dzc = camV.z - camT.z, lc = Math.hypot(dxc, dzc);
      if (lc > lagMax) { const f = lagMax / lc; camV.x = camT.x + dxc * f; camV.z = camT.z + dzc * f; }
      camera.position.copy(camV);
      camera.lookAt(car.x + fx * sp * 26 * aheadScale, camGroundRef + 1, car.z + fz * sp * 26 * aheadScale);   // bias the gaze where you're heading (→ centred on arrival)
      const fovT = 46 + 5 * sp;
      camera.fov += (fovT - camera.fov) * (1 - Math.exp(-3 * dt)); camera.updateProjectionMatrix();
    } else if (DRIVE_CAMS[camMode].topdown) {
      const CAM = DRIVE_CAMS[camMode];
      const sp = clamp(Math.abs(car.speed) / feelRef, 0, 1);          // sense of speed even from overhead
      // almost directly overhead, but offset a little behind and aimed a touch
      // forward so you can read the road ahead (not perfectly straight down).
      // At speed: float a touch higher, ease back, and push the look-ahead WAY
      // forward so the car slides toward the bottom of frame and you see the road
      // rushing up — the overhead read of velocity.
      const camT = _camT.set(car.x - fx * (CAM.dist + sp * 4), yC + CAM.h * czoom + sp * 9, car.z - fz * (CAM.dist + sp * 4));   // czoom = pure altitude (wide pinch range), speed-float added on top
      if (!camInit) { camV.copy(camT); camInit = true; }
      camV.lerp(camT, 1 - Math.exp(-(5 + clamp(Math.abs(car.speed) / 16, 0, 13)) * dt));   // keep up at top speed
      camera.position.copy(camV);
      camera.up.set(fx, 0, fz); // heading-up
      const spHiT = clamp((Math.abs(car.speed) - feelRef) / (feelRef * 2.7), 0, 1);
      const ahead = (CAM.ahead + sp * sp * 16 + spHiT * 14) * aheadScale;     // see further down the road flat-out (→ centred on arrival)
      camera.lookAt(car.x + fx * ahead, yC, car.z + fz * ahead);
      const fovT = 46 + 9 * sp + 12 * spHiT;                   // a real widen when truly flying
      camera.fov += (fovT - camera.fov) * (1 - Math.exp(-3 * dt)); camera.updateProjectionMatrix();
      if (!reduceMotion && spHiT > 0.1) { const r = spHiT * 0.04; camera.position.x += (Math.random() - 0.5) * r; camera.position.z += (Math.random() - 0.5) * r; }
    } else {
      const CAM = DRIVE_CAMS[camMode];
      camera.up.set(0, 1, 0);
      // free look: hold wherever you dragged, then auto-recenter behind the car shortly
      // after you let go — but HOLD the view for a while first so you can actually look
      // around / explore the scene (the old 600 ms snap made it feel impossible to look).
      // Recentre only after ~1.8 s of no look input, and ease back gently.
      // Free-look HOLDS far longer, then eases only YAW back behind the car (re-frame forward)
      // while PITCH stays where you set it — look up at the skyline / down at the road and it
      // sticks. The longer idle delay means a resting finger studying the view doesn't snap back.
      if (now - camOrbit.t > 2600) {
        camOrbit.yaw *= Math.exp(-dt * 0.9);                                       // slow yaw recentre
        camOrbit.pitch += (0.1 - camOrbit.pitch) * (1 - Math.exp(-dt * 0.35));     // drift pitch to a gentle rest, very slowly
      }
      const sp = clamp(Math.abs(car.speed) / feelRef, 0, 1);          // 0..1 of the FEEL range (~60 mph)
      // spHi keeps building ABOVE the feel range up to the real top (~180-220), so the
      // open-road blast the design invites actually reads as faster than a 40 mph cruise.
      const spHi = clamp((Math.abs(car.speed) - feelRef) / (feelRef * 2.7), 0, 1);
      const a = car.yaw + Math.PI + camOrbit.yaw - car.steer * 0.6;   // lead the camera into corners
      const dist = (CAM.dist + sp * sp * 9 + spHi * 6) * czoom;       // sink the car back further when truly flying
      const h = (CAM.h + camOrbit.pitch * 4.5 + sp * 3) * Math.max(0.7, czoom);
      // hold a STATIC altitude (drone cams): slow-smooth the ground ref so terrain
      // rolls don't bob the high cam; the low Close cam snaps to the ground.
      camGroundRef = camGroundRef == null ? yC : camGroundRef + (yC - camGroundRef) * (1 - Math.exp(-dt * (CAM.drone ? 1.2 : 6)));
      const camT = _camT.set(car.x + Math.sin(a) * dist, camGroundRef + h, car.z + Math.cos(a) * dist);
      if (!CAM.drone) {
        const g = resolveCam(car.x, yC + 1.2, car.z, camT.x, camT.y, camT.z);
        // Boxed in by buildings (e.g. arriving on a tight residential street): pull the
        // camera in toward the car, but RISE as it closes so it looks DOWN at the car from
        // above instead of burying into the wall / staring at the car's own roof.
        if (g < 1) { const lift = (1 - g) * 7; camT.set(car.x + (camT.x - car.x) * g, yC + 1.2 + (camT.y - yC - 1.2) * g + lift, car.z + (camT.z - car.z) * g); }
      }
      if (!camInit) { camV.copy(camT); camInit = true; _lookV = null; camFloorRef = null; }
      camV.lerp(camT, 1 - Math.exp(-(4.6 + clamp(Math.abs(car.speed) / 16, 0, 13)) * dt));   // frame-rate-independent + keeps up at top speed
      // Anti-clip floor based on the CAR's road level (yC = actorGroundY, which is
      // overpass/canopy-skipped). A high groundAt() raycast at the camera's xz used to hit an
      // OVERPASS deck above and shove the camera up over it — hiding the car under an
      // underpass / when changing levels. Tracking the car's own level fixes that (and the
      // low-pass keeps photogrammetry bumps from popping the cam).
      _camFloorRaw = yC + 1.3;
      camFloorRef = camFloorRef == null ? _camFloorRaw : camFloorRef + (_camFloorRaw - camFloorRef) * (1 - Math.exp(-dt * 3));
      if (camV.y < camFloorRef) camV.y = camFloorRef;
      camera.position.copy(camV);
      // WHIP: the look point isn't nailed to the car — it lags and carries a lateral
      // lead from the drift/steer, so on a hard corner the car slides toward the edge of
      // frame then snaps back. Sells corners far more than a rigid lookAt.
      // Scale the look-ahead with SPEED: parked/slow → look almost AT the car so it sits centred
      // (a fixed forward look-ahead dropped the car to the bottom of the steep cruise frame — "falling
      // behind the camera"); at speed it pushes forward so you read the road. Also lift the look point
      // toward the car's roof when slow so the car frames higher, not at its wheels.
      const lookAhead = (CAM.ahead * (0.32 + 0.68 * sp) + sp * 6) * aheadScale;
      const lookY = yC + 1.0 + (1 - sp) * 0.9;
      const rpxL = Math.cos(car.yaw), rpzL = -Math.sin(car.yaw);
      const latLead = (car.vlat * 0.05 + car.steer * 2.0) * (1 - 0.3 * sp) * aheadScale;
      _lookT.set(car.x + fx * lookAhead + rpxL * latLead, lookY, car.z + fz * lookAhead + rpzL * latLead);
      if (!_lookV) _lookV = _lookT.clone(); else _lookV.lerp(_lookT, 1 - Math.exp(-7 * dt));
      camera.up.set(0, 1, 0);
      camera.lookAt(_lookV);
      // asymmetric FOV: a stab of GO shoves the view wide FAST, then it relaxes slow.
      // The spHi term adds a second, smaller kick that only opens up at true top speed.
      const fovT = 46 + 30 * Math.pow(sp, 1.25) + 8 * spHi;           // ~76° at cruise top, ~84° flat out
      camera.fov += (fovT - camera.fov) * (1 - Math.exp(-(fovT > camera.fov ? 6 : 2.2) * dt)); camera.updateProjectionMatrix();
      if (!reduceMotion) {
        const roll = clamp(-car.steer * 2.0 - car.vlat * 0.012, -0.1, 0.1) * (0.4 + sp);   // Dutch-tilt into corners/drift
        camera.rotateZ(roll);
        const rumble = (clamp((sp - 0.55) / 0.45, 0, 1) * 0.5 + spHi * 0.5) * 0.06;        // grows past the feel cap when flat out
        if (rumble > 0.001) { camera.position.x += (Math.random() - 0.5) * rumble; camera.position.y += (Math.random() - 0.5) * rumble; }
      }
    }
    if (shakeMag > 0.01 && !reduceMotion) {                          // decaying collision shake
      camera.position.x += (Math.random() - 0.5) * shakeMag;
      camera.position.y += (Math.random() - 0.5) * shakeMag;
      camera.position.z += (Math.random() - 0.5) * shakeMag;
      shakeMag *= Math.exp(-dt * 9);
    } else shakeMag = 0;
    if (vehicleFill.visible) {
      vehicleFill.position.copy(camera.position);
      vehicleFill.position.y += 8;
      vehicleFillTarget.position.set(car.x, yC + 1.1, car.z);
      vehicleFillTarget.updateMatrixWorld();
    }
    updateTileClip(car.x, yC, car.z, DRIVE_CAMS[camMode] || {});   // R8: with the camera now placed, cut tile geometry between it and the car (ALL views)
    if (ui.mph) ui.mph.textContent = Math.round(Math.abs(car.speed) * 2.237);
    {
      const f = clamp(Math.abs(car.speed) / feelRef, 0, 1);
      if (ui.speedBar) {                                 // speed-bar fill + colour band
        ui.speedBar.style.width = (f * 100).toFixed(1) + '%';
        ui.speedBar.style.background = f < 0.45 ? '#3ad17a' : f < 0.78 ? '#ffc21e' : '#ff5a3c';
      }
      if (ui.boostBar) {                                 // nitro meter (direct DOM, no React churn)
        ui.boostBar.style.width = (boost * 100).toFixed(0) + '%';
        ui.boostBar.parentElement.classList.toggle('ready', boost > 0.25 && !boosting);
        ui.boostBar.parentElement.classList.toggle('firing', boosting);
      }
      if (ui.fx && !reduceMotion) {                      // speed streaks + vignette: build from ~18%, keep growing flat out
        const fHi = clamp((Math.abs(car.speed) - feelRef) / (feelRef * 2.7), 0, 1);
        const v = clamp((f - 0.18) / 0.62, 0, 1) * 0.82 + fHi * 0.18;
        ui.fx.style.setProperty('--spd', v.toFixed(2));
        ui.fx.style.setProperty('--ox', (50 - (car.steer + camOrbit.yaw * 0.4) * 16).toFixed(1) + '%');  // streaks flow from where you're heading
        ui.fx.classList.toggle('on', v > 0.01);
        ui.fx.classList.toggle('fast', v > 0.6);         // motion-blur the streaks only when truly flying
      }
    }
    audio.engineUpdate(car.speed, feelRef, throttle); // rev maps to the feel reference; load brightens it
    if (audio.musicSpeed) audio.musicSpeed(clamp(Math.abs(car.speed) / feelRef, 0, 1));   // the tune lifts on the blast
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
  let _rw = 0, _rh = 0, _resizeRaf = 0, _kbdOpen = false;
  function resize() {
    const [w, h] = viewportSize();
    _rw = w; _rh = h;
    renderer.setPixelRatio(renderPixelRatio());
    renderer.setSize(w, h, false);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    if (ui.box) { ui.box.style.width = w + 'px'; ui.box.style.height = h + 'px'; }
    camera.aspect = w / h; camera.updateProjectionMatrix();
    if (p3dtiles) p3dtiles.setResolutionFromRenderer(camera, renderer);
  }
  // rAF-coalesced resize for the event listeners. On iOS, visualViewport 'scroll' fires
  // continuously during the URL-bar show/hide, and a raw resize() per event churns the GL
  // viewport + tile-resolution recompute mid-gesture. Skip when the size hasn't changed.
  function requestResize() {
    // iPad/iOS: focusing the address box opens the on-screen keyboard, which SHRINKS visualViewport.
    // Resizing the canvas + HUD to that smaller strip is what "screws up the rest of the screen" — the
    // 3D scene squished into the top while you type. Hold the size steady while a text field is focused
    // and restore it on blur (see the focusin/focusout listeners below).
    if (_kbdOpen) return;
    if (_resizeRaf) return;
    _resizeRaf = requestAnimationFrame(() => {
      _resizeRaf = 0;
      if (_kbdOpen) return;   // the keyboard may have opened AFTER this rAF was queued (focusin one frame later) — don't squish to the keyboard strip
      const [w, h] = viewportSize();
      if (w !== _rw || h !== _rh) resize();
    });
  }

  // ---------- loop ----------
  const dirV = new THREE.Vector3();
  let prev = performance.now();
  let raf = 0, paused = false, ctxLost = false, _miniT = 0, _miniCtx = null, _miniEl = null, _shadowT = 0, _miniYaw = 0;
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
    const rawDt = Math.min(0.05, (now - prev) / 1000); prev = now;
    if (slowmoHold > 0) { slowmoHold -= rawDt; }              // hold the arrival slow-mo before recovering
    else timeScale += (1 - timeScale) * Math.min(1, rawDt * 4.5);   // recover from slow-mo back to real time
    const dt = rawDt * timeScale;
    if (waterMat) waterMat.uniforms.uTime.value = now * 0.001; // flowing creek
    updateAnimals(dt, now, (mode === 'scoop' && scoopScene === 'yard') ? CHAR : null); // ambient life every mode; spooks away from the player while scooping the yard
    updateCrowd(dt, now);   // dancing CeCe/Drew crowd (mode + distance gated) + hit-launch
    if (mode === 'drive') {
      updateDrive(dt, now);
    } else if (mode === 'scoop') {
      updateScoop(dt, now);
    } else {
      // frame-rate-INDEPENDENT blend (was a fixed 0.16/frame → converged twice as fast on a
      // 120 Hz phone and micro-stuttered under variable dt — the "aerial orbit isn't smooth").
      const k = reduceMotion ? 1 : (1 - Math.exp(-rawDt * 10.6));
      if (!reduceMotion && !ptrs.size && (Math.abs(azVel) > 1e-4 || Math.abs(poVel) > 1e-4)) {
        ctl.gaz += azVel * rawDt * 60; ctl.gpo = clamp(ctl.gpo + poVel * rawDt * 60, 0.14, 1.46);
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
    if (sun.castShadow && now - _shadowT > 140) { renderer.shadowMap.needsUpdate = true; _shadowT = now; }
    camera.getWorldDirection(dirV);
    if (ui.needle) ui.needle.style.transform = `rotate(${(Math.atan2(dirV.x, dirV.z) * 180 / Math.PI).toFixed(1)}deg)`;
    updateTilePrefetch(now);                                         // warm tiles along the route ahead (self-gates to drive + active destination)
    if (p3dtiles && photoModes(mode)) { camera.updateMatrixWorld(); if (now - _tilesUpdT > 55) { p3dtiles.update(); _tilesUpdT = now; } updateAttribution(now); }   // ~18 Hz LOD traversal
    else if (_attrStr) { _attrStr = ''; emit('attribution', ''); }   // no tiles shown → no credit
    if (mode === 'drive') {
      updateMiniMap(now);                                            // live Google minimap (when up)
      if (!_gmap && ui.minimap && now - _miniT > 80) {              // procedural fallback until/unless it loads
        _miniT = now;
        if (_miniEl !== ui.minimap) { _miniEl = ui.minimap; _miniCtx = ui.minimap.getContext('2d'); }
        if (_miniCtx) drawMinimap(_miniCtx, ui.minimap.width, ui.minimap.height);
      }
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  // iOS robustness: don't burn GPU/memory streaming tiles to a backgrounded tab,
  // and survive a WebGL context loss instead of freezing on a black canvas.
  // Backgrounded → stop the RAF (halts physics, the 4-camera renders, tile streaming,
  // minimap + FX) AND suspend audio (no engine drone / music) → a hidden tab draws ~no
  // power. iOS phone-lock / app-switch often fires pagehide/freeze WITHOUT a reliable
  // visibilitychange (and Low Power Mode can suppress it), so we listen to all of them.
  function suspend() { clearLiveInput(); _clearKbd(); if (!paused) { paused = true; cancelAnimationFrame(raf); if (audio.suspendAudio) audio.suspendAudio(); } }
  function resume() { if (paused && !disposed && !ctxLost) { paused = false; prev = performance.now(); if (audio.resumeAudio) audio.resumeAudio(); else audio.ensure(); raf = requestAnimationFrame(loop); } }
  function onVisibility() { if (document.hidden) suspend(); else resume(); }
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
  addEventListener('pagehide', suspend); addEventListener('freeze', suspend);     // iOS lock / app-switch
  addEventListener('pageshow', resume); addEventListener('resume', resume);
  addEventListener('blur', clearLiveInput);
  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  addEventListener('resize', requestResize);
  addEventListener('orientationchange', requestResize);   // iPad rotation doesn't always fire a 'resize' — re-fit the canvas on rotate too
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', requestResize);
    visualViewport.addEventListener('scroll', requestResize);
  }
  // Keyboard-open detection: a focused text field (the address box) is what brings up the on-screen
  // keyboard. While it's focused we freeze the viewport size; on blur we resize once to restore + also
  // un-scroll the page (iOS scrolls the document to reveal the input, leaving the fixed UI offset).
  const _isTextField = el => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(range|checkbox|radio|button|submit|reset|color|file)$/.test(el.type || 'text')));
  // Clear the freeze + restore size. Authoritative: only clears once focus has genuinely left every
  // text field, so it self-heals even when iOS/WebKit DROPS focusout on a focused <input> that React
  // unmounts on submit (the address box on Go/X/Escape) — which would otherwise stick _kbdOpen true and
  // silently freeze EVERY later resize for the session.
  const _clearKbd = () => { if (!_kbdOpen) return; _kbdOpen = false; try { window.scrollTo(0, 0); } catch (e) { } requestResize(); };
  const onFocusIn = e => { if (_isTextField(e.target)) _kbdOpen = true; };
  const onFocusOut = e => { if (_isTextField(e.target)) setTimeout(() => { if (!_isTextField(document.activeElement)) _clearKbd(); }, 0); };
  addEventListener('focusin', onFocusIn);
  addEventListener('focusout', onFocusOut);
  addEventListener('blur', _clearKbd);   // belt-and-suspenders: app-switch / lock with the keyboard up never leaves it stuck
  resize();
  const t1 = setTimeout(resize, 400), t2 = setTimeout(resize, 1500);

  emit('subline', 'Castro Valley, CA');   // clean default for the live location readout; the reverse-geocoder refines it to STREET · CITY, ST as you drive
  applyCam();
  renderer.render(scene, camera);
  emit('ready');
  emitPOIs();                 // seed the start-card "places found" badge from saved progress
  if (audio.setMuted) audio.setMuted(!soundOn);   // sync the master mute with the saved pref
  emit('sound', soundOn);   // seed the 🔊 toggle state
  emit('autosteer', autoSteer);
  emit('roadlife', roadLifeOn);
  checkFerrariUnlock();       // reconcile a prior 5/5 completion → keep the Ferrari unlocked
  if (document.hidden) paused = true;   // born in a background tab → don't render/stream until shown
  else raf = requestAnimationFrame(loop);

  function dispose() {
    disposed = true;
    cancelAnimationFrame(raf);
    clearTimeout(t1); clearTimeout(t2); clearTimeout(_crowdReplaceT);
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
    removeEventListener('pagehide', suspend); removeEventListener('freeze', suspend);
    removeEventListener('pageshow', resume); removeEventListener('resume', resume);
    removeEventListener('blur', clearLiveInput);
    removeEventListener('keydown', onKeyDown);
    removeEventListener('keyup', onKeyUp);
    removeEventListener('resize', requestResize);
    removeEventListener('orientationchange', requestResize);
    removeEventListener('focusin', onFocusIn);
    removeEventListener('focusout', onFocusOut);
    removeEventListener('blur', _clearKbd);
    stopFollow();
    if (window.visualViewport) {
      visualViewport.removeEventListener('resize', requestResize);
      visualViewport.removeEventListener('scroll', requestResize);
    }
    cancelAnimationFrame(_resizeRaf);
    audio.engineStop();
    if (audio.stopMusic) audio.stopMusic();      // kill the 30ms music scheduler interval (was leaking)
    if (audio.close) audio.close();              // close the AudioContext so it isn't left running
    if (cancelCarLoad) cancelCarLoad();          // late car load/timeout can't touch a dead scene
    for (const cancel of modelLoadCancels) if (cancel) cancel();
    disposeMiniMap();
    if (ceceCrowd) ceceCrowd.dispose();          // stop crowd mixers + detach the dancers
    if (drewCrowd) drewCrowd.dispose();
    if (dadCrowd) dadCrowd.dispose();
    if (momCrowd) momCrowd.dispose();
    for (const npc of npcs) { if (npc.ctrl.reset) npc.ctrl.reset(); if (npc.group.parent) npc.group.parent.remove(npc.group); }   // tear down the house NPCs
    setScout(false);                             // unregister the prefetch scout camera
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
    if (scene.environment && scene.environment.dispose) { scene.environment.dispose(); scene.environment = null; }
    renderer.dispose();
    document.documentElement.classList.remove('lite3d');
    delete window.__dahill;
  }

  const api = {
    enterDrive, exitDrive, enterScoop, exitScoop,
    toggleShiftLock: () => { shiftLock = !shiftLock; emit('shiftLock', shiftLock); },
    // hop: only from the ground; a keyboard Space also jumps (wired in onKeyDown)
    jump: () => { if (mode === 'scoop' && CHAR.airY <= 0 && CHAR.vy === 0) { CHAR.vy = 8.5; if (audio.blip) audio.blip(); } },
    // random celebration from the active avatar's emote set
    dance: () => {
      if (mode !== 'scoop' || !CHAR.drew) return;
      const a = CHAR.getActions();
      CHAR.drew.react(a.length ? a[Math.floor(Math.random() * a.length)].key : 'dance');
      if (audio.blip) audio.blip();
    },
    // play one specific emote (the side-menu action buttons)
    playAction: (key) => { if (mode === 'scoop' && CHAR.drew) { CHAR.drew.react(key); if (audio.blip) audio.blip(); } },
    // Drew <-> CeCe avatar swap (avatar only — the side-menu switch). Emits 'avatar' optimistically
    // (the toggle flips at once) and again once the new rig + its action list are ready.
    setAvatar: (name) => {
      CHAR.swapAvatar(name, n => emit('avatar', { name: n, actions: CHAR.getActions() }));   // real actions once the rig is mounted
      // optimistic: flip the toggle now, but only carry actions if that avatar is ALREADY mounted —
      // otherwise the grid would show the previous kid's emotes during CeCe's async load.
      emit('avatar', { name, actions: CHAR.avatar === name ? CHAR.getActions() : [] });
    },
    getAvatar: () => CHAR.avatar,
    getScoopActions: () => CHAR.getActions(),
    // Go inside / leave the house from a HUD button (proximity-free — the auto-walk door pad still works too)
    enterHouse: () => { if (mode === 'scoop' && interior && scoopScene === 'yard') enterHouse(performance.now()); },
    leaveHouse: () => { if (mode === 'scoop' && scoopScene === 'interior') leaveHouse(performance.now()); },
    focusHouse, cycleCamera, traceDrive, cycleCar, getCars, pickCar, cycleScoopCamera, driveFromScoop, resetToRoad, resize,
    setDestination, clearDestination, toggleAutoDrive, driveHome, jumpHome, driveToMyLocation, stopFollow,
    // address search + jump-to + autodrive speed cap (Google JS SDK, in-browser)
    placeSuggest, geocodeAddress, geocodePlaceId,
    jumpToAddress: (lat, lon, label) => jumpTo(lat, lon, label),
    jumpToText: (text) => geocodeAddress(text).then(g => { jumpTo(g.lat, g.lon, g.label); return g; }),
    jumpToPlace: (placeId, label) => geocodePlaceId(placeId, label).then(g => { jumpTo(g.lat, g.lon, g.label); return g; }),
    driveToText: (text) => setDestinationByText(text, true),
    driveToPlace: (placeId, label) => setDestinationByPlace(placeId, label, true),
    driveToLatLon,
    setAutoMaxMph, getAutoMaxMph: () => autoMaxMph,
    setSpeedMul, getSpeedMul: () => speedMul, setDriveZoom,
    setCrowdDensity, getCrowdDensity: () => CROWD_DENSITY,
    setTrafficDensity: (d) => {
      trafficDensity = clamp(+d || 0, 0, 2);
      try { localStorage.setItem('dahill.trafficdensity', String(trafficDensity)); } catch (e) { }
      const active = trafficActiveCount();
      for (let i = active; i < traffic.length; i++) traffic[i].group.visible = false;   // park any now-over-cap cars at once
      return trafficDensity;
    },
    getTrafficDensity: () => trafficDensity,
    preloadMaps: () => loadMapsSDK().catch(() => {}),   // warm the SDK so the first keystroke in the address box doesn't jank
    initMiniMap,                                         // mount the live Google minimap into a div
    setHandbrake: (on) => { inp2.hbrake = !!on; },
    // LOOK stick (right thumb): orbit the drive camera. dx/dy are screen-pixel deltas,
    // same convention as a look-drag on the canvas, so it feeds the existing camOrbit.
    nudgeLook: (dx, dy) => {
      const ld = lookDelta(dx, dy);
      camOrbit.yaw = clamp(camOrbit.yaw - ld.yaw, -2.4, 2.4);
      camOrbit.pitch = clamp(camOrbit.pitch + ld.pitch, -0.45, 0.8);
      camOrbit.t = performance.now();
      showT = 0;
    },
    setGas: (on) => { inp2.gas = on ? 1 : 0; if (on) showT = 0; },   // gas pedal (hold)
    setGasAmount: (v) => { inp2.gas = clamp(v, 0, 1); if (v > 0.05) showT = 0; },   // analog gas (touch drag)
    setBoost: (on) => { inp2.boost = !!on; },                        // nitro (hold while charged)
    setBrake: (on) => { inp2.brake = on ? 1 : 0; },                  // brake pedal (hold)
    // "Sound" toggle = master mute over EVERYTHING (engine drone + sfx + music), not just the soundtrack.
    toggleSound: () => { soundOn = !soundOn; try { localStorage.setItem('dahill.sound', soundOn ? '1' : '0'); } catch (e) { } if (audio.ensure) audio.ensure(); if (audio.setMuted) audio.setMuted(!soundOn); if (mode === 'drive' && audio.setMusic) audio.setMusic(soundOn); emit('sound', soundOn); return soundOn; },
    toggleAutoSteer: () => { autoSteer = !autoSteer; try { localStorage.setItem('dahill.autosteer', autoSteer ? '1' : '0'); } catch (e) { } emit('autosteer', autoSteer); toast(autoSteer ? '🛟 Auto-steer ON — it helps you hug the road' : 'Auto-steer off', 1400); return autoSteer; },
    toggleRoadLife: () => {
      roadLifeOn = !roadLifeOn;
      try { localStorage.setItem('dahill.roadlife', roadLifeOn ? '1' : '0'); } catch (e) { }
      emit('roadlife', roadLifeOn);
      if (!roadLifeOn) { hideTraffic(); hideCrowd(); }
      toast(roadLifeOn ? 'People + traffic ON' : 'People + traffic off', 1300);
      return roadLifeOn;
    },
    // tap-to-drive: convert a minimap pixel (HEADING-UP, car-centred) to a world point and let the
    // robot drive there. Inverts the SAME rotation drawMinimap drew with (via _miniYaw) so a tap lands
    // where the user pointed. range/scale mirror drawMinimap exactly.
    tapMinimap: (px, py, w, h) => {
      const range = 620, scale = (w / 2) / range, ca = Math.cos(_miniYaw), sa = Math.sin(_miniYaw);
      const ox = px - w / 2, oy = py - h / 2;
      setDriveTarget(car.x + (-ca * ox - sa * oy) / scale, car.z + (sa * ox - ca * oy) / scale);
    },
    dispose,
    get mode() { return mode; }
  };
  // tiny debug handle for headless verification + on-phone debugging
  window.__dahill = {
    api,
    scoop: () => ({ scene: scoopScene, ready: !!interior, avatar: CHAR.avatar, entry: entryPt && entryPt.map(v => +v.toFixed(1)), char: [+CHAR.x.toFixed(1), +CHAR.z.toFixed(1)], dDoor: entryPt ? +Math.hypot(CHAR.x - entryPt[0], CHAR.z - entryPt[1]).toFixed(1) : null, occ: interior ? interior.occluders.length : 0, hiddenOcc: interior ? interior.occluders.filter(o => !o.visible).length : 0 }),
    crowd: () => ({ on: roadLifeOn, cece: !!ceceCrowd, drew: !!drewCrowd, spots: crowdSpots.map(s => ({ zone: s.zone, x: Math.round(s.rec.x), z: Math.round(s.rec.z), vis: s.rec.grp.visible, road: !!s.onRoadHt, scale: +s.rec.grp.scale.x.toFixed(2), y: +s.rec.grp.position.y.toFixed(1), dCar: Math.round(Math.hypot(s.rec.x - car.x, s.rec.z - car.z)) })) }),
    traffic: () => ({ on: roadLifeOn, total: traffic.length, visible: traffic.filter(c => c.group.visible).length, cars: traffic.map(c => ({ x: Math.round(c.x || 0), z: Math.round(c.z || 0), vis: c.group.visible, speed: c.speed })) }),
    p3dt: P3DT,                       // mutate {yOffset,xOffset,zOffset,spin} then call nudge()
    nudge: applyP3DT,
    tiles: () => p3dtiles,
    setProcedural: (on) => { staticGroup.visible = on; },
    beacons: () => poiBeacons.map(b => ({ key: b.poi.key, vis: b.mesh.visible, op: +b.mat.opacity.toFixed(2), d: Math.round(Math.hypot(b.poi.x - car.x, b.poi.z - car.z)) })),
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
      poops: POOPS.length, car: { x: +car.x.toFixed(1), z: +car.z.toFixed(1), speed: +car.speed.toFixed(1), yaw: +car.yaw.toFixed(2), glb: !!car.glb },
      dest: DEST ? { x: +DEST.x.toFixed(1), z: +DEST.z.toFixed(1) } : null,
      char: { x: +CHAR.x.toFixed(1), z: +CHAR.z.toFixed(1), bag: CHAR.bag, total: CHAR.total, lvl: CHAR.lvl }
    })
  };
  return api;
}
