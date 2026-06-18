import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { S, C, W, uvAt, terrainAt, SREC, GRID_ANG } from './data.js';
import { clamp } from './coords.js';
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
import { createGround } from './occlusion/ground-height.js';
import { createTileClip } from './occlusion/tile-clip.js';
import { createPrefetch } from './occlusion/prefetch.js';
import { createGeo } from './nav/geo.js';
import { createRoadGraph } from './nav/road-graph.js';
import { DRIVE_CAMS, SCOOP_CAMS } from './camera/presets.js';
// ---- carved domain modules (each createX(ctx) returns its functions, bound to ctx.<ns>) ----
import { createScore } from './drive/score-fx.js';
import { createPoi } from './drive/poi.js';
import { createTraffic } from './drive/traffic.js';
import { createCars } from './drive/cars.js';
import { createCrowd } from './crowd/crowd-system.js';
import { createHouse } from './house/house.js';
import { createFollow } from './follow/follow.js';
import { createCam } from './camera/cameras.js';
import { createScoop } from './scoop/scoop.js';
import { createDrive } from './drive/drive.js';
import { createControls } from './controls/controls.js';
import { InputManager } from '../controls/InputManager.js';   // unified Roblox-style input (staged); bridged into ctx.inp2 per mode
import { createNav } from './nav/nav.js';
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
  // Shared engine context: a single plain-JS bag every subsystem reads/writes BY REFERENCE.
  // The hot RAF loop mutates this ~60–120×/s, so it deliberately lives OUTSIDE React (no
  // context/jotai — that would re-render per frame). Flat by design (mechanical, low-churn);
  // `ctx.car`/`ctx.CHAR`/`ctx.inp2` stay the existing aggregate bags. See plans/plan-engine-decomposition-*.
  const ctx = {};
  ctx.canvas = canvas; ctx.ui = ui; ctx.emit = emit;
  ctx.fn = {};   // back-edge registry: cross-cutting functions modules call (setMode, enterDrive, …); each owning module registers itself into ctx.fn
  // Carve the domain modules up-front: each factory only DEFINES closures over ctx (no state read
  // at creation), so ctx.<ns>.fn is available for every later construction-time + runtime call site.
  ctx.score = createScore(ctx);
  ctx.poi = createPoi(ctx);
  ctx.trafficSys = createTraffic(ctx);
  ctx.cars = createCars(ctx);
  ctx.crowd = createCrowd(ctx);
  ctx.houseSys = createHouse(ctx);
  ctx.follow = createFollow(ctx);
  ctx.cam = createCam(ctx);
  ctx.scoop = createScoop(ctx);
  ctx.drive = createDrive(ctx);
  ctx.controls = createControls(ctx);
  ctx.nav = createNav(ctx);
  ctx.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  ctx.toast = (html, ms) => ctx.emit('toast', { html, ms: ms || 1800 });
  // The toast is rendered via dangerouslySetInnerHTML, so any dynamic value that can carry
  // user/network text (geocoded addresses, place names) MUST be escaped before it goes in.
  // Static literals in toast() calls don't need this; only interpolated place/address text does.
  ctx.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ?lite : no shadows + 1x pixel ratio — for older phones and for headless
  //         verification, where software WebGL grinds at 1-5 fps otherwise.
  // ?nocar: skip the GLB swap (fast test loop; procedural car stays).
  ctx.flags = new URLSearchParams(location.search);
  // Phones: cap pixel ratio and lighten shadows. The shadow pass re-renders every
  // caster into the depth map each frame, so this is a real per-frame saving and
  // a defence against GPU-memory pressure on iOS Safari. Also catch iPadOS-13+, which
  // reports a desktop "Macintosh" UA but has touch — it was getting the heaviest path.
  ctx.MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  // Auto-LITE on low-end phones (few cores / little RAM) — previously LITE only triggered
  // with ?lite in the URL, so every DPR/AA/shadow mitigation below was dead code on a real
  // phone opened normally. This flips a weak device to DPR1 / no-AA / no-shadows.
  ctx.LITE = ctx.flags.has('lite') ||
    (ctx.MOBILE && ((navigator.hardwareConcurrency || 4) <= 4 || (navigator.deviceMemory || 4) <= 3));
  document.documentElement.classList.toggle('lite3d', ctx.LITE || ctx.MOBILE);
  ctx.renderPixelRatio = () => ctx.LITE ? 1 : Math.min(window.devicePixelRatio || 1, ctx.MOBILE ? 1.25 : 2);

  // Upgraded to three r184. The scene's colours and light intensities were all
  // hand-tuned under r128's un-managed, linear-output pipeline, so opt back out
  // of r152+ colour management and keep linear output to preserve that look;
  // the lights are re-scaled below for r155+ physically-correct units.
  THREE.ColorManagement.enabled = false;
  ctx.renderer = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: !ctx.LITE && !ctx.MOBILE, powerPreference: 'high-performance' });   // skip the MSAA resolve on mobile (fill-rate bound)
  ctx.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  // Cap pixel ratio: 1.25 on phones (the fill-rate dial — at DPR 2 a 3x phone draws ~2.6×
  // the fragments of the full-screen photoreal tiles for little visible gain; 1.25 supersampling
  // still softens edges), 2 on desktop. LITE stays at 1x.
  ctx.renderer.setPixelRatio(ctx.renderPixelRatio());   // 1.25² vs 2² ≈ 30% fewer fragments on the full-screen photoreal tiles
  ctx.renderer.shadowMap.enabled = !ctx.LITE;
  ctx.renderer.shadowMap.type = ctx.MOBILE ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  ctx.renderer.shadowMap.autoUpdate = false;
  ctx.renderer.localClippingEnabled = true;   // Drive-mode tile cutaway: only the photoreal tile materials carry clip planes, so the car/HUD/guide stay unclipped (see updateTileClip + tiles3d.clipPlanes)
  ctx.MAX_ANISO = ctx.renderer.capabilities.getMaxAnisotropy();   // sharp ground/roads at grazing angles
  setCarAniso(Math.min(8, ctx.MAX_ANISO));   // give the car textures the same anisotropic filtering as the tiles (de-grains the models)
  ctx.scene = new THREE.Scene();
  ctx.scene.background = new THREE.Color(0xc8d6da);
  ctx.scene.fog = new THREE.Fog(0xd2dcd6, 460, 1200);
  ctx.camera = new THREE.PerspectiveCamera(46, 1, 0.6, 3000);

  // r155+ uses physically-correct light units; ×π restores the r128 legacy
  // brightness these intensities were tuned for.
  ctx.scene.add(new THREE.HemisphereLight(0xd8e8f6, 0xa39a85, 0.6 * Math.PI));
  ctx.sun = new THREE.DirectionalLight(0xfff1d8, 0.95 * Math.PI);
  ctx.sun.position.set(-185, 240, 150);
  ctx.sun.castShadow = true;                 // gated to Scoop at runtime (see applyModeVisuals)
  ctx.sun.shadow.mapSize.set(ctx.MOBILE ? 1024 : 2048, ctx.MOBILE ? 1024 : 2048);   // casters sit in a tight frustum; 1024 is plenty on a phone
  ctx.sc2 = ctx.sun.shadow.camera;
  // tighter frustum (±170 vs ±300) ~= 3× the texel density where shadows actually
  // land (the scoop sanctuary + driveway); distant procedural shadows aren't missed.
  ctx.sc2.left = -170; ctx.sc2.right = 170; ctx.sc2.top = 170; ctx.sc2.bottom = -170; ctx.sc2.far = 900;
  ctx.sun.shadow.bias = -0.0009;
  ctx.scene.add(ctx.sun);
  ctx.vehicleFillTarget = new THREE.Object3D();
  ctx.scene.add(ctx.vehicleFillTarget);
  ctx.vehicleFill = new THREE.DirectionalLight(0xeaf4ff, 0.62 * Math.PI);
  ctx.vehicleFill.castShadow = false;
  ctx.vehicleFill.visible = false;
  ctx.vehicleFill.target = ctx.vehicleFillTarget;
  ctx.scene.add(ctx.vehicleFill);
  // Image-based lighting so the cars stop looking flat/"poopy": a metallic body (metalness ~0.45)
  // has NOTHING to reflect without an environment, so it renders near-black. A cheap procedural
  // studio (RoomEnvironment, baked once via PMREM) gives the paint + glass soft reflections and a
  // clear key/fill falloff that reads as a real sun direction. Tiles are MeshBasic (toneMapped:false,
  // no env) so the photoreal world is untouched; only the PBR actors (cars, characters) pick it up.
  // Intensity is dialled back for this legacy linear (ColorManagement-off) pipeline so it adds gloss
  // without washing out the body colour.
  {
    const pmrem = new THREE.PMREMGenerator(ctx.renderer);
    const room = new RoomEnvironment();
    ctx.scene.environment = pmrem.fromScene(room, 0.04).texture;
    if ('environmentIntensity' in ctx.scene) ctx.scene.environmentIntensity = 0.42;
    room.dispose && room.dispose();   // free the throwaway studio's geometries/materials
    pmrem.dispose();
  }

  ctx.world = buildWorld(ctx.scene, ctx.renderer, { S, C, W, uvAt, terrainAt, SREC, GRID_ANG, aerialUrl });
  ({ onRoad: ctx.onRoad, house: ctx.house, bldBoxes: ctx.bldBoxes, bldPolys: ctx.bldPolys, treePts: ctx.treePts, frontPt: ctx.frontPt, frontDir: ctx.frontDir, COMPOST: ctx.COMPOST, ring: ctx.ring, interiorGroup: ctx.interiorGroup, labelSprites: ctx.labelSprites, waterMat: ctx.waterMat, staticGroup: ctx.staticGroup, aerialMat: ctx.aerialMat } = ctx.world);

  // ---- minimap + address navigation ----
  // World-frame road segments for the minimap (drawn as a 2D map).
  ctx.roadSegs = [];
  for (const r of S.roads) {
    if (r.k !== 'residential' && r.k !== 'tertiary' && r.k !== 'service') continue;
    for (let k = 0; k < r.p.length - 1; k++) ctx.roadSegs.push([W(r.p[k]), W(r.p[k + 1])]);
  }
  // EVERY mapped road (any type) for the off-road auto-correct + reset-to-road: the
  // drivable-only roadSegs above (used by the minimap/traffic/crowd) miss roads the car
  // can still wander off, so nearestRoadPoint/resetToRoad search this wider graph instead.
  ctx.allRoadSegs = [];
  for (const r of S.roads) for (let k = 0; k < r.p.length - 1; k++) ctx.allRoadSegs.push([W(r.p[k]), W(r.p[k + 1])]);
  // geo <-> world (home-anchored ENU near the house, global/invertible for navigation) — see nav/geo.js
  ctx.geo = createGeo();   // ctx.geo.{geoToWorld, worldToGeo}
  ctx.DEST = null;        // { x, z, label }
  ctx.soundOn = (() => { try { return localStorage.getItem('dahill.sound') !== '0'; } catch (e) { return true; } })();   // master sound on by default
  ctx.autoSteer = (() => { try { return localStorage.getItem('dahill.autosteer') !== '0'; } catch (e) { return true; } })();   // road/lane-keep assist, on by default
  ctx.roadLifeOn = (() => { try { return localStorage.getItem('dahill.roadlife') !== '0'; } catch (e) { return true; } })();   // pedestrians + traffic on by default
  ctx.trafficDensity = (() => { try { const v = parseFloat(localStorage.getItem('dahill.trafficdensity')); return Number.isFinite(v) ? clamp(v, 0, 2) : 1; } catch (e) { return 1; } })();   // traffic amount slider (0..2, 1 = default)
  ctx.TRAFFIC_MAX = 18;   // hard pool ceiling (perf); density scales how many are ACTIVE
// d:0→0, d:1→9, d:2→18
  // Soft-wall / gravity-well that keeps the car on the street: past LANE_HALF metres off the
  // nearest road it gets pulled back, ramping in softly and clamped to WALL_MAX m/s so it never
  // overpowers a deliberate drive (and fades as the player steers).
  ctx.HOME_ROAD_RADIUS = 380;   // local procedural road graph coverage around the starting house
  ctx.LANE_HALF = 4.2, ctx.WALL_GAIN = 3.5, ctx.WALL_MAX = 9.0;
  ctx.offRoadT = 0;       // seconds the car has been stranded off the road (drives the auto-recover snap-back)
  ctx.recoverCooldown = 0;   // grace after a reset so the auto-recover can't immediately re-fire (no ping-pong → no "hidden car")
  ctx.ROUTE = null;       // [{x,z}, ...] road-following path from Google Directions
  ctx.routeIdx = 0;       // current target waypoint along ROUTE
  // FAR-FROM-HOME road graph: the procedural roadSegs only cover the ~±330 m hood, so out on the open
  // photoreal tiles the lane-keep assist had nothing to hug. Instead of a fragile 1-D "route ahead",
  // fetch the REAL road NETWORK in boxes around/ahead of the car (Mapbox vector tiles first, Overpass
  // fallback), projected through the same ENU geoToWorld as the tiles. This is a true graph (segments
  // on every side), so nearestRoadPoint / roadTargetAhead / the soft-wall / reset all work far from home.
  ctx.osmRoadSegs = [];          // legacy name: world-space external road segments ([[ax,az],[bx,bz]])
  ctx._osmCenter = null, ctx._osmFetching = false, ctx._osmT = 0;
  // Overpass mirrors, tried in order — the main de host throttles (429/504) under load, so fall
  // through to the public mirrors before giving up. Rotates start point so we don't always hammer #0.
  ctx.OVERPASS_MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  ctx._osmMirror = 0;
  ctx.autoDrive = false;
  ctx._railRoute = null;   // the ROUTE the auto-drive rail's arc-length (car.railS) was acquired for; re-acquire when it changes

  // ---- drive collectibles: gold coins scattered along the neighbourhood roads ----
  ctx.coins = [];
  ctx.coinsGot = 0;
  {
    const coinGeo = new THREE.CylinderGeometry(0.95, 0.95, 0.16, 18); coinGeo.rotateX(Math.PI / 2);
    const coinMat = new THREE.MeshStandardMaterial({ color: 0xffcb2e, metalness: 0.85, roughness: 0.22, emissive: 0x6b4a00, emissiveIntensity: 0.5 });
    const near = ctx.roadSegs.filter(s => Math.hypot(s[0][0], s[0][1]) < 250);
    const step = Math.max(1, Math.floor(near.length / 18));
    for (let i = 0; i < near.length && ctx.coins.length < 18; i += step) {
      const s = near[i], mx = (s[0][0] + s[1][0]) / 2, mz = (s[0][1] + s[1][1]) / 2;
      const m = new THREE.Mesh(coinGeo, coinMat); m.castShadow = true; m.frustumCulled = false; m.visible = false;
      m.position.set(mx, terrainAt(mx, mz) + 1.1, mz);
      ctx.scene.add(m); ctx.coins.push({ mesh: m, x: mx, z: mz, got: false, groundY: null });
    }
  }
  ctx.coinGroundCursor = 0;

  // ---- drive particles: skid decals + tyre smoke + coin sparks (all pooled) ----
  ctx.FX = { skids: [], smoke: [], sparks: [], si: 0, mi: 0, pi: 0 };
  {
    const skidGeo = new THREE.PlaneGeometry(0.42, 1.5); skidGeo.rotateX(-Math.PI / 2);  // lies flat on the ground
    for (let i = 0; i < 110; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x16120f, transparent: true, opacity: 0, depthWrite: false });
      const m = new THREE.Mesh(skidGeo, mat); m.visible = false; m.frustumCulled = false; m.renderOrder = 2;
      ctx.scene.add(m); ctx.FX.skids.push({ mesh: m, born: -1e9 });
    }
    const smokeBase = new THREE.SpriteMaterial({ color: 0xc8c8c8, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    for (let i = 0; i < 34; i++) {
      const s = new THREE.Sprite(smokeBase.clone()); s.visible = false; s.frustumCulled = false;
      ctx.scene.add(s); ctx.FX.smoke.push({ spr: s, born: -1e9, vx: 0, vz: 0 });
    }
    const sparkBase = new THREE.SpriteMaterial({ color: 0xffd34d, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    for (let i = 0; i < 28; i++) {
      const s = new THREE.Sprite(sparkBase.clone()); s.visible = false; s.frustumCulled = false;
      ctx.scene.add(s); ctx.FX.sparks.push({ spr: s, born: -1e9, vx: 0, vy: 0, vz: 0 });
    }
  }
  ctx.lastSkidT = 0;

  // ---- drive run: a coin-rally clock, a quick-chain combo, and a saved best time ----
  ctx.runStart = 0, ctx.runActive = false, ctx.lastRunMs = 0, ctx.comboExpired = true;
  ctx.combo = 0, ctx.comboExpire = 0;
  ctx.BEST_KEY = 'dahill.drive.bestMs';
  ctx.bestMs = parseInt((typeof localStorage !== 'undefined' && localStorage.getItem(ctx.BEST_KEY)) || '0', 10) || 0;
  // combo crescendo: a chain that's BUILDING should look and sound like it (was silent
  // — x7 read the same as x2). Escalates at 3 and 5+.
  ctx.comboPeak = 0;
// tripScore resets per drive so combo/score chips start clean (was carrying over)
  // close-call reward: skim a tree/animal/car at speed without hitting it → ramp the
  // same combo, a whoosh, and a 'Close!' beat. Turns every hazard into a thrill.
  ctx.lastNearT = -1e9, ctx.driftState = false, ctx.driftAccum = 0;

  // ---- neighbourhood landmarks: the 5 real places, doubling as a "visit them all"
  // meta-goal. Driving within 45 m calls it out AND ticks lasting progress, so the
  // marquee fantasy (drive to Meemaw's / your school) finally pays off + persists. ----
  ctx.poiSeen = new Set();   // per-session (suppress repeat toasts)
  ctx.POI_KEY = 'dahill.drive.poisFound';
  ctx.poiFound = new Set((() => { try { return JSON.parse(localStorage.getItem(ctx.POI_KEY) || '[]'); } catch (e) { return []; } })());
  ctx.homeGeo = ctx.geo.worldToGeo(ctx.house.c[0], ctx.house.c[1]);
  ctx.POIS = [{ key: 'home', x: ctx.house.c[0], z: ctx.house.c[1], lat: ctx.homeGeo.lat, lon: ctx.homeGeo.lon, icon: '🏠', label: 'your house', msg: "👋 That's YOUR house — welcome home!" }].concat(
    [['meemaw', 37.6995618, -122.0639216, '🏡', "Meemaw's", "🏡 Meemaw's house!"],
     ['canyon', 37.7046462, -122.0524363, '🏫', 'Canyon Middle', '🏫 Canyon Middle School!'],
     ['stanton', 37.7005734, -122.0940411, '🏫', 'Stanton Elem', '🏫 Stanton Elementary!'],
     ['dad', 37.8004778, -122.2739559, '💼', 'XQ', "💼 XQ — Mike's work!"]
    ].map(([key, lat, lon, icon, label, msg]) => { const w = ctx.geo.geoToWorld(lat, lon); return { key, x: w[0], z: w[1], lat, lon, icon, label, msg }; }));
  ctx.tripScore = 0;
  ctx.boost = 0, ctx.boostWas = false;                // 0..1 nitro meter — fills on skill, spends for a speed surge

  function makeWaypointPad(color, scale = 1, renderOrder = 998) {
    const group = new THREE.Group();
    const mats = [];
    const mat = (opacity, additive = false) => {
      const m = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      mats.push({ mat: m, opacity });
      return m;
    };
    const addFlat = (mesh, y) => {
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = y;
      mesh.renderOrder = renderOrder;
      mesh.frustumCulled = false;
      group.add(mesh);
      return mesh;
    };
    addFlat(new THREE.Mesh(new THREE.CircleGeometry(3.8 * scale, 56), mat(0.16, true)), 0.02);
    addFlat(new THREE.Mesh(new THREE.RingGeometry(4.8 * scale, 5.75 * scale, 72), mat(0.82)), 0.04);
    addFlat(new THREE.Mesh(new THREE.RingGeometry(2.05 * scale, 2.45 * scale, 48), mat(0.58)), 0.06);
    const core = addFlat(new THREE.Mesh(new THREE.CircleGeometry(0.78 * scale, 4), mat(0.9)), 0.08);
    core.rotation.z = Math.PI / 4;
    const tickGeo = new THREE.BoxGeometry(0.46 * scale, 0.05 * scale, 1.9 * scale);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      const tick = new THREE.Mesh(tickGeo, mat(0.8));
      tick.position.set(Math.sin(a) * 6.9 * scale, 0.12, Math.cos(a) * 6.9 * scale);
      tick.rotation.y = a;
      tick.renderOrder = renderOrder;
      tick.frustumCulled = false;
      group.add(tick);
    }
    group.userData.baseScale = 1;
    group.userData.markerOpacity = 0;
    group.userData.setState = (hex, alpha, pulse = 1) => {
      group.userData.markerOpacity = alpha;
      group.scale.setScalar(pulse);
      for (const entry of mats) {
        entry.mat.color.setHex(hex);
        entry.mat.opacity = entry.opacity * alpha;
      }
    };
    group.frustumCulled = false;
    group.visible = false;
    return group;
  }

  // ---- POI waypoints: low target pads over each real place, drawn THROUGH the world
  // so they remain findable without a vertical beam. Pink = still to find, green = found;
  // the nearest un-found one pulses. Only in Drive, faded in by distance. ----
  ctx.poiBeacons = ctx.POIS.map(poi => {
    const m = makeWaypointPad(0xff5ad0, 1, 998);
    m.position.set(poi.x, terrainAt(poi.x, poi.z) + 0.22, poi.z);
    ctx.scene.add(m);
    return { poi, mesh: m };
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
  ctx.poiLabels = ctx.POIS.map(poi => {
    const mat = new THREE.SpriteMaterial({ map: makeLabelTex(poi.icon + '  ' + poi.label.toUpperCase()), transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    const s = new THREE.Sprite(mat); s.position.set(poi.x, 13, poi.z); s.scale.set(26, 5.7, 1); s.frustumCulled = false; s.renderOrder = 999; s.visible = false;
    ctx.scene.add(s);
    return { poi, spr: s, mat };
  });

  // ---- ambient TRAFFIC: simple cars roaming the neighbourhood roads, so there's
  // finally something alive to weave through. They feed the near-miss/combo economy
  // and bounce on contact. Lives only on the ±330 m procedural street network. ----
  ctx.modelLoadCancels = [];
  ctx.traffic = [];
  {
    const tSegs = ctx.roadSegs.filter(s => Math.hypot((s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2) < 700 && Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) > 3);   // wider radius so the bigger pool covers outer streets too
    const cols = [0xb53a32, 0x2f5fb0, 0xd9d9d9, 0x2a2a2a, 0xd6a52e, 0x3f9e63, 0x8a8f96];
    const bodyGeo = new THREE.BoxGeometry(1.9, 1.0, 4.0), cabGeo = new THREE.BoxGeometry(1.6, 0.72, 1.9);
    // shared materials: one cab + 7 body colours, reused across all cars (was 22 clones)
    const bodyMats = cols.map(c => new THREE.MeshStandardMaterial({ color: c, metalness: 0.35, roughness: 0.55 }));
    const cabMat = new THREE.MeshStandardMaterial({ color: 0x1b2735, metalness: 0.2, roughness: 0.35 });
    for (let i = 0; i < ctx.TRAFFIC_MAX && tSegs.length; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, bodyMats[i % bodyMats.length]); body.position.y = 0.6; body.castShadow = true;
      const cab = new THREE.Mesh(cabGeo, cabMat); cab.position.set(0, 1.18, -0.25);
      g.add(body); g.add(cab); g.frustumCulled = false; g.visible = false; ctx.scene.add(g);
      const seg = tSegs[(i * 9 + 3) % tSegs.length];
      ctx.traffic.push({ group: g, box: [body, cab], a: seg[0], b: seg[1], t: (i * 0.21) % 1, speed: 6 + (i % 4) * 2.0, near: false, ti: i });
    }
    ctx.traffic._segs = tSegs;
    // upgrade the placeholder boxes to REAL (cloned) car models once they load — a few
    // normal neighbourhood cars spread across the fleet; clones share geometry (cheap).
    // flip:false → the proto's nose sits at +Z so the group's atan2(dx,dz) points it
    // ALONG travel (flip:true pointed every NPC backwards). KEEP each model's real textured
    // paint — just lift it OUT of the dim photogrammetry so it isn't near-black: drop the
    // metalness (metal with no env map renders black) and add a self-emissive copy of the
    // surface (emissiveMap = the texture) so the car reads bright while keeping ALL its
    // texture detail. (The earlier flat-colour recolour is exactly what looked "lame".)
    [[rav4Url, 4.6], [miniUrl, 3.85], [granviaUrl, 5.1]].forEach((def, mi, defs) => {
      ctx.modelLoadCancels.push(loadCarProto(def[0], def[1], false, proto => {
        for (let i = mi; i < ctx.traffic.length; i += defs.length) {
          const c = ctx.traffic[i];
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
  ctx.trafficTick = 0;

  // the finish-line moment: a big gold burst, a fanfare, a beat of slow-mo + flash, and
  // an 'ARRIVED' card. Fires for reaching a real place (or any nav destination).
  ctx.arriveCenterT = 0;   // while now < this, the drive cams zero their look-ahead so the car frames dead-centre on arrival

  // "Clean patch" under the car (Drive): a flat disc of the REAL aerial imagery
  // that follows the car and fades into the 3D photoreal, masking the melty
  // photogrammetry right around the actor. uvAt is affine, so the aerial UV is
  // computed from world position in-shader — the disc just moves, no UV rebuild.
  ctx.groundPatch = null;
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
      uniforms: { map: { value: ctx.aerialMat.map }, uA: { value: new THREE.Vector4(uS, uO, vS, vO) }, rInv: { value: 1 / R } },
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
    ctx.groundPatch = new THREE.Mesh(geo, mat);
    ctx.groundPatch.renderOrder = 3; ctx.groundPatch.visible = false; ctx.groundPatch.frustumCulled = false;
    ctx.scene.add(ctx.groundPatch);
  }

  // Parked cars live in their own group (NOT staticGroup) so they stay visible
  // over the photoreal world — Drew walks up to one in Scoop to start driving.
  ctx.carsGroup = new THREE.Group(); ctx.scene.add(ctx.carsGroup);
  ctx.parkedSpots = [];

  // Always-visible marker pin above the keeper (Scoop) — drawn on top of the
  // photoreal so Drew is never lost behind a real tree blob.
  ctx.marker = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 4),
    new THREE.MeshBasicMaterial({ color: 0xffc21e, depthTest: false, transparent: true, opacity: 0.95 }));
  ctx.marker.rotation.x = Math.PI; ctx.marker.renderOrder = 20; ctx.marker.visible = false; ctx.marker.frustumCulled = false;
  ctx.scene.add(ctx.marker);
  // draw-to-drive target ring (Top-down view)
  ctx.navMarker = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.7, 28),
    new THREE.MeshBasicMaterial({ color: 0xd94f1e, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  ctx.navMarker.rotation.x = -Math.PI / 2; ctx.navMarker.renderOrder = 19; ctx.navMarker.visible = false; ctx.navMarker.frustumCulled = false;
  ctx.scene.add(ctx.navMarker);
  // Scoop walk-to-drive cue: a tall poppy pin that floats high over the nearest
  // parked car (drawn through walls) so the keeper can find it from the backyard.
  ctx.carMarker = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.7, 4),
    new THREE.MeshBasicMaterial({ color: 0xd94f1e, depthTest: false, transparent: true, opacity: 0.92 }));
  ctx.carMarker.rotation.x = Math.PI; ctx.carMarker.renderOrder = 20; ctx.carMarker.visible = false; ctx.carMarker.frustumCulled = false;
  ctx.scene.add(ctx.carMarker);
  // Compost pin: a green pin over the compost bin shown while the keeper is carrying
  // poop, so the empty-here loop is obvious (drawn through walls from anywhere).
  ctx.compostMarker = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.7, 4),
    new THREE.MeshBasicMaterial({ color: 0x3a7d44, depthTest: false, transparent: true, opacity: 0.92 }));
  ctx.compostMarker.rotation.x = Math.PI; ctx.compostMarker.renderOrder = 20; ctx.compostMarker.visible = false; ctx.compostMarker.frustumCulled = false;
  ctx.scene.add(ctx.compostMarker);
  // ---- House interior (Scoop sub-scene) ----
  // The interior loads lazily and is mounted FAR from the yard (~2 km). Scoop's tight fog
  // (near 38 / far 92) hides the distant yard so the indoor camera only ever frames the room —
  // no per-object yard hide needed. scoopScene forks updateScoop between 'yard' and 'interior'.
  ctx.scoopScene = 'yard', ctx.interior = null, ctx.doorT = 0, ctx.entryArmed = true, ctx.exitArmed = false;
  ctx.npcs = [], ctx.npcsLoadStarted = false;   // non-playable house NPCs (dad, mom) — walk out of rooms + dance, never playable
  ctx.NPC_LOADERS = [loadDadController, loadMomController];
  ctx._syncDance = false, ctx._syncDanceUntil = 0, ctx._syncDanceNext = 0;   // periodic in-house "everybody dance the SAME thing" moment
  ctx.SYNC_DANCES = ['All_Night_Dance'];   // clip Dad + Mom both carry, so a pose() on all of them actually lines up
  ctx.INT_CX = 0, ctx.INT_CZ = 3000, ctx.INT_FLOOR = 0;
  // Blue glowing pads: the front-yard "enter" pad and the indoor "exit" pad (drawn through walls).
  ctx.doorMarker = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.7, 4),
    new THREE.MeshBasicMaterial({ color: 0x49b0ff, depthTest: false, transparent: true, opacity: 0.92 }));
  ctx.doorMarker.rotation.x = Math.PI; ctx.doorMarker.renderOrder = 20; ctx.doorMarker.visible = false; ctx.doorMarker.frustumCulled = false;
  ctx.scene.add(ctx.doorMarker);
  ctx.exitMarker = new THREE.Mesh(ctx.doorMarker.geometry, ctx.doorMarker.material.clone());
  ctx.exitMarker.rotation.x = Math.PI; ctx.exitMarker.renderOrder = 20; ctx.exitMarker.visible = false; ctx.exitMarker.frustumCulled = false;
  ctx.scene.add(ctx.exitMarker);
  // Flat blue "exit pad" ring on the floor (the floating cone sits overhead, easy to miss when you
  // spawn standing on it) — drawn through walls so it's findable from anywhere inside.
  ctx.exitRing = new THREE.Mesh(new THREE.RingGeometry(0.55, 1.05, 32),
    new THREE.MeshBasicMaterial({ color: 0x49b0ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: false }));
  ctx.exitRing.rotation.x = -Math.PI / 2; ctx.exitRing.renderOrder = 19; ctx.exitRing.visible = false; ctx.exitRing.frustumCulled = false;
  ctx.scene.add(ctx.exitRing);
  // Address guide: a ground-draped ribbon that FOLLOWS THE ROUTE through its turns — a
  // real navigation line over the road, not a single rotating bar. The geometry is a
  // triangle-strip rebuilt each frame from the route polyline just ahead of the car,
  // resampled + draped to the ground and drawn on top so road bumps don't hide it.
  ctx.GUIDE_N = 90;                                   // max cross-sections (~5 m apart)
  ctx.guidePos = new Float32Array(ctx.GUIDE_N * 2 * 3);
  ctx.guideGeo = new THREE.BufferGeometry();
  ctx.guideGeo.setAttribute('position', new THREE.BufferAttribute(ctx.guidePos, 3).setUsage(THREE.DynamicDrawUsage));
  { const idx = []; for (let i = 0; i < ctx.GUIDE_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } ctx.guideGeo.setIndex(idx); }
  // depthTest TRUE so the solid CAR (and hills/buildings) occlude the ribbon — the car
  // drives OVER the line, the line never paints on top of the car. depthWrite stays off so
  // it doesn't disturb other transparent sorting.
  ctx.guideLine = new THREE.Mesh(ctx.guideGeo, new THREE.MeshBasicMaterial({ color: 0x28c9ff, transparent: true, opacity: 0.82, depthWrite: false, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide }));
  ctx.guideLine.renderOrder = 6; ctx.guideLine.visible = false; ctx.guideLine.frustumCulled = false;
  ctx.scene.add(ctx.guideLine);
  ctx.destPin = makeWaypointPad(0xffc21e, 0.58, 21);
  ctx.destPin.userData.setState(0xffc21e, 0.95, 1);
  ctx.scene.add(ctx.destPin);
  // "You are here" locator — a bright downward chevron + halo bobbing over the car, drawn
  // on top, so you can FIND the car in the high aerial / top-down views where it's tiny.
  ctx.carLocator = new THREE.Group();
  { const cone = new THREE.Mesh(new THREE.ConeGeometry(1.9, 3.6, 4), new THREE.MeshBasicMaterial({ color: 0x3ad6ff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.92 }));
    cone.rotation.x = Math.PI; cone.renderOrder = 1001;
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.4, 28), new THREE.MeshBasicMaterial({ color: 0x3ad6ff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = -3.2; ring.renderOrder = 1000;
    ctx.carLocator.add(cone); ctx.carLocator.add(ring); }
  ctx.carLocator.frustumCulled = false; ctx.carLocator.visible = false; ctx.scene.add(ctx.carLocator);

  // Scoop renders the procedural world, so Drew collides with every visible
  // procedural tree (they sit along the streets, clear of the backyard sanctuary).
  // sancCx/sancCz mark the backyard centre (behind the house toward the creek).
  ctx.sancCx = -16, ctx.sancCz = -10;
  ctx.SCOOP_CLEAR_R = 25;
  ctx.scoopTrees = ctx.treePts;

  // The scoop backyard: a disc of the REAL procedural ground — true topology
  // (terrainAt heights) + the aerial photo (uvAt on the shared terrain material),
  // not a flat green pad. The photoreal neighborhood streams beyond it.
  ctx.scoopGrass = null;
  {
    const R = ctx.SCOOP_CLEAR_R + 4, rings = 24, segs = 60, pos = [], uv = [], idx = [];
    const addV = (x, z) => { pos.push(x, terrainAt(x, z) + 0.05, z); const t = uvAt(x, z); uv.push(t[0], t[1]); };
    addV(ctx.sancCx, ctx.sancCz);                                   // vertex 0 = centre
    for (let r = 1; r <= rings; r++) {
      const rad = R * r / rings;
      for (let s = 0; s <= segs; s++) { const a = s / segs * Math.PI * 2; addV(ctx.sancCx + Math.cos(a) * rad, ctx.sancCz + Math.sin(a) * rad); }
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
    const yardMat = ctx.aerialMat.clone();
    yardMat.transparent = true; yardMat.depthWrite = false;
    yardMat.onBeforeCompile = sh => {
      sh.uniforms.uYC = { value: new THREE.Vector2(ctx.sancCx, ctx.sancCz) };
      sh.uniforms.uYR = { value: R };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPy;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPy = (modelMatrix * vec4(transformed,1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPy; uniform vec2 uYC; uniform float uYR;')
        .replace('#include <dithering_fragment>',
          // De-wash JUST the yard ground (the bright aerial photo reads blown-out under the
          // game's un-managed linear pipeline). Scoped to the yard mesh — drive/tiles untouched:
          //   1) pull exposure down so the whole ground stops glowing
          //   2) soft knee that compresses ONLY the bright (>0.7) region — tames the blown-white
          //      driveway/concrete patches that a plain gamma curve leaves near-white
          //   3) gamma for midtone contrast, then a saturation lift so grass reads green not grey
          'vec3 yc = clamp(gl_FragColor.rgb, 0.0, 8.0);\n' +
          'yc *= 0.80;\n' +
          'yc = yc / (1.0 + max(yc - 0.70, 0.0) * 1.7);\n' +
          'yc = pow(clamp(yc, 0.0, 1.0), vec3(1.18));\n' +
          'yc = mix(vec3(dot(yc, vec3(0.299, 0.587, 0.114))), yc, 1.18);\n' +
          'gl_FragColor.rgb = yc;\n' +
          'gl_FragColor.a *= 1.0 - smoothstep(uYR * 0.72, uYR * 0.98, distance(vWPy.xz, uYC));\n#include <dithering_fragment>');
    };
    yardMat.customProgramCacheKey = () => 'scoopYard';
    ctx.scoopGrass = new THREE.Mesh(geo, yardMat);
    ctx.scoopGrass.renderOrder = 2; ctx.scoopGrass.visible = false; ctx.scoopGrass.frustumCulled = false;
    ctx.scoopGrass.receiveShadow = true;
    ctx.scene.add(ctx.scoopGrass);
  }

  // Wood fence ring marking the backyard property line (procedural, Scoop only).
  ctx.scoopFence = null;
  {
    const parts = [], woodC = new THREE.Color(0x8a6f49), railC = new THREE.Color(0x9c8259);
    const Rf = ctx.SCOOP_CLEAR_R, Np = 60;
    for (let i = 0; i < Np; i++) {
      const a0 = i / Np * Math.PI * 2, a1 = (i + 1) / Np * Math.PI * 2;
      const x0 = ctx.sancCx + Math.cos(a0) * Rf, z0 = ctx.sancCz + Math.sin(a0) * Rf;
      const x1 = ctx.sancCx + Math.cos(a1) * Rf, z1 = ctx.sancCz + Math.sin(a1) * Rf;
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
    ctx.scoopFence = new THREE.Mesh(merge(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .85 }));
    ctx.scoopFence.castShadow = true; ctx.scoopFence.visible = false; ctx.scoopFence.frustumCulled = false;
    ctx.scene.add(ctx.scoopFence);
  }
  // Building collision for Scoop. The sanctuary structures (barn/shed/coop) and
  // the house are all rendered procedurally in Scoop now, so Drew should bump
  // them. insideScoopBuilding tests the tight footprint polygon (not the oversized
  // AABB), so keeping every building can't wall off the open lawn.
  ctx.scoopBldPolys = ctx.bldPolys;
  function insideScoopBuilding(x, z) {
    for (const b of ctx.scoopBldPolys) {
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
  ctx.p3dtiles = null;
  ctx._tilesUpdT = 0;   // throttle the (expensive, full-tree) tiles LOD traversal to ~18 Hz
  ctx.DEG = Math.PI / 180;
  const LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * ctx.DEG);
  const houseLat = (LAT0 + C[1] / 110540) * ctx.DEG;
  const houseLon = (LON0 + C[0] / (COSLAT * 111320)) * ctx.DEG;
  ctx.tileAnchor = { lat: houseLat, lon: houseLon, x: 0, z: 0, label: 'Home' };
  // Floating render origin: the LOGICAL world point that is drawn at world (0,0).
  // The whole game runs in one home-anchored ENU frame, so a global teleport (e.g.
  // Paris) gives car/camera world coords in the MILLIONS of metres — past float32's
  // usable range, where the tile renderer's bounds/error math collapses and nothing
  // draws. So at a remote anchor we draw that anchor at the origin and shift every
  // rendered position (car, camera, tiles, ground/occlusion raycasts) by this
  // offset. It stays {0,0} near home, so the common case is byte-for-byte unchanged.
  ctx.renderOrigin = { x: 0, z: 0 };
  ctx.remoteView = false;   // true once anchored far from home: hide the home-only props (coins, traffic, beacons, parked cars)
  // live-tunable photoreal placement (window.__dahill.p3dt; call nudge()).
  // yOffset lifts the photoreal ground to the procedural terrain height; xOffset/
  // zOffset + spin (deg) translate/rotate the photoreal world about the house so
  // it matches the procedural frame (spawns + collision). Spin pivots on origin.
  ctx.P3DT = { yOffset: 32, xOffset: 0, zOffset: 0, spin: 0 };
  const applyP3DT = () => {
    if (!ctx.p3dtiles || !ctx.p3dtiles.holder) return;
    const h = ctx.p3dtiles.holder;
    const a = ctx.tileAnchor || { x: 0, z: 0 };
    const ro = ctx.renderOrigin;
    h.rotation.y = ctx.P3DT.spin * ctx.DEG;
    // Draw the anchor at the render origin: near home (ro = 0) this is the anchor's
    // own world coord as before; at a remote anchor (ro = anchor) it lands at ~0.
    h.position.set((a.x || 0) - ro.x + ctx.P3DT.xOffset, ctx.P3DT.yOffset, (a.z || 0) - ro.z + ctx.P3DT.zOffset);
    h.updateMatrixWorld(true);
  };
  function setPhotorealAnchor(lat, lon, x, z, label, force) {
    if (ctx.flags.has('flat') || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(x) || !Number.isFinite(z)) return false;
    const cur = ctx.tileAnchor || { x: 0, z: 0 };
    const d = Math.hypot(x - (cur.x || 0), z - (cur.z || 0));
    if (!force && d < 80000) return false;   // home/Bay Area stays in the original ENU tile frame
    ctx.tileAnchor = { lat: lat * ctx.DEG, lon: lon * ctx.DEG, x, z, label: label || 'Map' };
    const remote = Math.hypot(x, z) > 80000;   // a continent-scale teleport, past where the home ENU frame keeps float32 precision
    ctx.alignDone = remote;                      // remote frames cannot use the home-yard alignment sampler
    // Move the render origin onto the new anchor so it draws near (0,0); near-home
    // anchors keep the origin at home. The home-only props belong only to the home
    // frame, so retire them when teleporting out (per-frame gates keep them off
    // while remote and bring them back on return).
    ctx.renderOrigin = remote ? { x, z } : { x: 0, z: 0 };
    ctx.remoteView = remote;
    if (remote) {
      if (ctx.trafficSys) ctx.trafficSys.hideTraffic();
      if (ctx.crowd) ctx.crowd.hideCrowd();
      if (ctx.poi && ctx.poi.hideBeacons) ctx.poi.hideBeacons();
      for (const c of ctx.coins) c.mesh.visible = false;
      // Drop the held ground height + camera vertical refs so the probe re-finds the
      // new location's elevation from scratch (Paris ground sits hundreds of metres
      // off the home height) and the chase cam re-seats on it instead of underground.
      ctx.car.groundY = null;
      ctx.camGroundRef = null; ctx.camFloorRef = null; ctx.camInit = false;
    }
    ctx.tilesReady = false; ctx.emit('photoreal', false);
    ctx._tileWarmUntil = performance.now() + 14000;
    ctx._tileWarmOn = false;
    if (ctx.tileClip) ctx.tileClip.clearTileClip();
    if (ctx.p3dtiles) {
      // The Google root tileset is global, but after a continent-scale teleport
      // the renderer's traversal/cache state can stay biased toward the old area.
      // Rebuild on these rare jumps so Paris/Tokyo/etc. start from a clean root.
      if (ctx.fn.rebuildPhotorealTiles && ctx.fn.rebuildPhotorealTiles()) {
        ctx.fn.applyModeVisuals();
        return true;
      } else {
        if (ctx.p3dtiles.setGeoAnchor) ctx.p3dtiles.setGeoAnchor(ctx.tileAnchor.lat, ctx.tileAnchor.lon);
        if (ctx.p3dtiles.flushTileCache) ctx.p3dtiles.flushTileCache();
        ctx.fn.applyP3DT();
        ctx.p3dtiles.setResolutionFromRenderer(ctx.camera, ctx.renderer);
        ctx._tilesUpdT = 0;
      }
    }
    ctx.fn.applyModeVisuals();
    return true;
  }
  // ---- ground height authority ---- (see occlusion/ground-height.js)
  // ctx.ground.{rawTileY,groundAt,actorGroundY}: photoreal-tile surface height under (x,z) for
  // ACTOR + CAMERA height only; collision stays on the data (bldPolys/treePts).
  ctx.ground = createGround(ctx);
  // One-shot vertical align: sample a ring of down-rays in the open yard/street
  // (radius 14 m, away from the house roof), take the median tile height, and
  // set yOffset so it meets terrainAt(0,0). Clamped + single-shot so it can't
  // run away accumulating.
  ctx.alignDone = false;
  function alignP3DT() {
    if (ctx.alignDone || !ctx.p3dtiles || !ctx.p3dtiles.holder) return false;
    const ys = [];
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      const y = ctx.ground.rawTileY(Math.cos(a) * 14, Math.sin(a) * 14);
      if (y != null) ys.push(y);
    }
    if (ys.length < 8) return false;          // wait until enough clean samples
    ys.sort((a, b) => a - b);
    const adjust = terrainAt(0, 0) - ys[ys.length >> 1];
    if (Math.abs(adjust) > 18) return false;  // garbage (rays hit roofs/voids/coarse tiles) — retry
    ctx.P3DT.yOffset = clamp(ctx.P3DT.yOffset + adjust, 8, 56);
    ctx.fn.applyP3DT();
    ctx.alignDone = true;
    return true;
  }
  // ---- tile prefetch ----------------------------------------------------------
  // A small, low-res "scout" camera swept ALONG the active route ahead of the car so the
  // Google tiles for where you're GOING stream into the cache before you arrive (and the
  // ground-height probe ahead has data). Only on while a destination is set — exactly when
  // you're driving somewhere far — so free-roam near home pays nothing. Low resolution means
  // it warms only cheap COARSE tiles, filling the LRU cache without blowing the mobile budget.
  ctx.scoutOn = false; ctx._scoutT = 0; ctx._scoutPhase = 0;
  ctx.prefetch = createPrefetch(ctx);   // ctx.prefetch.{setScout, updateTilePrefetch, pointAlongRoute} — see occlusion/prefetch.js
  ctx.tileWarmCam = new THREE.PerspectiveCamera(58, 1, 1, 5000);
  ctx._tileWarmUntil = 0;
  ctx._tileWarmOn = false;
  function updateTileWarmCamera(now) {
    if (!ctx.tileWarmCam || !ctx.p3dtiles) return;
    const a = ctx.tileAnchor || { x: ctx.car.x, z: ctx.car.z };
    const remote = Math.hypot(a.x || 0, a.z || 0) > 80000;
    const on = ctx.fn.photoModes(ctx.mode) && (remote || now < ctx._tileWarmUntil);
    if (!on) {
      if (ctx._tileWarmOn && ctx.p3dtiles.deleteCamera) ctx.p3dtiles.deleteCamera(ctx.tileWarmCam);
      ctx._tileWarmOn = false;
      return;
    }
    if (!ctx._tileWarmOn) {
      ctx.p3dtiles.setCamera(ctx.tileWarmCam);
      ctx.p3dtiles.setResolution(ctx.tileWarmCam, 520, 520);
      ctx._tileWarmOn = true;
    }
    if (remote) {
      if (ctx.tileWarmCam.fov !== 72 || ctx.tileWarmCam.far !== 80000 || Math.abs(ctx.tileWarmCam.aspect - ctx.camera.aspect) > 0.001) {
        ctx.tileWarmCam.fov = 72;
        ctx.tileWarmCam.far = 80000;
        ctx.tileWarmCam.aspect = ctx.camera.aspect;
        ctx.tileWarmCam.updateProjectionMatrix();
      }
      ctx.tileWarmCam.up.copy(ctx.camera.up);
      ctx.tileWarmCam.position.copy(ctx.camera.position);
      ctx.tileWarmCam.quaternion.copy(ctx.camera.quaternion);
    } else {
      const y = (ctx.car.groundY != null ? ctx.car.groundY : ctx.P3DT.yOffset) + 420;
      const x = a.x || ctx.car.x;
      const z = a.z || ctx.car.z;
      if (ctx.tileWarmCam.fov !== 58 || ctx.tileWarmCam.far !== 5000) {
        ctx.tileWarmCam.fov = 58;
        ctx.tileWarmCam.far = 5000;
        ctx.tileWarmCam.updateProjectionMatrix();
      }
      ctx.tileWarmCam.up.set(0, 0, -1);
      ctx.tileWarmCam.position.set(x, y, z);
      ctx.tileWarmCam.lookAt(x, ctx.P3DT.yOffset, z);
    }
    ctx.tileWarmCam.updateMatrixWorld(true);
  }
  // Photoreal is the AERIAL view ONLY: render tiles in Explore; show the clean
  // built (procedural) world at ground level (Drive/Scoop). The groundAt + camera
  // tile probes gate on holder.visible, so ground actors ride smooth terrainAt
  // and never climb the bumpy photogrammetry mesh.
  ctx.tilesReady = false;
  // Photoreal Google tiles are the AERIAL + Drive backdrop only. Scoop plays in
  // the clean procedural world (the real house, the pig barn / iguana shed / duck
  // coop, the compost bin, trees, and the aerial-photo terrain) — Google
  // photogrammetry is unusably melty at a keeper's eye level, so we don't render
  // it in Scoop. This also means no tile-flattening hacks (which used to pancake
  // the house) and pristine tiles in Explore/Drive.
  const photoModes = mode => mode === 'explore' || mode === 'drive';
  function applyModeVisuals() {
    const photoOn = ctx.fn.photoModes(ctx.mode) && ctx.p3dtiles && ctx.tilesReady;
    if (ctx.p3dtiles) ctx.p3dtiles.holder.visible = ctx.fn.photoModes(ctx.mode);
    if (ctx.mode !== 'drive' && ctx.tileClip) ctx.tileClip.clearTileClip();   // Drive-only visibility window; never leak into Explore/Scoop
    // The procedural neighbourhood + parked cars belong to the home frame; at a
    // remote anchor they'd float around the origin in front of the teleported view.
    ctx.staticGroup.visible = (ctx.mode === 'scoop' || !photoOn) && !ctx.remoteView;   // procedural in Scoop, or as the no-tiles fallback
    ctx.carsGroup.visible = (ctx.mode === 'drive' || ctx.mode === 'scoop') && !ctx.remoteView;   // parked cars: ground modes only
    if (ctx.ring) ctx.ring.visible = ctx.mode === 'explore';   // marker only makes sense from the air
    // SHADOWS only in Scoop: in Drive/Explore the procedural receivers are hidden and the
    // Google tiles are MeshBasicMaterial (can't receive), so a full extra depth pass each
    // frame would render onto nothing. Gate the whole shadow pass off there.
    ctx.sun.castShadow = (ctx.mode === 'scoop') && !ctx.LITE;
    ctx.vehicleFill.visible = ctx.mode === 'drive';
    ctx.renderer.shadowMap.enabled = ctx.sun.castShadow;
    if (ctx.sun.castShadow) ctx.renderer.shadowMap.needsUpdate = true;
  }
  function delayedTileFallbackToast(msg) {
    setTimeout(() => { if (!ctx.disposed && ctx.fn.photoModes(ctx.mode) && !ctx.tilesReady) ctx.toast(msg, 2600); }, 6100);
  }
  ctx._photorealFactory = null;
  ctx._photorealGen = 0;
  function photorealOpts() {
    return {
      // errorTarget = screen-space pixel error the LOD traversal aims for; LOWER =
      // crisper (and a zoom/view change now actually pulls a higher LOD, since the
      // bar is tight enough to be unmet by coarse tiles). Google photoreal reads
      // sharp around 5–6 px. Phones stay coarser — leaf-tile geometry/texture is
      // the dominant iOS memory cost. lruMaxMB grows the resident budget on
      // desktop so the extra high-LOD tiles actually stay put instead of thrashing.
      lat: ctx.tileAnchor.lat, lon: ctx.tileAnchor.lon, azimuth: Math.PI,
      errorTarget: ctx.MOBILE ? 12 : 6, mobile: ctx.MOBILE,
      lruMinMB: ctx.MOBILE ? 120 : 280, lruMaxMB: ctx.MOBILE ? 200 : 460
    };
  }
  function mountPhotorealTiles(createPhotorealTiles) {
    if (ctx.disposed || ctx.flags.has('flat') || !createPhotorealTiles) return false;
    const gen = ++ctx._photorealGen;
    const tiles = createPhotorealTiles(ctx.scene, ctx.camera, ctx.renderer, photorealOpts());
    if (!tiles) { if (import.meta.env.VITE_GOOGLE_MAPS_KEY) delayedTileFallbackToast('Photoreal map unavailable — showing the built world'); return false; }
    if (ctx.disposed) { if (tiles.disposeAll) tiles.disposeAll(); return false; }
    ctx.p3dtiles = tiles;
    ctx.fn.applyP3DT();
    let tries = 0;
    tiles.addEventListener('load-model', () => {
      if (gen !== ctx._photorealGen || ctx.p3dtiles !== tiles) return;
      if (!ctx.tilesReady) { ctx.tilesReady = true; ctx.emit('photoreal', true); if (ctx.startCrowdLoad) ctx.startCrowdLoad(); }   // first tiles are up → the scene is visible, so NOW pull in the crowd rigs (deferred from boot)
      // Vertically align the photoreal ground to the procedural terrain as the
      // street tiles stream (Explore/Drive only — Scoop never shows tiles).
      if (tries < 24) { tries++; ctx.fn.alignP3DT(); }
      ctx.fn.applyModeVisuals();          // hide procedural once tiles are up (Explore/Drive)
    });
    // surface auth/quota/referrer failures instead of silently falling back to
    // the procedural world (a baked, referrer-blocked or over-quota key 403s here).
    let warnedErr = false;
    tiles.addEventListener('load-error', e => {
      if (gen !== ctx._photorealGen || ctx.p3dtiles !== tiles || warnedErr) return; warnedErr = true;
      console.warn('[tiles3d] tile load error (check VITE_GOOGLE_MAPS_KEY restrictions/quota)', e && e.error);
      if (!ctx.tilesReady) ctx.toast('Photoreal map unavailable — showing the built world', 2600);
    });
    ctx.fn.applyModeVisuals();
    return true;
  }
  function rebuildPhotorealTiles() {
    if (!ctx._photorealFactory || ctx.flags.has('flat')) return false;
    const old = ctx.p3dtiles;
    ctx.p3dtiles = null;
    ctx._tilesUpdT = 0;
    if (old && old.disposeAll) old.disposeAll();
    return mountPhotorealTiles(ctx._photorealFactory);
  }
  if (!ctx.flags.has('flat')) {
    if (!import.meta.env.VITE_GOOGLE_MAPS_KEY) delayedTileFallbackToast('Photoreal map key missing — showing the built world');
    import('./tiles3d.js').then(({ createPhotorealTiles }) => {
      if (ctx.disposed) return;
      ctx._photorealFactory = createPhotorealTiles;
      mountPhotorealTiles(createPhotorealTiles);
    }).catch(e => { console.warn('[tiles3d] import failed; staying procedural', e); delayedTileFallbackToast('Photoreal map unavailable — showing the built world'); });
  }

  // ?debug: tall coloured poles at the procedural reference points (in the scene,
  // not staticGroup, so they show over photoreal) to eyeball alignment.
  if (ctx.flags.has('debug')) {
    const pole = (x, z, color) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 80, 8),
        new THREE.MeshBasicMaterial({ color }));
      m.position.set(x, 40, z); ctx.scene.add(m);
    };
    pole(ctx.house.c[0], ctx.house.c[1], 0xff0000);                       // house = red
    if (ctx.frontPt) pole(ctx.frontPt[0], ctx.frontPt[1], 0x00ff00);          // car spawn = green
    pole(SREC.pen[0], SREC.pen[1], 0xff00ff);                     // pigs/pen = magenta
    pole(SREC.coop[0], SREC.coop[1], 0x00ffff);                   // ducks/coop = cyan
    pole(SREC.shed[0], SREC.shed[1], 0xff8800);                   // iguana/shed = orange
  }

  // Car-vs-building test: a point is solid only when it's inside an actual
  // footprint polygon (AABB prefilter keeps it cheap). This is what lets the
  // car drive off-road, across intersections and between houses freely.
  function insideBuilding(x, z) {
    for (const b of ctx.bldPolys) {
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

  ctx.audio = createAudio();

  ctx.scoopHudDirty = false;
  ctx.animals = createAnimals(ctx.scene, { terrainAt, SREC, bldBoxes: ctx.bldBoxes, onPoopChange: () => { ctx.scoopHudDirty = true; } });
  ({ ANIMALS: ctx.ANIMALS, POOPS: ctx.POOPS, updateAnimals: ctx.updateAnimals, removePoop: ctx.removePoop } = ctx.animals);
  ctx.CHAR = createCharacter(ctx.scene, SREC);

  // ---- CROWD: dancing CeCe + Drew characters. Yard dancers liven up Scoop; street
  // dancers + clusters at every preset destination liven up Drive. Visibility is mode- and
  // distance-gated so only a handful animate at once (skinned meshes aren't cheap).
  ctx.ceceCrowd = null, ctx.drewCrowd = null, ctx.dadCrowd = null, ctx.momCrowd = null;
  ctx.crowdSpots = [];   // { rec, zone }
  // Pedestrian density (settings slider): scales the spread-out pool size. 1 = default.
  ctx.CROWD_DENSITY = (() => { try { const v = parseFloat(localStorage.getItem('dahill.peddensity')); return Number.isFinite(v) ? clamp(v, 0, 2) : 1; } catch (e) { return 1; } })();
  ctx.CROWD_VIS_CAP = 20;       // max pedestrians visible/animating at once (skinned meshes are costly) — bounds per-frame cost no matter the pool size
  ctx.SIDEWALK_OFF = 3.0;       // metres from the road centre out to the sidewalk
  ctx.CROWD_POOL_CAP = 120;     // SINGLE hard cap on total persistent clones at density 1 (×D): sidewalk+scatter take POOL = cap − RESERVED, the POI/cluster/meemaw dancers take RESERVED. Visibility cap animates only the nearest 20. Bounds total boot-time SkeletonUtils.clone cost.
  ctx._crowdReplaceT = 0, ctx._crowdVisT = 0;   // debounce the slider re-pool; throttle the nearest-N visibility scan
  ctx._crowdN = 0, ctx._crowdPlaced = false, ctx._placedNoAdults = false;
  if (!ctx.flags.has('nochar')) {
    // DEPRIORITISE the crowd rigs (~21 MB: cece+drew+dad+mom) behind the photoreal tiles. On a slow
    // network these pedestrian GLBs would otherwise contend with the Google 3D tiles that ARE the
    // visible scene, so first paint drags. Start them once the first tiles land (scene is up) — or
    // after a fallback delay covering the no-key / procedural-fallback path where tiles never arrive.
    // Idempotent; placement still self-heals via _onCrowd re-pool if a rig lands after _doPlace.
    ctx.startCrowdLoad = () => {
      if (ctx._crowdLoadStarted || ctx.disposed) return;
      ctx._crowdLoadStarted = true;
      loadCeceCrowd(c => { if (!ctx.disposed) ctx.ceceCrowd = c; ctx.crowd._onCrowd(); }, () => ctx.crowd._onCrowd());
      loadDrewCrowd(c => { if (!ctx.disposed) ctx.drewCrowd = c; ctx.crowd._onCrowd(); }, () => ctx.crowd._onCrowd());
      loadDadCrowd(c => { if (!ctx.disposed) ctx.dadCrowd = c; ctx.crowd._onCrowd(); }, () => ctx.crowd._onCrowd());
      loadMomCrowd(c => { if (!ctx.disposed) ctx.momCrowd = c; ctx.crowd._onCrowd(); }, () => ctx.crowd._onCrowd());
      setTimeout(() => { if (!ctx.disposed) ctx.crowd._doPlace(); }, 9000);   // …but don't let a slow Dad/Mom rig hold the whole crowd hostage
    };
    setTimeout(() => ctx.startCrowdLoad(), 6000);   // fallback: start anyway if tiles never signal ready (no key / procedural world)
  } else ctx.nav.geocodePOIs();
  ctx._crowdHitT = 0;

  ctx.disposed = false;
  ctx.car = createCar(ctx.scene);
  ctx.car.group.scale.setScalar(1.1);   // the player car renders ~10% bigger
  ctx.cancelCarLoad = null;
  // LAZY vehicle roster: each slot's GLB is only fetched when that car is actually driven (the
  // random start car at boot, or a garage pick). Unpicked cars never download — so a big garage
  // doesn't weigh down a session. Slot 2 (Ferrari) is the Draco loadRealCar path; the rest are
  // loadDrivableCar. All these GLBs run nose -Z, so flip:true points them forward.
  ctx.CAR_DEFS = {
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
  ctx.vehLoading = new Set();
  ctx.ferrariLoadStarted = false;
  if (!ctx.flags.has('nocar')) {
    installDracoDecoder();
    // START ON A RANDOM CAR: pick a random non-Ferrari roster slot as this session's default,
    // load ONLY that one (others stay lazy), and hold the reveal until it arrives.
    const startable = Object.keys(ctx.CAR_DEFS).map(Number);
    ctx.car.defaultSlot = startable[(Math.random() * startable.length) | 0];
    ctx.car.heldForDefault = true;
    // fallback: if the random default is slow/fails, after ~2.8 s show whatever HAS loaded
    setTimeout(() => { if (!ctx.disposed && ctx.car.heldForDefault) { ctx.car.heldForDefault = false; const f = ctx.car.models.findIndex(Boolean); if (f >= 0) setVehicle(ctx.car, f); else ctx.cars.ensureVehicle(0); } }, 2800);
    ctx.cars.ensureVehicle(ctx.car.defaultSlot);
  }
  // Two black Toyotas parked in the driveway (part of the clean ground world;
  // staticGroup, so they show at ground level, not over the photoreal aerial).
  if (ctx.frontPt && !ctx.flags.has('nocar')) {
    const ux = ctx.house.c[0] - ctx.frontPt[0], uz = ctx.house.c[1] - ctx.frontPt[1];
    const ul = Math.hypot(ux, uz) || 1, u = [ux / ul, uz / ul], perp = [-u[1], u[0]];
    const carYaw = Math.atan2(-u[0], -u[1]);            // nose toward the street
    const park = (url, side, len, flip, black = true) => {
      const cx = ctx.frontPt[0] + u[0] * 7 + perp[0] * side * 2.4;
      const cz = ctx.frontPt[1] + u[1] * 7 + perp[1] * side * 2.4;
      ctx.parkedSpots.push({ x: cx, z: cz });          // walk-to-drive targets
      // add the footprint collider only once the car actually loads, so a failed
      // load doesn't leave an invisible wall the driven car bounces off.
      ctx.modelLoadCancels.push(loadParkedCar(ctx.carsGroup, url, { x: cx, z: cz, y: terrainAt(cx, cz), yaw: carYaw, length: len, black, flip }, () => {
        const hl = len / 2, hw = 1.05, yaw = carYaw + (flip ? Math.PI : 0);
        const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const p = [
          [cx + fx * hl + rx * hw, cz + fz * hl + rz * hw],
          [cx + fx * hl - rx * hw, cz + fz * hl - rz * hw],
          [cx - fx * hl - rx * hw, cz - fz * hl - rz * hw],
          [cx - fx * hl + rx * hw, cz - fz * hl + rz * hw],
        ];
        const xs = p.map(q => q[0]), zs = p.map(q => q[1]);
        ctx.bldPolys.push({ p, bb: [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)] });
      }));
    };
    park(rav4Url, 1, 4.6, false, false);  // RAV4 nose runs +Z → carYaw already faces it; black baked in (keeps taillights)
    park(siennaUrl, -1, 5.1, false, false);   // GLB nose runs -Z; black baked in (keeps taillights)
  }
  ctx.showT = 0;

  // The Ferrari (slot 2) is the reward for finding all 5 neighbourhood places.
  ctx.ferrariUnlocked = (() => { try { return localStorage.getItem('dahill.drive.ferrari') === '1'; } catch (e) { return false; } })();

  // (Street-view photo billboards removed — they read as odd roadside signs.
  //  Real street imagery now lives on the buildings: photoreal Google 3D Tiles
  //  when enabled, the procedural facade texture otherwise.)

  // "Look inside" (dollhouse) removed — keep the procedural interior hidden.
  ctx.interiorGroup.visible = false;   // legacy procedural dollhouse stays hidden; the GLB interior replaces it

  // Inward normal from the curb toward the house (frontDir is the ROAD TANGENT — never inward),
  // and a back-door pad on the yard/patio side (near where Scoop is played).
  // Put the "go inside" pad on the house side FACING the Scoop play area (the sanctuary spawn), so
  // the player walks straight into it. entryU points from the house centre toward that spawn.
  ctx._spawnPt = [(SREC.coop[0] + SREC.pen[0]) / 2, (SREC.coop[1] + SREC.pen[1]) / 2];
  ctx._toSpawn = [ctx._spawnPt[0] - ctx.house.c[0], ctx._spawnPt[1] - ctx.house.c[1]];
  ctx._uL = Math.hypot(ctx._toSpawn[0], ctx._toSpawn[1]) || 1;
  ctx.entryU = [ctx._toSpawn[0] / ctx._uL, ctx._toSpawn[1] / ctx._uL];
  ctx._halfExt = 0.5 * (Math.abs(ctx.entryU[0]) * (ctx.house.bbox[1] - ctx.house.bbox[0]) + Math.abs(ctx.entryU[1]) * (ctx.house.bbox[3] - ctx.house.bbox[2]));
  ctx.entryPt = [ctx.house.c[0] + ctx.entryU[0] * (ctx._halfExt + 1.6), ctx.house.c[1] + ctx.entryU[1] * (ctx._halfExt + 1.6)];

  // LAZY interior: the house scan + its swapped-in furniture (couchy.usdz 13.8 MB, the three critter
  // cages, …) total ~34 MB and are ONLY ever seen INSIDE the house in Scoop. Boot starts in explore→drive,
  // so fetching all of it up front just starves the network for the Google 3D tiles that Drive actually
  // shows (terrible on slow links). Defer the whole load until the player first enters Scoop; loaded once,
  // fail-soft. (The `nointerior` flag still skips it entirely.)
  ctx.ensureInterior = () => {
    if (ctx.interior || ctx._interiorLoading || ctx.flags.has('nointerior')) return;
    ctx._interiorLoading = true;
    ctx.modelLoadCancels.push(createInterior(ctx.scene, { cx: ctx.INT_CX, cz: ctx.INT_CZ, floorY: ctx.INT_FLOOR },
      mod => { ctx.interior = mod; ctx.interior.group.visible = ctx.scoopScene === 'interior'; ctx.crowd.placeInteriorDancers(); ctx.emit('house', { inside: ctx.scoopScene === 'interior', ready: true }); },
      () => { ctx._interiorLoading = false; /* fail-soft: the door pad just stays inert */ }));
  };

  // ---- House NPCs: a small behaviour FSM (dad, mom) ------------------------------------------
  // They WANDER room to room — collision-checked (interior.collide, so no walking through walls /
  // furniture) and door-routed — with a bias to share the player's room. On arrival they pick an
  // activity: cycle dances, sprinkle one-shot emote beats, idle, or (if they have a sit clip) SIT
  // down on a couch. State per NPC: 'travel' | 'act'.
  ctx.NPC_RAD = 0.34, ctx.NPC_SPD = 1.35;

  // ---------- controls (explore) ----------
  ctx.ctl = {
    tx: ctx.house.c[0], ty: ctx.house.baseY + 5, tz: ctx.house.c[1], az: 0.85, po: 0.72, r: 330,
    gtx: ctx.house.c[0], gty: ctx.house.baseY + 5, gtz: ctx.house.c[1], gaz: 0.45, gpo: 0.92, gr: 185
  };
  if (ctx.reduceMotion) { ctx.ctl.az = 0.45; ctx.ctl.po = 0.92; ctx.ctl.r = 185; }

  ctx.mode = 'explore';
  const setMode = m => {
    ctx.mode = m;
    // Scoop plays at ground level where the photoreal horizon turns to melt; pull
    // the fog in close (haze color = background) so the distant photogrammetry
    // dissolves softly instead of reading as a melty wall — the play area within
    // ~35 m stays crisp. Other modes keep the far aerial fog.
    if (ctx.scene.fog) {
      if (m === 'scoop') { ctx.scene.fog.near = 38; ctx.scene.fog.far = 92; }
      else { ctx.scene.fog.near = 460; ctx.scene.fog.far = 1200; }
    }
    ctx.emit('mode', m); ctx.fn.applyModeVisuals();
  };
  ctx.ptrs = new Map(); ctx.lastPinch = 0, ctx.lastMid = null, ctx.moved = 0;
  ctx.lookPtrs = new Map();
  ctx.camOrbit = { yaw: 0, pitch: 0, t: 0 };
  ctx._orbitUserSet = false;   // has the user dragged to set the orbit angle? (until then, autodrive/follow runs cinematic "race day" camera sweeps)
  ctx._viewYaw = 0;            // smoothed heading the MAP views (overhead/aerial) + minimap orient to — car-heading normally, compass in follow. Eased so turns don't shimmer.
  ctx._cineAmt = 0;            // 0..1 amount of the cinematic "race day" sweep currently applied (eased out once the user takes the camera)
  ctx.movePtr = null, ctx.joyBX = 0, ctx.joyBY = 0, ctx.pinchD = 0, ctx.czoom = 1, ctx.szoom = 1;
  // Roblox-style controls: shared look/zoom feel across drive+scoop, a steering
  // stick + gas/brake pedals for touch driving, shift-lock for the keeper, and
  // flick momentum in explore. inp2 mixes stick (j*), keyboard (k*) and the
  // dedicated touch driving inputs (steer/gas/brake).
  ctx.LOOK_YAW_PER_SCREEN = 2.8, ctx.LOOK_PITCH_PER_SCREEN = 2.4, ctx.ZOOM_RATE = 0.0011, ctx.MOVE_DEADZONE = 0.10;   // screen-normalized free-look
  ctx.JOY_R = 66, ctx.JOY_MAX = 52;
  ctx.inp2 = { jx: 0, jy: 0, kx: 0, ky: 0, steer: 0, gas: 0, brake: 0, navActive: false, navX: 0, navZ: 0, hbrake: false, boost: false };
  // Unified input: ONE InputManager owns ONE InputState; pumpInput() bridges it into ctx.inp2 + the
  // tuned cameras each frame (see pumpInput). Drive keeps its own tuned cam/handlers (untouched for now);
  // scoop's input source is swapped here. traceMode = the opt-in "draw to drive" alternate (default off).
  ctx.im = new InputManager(ctx.canvas, { keyboard: false, wheel: true });   // keyboard stays on the legacy handler (tank-turn/Shift-lock/E/Space) for ALL modes; InputManager owns TOUCH + wheel
  ctx._orient = ctx.im.state.orientation;
  ctx.traceMode = false;
  ctx.imScoop = true;   // gate: when true, scoop uses InputManager (legacy scoop pointer handlers stand down)
  ctx.imDrive = true;   // gate: when true (and NOT traceMode), drive uses InputManager; traceMode falls back to the legacy draw-to-drive handlers
  ctx.camYawS = 0, ctx.scPitch = 0.34, ctx.bagWarned = false, ctx.spotless = false, ctx.nearCar = false;
  ctx.scoopMoveYaw = 0, ctx.scoopMoveActive = false;
  // Experimental "draw to drive": in the Top-down view, a drag projects the finger
  // onto the ground and the car steers toward it + auto-throttles, so you trace its
  // path with one finger. (Joystick/keyboard still drive the other camera views.)
  ctx.navPtr = null, ctx.navDownX = 0, ctx.navDownY = 0, ctx.navMoved = false, ctx.navCurX = 0, ctx.navCurY = 0;   // tap (route along roads) vs drag (freeform draw-to-drive); navCur tracks the live finger for overhead pinch
  ctx._navRay = new THREE.Raycaster(), ctx._navNDC = new THREE.Vector2();
  ctx._navPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), ctx._navHit = new THREE.Vector3();
  ctx.lastLookT = -1e9;   // last manual look-drag time (ms); suppresses scoop follow-cam briefly
  ctx.shiftLock = false, ctx.azVel = 0, ctx.poVel = 0;













  function enterScoop() {
    ctx.ensureInterior();   // kick off the ~34 MB house-interior load now (deferred from boot) so it's ready by the time the player walks to the door
    ctx.fn.setMode('scoop'); ctx.camInit = false; ctx.szoom = 1; ctx.camGroundRef = null; ctx.CHAR.groundY = null;   // fresh framing per scoop entry (pinch-zoom shouldn't leak in)
    ctx.houseSys.setInside(false);
    for (const s of ctx.labelSprites) s.visible = false;
    ctx.CHAR.group.visible = true;
    // Spawn out in the OPEN sanctuary (between the coop and the pen), away from
    // the house, patio and driveway cars so the camera opens onto the play area
    // and animals, not flat house walls.
    ctx.CHAR.x = (SREC.coop[0] + SREC.pen[0]) / 2; ctx.CHAR.z = (SREC.coop[1] + SREC.pen[1]) / 2;
    ctx.CHAR.yaw = Math.atan2(SREC.barn[0] - ctx.CHAR.x, SREC.barn[1] - ctx.CHAR.z);
    ctx.camYawS = ctx.CHAR.yaw; ctx.scoopMoveYaw = ctx.camYawS; ctx.scoopMoveActive = false;
    ctx.scoopScene = 'yard'; ctx.entryArmed = true; ctx.exitArmed = false; ctx.doorMarker.visible = false; ctx.exitMarker.visible = false; ctx.exitRing.visible = false;
    ctx.emit('avatar', { name: ctx.CHAR.avatar, actions: ctx.CHAR.getActions() });
    ctx.audio.ensure();
    ctx.scoop.setTool(ctx.CHAR.lvl);
    ctx.toast('Scoop the sanctuary poop! 💩<br><small>Empty at the green compost bin · the 🚪 pad takes you inside the house</small>', 3200);
  }
  function exitScoop() {
    ctx.fn.setMode('explore');
    ctx.camera.up.set(0, 1, 0);                 // symmetry with exitDrive; never leak a tilted up-vector
    ctx.houseSys.setInside(false);                       // back to the yard scene (hide the interior if we left from inside)
    if (ctx.groundPatch) ctx.groundPatch.visible = false;
    if (ctx.scoopGrass) ctx.scoopGrass.visible = false;
    if (ctx.scoopFence) ctx.scoopFence.visible = false;
    ctx.marker.visible = false; ctx.carMarker.visible = false; ctx.compostMarker.visible = false; ctx.doorMarker.visible = false; ctx.exitMarker.visible = false; ctx.exitRing.visible = false;
    if (ctx.nearCar) { ctx.nearCar = false; ctx.emit('nearCar', false); }
    ctx.controls.hideJoy();
    for (const s of ctx.labelSprites) s.visible = true;
    ctx.CHAR.group.visible = false;
    ctx.inp2.jx = ctx.inp2.jy = ctx.inp2.kx = ctx.inp2.ky = 0; ctx.scoopMoveActive = false;
    ctx.ctl.gtx = clamp(ctx.CHAR.x, -310, 310); ctx.ctl.gtz = clamp(ctx.CHAR.z, -310, 310);
    ctx.ctl.gty = terrainAt(ctx.ctl.gtx, ctx.ctl.gtz) + 3; ctx.ctl.gr = 60; ctx.ctl.gpo = 0.85;
    ctx.ctl.tx = ctx.ctl.gtx; ctx.ctl.tz = ctx.ctl.gtz;
  }

  // Indoor follow cam + the exit pad (movement/grounding/collision already ran in updateScoop).
  ctx._wallRay = new THREE.Raycaster(); ctx._wallDir = new THREE.Vector3();
  ctx._wallCutT = 0;
  // hop from walking straight into driving (the car spawns at the driveway)
  function driveFromScoop() {
    if (ctx.mode !== 'scoop' || !ctx.nearCar) return;
    ctx.nearCar = false; ctx.emit('nearCar', false);
    ctx.audio.blip();
    ctx.fn.enterDrive();
  }

  // ---------- drive mode ----------
  function enterDrive() {
    ctx.fn.setMode('drive'); ctx.camInit = false;
    // A fresh drive spawns at the home driveway, so restore the home tile frame +
    // render origin if a previous drive teleported the anchor far away (Paris etc.) —
    // otherwise the home-spawned car would land off in render space. No-op normally.
    if (ctx.remoteView) {
      ctx.renderOrigin = { x: 0, z: 0 };
      ctx.remoteView = false;
      ctx.tileAnchor = { lat: houseLat, lon: houseLon, x: 0, z: 0, label: 'Home' };
      ctx.alignDone = false;
      if (ctx.fn.rebuildPhotorealTiles) ctx.fn.rebuildPhotorealTiles();
    }
    ctx.houseSys.setInside(false);
    ctx.nav.clearDestination();
    if (ctx.navMarker) ctx.navMarker.visible = false;
    // Default to the Roblox-style CHASE cam ('Close') so driving leads with the
    // dynamic thumbstick + swipe-to-look controls — that IS the Roblox feel the
    // player expects. The overhead drag-to-drive map stays one tap away on the VIEW
    // cycle for anyone who prefers steering by tapping the map. We only honour a cam
    // the player chose themselves on a previous drive (driveCamUserPicked).
    if (!ctx.driveCamUserPicked) {
      const i = DRIVE_CAMS.findIndex(c => c.name === 'Close');
      if (i >= 0) ctx.camMode = i;
    }
    ctx.czoom = 1;                                            // fresh zoom (pinch shouldn't leak between drives)
    ctx.poiSeen.clear();                                      // re-arm the neighbourhood callouts
    for (const c of ctx.coins) { c.got = false; c.groundY = null; } ctx.coinsGot = 0;   // fresh coins each drive
    ctx.score.resetRun(); ctx.score.resetParticles();
    ctx.score.emitScore({ finishMs: 0 });
    ctx.emit('driveCam', DRIVE_CAMS[ctx.camMode].name);
    // FREE ROAM by default — no auto-destination, so the route line is OFF until you
    // choose somewhere (🧭 / tap the map). The pink POI beacons still point the way.
    const sp = ctx.frontPt || [ctx.house.c[0], ctx.house.c[1] + 14];
    ctx.car.x = sp[0]; ctx.car.z = sp[1];
    if (ctx.frontDir) {
      // face whichever direction has the longer drivable run
      const run = sx => {
        let i = 0;
        while (i < 12 && ctx.onRoad(sp[0] + ctx.frontDir[0] * sx * (i + 1) * 8, sp[1] + ctx.frontDir[1] * sx * (i + 1) * 8)) i++;
        return i;
      };
      const sg = run(1) >= run(-1) ? 1 : -1;
      ctx.car.yaw = Math.atan2(ctx.frontDir[0] * sg, ctx.frontDir[1] * sg);
    } else ctx.car.yaw = 0;
    ctx.car.speed = 0; ctx.car.throttle = 0; ctx.car.brakeAmt = 0; ctx.car.pitchDyn = 0; ctx.car.kSteer = 0; ctx.car.revArmT = 0; ctx.boost = 0; ctx.car.group.visible = true; ctx.car.groundY = null;
    ctx.camOrbit.yaw = 0; ctx.camOrbit.pitch = 0; ctx._orbitUserSet = false; ctx.camGroundRef = null; ctx._viewYaw = ctx.follow.viewHeading(); ctx._miniYaw = ctx.follow.viewHeading(); ctx._gmapHeading = ((180 - ctx.follow.viewHeading() * 180 / Math.PI) % 360 + 360) % 360;   // re-arm the cinematic sweep + snap BOTH minimaps to the heading (no rotate-in)
    ctx.showT = 0;                                   // skip the low cinematic orbit (melty up close)
    for (const s of ctx.labelSprites) s.visible = false;
    ctx.audio.engineStart();
    if (ctx.soundOn && ctx.audio.startMusic) ctx.audio.startMusic();
    ctx.cars.showCarCard();
    // TRUE free roam: never auto-set a destination on entry. The pink POI beacons still
    // point the way; pick a place with 🧭 or by tapping the map when YOU want a route+ETA.
    if (ctx.poiFound.size >= ctx.POIS.length) ctx.toast('🏆 All places found — free roam, beat your times!', 2400);
  }
  function exitDrive() {
    ctx.fn.setMode('explore');
    ctx.follow.stopFollow();
    ctx.camera.up.set(0, 1, 0);
    ctx.controls.hideJoy();
    ctx.navPtr = null; ctx.inp2.navActive = false; if (ctx.navMarker) ctx.navMarker.visible = false;
    ctx.guideLine.visible = false; ctx.destPin.visible = false;
    if (ctx.ui.fx) ctx.ui.fx.classList.remove('on');
    if (ctx.camera.fov !== 46) { ctx.camera.fov = 46; ctx.camera.updateProjectionMatrix(); }
    for (const c of ctx.coins) c.mesh.visible = false;
    ctx.score.resetParticles();
    ctx.poi.hideBeacons();
    ctx.trafficSys.hideTraffic();
    ctx.carLocator.visible = false;
    ctx.car.group.visible = false;
    if (ctx.groundPatch) ctx.groundPatch.visible = false;
    for (const s of ctx.labelSprites) s.visible = true;
    ctx.inp2.jx = ctx.inp2.jy = ctx.inp2.kx = ctx.inp2.ky = 0;
    ctx.audio.engineStop();
    if (ctx.audio.stopMusic) ctx.audio.stopMusic();
    ctx.ctl.gtx = clamp(ctx.car.x, -310, 310); ctx.ctl.gtz = clamp(ctx.car.z, -310, 310);
    ctx.ctl.gty = terrainAt(ctx.ctl.gtx, ctx.ctl.gtz) + 3; ctx.ctl.gr = 110; ctx.ctl.gpo = 0.95;
    ctx.ctl.tx = ctx.ctl.gtx; ctx.ctl.tz = ctx.ctl.gtz;
  }
  // Unstick: snap the car to the nearest point ON a drivable road segment, facing
  // along it, stopped. Projects onto each segment (not just vertices) for accuracy.
  function resetToRoad() {
    if (ctx.mode !== 'drive') return;
    if (ctx.followMode) ctx.follow.stopFollow();   // FIX·ROAD must OWN the snap — else the follow spring drags the car right back, so the button looks dead
    const far = !ctx.roads.nearestRoadLocation(ctx.car.x, ctx.car.z, { includeRoute: false, includeOsm: false, includeHome: true, maxDistance: ctx.HOME_ROAD_RADIUS || 380 });
    // Use the same road-graph projection as drive assist/follow: route first, then the live
    // OSM graph around the current car, and only the home graph while actually near home.
    let snap = ctx.roads.nearestRoadLocation(ctx.car.x, ctx.car.z, {
      includeHome: !far,
      maxDistance: far && !(ctx.ROUTE && ctx.ROUTE.length > 1) ? 250 : Infinity,
    });
    if (!snap) {
      if (far) {
        // No local road data yet (the OSM fetch hasn't landed). Force a fetch now and LEAVE THE CAR PUT
        // rather than flinging it home; the next tap snaps onto the real nearest road once it arrives.
        ctx.nav.updateAreaRoads(performance.now(), true);
        ctx.toast('Finding the nearest road… try again in a sec 🛰️', 1600);
        return;
      }
      snap = ctx.roads.nearestRoadLocation(ctx.car.x, ctx.car.z, { includeHome: true });
      if (!snap) return;
    }
    ctx.car.x = snap.x; ctx.car.z = snap.z; ctx.car.speed = 0; ctx.car.steer = 0; ctx.car.vlat = 0; ctx.car.revArmT = 0; ctx.car.groundY = null; ctx.car.yaw = Math.atan2(snap.tx, snap.tz);
    ctx.nav.clearRouteRail();   // if auto-drive is still on, reacquire rail arc from the snapped road point
    ctx.camInit = false; ctx.camGroundRef = null; ctx.camFloorRef = null; ctx.inp2.navActive = false; ctx.recoverCooldown = 1.8;   // re-seat the chase/orbit cam at the new spot; grace so auto-recover can't immediately re-fire
    ctx.audio.blip && ctx.audio.blip();
    ctx.toast('Back on the road 🛣️', 1000);
  }
  // Register the cross-cutting core back-edges so extracted domain modules can call them via ctx.fn.
  // (mode machine, mode transitions, building hit-tests, tile align — these stay in engine.js / core for now.)
  Object.assign(ctx.fn, { setMode, applyModeVisuals, photoModes, enterDrive, exitDrive, enterScoop, exitScoop, driveFromScoop, resetToRoad, insideBuilding, insideScoopBuilding, alignP3DT, applyP3DT, setPhotorealAnchor, rebuildPhotorealTiles });

  // ---- destination / routing / auto-drive ----
  // Real road route from Google Directions (via the Maps JS SDK, which works in the
  // browser — the Directions web service is CORS-blocked). Falls back to a straight
  // line if the SDK/Directions API isn't enabled on the key.
  ctx._mapsSDK = null;
  ctx.routeReqId = 0, ctx._quietRoute = false;
  ctx.LANE_OFFSET = 2.8;   // metres right of centreline ≈ middle of the right-hand lane

  // Correct the preset POIs to their REAL coordinates via Google geocoding (the hardcoded
  // lat/lons were approximate). Updates each POI's world position so proximity/'found' and
  // the in-world beacon+label point at the actual place; shifts the Stanton dancers along.
  ctx.POI_ADDR = {
    meemaw: '4311 Circle Ave, Castro Valley, CA 94546',
    canyon: 'Canyon Middle School, Castro Valley, CA',
    stanton: 'Stanton Elementary School, Castro Valley, CA',
    dad: '807 Broadway, Oakland, CA 94607',
  };
  // ---- live Google minimap (always shows real streets, even far from the procedural
  // neighbourhood where the canvas minimap goes blank). Centres on the car, draws the route,
  // and a tap drives there. Sits OVER the procedural canvas, which stays as the fallback. ----
  ctx.DARK_MAP_STYLE = [
    { elementType: 'geometry', stylers: [{ color: '#1b2027' }] },
    { elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#3a4350' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#55617a' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#16202b' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#222831' }] },
  ];
  ctx._gmap = null, ctx._gmapCar = null, ctx._gmapRoute = null, ctx._gmapClick = null, ctx._gmapT = 0, ctx._gmapDiv = null, ctx._gmapRouteFor = null, ctx._gmaps = null, ctx._gmapOverviewUntil = 0, ctx._gmapHeading = 0, ctx._gmapRot = 0, ctx._gmapScale = 1;
  ctx._acSvc = null, ctx._acTok = null;
  ctx._acCache = new Map();
  // Relocate the START: teleport the car to an address, land it on a ROAD (so it matches
  // where Drive-to arrives — Google geocodes to a rooftop/parcel, not the curb), clear any
  // destination, re-settle the camera. Lets you start anywhere on the map.
  ctx.jumpReqId = 0, ctx._jumpSnap = null;   // after a FAR jump: { x, z, until } — snap onto the road once OSM/Google for the NEW area lands; time+position scoped so it self-expires and can't leak into a later drive
  // FOLLOW = track the user's real GPS position EXACTLY: glide straight to the live point (NO Google
  // routing — that snapped to the "wrong street" and overshot short hops) and orient the car to the
  // phone's compass heading. "Drive to me" (non-follow) still routes there once for the scenic drive.
  ctx._geoWatch = null, ctx.followMode = false, ctx._followGeo = null, ctx._followHeading = null, ctx._followSeeded = false;
  ctx._followVx = 0, ctx._followVz = 0;   // spring VELOCITY for the follow glide — momentum so a new GPS fix accelerates smoothly instead of darting/stopping (no stop-and-go between sparse updates)
  ctx._headingOn = false, ctx._headingOff = null, ctx._headingGen = 0;
  // Autodrive max-speed cap (mph; 0 = uncapped). Persisted; applied in autoDriveTargetSpeed.
  ctx.autoMaxMph = (() => { try { return parseInt(localStorage.getItem('dahill.automax') || '0', 10) || 0; } catch (e) { return 0; } })();
  // Global driving-speed/accel multiplier (settings slider). Scales top speed AND accel so the
  // whole envelope slows together — a parent can dial it down for little kids on tight streets.
  ctx.speedMul = (() => { try { const v = parseFloat(localStorage.getItem('dahill.speedmul')); return v >= 0.3 && v <= 2 ? v : 1; } catch (e) { return 1; } })();
  // ---- auto-drive RAIL: a chauffeur is not a physics sim. Glue the car to the route polyline and
  // advance it by arc-length at a fast cruise, so a cross-town trip takes ~30-90 s and it can never
  // overshoot a bend or ping-pong off the route, no matter the speed. (Supernatural traction by design.)
  ctx._routeLenFor = null, ctx._routeLen = 0;
  // ---- road-graph queries (lane-keep / steer-back / face-along-street) ---- (see nav/road-graph.js)
  ctx.roads = createRoadGraph(ctx);   // ctx.roads.{roadTargetAhead, nearestRoadPoint, nearestRoadSeg}
  // Live "where am I" readout: reverse-geocode the car's position to a rough STREET · CITY, ST and push
  // it to the subline. Throttled hard (every ~4 s, and only after moving ~140 m) to stay well within the
  // geocoder quota; falls back silently on any error.
  ctx._geoT = 0, ctx._geoBusy = false, ctx._geoLabel = '', ctx._geoLast = null;
  // Rebuild the guide ribbon along the route polyline ahead of the car: gather the next
  // ~170 m of route (its real turns), resample to ~5 m steps, drape each cross-section
  // to the ground (relative to the car's road height so it sits ON the street), and
  // write the triangle-strip vertices. Falls back to a straight line to a routeless DEST.
  // Cached canopy-skipped ROAD height per ROUTE point. Fallback heights retry until
  // tiles stream, so a route line never gets stuck forever at a procedural/clamped y.
  ctx._routeYFor = null, ctx._routeY = [];

  // collision feedback: a thunk, a kick of camera shake, and a haptic buzz, scaled
  // by impact speed — so hits read as intentional, not a silent invisible-wall ping.
  ctx.shakeMag = 0, ctx.lastHitT = -1e9, ctx.timeScale = 1, ctx.slowmoHold = 0;

  ctx.camV = new THREE.Vector3();
  ctx._camT = new THREE.Vector3();      // per-frame camera target scratch (drive/scoop are mutually exclusive)
  ctx._lookT = new THREE.Vector3();     // desired chase look point (scratch)
  ctx._lookV = null;                       // smoothed chase look point — lags so the car whips toward frame edge
  ctx._lookYS = null;                      // low-passed look-point height — kills the per-bump vertical pitch on photoreal ground
  ctx.camGroundRef = null;                 // slow-smoothed ground height for a STATIC-feeling drone altitude
  ctx.camFloorRef = null;                   // low-passed anti-clip floor so per-bump groundAt spikes don't POP the cam
  ctx._camFloorT = 0, ctx._camFloorRaw = 0;     // throttle the floor raycast (~14 Hz) — its output is low-passed to ~3 Hz anyway
  ctx.camMode = 0;
  ctx.camInit = false;
  ctx.driveCamUserPicked = false;
  ctx.scCam = 0;
  // March the subject->camera segment and pull the camera in before it would
  // enter a building below that building's roofline.
  ctx._camRayO = new THREE.Vector3(), ctx._camRayD = new THREE.Vector3();
  ctx.camRay = new THREE.Raycaster(); ctx.camRay.firstHitOnly = true;
  ctx._camHits = [];

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
  // ---- occlusion: drive tile cutaway ---- (see occlusion/tile-clip.js)
  ctx.tileClip = createTileClip(ctx);   // ctx.tileClip.updateTileClip — see occlusion/tile-clip.js


  // ---------- viewport (critical mobile invariant — do not regress) ----------
  // The Claude app webview reports a layout viewport TALLER than the visible
  // area; size everything from visualViewport or HUD/subject drift offscreen.
  function viewportSize() {
    const vv = window.visualViewport;
    const w = vv ? Math.round(vv.width) : document.documentElement.clientWidth || innerWidth;
    const h = vv ? Math.round(vv.height) : document.documentElement.clientHeight || innerHeight;
    return [Math.max(1, w), Math.max(1, h)];
  }
  ctx._rw = 0, ctx._rh = 0, ctx._resizeRaf = 0, ctx._kbdOpen = false;
  function resize() {
    const [w, h] = viewportSize();
    ctx._rw = w; ctx._rh = h;
    ctx.renderer.setPixelRatio(ctx.renderPixelRatio());
    ctx.renderer.setSize(w, h, false);
    ctx.canvas.style.width = w + 'px'; ctx.canvas.style.height = h + 'px';
    if (ctx.ui.box) { ctx.ui.box.style.width = w + 'px'; ctx.ui.box.style.height = h + 'px'; }
    ctx.camera.aspect = w / h; ctx.camera.updateProjectionMatrix();
    if (ctx.p3dtiles) ctx.p3dtiles.setResolutionFromRenderer(ctx.camera, ctx.renderer);
  }
  // rAF-coalesced resize for the event listeners. On iOS, visualViewport 'scroll' fires
  // continuously during the URL-bar show/hide, and a raw resize() per event churns the GL
  // viewport + tile-resolution recompute mid-gesture. Skip when the size hasn't changed.
  function requestResize() {
    // iPad/iOS: focusing the address box opens the on-screen keyboard, which SHRINKS visualViewport.
    // Resizing the canvas + HUD to that smaller strip is what "screws up the rest of the screen" — the
    // 3D scene squished into the top while you type. Hold the size steady while a text field is focused
    // and restore it on blur (see the focusin/focusout listeners below).
    if (ctx._kbdOpen) return;
    if (ctx._resizeRaf) return;
    ctx._resizeRaf = requestAnimationFrame(() => {
      ctx._resizeRaf = 0;
      if (ctx._kbdOpen) return;   // the keyboard may have opened AFTER this rAF was queued (focusin one frame later) — don't squish to the keyboard strip
      const [w, h] = viewportSize();
      if (w !== ctx._rw || h !== ctx._rh) resize();
    });
  }

  // ---------- loop ----------
  ctx.dirV = new THREE.Vector3();
  ctx.prev = performance.now();
  ctx.raf = 0, ctx.paused = false, ctx.ctxLost = false, ctx._miniT = 0, ctx._miniCtx = null, ctx._miniEl = null, ctx._shadowT = 0, ctx._miniYaw = 0;
  // Google 3D Tiles ToS: surface the LIVE data attribution for the tiles currently
  // in view whenever the photoreal world is shown. Throttled; emits only on change.
  ctx._attrTarget = []; ctx._attrStr = '', ctx._attrT = 0;
  function updateAttribution(now) {
    if (now - ctx._attrT < 500) return;
    ctx._attrT = now; ctx._attrTarget.length = 0;
    try { ctx.p3dtiles.getAttributions(ctx._attrTarget); } catch (e) { return; }
    const s = ctx._attrTarget.filter(a => a && a.type === 'string').map(a => a.value).filter(Boolean).join(' · ');
    if (s !== ctx._attrStr) { ctx._attrStr = s; ctx.emit('attribution', s); }
  }
  function setOrientation(o) { ctx._orient = o; if (ctx.im) ctx.im.setOrientation(o); }
  // Bridge the unified InputState into the engine's tuned consumers, ONE mapping per mode (no
  // duplicated movement logic). Drive is untouched for now (keeps its legacy handlers); scoop's
  // input source is swapped to the InputManager here.
  function pumpInput(dt) {
    ctx.im.update(dt);
    const s = ctx.im.state;
    if (s.orientation !== ctx._orient) setOrientation(s.orientation);
    if (ctx.mode === 'scoop' && ctx.imScoop) {
      ctx.inp2.jx = s.moveX; ctx.inp2.jy = -s.moveY;                       // camera-relative twin-stick → the tuned scoop move
      if (s.lookX || s.lookY) { ctx.camYawS -= s.lookX; ctx.scPitch = clamp(ctx.scPitch + s.lookY, -0.2, 1.2); ctx.lastLookT = performance.now(); }   // right-thumb drag → orbit the follow cam
      if (s.zoomDelta) ctx.szoom = clamp(ctx.szoom * Math.exp(-s.zoomDelta * 0.12), 0.5, 2.4);   // pinch/wheel → scoop zoom (multiplier, like czoom)
    } else if (ctx.mode === 'drive' && ctx.imDrive && !ctx.traceMode) {
      ctx.inp2.jx = s.moveX; ctx.inp2.jy = -s.moveY;                       // twin-stick: jx steer, jy throttle(up)/brake(down) → the tuned car physics
      if (s.lookX || s.lookY) {                                          // right-thumb drag → orbit the PRESERVED heading-up drive cam (same signs the legacy look used)
        ctx.camOrbit.yaw = clamp(ctx.camOrbit.yaw - s.lookX, -2.4, 2.4);
        ctx.camOrbit.pitch = clamp(ctx.camOrbit.pitch + s.lookY, -0.45, 0.8);
        ctx.camOrbit.t = performance.now(); ctx._orbitUserSet = true;     // user grabbed the cam → stop the cinematic sweep
      }
      if (s.zoomDelta) {                                                  // pinch/wheel → czoom. czoom is a MULTIPLIER (not metres): bridge the additive delta so the tuned boom range is kept.
        const td = ctx.controls.driveTopDown();
        ctx.czoom = clamp(ctx.czoom / Math.exp(s.zoomDelta * 0.12), td ? 0.14 : 0.4, td ? 7 : 3.4);
        ctx.controls.emitDriveZoom();
      }
    }
  }
  ctx.fn.setOrientation = setOrientation;
  function loop(now) {
    if (ctx.disposed || ctx.paused || ctx.ctxLost) return;
    const rawDt = Math.min(0.05, (now - ctx.prev) / 1000); ctx.prev = now;
    pumpInput(rawDt);   // unified input → ctx.inp2 + cameras (uses real-time dt so look/zoom aren't slow-mo'd)
    if (ctx.slowmoHold > 0) { ctx.slowmoHold -= rawDt; }              // hold the arrival slow-mo before recovering
    else ctx.timeScale += (1 - ctx.timeScale) * Math.min(1, rawDt * 4.5);   // recover from slow-mo back to real time
    const dt = rawDt * ctx.timeScale;
    if (ctx.waterMat) ctx.waterMat.uniforms.uTime.value = now * 0.001; // flowing creek
    ctx.updateAnimals(dt, now, (ctx.mode === 'scoop' && ctx.scoopScene === 'yard') ? ctx.CHAR : null); // ambient life every mode; spooks away from the player while scooping the yard
    if (!ctx.remoteView) ctx.crowd.updateCrowd(dt, now);   // dancing CeCe/Drew crowd (mode + distance gated) + hit-launch — home-only, off when teleported away
    if (ctx.mode === 'drive') {
      ctx.drive.updateDrive(dt, now);
    } else if (ctx.mode === 'scoop') {
      ctx.scoop.updateScoop(dt, now);
    } else {
      // frame-rate-INDEPENDENT blend (was a fixed 0.16/frame → converged twice as fast on a
      // 120 Hz phone and micro-stuttered under variable dt — the "aerial orbit isn't smooth").
      const k = ctx.reduceMotion ? 1 : (1 - Math.exp(-rawDt * 10.6));
      if (!ctx.reduceMotion && !ctx.ptrs.size && (Math.abs(ctx.azVel) > 1e-4 || Math.abs(ctx.poVel) > 1e-4)) {
        ctx.ctl.gaz += ctx.azVel * rawDt * 60; ctx.ctl.gpo = clamp(ctx.ctl.gpo + ctx.poVel * rawDt * 60, 0.14, 1.46);
        const decay = Math.exp(-dt * 4); ctx.azVel *= decay; ctx.poVel *= decay; // flick momentum
      }
      ctx.ctl.tx += (ctx.ctl.gtx - ctx.ctl.tx) * k; ctx.ctl.ty += (ctx.ctl.gty - ctx.ctl.ty) * k; ctx.ctl.tz += (ctx.ctl.gtz - ctx.ctl.tz) * k;
      ctx.ctl.az += (ctx.ctl.gaz - ctx.ctl.az) * k; ctx.ctl.po += (ctx.ctl.gpo - ctx.ctl.po) * k; ctx.ctl.r += (ctx.ctl.gr - ctx.ctl.r) * k;
      ctx.controls.applyCam();
      ctx.camInit = false;
    }
    if (!ctx.reduceMotion) {
      const s = 1 + 0.04 * Math.sin(now * 0.0023);
      ctx.ring.scale.set(s, s, 1);
      ctx.ring.material.opacity = 0.5 + 0.22 * Math.sin(now * 0.0023);
    }
    if (ctx.sun.castShadow && now - ctx._shadowT > 140) { ctx.renderer.shadowMap.needsUpdate = true; ctx._shadowT = now; }
    ctx.camera.getWorldDirection(ctx.dirV);
    if (ctx.ui.needle) ctx.ui.needle.style.transform = `rotate(${(Math.atan2(ctx.dirV.x, ctx.dirV.z) * 180 / Math.PI).toFixed(1)}deg)`;
    ctx.prefetch.updateTilePrefetch(now);                                         // warm tiles along the route ahead (self-gates to drive + active destination)
    updateTileWarmCamera(now);                                                   // after far teleports, bootstrap Google root traversal while the user stays in Close
    if (ctx.p3dtiles && ctx.fn.photoModes(ctx.mode)) { ctx.camera.updateMatrixWorld(); if (now - ctx._tilesUpdT > 55) { ctx.p3dtiles.update(); ctx._tilesUpdT = now; } updateAttribution(now); }   // ~18 Hz LOD traversal
    else if (ctx._attrStr) { ctx._attrStr = ''; ctx.emit('attribution', ''); }   // no tiles shown → no credit
    if (ctx.mode === 'drive') {
      ctx.nav.updateMiniMap(now);                                            // live Google minimap (when up)
      if (!ctx._gmap && ctx.ui.minimap && now - ctx._miniT > 80) {              // procedural fallback until/unless it loads
        ctx._miniT = now;
        if (ctx._miniEl !== ctx.ui.minimap) { ctx._miniEl = ctx.ui.minimap; ctx._miniCtx = ctx.ui.minimap.getContext('2d'); }
        if (ctx._miniCtx) ctx.nav.drawMinimap(ctx._miniCtx, ctx.ui.minimap.width, ctx.ui.minimap.height);
      }
    }
    ctx.renderer.render(ctx.scene, ctx.camera);
    ctx.raf = requestAnimationFrame(loop);
  }
  // iOS robustness: don't burn GPU/memory streaming tiles to a backgrounded tab,
  // and survive a WebGL context loss instead of freezing on a black canvas.
  // Backgrounded → stop the RAF (halts physics, the 4-camera renders, tile streaming,
  // minimap + FX) AND suspend audio (no engine drone / music) → a hidden tab draws ~no
  // power. iOS phone-lock / app-switch often fires pagehide/freeze WITHOUT a reliable
  // visibilitychange (and Low Power Mode can suppress it), so we listen to all of them.
  function suspend() { ctx.controls.clearLiveInput(); _clearKbd(); if (!ctx.paused) { ctx.paused = true; cancelAnimationFrame(ctx.raf); if (ctx.audio.suspendAudio) ctx.audio.suspendAudio(); } }
  function resume() { if (ctx.paused && !ctx.disposed && !ctx.ctxLost) { ctx.paused = false; ctx.prev = performance.now(); if (ctx.audio.resumeAudio) ctx.audio.resumeAudio(); else ctx.audio.ensure(); ctx.raf = requestAnimationFrame(loop); } }
  function onVisibility() { if (document.hidden) suspend(); else resume(); }
  function onContextLost(e) { e.preventDefault(); ctx.ctxLost = true; cancelAnimationFrame(ctx.raf); }
  function onContextRestored() { if (!ctx.disposed) location.reload(); }   // rebuild streamed GPU state via reload

  // ---------- wire up ----------
  ctx.canvas.addEventListener('pointerdown', ctx.controls.onPointerDown);
  ctx.canvas.addEventListener('pointermove', ctx.controls.onPointerMove);
  ctx.canvas.addEventListener('pointerup', ctx.controls.onPointerEnd);
  ctx.canvas.addEventListener('pointercancel', ctx.controls.onPointerEnd);
  ctx.canvas.addEventListener('contextmenu', ctx.controls.onContextMenu);
  ctx.canvas.addEventListener('dblclick', ctx.controls.onDblClick);
  ctx.canvas.addEventListener('wheel', ctx.controls.onWheel, { passive: false });
  ctx.canvas.addEventListener('webglcontextlost', onContextLost, false);
  ctx.canvas.addEventListener('webglcontextrestored', onContextRestored, false);
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('pagehide', suspend); addEventListener('freeze', suspend);     // iOS lock / app-switch
  addEventListener('pageshow', resume); addEventListener('resume', resume);
  addEventListener('blur', ctx.controls.clearLiveInput);
  addEventListener('keydown', ctx.controls.onKeyDown);
  addEventListener('keyup', ctx.controls.onKeyUp);
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
  const _clearKbd = () => { if (!ctx._kbdOpen) return; ctx._kbdOpen = false; try { window.scrollTo(0, 0); } catch (e) { } requestResize(); };
  const onFocusIn = e => { if (_isTextField(e.target)) ctx._kbdOpen = true; };
  const onFocusOut = e => { if (_isTextField(e.target)) setTimeout(() => { if (!_isTextField(document.activeElement)) _clearKbd(); }, 0); };
  addEventListener('focusin', onFocusIn);
  addEventListener('focusout', onFocusOut);
  addEventListener('blur', _clearKbd);   // belt-and-suspenders: app-switch / lock with the keyboard up never leaves it stuck
  resize();
  const t1 = setTimeout(resize, 400), t2 = setTimeout(resize, 1500);

  ctx.emit('subline', 'Castro Valley, CA');   // clean default for the live location readout; the reverse-geocoder refines it to STREET · CITY, ST as you drive
  ctx.controls.applyCam();
  ctx.renderer.render(ctx.scene, ctx.camera);
  ctx.emit('ready');
  ctx.poi.emitPOIs();                 // seed the start-card "places found" badge from saved progress
  if (ctx.audio.setMuted) ctx.audio.setMuted(!ctx.soundOn);   // sync the master mute with the saved pref
  ctx.emit('sound', ctx.soundOn);   // seed the 🔊 toggle state
  ctx.emit('autosteer', ctx.autoSteer);
  ctx.emit('roadlife', ctx.roadLifeOn);
  ctx.cars.checkFerrariUnlock();       // reconcile a prior 5/5 completion → keep the Ferrari unlocked
  if (document.hidden) ctx.paused = true;   // born in a background tab → don't render/stream until shown
  else ctx.raf = requestAnimationFrame(loop);

  function dispose() {
    ctx.disposed = true;
    cancelAnimationFrame(ctx.raf);
    clearTimeout(t1); clearTimeout(t2); clearTimeout(ctx._crowdReplaceT);
    ctx.canvas.removeEventListener('pointerdown', ctx.controls.onPointerDown);
    ctx.canvas.removeEventListener('pointermove', ctx.controls.onPointerMove);
    ctx.canvas.removeEventListener('pointerup', ctx.controls.onPointerEnd);
    ctx.canvas.removeEventListener('pointercancel', ctx.controls.onPointerEnd);
    ctx.canvas.removeEventListener('contextmenu', ctx.controls.onContextMenu);
    ctx.canvas.removeEventListener('dblclick', ctx.controls.onDblClick);
    ctx.canvas.removeEventListener('wheel', ctx.controls.onWheel);
    ctx.canvas.removeEventListener('webglcontextlost', onContextLost);
    ctx.canvas.removeEventListener('webglcontextrestored', onContextRestored);
    document.removeEventListener('visibilitychange', onVisibility);
    removeEventListener('pagehide', suspend); removeEventListener('freeze', suspend);
    removeEventListener('pageshow', resume); removeEventListener('resume', resume);
    removeEventListener('blur', ctx.controls.clearLiveInput);
    removeEventListener('keydown', ctx.controls.onKeyDown);
    removeEventListener('keyup', ctx.controls.onKeyUp);
    removeEventListener('resize', requestResize);
    removeEventListener('orientationchange', requestResize);
    removeEventListener('focusin', onFocusIn);
    removeEventListener('focusout', onFocusOut);
    removeEventListener('blur', _clearKbd);
    ctx.follow.stopFollow();
    if (ctx.im) ctx.im.dispose();
    if (window.visualViewport) {
      visualViewport.removeEventListener('resize', requestResize);
      visualViewport.removeEventListener('scroll', requestResize);
    }
    cancelAnimationFrame(ctx._resizeRaf);
    ctx.audio.engineStop();
    if (ctx.audio.stopMusic) ctx.audio.stopMusic();      // kill the 30ms music scheduler interval (was leaking)
    if (ctx.audio.close) ctx.audio.close();              // close the AudioContext so it isn't left running
    if (ctx.cancelCarLoad) ctx.cancelCarLoad();          // late car load/timeout can't touch a dead scene
    for (const cancel of ctx.modelLoadCancels) if (cancel) cancel();
    ctx.nav.disposeMiniMap();
    if (ctx.ceceCrowd) ctx.ceceCrowd.dispose();          // stop crowd mixers + detach the dancers
    if (ctx.drewCrowd) ctx.drewCrowd.dispose();
    if (ctx.dadCrowd) ctx.dadCrowd.dispose();
    if (ctx.momCrowd) ctx.momCrowd.dispose();
    for (const npc of ctx.npcs) { if (npc.ctrl.reset) npc.ctrl.reset(); if (npc.group.parent) npc.group.parent.remove(npc.group); }   // tear down the house NPCs
    ctx.prefetch.setScout(false);                             // unregister the prefetch scout camera
    if (ctx.p3dtiles && ctx.p3dtiles.disposeAll) ctx.p3dtiles.disposeAll();
    // free GPU resources the renderer.dispose() alone doesn't reclaim
    ctx.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
        m.dispose();
      }
    });
    if (ctx.scene.environment && ctx.scene.environment.dispose) { ctx.scene.environment.dispose(); ctx.scene.environment = null; }
    ctx.renderer.dispose();
    document.documentElement.classList.remove('lite3d');
    delete window.__dahill;
  }

  const api = {
    enterDrive: ctx.fn.enterDrive, exitDrive: ctx.fn.exitDrive, enterScoop: ctx.fn.enterScoop, exitScoop: ctx.fn.exitScoop,
    im: ctx.im,                                                // the unified InputManager (MobileControls reads .joystick + .requestJump)
    setTraceMode: (on) => { ctx.traceMode = !!on; ctx.emit('traceMode', ctx.traceMode); },   // opt-in 'draw to drive' alternate input (drive)
    toggleShiftLock: () => { ctx.shiftLock = !ctx.shiftLock; ctx.emit('shiftLock', ctx.shiftLock); },
    // hop: only from the ground; a keyboard Space also jumps (wired in onKeyDown)
    jump: () => { if (ctx.mode === 'scoop' && ctx.CHAR.airY <= 0 && ctx.CHAR.vy === 0) { ctx.CHAR.vy = 8.5; if (ctx.audio.blip) ctx.audio.blip(); } },
    // random celebration from the active avatar's emote set
    dance: () => {
      if (ctx.mode !== 'scoop' || !ctx.CHAR.drew) return;
      const a = ctx.CHAR.getActions();
      ctx.CHAR.drew.react(a.length ? a[Math.floor(Math.random() * a.length)].key : 'dance');
      if (ctx.audio.blip) ctx.audio.blip();
    },
    // play one specific emote (the side-menu action buttons)
    playAction: (key) => { if (ctx.mode === 'scoop' && ctx.CHAR.drew) { ctx.CHAR.drew.react(key); if (ctx.audio.blip) ctx.audio.blip(); } },
    // Drew <-> CeCe avatar swap (avatar only — the side-menu switch). Emits 'avatar' optimistically
    // (the toggle flips at once) and again once the new rig + its action list are ready.
    setAvatar: (name) => {
      ctx.CHAR.swapAvatar(name, n => ctx.emit('avatar', { name: n, actions: ctx.CHAR.getActions() }));   // real actions once the rig is mounted
      // optimistic: flip the toggle now, but only carry actions if that avatar is ALREADY mounted —
      // otherwise the grid would show the previous kid's emotes during CeCe's async load.
      ctx.emit('avatar', { name, actions: ctx.CHAR.avatar === name ? ctx.CHAR.getActions() : [] });
    },
    getAvatar: () => ctx.CHAR.avatar,
    getScoopActions: () => ctx.CHAR.getActions(),
    // Go inside / leave the house from a HUD button (proximity-free — the auto-walk door pad still works too)
    enterHouse: () => { if (ctx.mode === 'scoop' && ctx.interior && ctx.scoopScene === 'yard') ctx.houseSys.enterHouse(performance.now()); },
    leaveHouse: () => { if (ctx.mode === 'scoop' && ctx.scoopScene === 'interior') ctx.houseSys.leaveHouse(performance.now()); },
    focusHouse: ctx.controls.focusHouse, cycleCamera: ctx.cam.cycleCamera, traceDrive: ctx.cam.traceDrive, cycleCar: ctx.cars.cycleCar, getCars: ctx.cars.getCars, pickCar: ctx.cars.pickCar, cycleScoopCamera: ctx.cam.cycleScoopCamera, driveFromScoop: ctx.fn.driveFromScoop, resetToRoad: ctx.fn.resetToRoad, resize,
    setDestination: ctx.nav.setDestination, clearDestination: ctx.nav.clearDestination, toggleAutoDrive: ctx.nav.toggleAutoDrive, driveHome: ctx.nav.driveHome, jumpHome: ctx.nav.jumpHome, driveToMyLocation: ctx.follow.driveToMyLocation, stopFollow: ctx.follow.stopFollow,
    // address search + jump-to + autodrive speed cap (Google JS SDK, in-browser)
    placeSuggest: ctx.nav.placeSuggest, geocodeAddress: ctx.nav.geocodeAddress, geocodePlaceId: ctx.nav.geocodePlaceId,
    jumpToAddress: (lat, lon, label) => ctx.nav.jumpTo(lat, lon, label),
    jumpToText: (text) => ctx.nav.geocodeAddress(text).then(g => { ctx.nav.jumpTo(g.lat, g.lon, g.label); return g; }),
    jumpToPlace: (placeId, label) => ctx.nav.geocodePlaceId(placeId, label).then(g => { ctx.nav.jumpTo(g.lat, g.lon, g.label); return g; }),
    driveToText: (text) => ctx.nav.setDestinationByText(text, true),
    driveToPlace: (placeId, label) => ctx.nav.setDestinationByPlace(placeId, label, true),
    driveToLatLon: ctx.nav.driveToLatLon,
    setAutoMaxMph: ctx.follow.setAutoMaxMph, getAutoMaxMph: () => ctx.autoMaxMph,
    setSpeedMul: ctx.follow.setSpeedMul, getSpeedMul: () => ctx.speedMul, setDriveZoom: ctx.controls.setDriveZoom,
    setCrowdDensity: ctx.crowd.setCrowdDensity, getCrowdDensity: () => ctx.CROWD_DENSITY,
    setTrafficDensity: (d) => {
      ctx.trafficDensity = clamp(+d || 0, 0, 2);
      try { localStorage.setItem('dahill.trafficdensity', String(ctx.trafficDensity)); } catch (e) { }
      const active = ctx.trafficSys.trafficActiveCount();
      for (let i = active; i < ctx.traffic.length; i++) ctx.traffic[i].group.visible = false;   // park any now-over-cap cars at once
      return ctx.trafficDensity;
    },
    getTrafficDensity: () => ctx.trafficDensity,
    preloadMaps: () => ctx.nav.loadMapsSDK().catch(() => {}),   // warm the SDK so the first keystroke in the address box doesn't jank
    initMiniMap: ctx.nav.initMiniMap,                                         // mount the live Google minimap into a div
    setHandbrake: (on) => { ctx.inp2.hbrake = !!on; },
    // LOOK stick (right thumb): orbit the drive camera. dx/dy are screen-pixel deltas,
    // same convention as a look-drag on the canvas, so it feeds the existing camOrbit.
    nudgeLook: (dx, dy) => {
      const ld = ctx.controls.lookDelta(dx, dy);
      ctx.camOrbit.yaw = clamp(ctx.camOrbit.yaw - ld.yaw, -2.4, 2.4);
      ctx.camOrbit.pitch = clamp(ctx.camOrbit.pitch + ld.pitch, -0.45, 0.8);
      ctx.camOrbit.t = performance.now();
      ctx.showT = 0;
    },
    setGas: (on) => { ctx.inp2.gas = on ? 1 : 0; if (on) ctx.showT = 0; },   // gas pedal (hold)
    setGasAmount: (v) => { ctx.inp2.gas = clamp(v, 0, 1); if (v > 0.05) ctx.showT = 0; },   // analog gas (touch drag)
    setBoost: (on) => { ctx.inp2.boost = !!on; },                        // nitro (hold while charged)
    setBrake: (on) => { ctx.inp2.brake = on ? 1 : 0; },                  // brake pedal (hold)
    // "Sound" toggle = master mute over EVERYTHING (engine drone + sfx + music), not just the soundtrack.
    toggleSound: () => { ctx.soundOn = !ctx.soundOn; try { localStorage.setItem('dahill.sound', ctx.soundOn ? '1' : '0'); } catch (e) { } if (ctx.audio.ensure) ctx.audio.ensure(); if (ctx.audio.setMuted) ctx.audio.setMuted(!ctx.soundOn); if (ctx.mode === 'drive' && ctx.audio.setMusic) ctx.audio.setMusic(ctx.soundOn); ctx.emit('sound', ctx.soundOn); return ctx.soundOn; },
    toggleAutoSteer: () => { ctx.autoSteer = !ctx.autoSteer; try { localStorage.setItem('dahill.autosteer', ctx.autoSteer ? '1' : '0'); } catch (e) { } ctx.emit('autosteer', ctx.autoSteer); ctx.toast(ctx.autoSteer ? '🛟 Auto-steer ON — it helps you hug the road' : 'Auto-steer off', 1400); return ctx.autoSteer; },
    toggleRoadLife: () => {
      ctx.roadLifeOn = !ctx.roadLifeOn;
      try { localStorage.setItem('dahill.roadlife', ctx.roadLifeOn ? '1' : '0'); } catch (e) { }
      ctx.emit('roadlife', ctx.roadLifeOn);
      if (!ctx.roadLifeOn) { ctx.trafficSys.hideTraffic(); ctx.crowd.hideCrowd(); }
      ctx.toast(ctx.roadLifeOn ? 'People + traffic ON' : 'People + traffic off', 1300);
      return ctx.roadLifeOn;
    },
    // tap-to-drive: convert a minimap pixel (HEADING-UP, car-centred) to a world point and let the
    // robot drive there. Inverts the SAME rotation drawMinimap drew with (via _miniYaw) so a tap lands
    // where the user pointed. range/scale mirror drawMinimap exactly.
    tapMinimap: (px, py, w, h) => {
      const range = 620, scale = (w / 2) / range, ca = Math.cos(ctx._miniYaw), sa = Math.sin(ctx._miniYaw);
      const ox = px - w / 2, oy = py - h / 2;
      ctx.nav.setDriveTarget(ctx.car.x + (-ca * ox - sa * oy) / scale, ctx.car.z + (sa * ox - ca * oy) / scale);
    },
    dispose,
    get mode() { return ctx.mode; }
  };
  ctx.api = api;   // a couple of modules (controls Space=jump) reach the public api via ctx.api
  // tiny debug handle for headless verification + on-phone debugging
  window.__dahill = {
    api,
    scoop: () => ({ scene: ctx.scoopScene, ready: !!ctx.interior, avatar: ctx.CHAR.avatar, entry: ctx.entryPt && ctx.entryPt.map(v => +v.toFixed(1)), char: [+ctx.CHAR.x.toFixed(1), +ctx.CHAR.z.toFixed(1)], dDoor: ctx.entryPt ? +Math.hypot(ctx.CHAR.x - ctx.entryPt[0], ctx.CHAR.z - ctx.entryPt[1]).toFixed(1) : null, occ: ctx.interior ? ctx.interior.occluders.length : 0, hiddenOcc: ctx.scoop && ctx.scoop.seeThrough ? ctx.scoop.seeThrough.occludedCount() : 0 }),
    crowd: () => ({ on: ctx.roadLifeOn, cece: !!ctx.ceceCrowd, drew: !!ctx.drewCrowd, spots: ctx.crowdSpots.map(s => ({ zone: s.zone, x: Math.round(s.rec.x), z: Math.round(s.rec.z), vis: s.rec.grp.visible, road: !!s.onRoadHt, scale: +s.rec.grp.scale.x.toFixed(2), y: +s.rec.grp.position.y.toFixed(1), dCar: Math.round(Math.hypot(s.rec.x - ctx.car.x, s.rec.z - ctx.car.z)) })) }),
    traffic: () => ({ on: ctx.roadLifeOn, total: ctx.traffic.length, visible: ctx.traffic.filter(c => c.group.visible).length, cars: ctx.traffic.map(c => ({ x: Math.round(c.x || 0), z: Math.round(c.z || 0), vis: c.group.visible, speed: c.speed })) }),
    p3dt: ctx.P3DT,                       // mutate {yOffset,xOffset,zOffset,spin} then call nudge()
    nudge: ctx.fn.applyP3DT,
    tiles: () => ctx.p3dtiles,
    setProcedural: (on) => { ctx.staticGroup.visible = on; },
    beacons: () => ctx.poiBeacons.map(b => ({ key: b.poi.key, vis: b.mesh.visible, op: +(b.mesh.userData.markerOpacity || 0).toFixed(2), d: Math.round(Math.hypot(b.poi.x - ctx.car.x, b.poi.z - ctx.car.z)) })),
    // sweep spin; score = avg tile height at building centroids − at road points
    // (correct alignment => buildings high/roofs, roads low). Pick the max.
    calibrate: () => {
      const road = [], bld = [];
      for (const r of S.roads) {
        if (r.k !== 'residential' && r.k !== 'tertiary') continue;
        for (const p of r.p) { const w = W(p); if (Math.hypot(w[0], w[1]) < 90) road.push(w); }
      }
      for (const b of ctx.bldPolys) {
        const cx = (b.bb[0] + b.bb[1]) / 2, cz = (b.bb[2] + b.bb[3]) / 2;
        if (Math.hypot(cx, cz) < 90) bld.push([cx, cz]);
      }
      // Rotate the SAMPLE POINTS by -s about origin (equivalent to spinning the
      // photoreal +s) and probe the static tiles — avoids stale matrixWorld.
      const out = {};
      for (let s = 0; s < 360; s += 5) {
        const a = -s * ctx.DEG, ca = Math.cos(a), sa = Math.sin(a);
        let rs = 0, rn = 0, bs = 0, bn = 0;
        for (const [x, z] of road) { const y = ctx.ground.rawTileY(x * ca - z * sa, x * sa + z * ca); if (y != null) { rs += y; rn++; } }
        for (const [x, z] of bld) { const y = ctx.ground.rawTileY(x * ca - z * sa, x * sa + z * ca); if (y != null) { bs += y; bn++; } }
        out[s] = (rn && bn) ? +(bs / bn - rs / rn).toFixed(2) : null;
      }
      let best = 0, bestv = -1e9;
      for (const s in out) if (out[s] != null && out[s] > bestv) { bestv = out[s]; best = +s; }
      return { bestSpin: best, bestScore: bestv, scores: out, roadPts: road.length, bldPts: bld.length };
    },
    state: () => ({
      mode: ctx.mode, buildings: S.buildings.length, photoreal: !!ctx.p3dtiles && !ctx.staticGroup.visible,
      poops: ctx.POOPS.length, car: { x: +ctx.car.x.toFixed(1), z: +ctx.car.z.toFixed(1), speed: +ctx.car.speed.toFixed(1), yaw: +ctx.car.yaw.toFixed(2), glb: !!ctx.car.glb },
      dest: ctx.DEST ? { x: +ctx.DEST.x.toFixed(1), z: +ctx.DEST.z.toFixed(1) } : null,
      char: { x: +ctx.CHAR.x.toFixed(1), z: +ctx.CHAR.z.toFixed(1), bag: ctx.CHAR.bag, total: ctx.CHAR.total, lvl: ctx.CHAR.lvl }
    })
  };
  return api;
}
