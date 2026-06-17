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
import { createGeo } from './nav/geo.js';
import { createRoadGraph } from './nav/road-graph.js';
import { DRIVE_CAMS, SCOOP_CAMS } from './camera/presets.js';
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
  const sc2 = ctx.sun.shadow.camera;
  // tighter frustum (±170 vs ±300) ~= 3× the texel density where shadows actually
  // land (the scoop sanctuary + driveway); distant procedural shadows aren't missed.
  sc2.left = -170; sc2.right = 170; sc2.top = 170; sc2.bottom = -170; sc2.far = 900;
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
  // geo <-> world, anchored at 1840 Dahill Lane. CURVATURE-CORRECT local ENU (East/North metres) so
  // routes / jumps / the road-snap line up with the real photoreal-tile roads even far from home —
  // the old flat-tangent version drifted ~d²/2R from the (curved-earth) tiles (~a lane at 5 km,
  // ~30 m at 20 km). Identical to the flat math within a millimetre near home, so nothing local
  // changes. Axis convention unchanged: world x = East, world z = -North, centred on C.
  // geo <-> world (ENU anchored at 1840 Dahill Lane) — see nav/geo.js
  ctx.geo = createGeo();   // ctx.geo.{geoToWorld, worldToGeo}
  ctx.DEST = null;        // { x, z, label }
  ctx.soundOn = (() => { try { return localStorage.getItem('dahill.sound') !== '0'; } catch (e) { return true; } })();   // master sound on by default
  ctx.autoSteer = (() => { try { return localStorage.getItem('dahill.autosteer') !== '0'; } catch (e) { return true; } })();   // road/lane-keep assist, on by default
  ctx.roadLifeOn = (() => { try { return localStorage.getItem('dahill.roadlife') !== '0'; } catch (e) { return true; } })();   // pedestrians + traffic on by default
  ctx.trafficDensity = (() => { try { const v = parseFloat(localStorage.getItem('dahill.trafficdensity')); return Number.isFinite(v) ? clamp(v, 0, 2) : 1; } catch (e) { return 1; } })();   // traffic amount slider (0..2, 1 = default)
  const TRAFFIC_MAX = 18;   // hard pool ceiling (perf); density scales how many are ACTIVE
  const trafficActiveCount = () => Math.round(clamp(ctx.trafficDensity, 0, 2) / 2 * TRAFFIC_MAX);   // d:0→0, d:1→9, d:2→18
  // Soft-wall / gravity-well that keeps the car on the street: past LANE_HALF metres off the
  // nearest road it gets pulled back, ramping in softly and clamped to WALL_MAX m/s so it never
  // overpowers a deliberate drive (and fades as the player steers).
  const LANE_HALF = 4.2, WALL_GAIN = 3.5, WALL_MAX = 9.0;
  ctx.offRoadT = 0;       // seconds the car has been stranded off the road (drives the auto-recover snap-back)
  ctx.recoverCooldown = 0;   // grace after a reset so the auto-recover can't immediately re-fire (no ping-pong → no "hidden car")
  ctx.ROUTE = null;       // [{x,z}, ...] road-following path from Google Directions
  ctx.routeIdx = 0;       // current target waypoint along ROUTE
  // FAR-FROM-HOME road graph: the procedural roadSegs only cover the ~±330 m hood, so out on the open
  // photoreal tiles the lane-keep assist had nothing to hug. Instead of a fragile 1-D "route ahead",
  // fetch the REAL road NETWORK from OpenStreetMap (Overpass) in a box around the car, projected
  // through the same ENU geoToWorld as the tiles, and re-fetch as you drive into new areas. This is a
  // true graph (segments on every side), so nearestRoadPoint / roadTargetAhead / the soft-wall / reset
  // all work EVERYWHERE, exactly like they do at home. Degrades to no-assist if Overpass is unreachable.
  ctx.osmRoadSegs = [];          // world-space road segments fetched around the car ([[ax,az],[bx,bz]])
  let _osmCenter = null, _osmFetching = false, _osmT = 0;
  // Overpass mirrors, tried in order — the main de host throttles (429/504) under load, so fall
  // through to the public mirrors before giving up. Rotates start point so we don't always hammer #0.
  const OVERPASS_MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let _osmMirror = 0;
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
  function spawnSkid(x, z, y, yaw, now) {
    const s = ctx.FX.skids[ctx.FX.si++ % ctx.FX.skids.length];
    s.born = now; s.mesh.visible = true;
    s.mesh.position.set(x, y + 0.035, z);
    s.mesh.rotation.set(0, yaw, 0);
    s.mesh.material.opacity = 0.5;
  }
  function spawnSmoke(x, z, y, now, onRoad) {
    const p = ctx.FX.smoke[ctx.FX.mi++ % ctx.FX.smoke.length];
    p.born = now; p.spr.visible = true;
    p.spr.position.set(x, y + 0.3, z);
    p.vx = (ctx.FX.mi % 7 - 3) * 0.25; p.vz = (ctx.FX.mi % 5 - 2) * 0.25;
    p.spr.scale.setScalar(1.1);
    p.spr.material.color.setHex(onRoad === false ? 0xb89066 : 0xc8c8c8);   // brown dust off-road, grey tyre smoke on tarmac
    p.spr.material.opacity = 0.32;
  }
  function spawnCoinBurst(x, z, y, now) {
    for (let i = 0; i < 6; i++) {
      const p = ctx.FX.sparks[ctx.FX.pi++ % ctx.FX.sparks.length];
      const a = i / 6 * Math.PI * 2;
      p.born = now; p.spr.visible = true;
      p.spr.position.set(x, y + 0.8, z);
      p.vx = Math.cos(a) * 3.2; p.vz = Math.sin(a) * 3.2; p.vy = 4 + (i % 3);
      p.spr.scale.setScalar(0.7);
      p.spr.material.opacity = 0.95;
    }
  }
  function tickParticles(now, dt) {
    for (const s of ctx.FX.skids) {
      if (!s.mesh.visible) continue;
      const age = (now - s.born) / 1000;
      if (age > 6) { s.mesh.visible = false; continue; }
      s.mesh.material.opacity = 0.5 * (1 - age / 6);
    }
    for (const p of ctx.FX.smoke) {
      if (!p.spr.visible) continue;
      const age = (now - p.born) / 1000;
      if (age > 0.85) { p.spr.visible = false; continue; }
      p.spr.position.x += p.vx * dt; p.spr.position.z += p.vz * dt;
      p.spr.position.y += (2.2 - age) * dt;
      p.spr.scale.setScalar(1.1 + age * 5);
      p.spr.material.opacity = 0.32 * (1 - age / 0.85);
    }
    for (const p of ctx.FX.sparks) {
      if (!p.spr.visible) continue;
      const age = (now - p.born) / 1000;
      if (age > 0.6) { p.spr.visible = false; continue; }
      p.vy -= 14 * dt;
      p.spr.position.x += p.vx * dt; p.spr.position.y += p.vy * dt; p.spr.position.z += p.vz * dt;
      p.spr.material.opacity = 0.95 * (1 - age / 0.6);
    }
  }
  function resetParticles() {
    for (const s of ctx.FX.skids) s.mesh.visible = false;
    for (const p of ctx.FX.smoke) p.spr.visible = false;
    for (const p of ctx.FX.sparks) p.spr.visible = false;
  }

  // ---- drive run: a coin-rally clock, a quick-chain combo, and a saved best time ----
  ctx.runStart = 0, ctx.runActive = false, ctx.lastRunMs = 0, ctx.comboExpired = true;
  ctx.combo = 0, ctx.comboExpire = 0;
  const BEST_KEY = 'dahill.drive.bestMs';
  ctx.bestMs = parseInt((typeof localStorage !== 'undefined' && localStorage.getItem(BEST_KEY)) || '0', 10) || 0;
  const fmtTime = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function startRun(now) { if (!ctx.runActive && ctx.coinsGot < ctx.coins.length) { ctx.runActive = true; ctx.runStart = now; } }
  function emitScore(extra) { ctx.emit('driveScore', Object.assign({ got: ctx.coinsGot, total: ctx.coins.length, best: ctx.bestMs, bestStr: ctx.bestMs ? fmtTime(ctx.bestMs) : '', combo: ctx.combo, trip: ctx.tripScore }, extra)); }
  function collectCoin(now) {
    if (ctx.audio.sfxChime) ctx.audio.sfxChime(ctx.combo >= 2 ? [784, 1047, 1319] : [784, 1047]);
    startRun(now);
    ctx.combo = (!ctx.comboExpired && now < ctx.comboExpire) ? ctx.combo + 1 : 1;   // chain within 4s to ramp it
    ctx.comboExpire = now + 4000; ctx.comboExpired = false;
    comboFx(now);
    // First coin teaches the loop: tell the kid what the coins are FOR (a time trial).
    if (ctx.coinsGot === 1 && ctx.coins.length > 1) ctx.toast('💛 First coin! Grab them all for a time trial 🏁', 1600);
    let finishMs = 0;
    if (ctx.coinsGot >= ctx.coins.length) {                                // rally complete → stop clock, save best
      ctx.runActive = false; ctx.lastRunMs = now - ctx.runStart; finishMs = ctx.lastRunMs;
      if (!ctx.bestMs || ctx.lastRunMs < ctx.bestMs) { ctx.bestMs = ctx.lastRunMs; try { localStorage.setItem(BEST_KEY, String(ctx.bestMs)); } catch (e) { } }
    }
    emitScore({ finishMs });
  }
  // combo crescendo: a chain that's BUILDING should look and sound like it (was silent
  // — x7 read the same as x2). Escalates at 3 and 5+.
  ctx.comboPeak = 0;
  function comboFx(now) {
    if (ctx.combo <= ctx.comboPeak) { if (ctx.combo < 2) ctx.comboPeak = 0; return; }
    ctx.comboPeak = ctx.combo;
    if (ctx.combo === 3) { ctx.toast('🔥 Combo ×3!', 1100); if (ctx.audio.sfxWhoosh) ctx.audio.sfxWhoosh(0.6); }
    else if (ctx.combo === 5) { ctx.toast('🔥🔥 ON FIRE! ×5', 1500); if (ctx.audio.sfxChime) ctx.audio.sfxChime([784, 988, 1319, 1568]); if (ctx.ui.fx && !ctx.reduceMotion) { ctx.ui.fx.classList.add('arrive'); setTimeout(() => ctx.ui.fx && ctx.ui.fx.classList.remove('arrive'), 420); } }
    else if (ctx.combo >= 8 && ctx.combo % 3 === 2) { ctx.toast('🔥🔥🔥 UNSTOPPABLE! ×' + ctx.combo, 1500); }
  }
  function resetRun() { ctx.runActive = false; ctx.runStart = 0; ctx.lastRunMs = 0; ctx.combo = 0; ctx.comboExpired = true; ctx.tripScore = 0; }   // tripScore resets per drive so combo/score chips start clean (was carrying over)
  // close-call reward: skim a tree/animal/car at speed without hitting it → ramp the
  // same combo, a whoosh, and a 'Close!' beat. Turns every hazard into a thrill.
  ctx.lastNearT = -1e9, ctx.driftState = false, ctx.driftAccum = 0;
  function nearMiss(now) {
    if (now - ctx.lastNearT < 650) return;
    ctx.lastNearT = now;
    ctx.combo = (!ctx.comboExpired && now < ctx.comboExpire) ? ctx.combo + 1 : 1;
    ctx.comboExpire = now + 4000; ctx.comboExpired = false;
    ctx.tripScore += 40 + ctx.combo * 20; addBoost(0.13);
    if (ctx.audio.sfxWhoosh) ctx.audio.sfxWhoosh(0.8);
    ctx.toast('💨 Close one!' + (ctx.combo > 1 ? ' ×' + ctx.combo : ''), 850);
    comboFx(now);
    emitScore({});
  }

  // ---- neighbourhood landmarks: the 5 real places, doubling as a "visit them all"
  // meta-goal. Driving within 45 m calls it out AND ticks lasting progress, so the
  // marquee fantasy (drive to Meemaw's / your school) finally pays off + persists. ----
  const poiSeen = new Set();   // per-session (suppress repeat toasts)
  const POI_KEY = 'dahill.drive.poisFound';
  const poiFound = new Set((() => { try { return JSON.parse(localStorage.getItem(POI_KEY) || '[]'); } catch (e) { return []; } })());
  const homeGeo = ctx.geo.worldToGeo(ctx.house.c[0], ctx.house.c[1]);
  const POIS = [{ key: 'home', x: ctx.house.c[0], z: ctx.house.c[1], lat: homeGeo.lat, lon: homeGeo.lon, icon: '🏠', label: 'your house', msg: "👋 That's YOUR house — welcome home!" }].concat(
    [['meemaw', 37.6995618, -122.0639216, '🏡', "Meemaw's", "🏡 Meemaw's house!"],
     ['canyon', 37.7046462, -122.0524363, '🏫', 'Canyon Middle', '🏫 Canyon Middle School!'],
     ['stanton', 37.7005734, -122.0940411, '🏫', 'Stanton Elem', '🏫 Stanton Elementary!'],
     ['dad', 37.8004778, -122.2739559, '💼', 'XQ', "💼 XQ — Mike's work!"]
    ].map(([key, lat, lon, icon, label, msg]) => { const w = ctx.geo.geoToWorld(lat, lon); return { key, x: w[0], z: w[1], lat, lon, icon, label, msg }; }));
  ctx.tripScore = 0;
  ctx.boost = 0, ctx.boostWas = false;                // 0..1 nitro meter — fills on skill, spends for a speed surge
  function addBoost(amt) { ctx.boost = clamp(ctx.boost + amt, 0, 1); }
  function emitPOIs() { ctx.emit('poiProgress', { found: poiFound.size, total: POIS.length }); }
  // Route the player to the nearest place they HAVEN'T found yet — turns 5 one-shot
  // discoveries into a chained road trip ("now drive to the next place!").
  function chainToNextPOI(now) {
    let best = null, bd = 1e18;
    for (const p of POIS) { if (poiFound.has(p.key)) continue; const d = Math.hypot(p.x - ctx.car.x, p.z - ctx.car.z); if (d < 35) continue; if (d < bd) { bd = d; best = p; } }   // skip the one you're at
    if (!best) return;
    ctx.autoDrive = false;
    setDestination(best.lat, best.lon, best.label, true);
    if (ctx.DEST) ctx.DEST.poiKey = best.key;   // tag so the chain only continues for places you chose
    ctx.toast('🏁 Next stop: floor it to ' + ctx.esc(best.label) + ' — follow the pink beam! 🏁', 2600);
  }
  function checkPOIs(now) {
    for (const poi of POIS) {
      if (poiSeen.has(poi.key)) continue;
      if (Math.hypot(ctx.car.x - poi.x, ctx.car.z - poi.z) < 45) {
        poiSeen.add(poi.key);
        const fresh = !poiFound.has(poi.key);
        poiFound.add(poi.key);
        try { localStorage.setItem(POI_KEY, JSON.stringify([...poiFound])); } catch (e) { }
        // fare score: a base + a speed bonus + the running combo (rewards a brisk trip)
        if (fresh && poi.key !== 'home') {
          const pts = 250 + Math.round(Math.abs(ctx.car.speed) * 4) + ctx.combo * 50;
          ctx.tripScore += pts;
          ctx.combo = (!ctx.comboExpired && now < ctx.comboExpire) ? ctx.combo + 1 : 1; ctx.comboExpire = now + 6000; ctx.comboExpired = false;
          arriveCelebrate(poi.label, pts, now);   // the finish-line moment
        } else {
          ctx.toast(poi.msg + (fresh ? '  ·  🏆 ' + poiFound.size + '/' + POIS.length : ''), 2600);
          if (ctx.audio.sfxChime) ctx.audio.sfxChime(fresh ? [659, 988, 1319] : [659, 988]);
        }
        emitScore({}); emitPOIs();
        if (poiFound.size === POIS.length && fresh) {
          checkFerrariUnlock();
          ctx.toast('🏆 ALL 5 places found! Trip score ' + ctx.tripScore + ' 🎉', 3800);
        } else if (fresh && ctx.DEST && poi.key === (ctx.DEST.poiKey || '') ) {
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
    ctx.scene.add(m);
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
    ctx.scene.add(s);
    return { poi, spr: s, mat };
  });

  // ---- ambient TRAFFIC: simple cars roaming the neighbourhood roads, so there's
  // finally something alive to weave through. They feed the near-miss/combo economy
  // and bounce on contact. Lives only on the ±330 m procedural street network. ----
  const modelLoadCancels = [];
  const traffic = [];
  {
    const tSegs = ctx.roadSegs.filter(s => Math.hypot((s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2) < 700 && Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) > 3);   // wider radius so the bigger pool covers outer streets too
    const cols = [0xb53a32, 0x2f5fb0, 0xd9d9d9, 0x2a2a2a, 0xd6a52e, 0x3f9e63, 0x8a8f96];
    const bodyGeo = new THREE.BoxGeometry(1.9, 1.0, 4.0), cabGeo = new THREE.BoxGeometry(1.6, 0.72, 1.9);
    // shared materials: one cab + 7 body colours, reused across all cars (was 22 clones)
    const bodyMats = cols.map(c => new THREE.MeshStandardMaterial({ color: c, metalness: 0.35, roughness: 0.55 }));
    const cabMat = new THREE.MeshStandardMaterial({ color: 0x1b2735, metalness: 0.2, roughness: 0.35 });
    for (let i = 0; i < TRAFFIC_MAX && tSegs.length; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, bodyMats[i % bodyMats.length]); body.position.y = 0.6; body.castShadow = true;
      const cab = new THREE.Mesh(cabGeo, cabMat); cab.position.set(0, 1.18, -0.25);
      g.add(body); g.add(cab); g.frustumCulled = false; g.visible = false; ctx.scene.add(g);
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
  ctx.trafficTick = 0;
  function updateTraffic(dt, now) {
    if (!ctx.roadLifeOn) { hideTraffic(); return; }
    const active = trafficActiveCount();
    ctx.trafficTick++;
    for (let ci = 0; ci < traffic.length; ci++) {
      const c = traffic[ci];
      if (ci >= active) { if (c.group.visible) c.group.visible = false; continue; }   // parked by the density slider
      const dx = c.b[0] - c.a[0], dz = c.b[1] - c.a[1], len = Math.hypot(dx, dz) || 1;
      const fdx = dx / len, fdz = dz / len, rgx = fdz, rgz = -fdx;   // forward + right (for lanes)
      let cxp = c.a[0] + dx * c.t, czp = c.a[1] + dz * c.t;          // centreline point
      // YIELD: when the player is close and roughly ahead, the car slows right down (and
      // swings wide, below) so it's never an unavoidable head-on — you always have room.
      const toP = Math.hypot(ctx.car.x - cxp, ctx.car.z - czp);
      const ahead = (ctx.car.x - cxp) * fdx + (ctx.car.z - czp) * fdz;
      const yielding = toP < 28 && ahead > -6;
      const spdMul = yielding ? clamp((toP - 7) / 20, 0.06, 1) : 1;
      c.t += (c.speed * spdMul * dt) / len;
      if (c.t >= 1) { nextTrafficSeg(c); continue; }
      cxp = c.a[0] + dx * c.t; czp = c.a[1] + dz * c.t;
      // keep to the RIGHT of the centreline (a passable lane); if the player is bearing
      // down in this car's lane, swing wide to the OTHER side to clear a path.
      const pPerp = (ctx.car.x - cxp) * rgx + (ctx.car.z - czp) * rgz;       // >0 = player on the car's right
      const off = (yielding && pPerp > -1.2) ? -2.0 : 1.5;
      const x = cxp + rgx * off, z = czp + rgz * off;
      c.x = x; c.z = z;
      // GATE: cars far from the player are off-screen — hide them and skip the costly tile
      // raycast entirely (these 8 unthrottled casts were the biggest per-frame CPU chunk).
      if ((ctx.car.x - x) * (ctx.car.x - x) + (ctx.car.z - z) * (ctx.car.z - z) > 200 * 200) { c.group.visible = false; continue; }
      c.group.visible = true;
      // Use the SAME height authority as the player car. Raw groundAt follows the
      // bumpy photogrammetry mesh near home while the player rides the smooth
      // terrain road, which made traffic visibly float/sink on a different surface.
      // Keep the staggered refresh so only a few traffic cars sample tiles per frame.
      if (c.gy === undefined || (ctx.trafficTick + c.ti) % 4 === 0) c.gyT = ctx.ground.actorGroundY(x, z, c.gy) + 0.05;
      c.gy = c.gy === undefined ? c.gyT : c.gy + (c.gyT - c.gy) * Math.min(1, dt * 6);
      c.group.position.set(x, c.gy, z);
      c.group.rotation.set(0, Math.atan2(dx, dz), 0);
    }
  }
  function hideTraffic() { for (const c of traffic) c.group.visible = false; }
  function updateBeacons(now) {
    let nearestKey = null, nd = 1e18;
    for (const b of poiBeacons) { if (poiFound.has(b.poi.key)) continue; const d = Math.hypot(b.poi.x - ctx.car.x, b.poi.z - ctx.car.z); if (d < nd) { nd = d; nearestKey = b.poi.key; } }
    for (const b of poiBeacons) {
      const d = Math.hypot(b.poi.x - ctx.car.x, b.poi.z - ctx.car.z);
      const show = d > 16 && d < 1200;                // hide once you're basically there
      b.mesh.visible = show;
      if (!show) continue;
      const found = poiFound.has(b.poi.key);
      b.mat.color.setHex(found ? 0x6dffa8 : 0xff7ad8);
      const fade = clamp((d - 16) / 55, 0, 1) * clamp(1 - (d - 260) / 940, 0.3, 1);   // strong near, fades far
      const pulse = (b.poi.key === nearestKey && !ctx.reduceMotion) ? 0.7 + 0.3 * Math.sin(now * 0.006) : 0.8;
      b.mat.opacity = fade * 0.95 * pulse;
    }
    // name-plates: legible only when you're close enough to actually be AT the place
    for (const l of poiLabels) {
      const d = Math.hypot(l.poi.x - ctx.car.x, l.poi.z - ctx.car.z);
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
  ctx.arriveCenterT = 0;   // while now < this, the drive cams zero their look-ahead so the car frames dead-centre on arrival
  function arriveCelebrate(label, points, now) {
    ctx.arriveCenterT = now + 2600;
    const y = ctx.car.group ? ctx.car.group.position.y : 1;
    for (let k = 0; k < 4; k++) spawnCoinBurst(ctx.car.x + (k - 1.5) * 1.2, ctx.car.z, y, now);   // ~24 sparks
    if (ctx.audio.sfxChime) ctx.audio.sfxChime([523, 659, 784, 1047, 1319]);
    addBoost(0.5);                                     // arriving fills a big chunk of nitro for the next leg
    if (!ctx.reduceMotion) {
      ctx.timeScale = 0.4; ctx.slowmoHold = 0.32;             // HELD slow-mo (then it eases back) — a real beat, not a blink
      if (ctx.ui.fx) { ctx.ui.fx.classList.add('arrive'); setTimeout(() => ctx.ui.fx && ctx.ui.fx.classList.remove('arrive'), 850); }
    }
    // a second triumphant spark wave a beat later
    setTimeout(() => {
      if (ctx.mode !== 'drive') return;
      const y2 = ctx.car.group ? ctx.car.group.position.y : 1;
      for (let k = 0; k < 3; k++) spawnCoinBurst(ctx.car.x + (k - 1) * 1.6, ctx.car.z, y2, performance.now());
      if (ctx.audio.sfxChime) ctx.audio.sfxChime([784, 1047, 1319, 1568]);
    }, 280);
    ctx.emit('arrived', { label, points: points || 0, trip: ctx.tripScore });
  }

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
  const carsGroup = new THREE.Group(); ctx.scene.add(carsGroup);
  const parkedSpots = [];

  // Always-visible marker pin above the keeper (Scoop) — drawn on top of the
  // photoreal so Drew is never lost behind a real tree blob.
  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 4),
    new THREE.MeshBasicMaterial({ color: 0xffc21e, depthTest: false, transparent: true, opacity: 0.95 }));
  marker.rotation.x = Math.PI; marker.renderOrder = 20; marker.visible = false; marker.frustumCulled = false;
  ctx.scene.add(marker);
  // draw-to-drive target ring (Top-down view)
  const navMarker = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.7, 28),
    new THREE.MeshBasicMaterial({ color: 0xd94f1e, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  navMarker.rotation.x = -Math.PI / 2; navMarker.renderOrder = 19; navMarker.visible = false; navMarker.frustumCulled = false;
  ctx.scene.add(navMarker);
  // Scoop walk-to-drive cue: a tall poppy pin that floats high over the nearest
  // parked car (drawn through walls) so the keeper can find it from the backyard.
  const carMarker = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.7, 4),
    new THREE.MeshBasicMaterial({ color: 0xd94f1e, depthTest: false, transparent: true, opacity: 0.92 }));
  carMarker.rotation.x = Math.PI; carMarker.renderOrder = 20; carMarker.visible = false; carMarker.frustumCulled = false;
  ctx.scene.add(carMarker);
  // Compost pin: a green pin over the compost bin shown while the keeper is carrying
  // poop, so the empty-here loop is obvious (drawn through walls from anywhere).
  const compostMarker = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.7, 4),
    new THREE.MeshBasicMaterial({ color: 0x3a7d44, depthTest: false, transparent: true, opacity: 0.92 }));
  compostMarker.rotation.x = Math.PI; compostMarker.renderOrder = 20; compostMarker.visible = false; compostMarker.frustumCulled = false;
  ctx.scene.add(compostMarker);
  // ---- House interior (Scoop sub-scene) ----
  // The interior loads lazily and is mounted FAR from the yard (~2 km). Scoop's tight fog
  // (near 38 / far 92) hides the distant yard so the indoor camera only ever frames the room —
  // no per-object yard hide needed. scoopScene forks updateScoop between 'yard' and 'interior'.
  ctx.scoopScene = 'yard', ctx.interior = null, ctx.doorT = 0, ctx.entryArmed = true, ctx.exitArmed = false;
  ctx.npcs = [], ctx.npcsLoadStarted = false;   // non-playable house NPCs (dad, mom) — walk out of rooms + dance, never playable
  const NPC_LOADERS = [loadDadController, loadMomController];
  ctx._syncDance = false, ctx._syncDanceUntil = 0, ctx._syncDanceNext = 0;   // periodic in-house "everybody dance the SAME thing" moment
  const SYNC_DANCES = ['All_Night_Dance'];   // clip Dad + Mom both carry, so a pose() on all of them actually lines up
  const INT_CX = 0, INT_CZ = 3000, INT_FLOOR = 0;
  // Blue glowing pads: the front-yard "enter" pad and the indoor "exit" pad (drawn through walls).
  const doorMarker = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.7, 4),
    new THREE.MeshBasicMaterial({ color: 0x49b0ff, depthTest: false, transparent: true, opacity: 0.92 }));
  doorMarker.rotation.x = Math.PI; doorMarker.renderOrder = 20; doorMarker.visible = false; doorMarker.frustumCulled = false;
  ctx.scene.add(doorMarker);
  const exitMarker = new THREE.Mesh(doorMarker.geometry, doorMarker.material.clone());
  exitMarker.rotation.x = Math.PI; exitMarker.renderOrder = 20; exitMarker.visible = false; exitMarker.frustumCulled = false;
  ctx.scene.add(exitMarker);
  // Flat blue "exit pad" ring on the floor (the floating cone sits overhead, easy to miss when you
  // spawn standing on it) — drawn through walls so it's findable from anywhere inside.
  const exitRing = new THREE.Mesh(new THREE.RingGeometry(0.55, 1.05, 32),
    new THREE.MeshBasicMaterial({ color: 0x49b0ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: false }));
  exitRing.rotation.x = -Math.PI / 2; exitRing.renderOrder = 19; exitRing.visible = false; exitRing.frustumCulled = false;
  ctx.scene.add(exitRing);
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
  ctx.scene.add(guideLine);
  const destPin = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.4, 4),
    new THREE.MeshBasicMaterial({ color: 0xffc21e, depthTest: false, transparent: true, opacity: 0.95 }));
  destPin.rotation.x = Math.PI; destPin.renderOrder = 21; destPin.visible = false; destPin.frustumCulled = false;
  ctx.scene.add(destPin);
  // "You are here" locator — a bright downward chevron + halo bobbing over the car, drawn
  // on top, so you can FIND the car in the high aerial / top-down views where it's tiny.
  const carLocator = new THREE.Group();
  { const cone = new THREE.Mesh(new THREE.ConeGeometry(1.9, 3.6, 4), new THREE.MeshBasicMaterial({ color: 0x3ad6ff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.92 }));
    cone.rotation.x = Math.PI; cone.renderOrder = 1001;
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.4, 28), new THREE.MeshBasicMaterial({ color: 0x3ad6ff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = -3.2; ring.renderOrder = 1000;
    carLocator.add(cone); carLocator.add(ring); }
  carLocator.frustumCulled = false; carLocator.visible = false; ctx.scene.add(carLocator);

  // Scoop renders the procedural world, so Drew collides with every visible
  // procedural tree (they sit along the streets, clear of the backyard sanctuary).
  // sancCx/sancCz mark the backyard centre (behind the house toward the creek).
  const sancCx = -16, sancCz = -10;
  const SCOOP_CLEAR_R = 25;
  const scoopTrees = ctx.treePts;

  // The scoop backyard: a disc of the REAL procedural ground — true topology
  // (terrainAt heights) + the aerial photo (uvAt on the shared terrain material),
  // not a flat green pad. The photoreal neighborhood streams beyond it.
  ctx.scoopGrass = null;
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
    const yardMat = ctx.aerialMat.clone();
    yardMat.transparent = true; yardMat.depthWrite = false;
    yardMat.onBeforeCompile = sh => {
      sh.uniforms.uYC = { value: new THREE.Vector2(sancCx, sancCz) };
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
    ctx.scoopFence = new THREE.Mesh(merge(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .85 }));
    ctx.scoopFence.castShadow = true; ctx.scoopFence.visible = false; ctx.scoopFence.frustumCulled = false;
    ctx.scene.add(ctx.scoopFence);
  }
  // Building collision for Scoop. The sanctuary structures (barn/shed/coop) and
  // the house are all rendered procedurally in Scoop now, so Drew should bump
  // them. insideScoopBuilding tests the tight footprint polygon (not the oversized
  // AABB), so keeping every building can't wall off the open lawn.
  const scoopBldPolys = ctx.bldPolys;
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
  ctx.p3dtiles = null;
  ctx._tilesUpdT = 0;   // throttle the (expensive, full-tree) tiles LOD traversal to ~18 Hz
  const DEG = Math.PI / 180;
  // live-tunable photoreal placement (window.__dahill.p3dt; call nudge()).
  // yOffset lifts the photoreal ground to the procedural terrain height; xOffset/
  // zOffset + spin (deg) translate/rotate the photoreal world about the house so
  // it matches the procedural frame (spawns + collision). Spin pivots on origin.
  const P3DT = { yOffset: 32, xOffset: 0, zOffset: 0, spin: 0 };
  const applyP3DT = () => {
    if (!ctx.p3dtiles || !ctx.p3dtiles.holder) return;
    const h = ctx.p3dtiles.holder;
    h.rotation.y = P3DT.spin * DEG;
    h.position.set(P3DT.xOffset, P3DT.yOffset, P3DT.zOffset);
  };
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
    P3DT.yOffset = clamp(P3DT.yOffset + adjust, 8, 56);
    applyP3DT();
    ctx.alignDone = true;
    return true;
  }
  // ---- tile prefetch ----------------------------------------------------------
  // A small, low-res "scout" camera swept ALONG the active route ahead of the car so the
  // Google tiles for where you're GOING stream into the cache before you arrive (and the
  // ground-height probe ahead has data). Only on while a destination is set — exactly when
  // you're driving somewhere far — so free-roam near home pays nothing. Low resolution means
  // it warms only cheap COARSE tiles, filling the LRU cache without blowing the mobile budget.
  const scoutCam = new THREE.PerspectiveCamera(60, 1.5, 1, 4000);
  ctx.scoutOn = false, ctx._scoutT = 0, ctx._scoutPhase = 0;
  function pointAlongRoute(dist) {
    if (!ctx.ROUTE || ctx.ROUTE.length < 2) return null;
    let px = ctx.car.x, pz = ctx.car.z, acc = 0;
    for (let i = Math.max(0, ctx.routeIdx); i < ctx.ROUTE.length; i++) {
      const dx = ctx.ROUTE[i].x - px, dz = ctx.ROUTE[i].z - pz, seg = Math.hypot(dx, dz) || 1e-3;
      if (acc + seg >= dist) { const t = (dist - acc) / seg; return { x: px + dx * t, z: pz + dz * t }; }
      acc += seg; px = ctx.ROUTE[i].x; pz = ctx.ROUTE[i].z;
    }
    return { x: px, z: pz };
  }
  function setScout(on) {
    if (on === ctx.scoutOn || !ctx.p3dtiles) return;
    ctx.scoutOn = on;
    if (on) { ctx.p3dtiles.setCamera(scoutCam); ctx.p3dtiles.setResolution(scoutCam, 360, 240); }
    else if (ctx.p3dtiles.deleteCamera) ctx.p3dtiles.deleteCamera(scoutCam);
  }
  function updateTilePrefetch(now) {
    if (!ctx.p3dtiles || ctx.mode !== 'drive' || !ctx.p3dtiles.holder.visible || !ctx.DEST || !ctx.ROUTE || ctx.ROUTE.length < 2) { setScout(false); return; }
    if (now - ctx._scoutT < 220) return;                       // ~4.5 Hz
    ctx._scoutT = now;
    setScout(true);
    ctx._scoutPhase = (ctx._scoutPhase + 1) % 6;                   // sweep the aim through the corridor ahead…
    const p = pointAlongRoute(90 + ctx._scoutPhase * 135);     // …≈90–765 m along the route (reach matches the faster rail cruise)
    if (!p) { setScout(false); return; }
    const gy = ctx.car.groundY != null ? ctx.car.groundY : 0;
    scoutCam.up.set(0, 0, -1);
    scoutCam.position.set(p.x, gy + 260, p.z);             // high, straight down → warms the ground tiles ahead
    scoutCam.lookAt(p.x, gy, p.z);
    scoutCam.updateMatrixWorld(true);
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
    const photoOn = photoModes(ctx.mode) && ctx.p3dtiles && ctx.tilesReady;
    if (ctx.p3dtiles) ctx.p3dtiles.holder.visible = photoModes(ctx.mode);
    if (ctx.p3dtiles && ctx.p3dtiles.clipPlanes && ctx.mode !== 'drive') ctx.p3dtiles.clipPlanes.length = 0;   // R8 cutaway is Drive-only; never slice the Explore high-orbit / Scoop
    ctx.staticGroup.visible = ctx.mode === 'scoop' || !photoOn;   // procedural in Scoop, or as the no-tiles fallback
    carsGroup.visible = ctx.mode === 'drive' || ctx.mode === 'scoop';   // parked cars: ground modes only
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
    setTimeout(() => { if (!ctx.disposed && photoModes(ctx.mode) && !ctx.tilesReady) ctx.toast(msg, 2600); }, 6100);
  }
  if (!ctx.flags.has('flat')) {
    if (!import.meta.env.VITE_GOOGLE_MAPS_KEY) delayedTileFallbackToast('Photoreal map key missing — showing the built world');
    const LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * DEG);
    const houseLat = (LAT0 + C[1] / 110540) * DEG;
    const houseLon = (LON0 + C[0] / (COSLAT * 111320)) * DEG;
    import('./tiles3d.js').then(({ createPhotorealTiles }) => {
      if (ctx.disposed) return;
      ctx.p3dtiles = createPhotorealTiles(ctx.scene, ctx.camera, ctx.renderer, {
        // raise errorTarget on phones (coarser tiles) — leaf-tile geometry/texture
        // is the dominant iOS memory cost, and Drive can now roam far and stream more.
        lat: houseLat, lon: houseLon, azimuth: Math.PI, errorTarget: ctx.MOBILE ? 16 : 10, mobile: ctx.MOBILE
      });
      if (!ctx.p3dtiles) { if (import.meta.env.VITE_GOOGLE_MAPS_KEY) delayedTileFallbackToast('Photoreal map unavailable — showing the built world'); return; }
      if (ctx.disposed) { if (ctx.p3dtiles.disposeAll) ctx.p3dtiles.disposeAll(); ctx.p3dtiles = null; return; }
      applyP3DT();
      let tries = 0;
      ctx.p3dtiles.addEventListener('load-model', () => {
        if (!ctx.tilesReady) { ctx.tilesReady = true; ctx.emit('photoreal', true); }
        // Vertically align the photoreal ground to the procedural terrain as the
        // street tiles stream (Explore/Drive only — Scoop never shows tiles).
        if (tries < 24) { tries++; alignP3DT(); }
        applyModeVisuals();          // hide procedural once tiles are up (Explore/Drive)
      });
      // surface auth/quota/referrer failures instead of silently falling back to
      // the procedural world (a baked, referrer-blocked or over-quota key 403s here).
      let warnedErr = false;
      ctx.p3dtiles.addEventListener('load-error', e => {
        if (warnedErr) return; warnedErr = true;
        console.warn('[tiles3d] tile load error (check VITE_GOOGLE_MAPS_KEY restrictions/quota)', e && e.error);
        if (!ctx.tilesReady) ctx.toast('Photoreal map unavailable — showing the built world', 2600);
      });
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
  const animals = createAnimals(ctx.scene, { terrainAt, SREC, bldBoxes: ctx.bldBoxes, onPoopChange: () => { ctx.scoopHudDirty = true; } });
  const { ANIMALS, POOPS, updateAnimals, removePoop } = animals;
  ctx.CHAR = createCharacter(ctx.scene, SREC);
  const cleanPct = () => Math.max(0, Math.round(100 * (1 - POOPS.length / POOP_ACTIVE_CAP)));

  // ---- CROWD: dancing CeCe + Drew characters. Yard dancers liven up Scoop; street
  // dancers + clusters at every preset destination liven up Drive. Visibility is mode- and
  // distance-gated so only a handful animate at once (skinned meshes aren't cheap).
  ctx.ceceCrowd = null, ctx.drewCrowd = null, ctx.dadCrowd = null, ctx.momCrowd = null;
  // Pick a street/scatter pedestrian: mostly the CeCe/Drew kids, with the occasional grown-up Dad/Mom
  // mixed in (taller, distinct models). Falls back to the kids if the adult rigs haven't loaded.
  const pickPed = (i) => { const r = Math.random(); if (ctx.dadCrowd && r < 0.09) return ctx.dadCrowd; if (ctx.momCrowd && r < 0.18) return ctx.momCrowd; return (i & 1) ? ctx.ceceCrowd : ctx.drewCrowd; };
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
      const gy = onRoadHt ? ctx.ground.actorGroundY(x, z) : terrainAt(x, z);
      const y = (Number.isFinite(gy) ? gy : (ctx.car.groundY ?? 0)) + 0.02;
      const yaw = opts.yaw != null ? opts.yaw : Math.random() * Math.PI * 2;
      crowdSpots.push({ rec: crowd.add(ctx.scene, { x, y, z, yaw, clip: opts.clip }), zone, onRoadHt: !!onRoadHt, settleT: 0 });
    };
    const hx = ctx.house.c[0], hz = ctx.house.c[1];
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
    for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2 + 0.5, r = 6 + i * 1.6; const [px, pz] = clearYard(hx + Math.cos(a) * r, hz + Math.sin(a) * r); put(ctx.ceceCrowd, px, pz, 'yard', false); }
    for (let i = 0; i < 2; i++) { const a = i * 2.3 + 1.6; const [px, pz] = clearYard(hx + Math.cos(a) * 8.5, hz + Math.sin(a) * 8.5); put(ctx.drewCrowd, px, pz, 'yard', false, { clip: 'dance' }); }
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
      for (const s of ctx.roadSegs) { const L = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]); if (L >= 6) totalCurb += L; }
      const step = totalCurb > 0 ? Math.max(12, totalCurb / Math.max(1, sidewalkTarget)) : 1e9;
      for (const s of ctx.roadSegs) {
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
        const crowd = (i + pi) % 2 ? ctx.ceceCrowd : ctx.drewCrowd;
        put(crowd, p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, p.key, true, {
          yaw: a + Math.PI,
          clip: crowd === ctx.drewCrowd ? (i % 2 ? 'dance' : 'cheer') : undefined
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
    scatterCluster(ctx.ceceCrowd, POIS.find(q => q.key === 'stanton'), cn, 'All_Night_Dance');   // CeCe all over Stanton Elementary (cn hoisted above, counted against the cap)
    scatterCluster(ctx.drewCrowd, POIS.find(q => q.key === 'canyon'), cn, 'dance');               // Drew all over Canyon Middle
    scatterCluster(ctx.dadCrowd, D > 0 ? POIS.find(q => q.key === 'dad') : null, Math.min(8, cn), 'Bass_Beats');   // a few Mikes hanging around XQ (Dad's work)
    // MEEMAW: a CeCe + Drew pair dancing together right out front of the house.
    const meemaw = D > 0 ? POIS.find(q => q.key === 'meemaw') : null;
    if (meemaw) {
      const a = Math.PI / 2, r = 7;   // out the front, side by side, facing back toward the house
      const fx = meemaw.x + Math.cos(a) * r, fz = meemaw.z + Math.sin(a) * r;
      put(ctx.ceceCrowd, fx - 1.2, fz, 'meemaw', true, { yaw: a + Math.PI, clip: 'All_Night_Dance' });
      put(ctx.drewCrowd, fx + 1.2, fz, 'meemaw', true, { yaw: a + Math.PI, clip: 'dance' });
    }
    placeInteriorDancers();   // the decorative Drew + CeCe inside the house (survives a density re-pool)
  }
  // Remove every placed pedestrian (stop mixers, detach groups, drop the clone pool) so a
  // density change can re-place from scratch without leaking clones/mixers.
  function clearCrowd() {
    for (const sp of crowdSpots) { if (sp.rec.grp.parent) sp.rec.grp.parent.remove(sp.rec.grp); sp.rec.mixer.stopAllAction(); }
    crowdSpots.length = 0;
    if (ctx.ceceCrowd) ctx.ceceCrowd.removeAll(); if (ctx.drewCrowd) ctx.drewCrowd.removeAll();
    if (ctx.dadCrowd) ctx.dadCrowd.removeAll(); if (ctx.momCrowd) ctx.momCrowd.removeAll();
  }
  function setCrowdDensity(v) {
    CROWD_DENSITY = clamp(+v || 0, 0, 2);
    try { localStorage.setItem('dahill.peddensity', String(CROWD_DENSITY)); } catch (e) { }
    // DEBOUNCE the re-pool: a slider drag fires every step, and clearCrowd()+placeCrowd()
    // re-clones the whole pedestrian pool (skinned-mesh clones) — doing that per step stalls the
    // main thread. Re-pool once, ~220 ms after the drag settles.
    clearTimeout(_crowdReplaceT);
    _crowdReplaceT = setTimeout(() => { if (!ctx.disposed && ctx.ceceCrowd && ctx.drewCrowd) { clearCrowd(); placeCrowd(); } }, 220);
    return CROWD_DENSITY;
  }
  let _crowdN = 0, _crowdPlaced = false, _placedNoAdults = false;
  const _doPlace = () => { if (ctx.disposed || _crowdPlaced || !(ctx.ceceCrowd && ctx.drewCrowd)) return; _crowdPlaced = true; _placedNoAdults = !(ctx.dadCrowd && ctx.momCrowd); placeCrowd(); geocodePOIs(); };
  const _onCrowd = () => {
    if (ctx.disposed) return;
    _crowdN++;
    if (!_crowdPlaced) { if (_crowdN >= 4) _doPlace(); return; }   // wait for all four rigs so Dad/Mom are mixed in from the FIRST placement (no slider needed)
    // If the 9 s fallback placed a kids-only crowd before the adult rigs loaded, re-pool ONCE (debounced,
    // same path as the density slider) when both Dad + Mom finally arrive so they aren't absent all session.
    if (_placedNoAdults && ctx.dadCrowd && ctx.momCrowd) { _placedNoAdults = false; clearTimeout(_crowdReplaceT); _crowdReplaceT = setTimeout(() => { if (!ctx.disposed && ctx.ceceCrowd && ctx.drewCrowd) { clearCrowd(); placeCrowd(); } }, 220); }
  };
  if (!ctx.flags.has('nochar')) {
    loadCeceCrowd(c => { if (!ctx.disposed) ctx.ceceCrowd = c; _onCrowd(); }, () => _onCrowd());
    loadDrewCrowd(c => { if (!ctx.disposed) ctx.drewCrowd = c; _onCrowd(); }, () => _onCrowd());
    loadDadCrowd(c => { if (!ctx.disposed) ctx.dadCrowd = c; _onCrowd(); }, () => _onCrowd());
    loadMomCrowd(c => { if (!ctx.disposed) ctx.momCrowd = c; _onCrowd(); }, () => _onCrowd());
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
    const y = ctx.ground.actorGroundY(sp.rec.x, sp.rec.z, sp.rec.baseY) + 0.02;
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
    const fromHome = Math.hypot(ctx.car.x, ctx.car.z);
    const segs = (fromHome < 340 && ctx.roadSegs.length) ? ctx.roadSegs : (ctx.osmRoadSegs.length ? ctx.osmRoadSegs : ctx.roadSegs);
    let nx = null, nz = null;
    if (segs && segs.length) {
      for (let tr = 0; tr < 8; tr++) {
        const s = segs[(Math.random() * segs.length) | 0];
        const ax = s[0][0], az = s[0][1], bx = s[1][0], bz = s[1][1];
        const sdx = bx - ax, sdz = bz - az, L = Math.hypot(sdx, sdz); if (L < 6) continue;
        const t = Math.random(), cx = ax + sdx * t, cz = az + sdz * t;
        const d = Math.hypot(cx - ctx.car.x, cz - ctx.car.z);
        if (d < 45 || d > 230) continue;                                   // not on top of you, within the cull radius
        const ux = sdx / L, uz = sdz / L, side = Math.random() < 0.5 ? 1 : -1;
        const off = SIDEWALK_OFF + Math.random() * 1.4;
        nx = cx + (-uz) * side * off; nz = cz + ux * side * off; break;     // out to the sidewalk
      }
    }
    if (nx == null) { const a = Math.random() * Math.PI * 2, r = 70 + Math.random() * 150; nx = ctx.car.x + Math.cos(a) * r; nz = ctx.car.z + Math.sin(a) * r; }
    const rec = sp.rec;
    rec.x = nx; rec.z = nz; rec.baseX = nx; rec.baseZ = nz;
    rec.grp.position.x = nx; rec.grp.position.z = nz;
    rec.baseY = (Number.isFinite(ctx.car.groundY) ? ctx.car.groundY : 0) + 0.02;    // rough; settle snaps to the real tile ground when visible. Number.isFinite guards a NaN groundY (?? lets NaN through → ped stuck underground forever)
    rec.grp.position.y = rec.baseY;
    rec.vel = null; rec.respawnAt = 0; sp.onRoadHt = true; sp.settleT = 0;
  }
  function updateCrowd(dt, now) {
    if (!crowdSpots.length) return;
    const inDrive = ctx.mode === 'drive', inScoop = ctx.mode === 'scoop';
    const wantInt = inScoop && ctx.scoopScene === 'interior';
    if (!ctx.roadLifeOn) {
      // "People + traffic" OFF hides street/yard pedestrians — but the in-house companion is gameplay,
      // not road life, so keep showing + ticking it.
      for (const sp of crowdSpots) sp.rec.grp.visible = wantInt && sp.zone === 'interior' && sp.char !== ctx.CHAR.avatar;
      if (wantInt) { if (ctx.ceceCrowd) ctx.ceceCrowd.tick(dt, now); if (ctx.drewCrowd) ctx.drewCrowd.tick(dt, now); if (ctx.dadCrowd) ctx.dadCrowd.tick(dt, now); if (ctx.momCrowd) ctx.momCrowd.tick(dt, now); }
      return;
    }
    if (inScoop) {
      for (const sp of crowdSpots) {
        // indoors: show only the companion you're NOT playing (one at a time); outdoors: the yard pair
        if (sp.zone === 'interior') sp.rec.grp.visible = wantInt && sp.char !== ctx.CHAR.avatar;
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
          const d2 = (sp.rec.x - ctx.car.x) ** 2 + (sp.rec.z - ctx.car.z) ** 2;
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
    if (inDrive && Math.abs(ctx.car.speed) > 6 && now - _crowdHitT > 250) {
      const dir = Math.sign(ctx.car.speed) || 1, vx = Math.sin(ctx.car.yaw) * dir, vz = Math.cos(ctx.car.yaw) * dir, sp = Math.abs(ctx.car.speed);
      const hit = (ctx.ceceCrowd && ctx.ceceCrowd.launchNear(ctx.car.x, ctx.car.z, vx, vz, sp)) || (ctx.drewCrowd && ctx.drewCrowd.launchNear(ctx.car.x, ctx.car.z, vx, vz, sp)) || (ctx.dadCrowd && ctx.dadCrowd.launchNear(ctx.car.x, ctx.car.z, vx, vz, sp)) || (ctx.momCrowd && ctx.momCrowd.launchNear(ctx.car.x, ctx.car.z, vx, vz, sp));
      if (hit) { _crowdHitT = now; if (ctx.audio.sfxThunk) ctx.audio.sfxThunk(0.5); ctx.toast('🎳 WHEEE!', 700); if (navigator.vibrate) { try { navigator.vibrate(22); } catch (e) { } } }
    }
    if (ctx.ceceCrowd) ctx.ceceCrowd.tick(dt, now);   // tick() advances visible mixers + any in-flight launch
    if (ctx.drewCrowd) ctx.drewCrowd.tick(dt, now);
    if (ctx.dadCrowd) ctx.dadCrowd.tick(dt, now);
    if (ctx.momCrowd) ctx.momCrowd.tick(dt, now);
  }

  ctx.disposed = false;
  ctx.car = createCar(ctx.scene);
  function clearRouteRail() {
    ctx.car.railS = null;
    ctx.car.railSpeed = null;
    ctx.car.railEndT = 0;
    ctx._railRoute = null;
  }
  ctx.car.group.scale.setScalar(1.1);   // the player car renders ~10% bigger
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
    if (ctx.flags.has('nocar') || ctx.disposed) return;
    if (slot === 2) {   // Ferrari — Draco, lazy on first need (its own fallback toast)
      if (ferrariLoadStarted) return;
      ferrariLoadStarted = true;
      installDracoDecoder();
      cancelCarLoad = loadRealCar(ctx.car, carGlbUrl, () => { if (!ctx.disposed) ctx.toast('Using fallback car model'); });
      return;
    }
    if (ctx.car.models[slot] || vehLoading.has(slot)) return;   // already loaded / in flight
    const def = CAR_DEFS[slot];
    if (!def) return;
    vehLoading.add(slot);
    modelLoadCancels.push(loadDrivableCar(ctx.car, def.url, slot, {
      length: def.length, flip: def.flip !== false, black: false, extraYaw: def.extraYaw || 0, meta: VEHICLES[slot],   // default nose -Z (flip:true); extraYaw is a per-car quarter-turn for odd model axes
      onReady: (s) => { vehLoading.delete(s); ctx.emit('cars', getCars()); if (ctx.car.modelIdx === s) showCarCard(); }
    }));
  }
  if (!ctx.flags.has('nocar')) {
    installDracoDecoder();
    // START ON A RANDOM CAR: pick a random non-Ferrari roster slot as this session's default,
    // load ONLY that one (others stay lazy), and hold the reveal until it arrives.
    const startable = Object.keys(CAR_DEFS).map(Number);
    ctx.car.defaultSlot = startable[(Math.random() * startable.length) | 0];
    ctx.car.heldForDefault = true;
    // fallback: if the random default is slow/fails, after ~2.8 s show whatever HAS loaded
    setTimeout(() => { if (!ctx.disposed && ctx.car.heldForDefault) { ctx.car.heldForDefault = false; const f = ctx.car.models.findIndex(Boolean); if (f >= 0) setVehicle(ctx.car, f); else ensureVehicle(0); } }, 2800);
    ensureVehicle(ctx.car.defaultSlot);
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
        ctx.bldPolys.push({ p, bb: [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)] });
      }));
    };
    park(rav4Url, 1, 4.6, false, false);  // RAV4 nose runs +Z → carYaw already faces it; black baked in (keeps taillights)
    park(siennaUrl, -1, 5.1, false, false);   // GLB nose runs -Z; black baked in (keeps taillights)
  }
  ctx.showT = 0;

  function showCarCard() {
    const v = ctx.car.models[ctx.car.modelIdx];
    const meta = v && v.name ? v : VEHICLES[0];     // fallback card while no GLB has loaded yet
    ctx.emit('carCard', { name: meta.name, spec: meta.spec, credit: meta.credit || '' });
  }
  function cycleCar() {
    if (!cycleVehicle(ctx.car)) { ctx.toast('Open the garage (☰ → Cars) to pick another ride'); return; }
    showCarCard();
    ctx.audio.blip();
  }
  // The Ferrari (slot 2) is the reward for finding all 5 neighbourhood places.
  ctx.ferrariUnlocked = (() => { try { return localStorage.getItem('dahill.drive.ferrari') === '1'; } catch (e) { return false; } })();
  function checkFerrariUnlock() {
    if (ctx.ferrariUnlocked || poiFound.size < POIS.length) return;
    ctx.ferrariUnlocked = true;
    try { localStorage.setItem('dahill.drive.ferrari', '1'); } catch (e) { }
    ctx.toast('🏎️ You earned the Ferrari 458! Tap 🚗 to drive it', 4000);
    if (ctx.audio.sfxChime) ctx.audio.sfxChime([523, 659, 784, 1047]);
    ctx.emit('cars', getCars());
  }
  function getCars() { return vehicleList(ctx.car).map(v => v.slot === 2 ? Object.assign({}, v, { locked: !ctx.ferrariUnlocked }) : v); }
  function pickCar(slot) {
    if (slot === 2 && !ctx.ferrariUnlocked) { ctx.toast('🔒 Find all 5 neighbourhood places to unlock the Ferrari!', 2400); return; }
    ensureVehicle(slot);                              // lazy: fetch its GLB now if it isn't loaded yet
    if (setVehicle(ctx.car, slot)) { showCarCard(); ctx.audio.blip(); }
    else { ctx.car.pendingPick = slot; ctx.toast('Loading ' + (VEHICLES[slot] ? ctx.esc(VEHICLES[slot].name) : 'car') + '…', 1500); }   // it swaps in (registerVehicle) the moment it arrives
  }

  // (Street-view photo billboards removed — they read as odd roadside signs.
  //  Real street imagery now lives on the buildings: photoreal Google 3D Tiles
  //  when enabled, the procedural facade texture otherwise.)

  // "Look inside" (dollhouse) removed — keep the procedural interior hidden.
  ctx.interiorGroup.visible = false;   // legacy procedural dollhouse stays hidden; the GLB interior replaces it

  // Inward normal from the curb toward the house (frontDir is the ROAD TANGENT — never inward),
  // and a back-door pad on the yard/patio side (near where Scoop is played).
  // Put the "go inside" pad on the house side FACING the Scoop play area (the sanctuary spawn), so
  // the player walks straight into it. entryU points from the house centre toward that spawn.
  const _spawnPt = [(SREC.coop[0] + SREC.pen[0]) / 2, (SREC.coop[1] + SREC.pen[1]) / 2];
  const _toSpawn = [_spawnPt[0] - ctx.house.c[0], _spawnPt[1] - ctx.house.c[1]];
  const _uL = Math.hypot(_toSpawn[0], _toSpawn[1]) || 1;
  const entryU = [_toSpawn[0] / _uL, _toSpawn[1] / _uL];
  const _halfExt = 0.5 * (Math.abs(entryU[0]) * (ctx.house.bbox[1] - ctx.house.bbox[0]) + Math.abs(entryU[1]) * (ctx.house.bbox[3] - ctx.house.bbox[2]));
  const entryPt = [ctx.house.c[0] + entryU[0] * (_halfExt + 1.6), ctx.house.c[1] + entryU[1] * (_halfExt + 1.6)];

  if (!ctx.flags.has('nointerior')) {
    modelLoadCancels.push(createInterior(ctx.scene, { cx: INT_CX, cz: INT_CZ, floorY: INT_FLOOR },
      mod => { ctx.interior = mod; ctx.interior.group.visible = ctx.scoopScene === 'interior'; placeInteriorDancers(); ctx.emit('house', { inside: ctx.scoopScene === 'interior', ready: true }); },
      () => { /* fail-soft: the door pad just stays inert */ }));
  }

  // Show/hide the interior. The yard is NOT hidden object-by-object — it's 2 km away and fogged
  // out — so this only flips the scene flag, the interior group, and yard-only pins.
  function setInside(on) {
    ctx.scoopScene = on ? 'interior' : 'yard';
    if (ctx.interior) ctx.interior.group.visible = on;
    if (on) { marker.visible = false; carMarker.visible = false; compostMarker.visible = false; doorMarker.visible = false; if (ctx.nearCar) { ctx.nearCar = false; ctx.emit('nearCar', false); } }
    else { exitMarker.visible = false; exitRing.visible = false; for (const npc of ctx.npcs) npc.group.visible = false; }
    ctx.emit('house', { inside: on, ready: !!ctx.interior });
  }
  function enterHouse(now) {
    if (!ctx.interior) return;
    setInside(true);
    const sp = ctx.interior.spawn;
    ctx.CHAR.x = sp.x; ctx.CHAR.z = sp.z; ctx.CHAR.yaw = sp.yaw; ctx.camYawS = sp.yaw;
    ctx.CHAR.airY = 0; ctx.CHAR.vy = 0; ctx.camInit = false; ctx.szoom = 1; ctx.scPitch = 0.2; ctx.camGroundRef = null;   // reset tilt so indoor entry framing is consistent (not pinned to the ceiling)
    ctx.doorT = now + 1200; ctx.exitArmed = false;
    // House NPCs (dad, mom): lazy-load on first entry, then have each walk out of a room and dance.
    if (!ctx.npcsLoadStarted) {
      ctx.npcsLoadStarted = true;
      for (const load of NPC_LOADERS) load(ctrl => { if (ctx.disposed) return; const g = new THREE.Group(); g.add(ctrl.group); g.visible = false; ctx.scene.add(g); ctx.npcs.push({ ctrl, group: g, x: 0, z: 0, yaw: 0, state: 'act', act: 'idle', actUntil: 0 }); resetNpcs(); }, () => {});
    } else resetNpcs();
    if (ctx.audio.blip) ctx.audio.blip();
    ctx.toast('🏠 Inside the house! Open the ☰ menu (top-right) for characters &amp; actions · tap "Leave house 🚪" to head back out', 3600);
  }
  // ---- House NPCs: a small behaviour FSM (dad, mom) ------------------------------------------
  // They WANDER room to room — collision-checked (interior.collide, so no walking through walls /
  // furniture) and door-routed — with a bias to share the player's room. On arrival they pick an
  // activity: cycle dances, sprinkle one-shot emote beats, idle, or (if they have a sit clip) SIT
  // down on a couch. State per NPC: 'travel' | 'act'.
  const NPC_RAD = 0.34, NPC_SPD = 1.35;
  function playerRoomIndex() {
    const rs = ctx.interior.rooms;
    if (!rs || !rs.length) return 0;
    for (let i = 0; i < rs.length; i++) { const r = rs[i]; if (ctx.CHAR.x >= r.minX && ctx.CHAR.x <= r.maxX && ctx.CHAR.z >= r.minZ && ctx.CHAR.z <= r.maxZ) return i; }
    let best = 0, bd = Infinity; rs.forEach((r, i) => { const d = (r.x - ctx.CHAR.x) ** 2 + (r.z - ctx.CHAR.z) ** 2; if (d < bd) { bd = d; best = i; } }); return best;
  }
  // ---- ROOM-GRAPH NAVIGATION: NPCs PLAN a path room-to-room (BFS through doorways) instead of walking
  // a straight line into a wall and jamming. The rooms + doorways are static, so the connectivity graph
  // is built once and cached on `interior`. Each doorway connects the two rooms whose AABBs it sits on.
  function roomGraph() {
    if (ctx.interior._navGraph) return ctx.interior._navGraph;
    const rooms = ctx.interior.rooms || [], dws = ctx.interior.doorways || [];
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
    return (ctx.interior._navGraph = adj);
  }
  function roomIndexAt(x, z) {
    const rooms = ctx.interior.rooms || [];
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
    npc.wantSeat = null; npc.baseY = ctx.interior.floorY;
    const roll = Math.random();
    if (roll < 0.45 && npc.ctrl.dances.length) { npc.act = 'dance'; npc.nextMove = 0; triggerMove(npc, now); }
    else if (roll < 0.78 && (npc.ctrl.emotes.length || npc.ctrl.dances.length)) { npc.act = 'emote'; npc.nextMove = 0; triggerMove(npc, now); }
    else { npc.act = 'idle'; npc.ctrl.locomotion(0); }
    npc.actUntil = now + 5000 + Math.random() * 7000;
  }
  function pickNextRoom(npc, now) {
    if (npc.ctrl.reset) npc.ctrl.reset();   // stand up from a sit / end any dance cleanly before walking
    npc.seat = null; npc.baseY = ctx.interior.floorY;
    const rs = ctx.interior.rooms;
    if (!rs || !rs.length) { npc.state = 'act'; npc.act = 'idle'; npc.actUntil = now + 4000; return; }   // no rooms (GLB w/o floors) — just idle
    const room = (Math.random() < 0.55 ? rs[playerRoomIndex()] : rs[(Math.random() * rs.length) | 0]) || rs[0];
    let wantSeat = null;   // sometimes go sit on a free couch
    if (npc.ctrl.sitClip && ctx.interior.seats && ctx.interior.seats.length && Math.random() < 0.4) {
      const taken = new Set(ctx.npcs.map(n => n.seat).filter(Boolean));
      let bs = Infinity; for (const s of ctx.interior.seats) { if (taken.has(s)) continue; const d = (s.x - room.x) ** 2 + (s.z - room.z) ** 2; if (d < bs) { bs = d; wantSeat = s; } }
    }
    npc.wantSeat = wantSeat;
    let tx, tz;
    if (wantSeat) { const ap = ctx.interior.clearAt(wantSeat.x + Math.sin(wantSeat.yaw) * 0.75, wantSeat.z + Math.cos(wantSeat.yaw) * 0.75, NPC_RAD, true); tx = ap.x; tz = ap.z; }
    else { const p = ctx.interior.clearAt(room.minX + 0.6 + Math.random() * Math.max(0.2, room.maxX - room.minX - 1.2), room.minZ + 0.6 + Math.random() * Math.max(0.2, room.maxZ - room.minZ - 1.2), NPC_RAD, true); tx = p.x; tz = p.z; }
    startTravel(npc, tx, tz);
  }
  // Each NPC starts in a distinct far room and heads for the main room, then wanders.
  function resetNpcs() {
    if (!ctx.interior || !ctx.interior.rooms || !ctx.interior.rooms.length || !ctx.npcs.length) return;
    ctx._syncDance = false; ctx._syncDanceNext = 0;   // re-arm the dance-party timer fresh on entry, so it doesn't fire instantly every time you step back inside
    const main = ctx.interior.spawn, now = performance.now();
    ctx.npcs.forEach((npc, i) => {
      if (npc.ctrl.reset) npc.ctrl.reset();
      // START clustered around the MAIN room (where the player enters) so they're together near you, not
      // scattered into far bedrooms they then get stuck pathing out of. They idle a beat, then wander off.
      const a = i / Math.max(1, ctx.npcs.length) * Math.PI * 2 + 0.4;
      const from = ctx.interior.clearAt(main.x + Math.cos(a) * 1.5, main.z + Math.sin(a) * 1.5, NPC_RAD, true);
      npc.x = from.x; npc.z = from.z; npc.yaw = Math.atan2(main.x - from.x, main.z - from.z); npc.seat = null; npc.wantSeat = null; npc.baseY = ctx.interior.floorY;
      npc.state = 'act'; npc.act = 'idle'; npc.actUntil = now + 2200 + Math.random() * 3500; npc.ctrl.locomotion(0);
      npc.group.visible = true; npc.group.position.set(npc.x, npc.baseY, npc.z);
    });
  }
  function updateNpcs(dt, now) {
    // SYNCHRONIZED DANCE PARTY: every ~30-55 s the whole house stops what it's doing and dances the
    // SAME clip together (pose() loops it, started on the same frame for all, so they stay in lockstep).
    if (!ctx._syncDanceNext) ctx._syncDanceNext = now + 20000 + Math.random() * 16000;
    if (ctx._syncDance && now > ctx._syncDanceUntil) { ctx._syncDance = false; ctx._syncDanceNext = now + 30000 + Math.random() * 25000; for (const npc of ctx.npcs) pickNextRoom(npc, now); }
    else if (!ctx._syncDance && now > ctx._syncDanceNext && ctx.npcs.length > 1 && ctx.interior) {
      ctx._syncDance = true; ctx._syncDanceUntil = now + 11000 + Math.random() * 6000;
      const clip = SYNC_DANCES[(Math.random() * SYNC_DANCES.length) | 0];
      for (const npc of ctx.npcs) {
        npc.state = 'act'; npc.act = 'dance'; npc.seat = null; npc.wantSeat = null; npc.baseY = ctx.interior.floorY;
        npc.yaw = Math.atan2(ctx.interior.spawn.x - npc.x, ctx.interior.spawn.z - npc.z);   // turn in toward the middle → a little dance circle
        if (npc.ctrl.pose) npc.ctrl.pose(clip);
      }
    }
    for (const npc of ctx.npcs) {
      npc.group.visible = true;
      // GREET: when the player walks up, turn to face them and throw a quick move (not mid-party).
      if (!ctx._syncDance && npc.state === 'act' && now > (npc.greetT || 0)) {
        const dpx = ctx.CHAR.x - npc.x, dpz = ctx.CHAR.z - npc.z;
        if (dpx * dpx + dpz * dpz < 2.7 * 2.7) {
          npc.greetT = now + 6500;
          if (npc.seat) { if (npc.ctrl.reset) npc.ctrl.reset(); npc.seat = null; npc.baseY = ctx.interior.floorY; }   // get up off the couch first, else she'd "stand" floating at seat height + hog the seat
          npc.yaw = Math.atan2(dpx, dpz);                                          // look at the player
          const pool = (npc.ctrl.emotes && npc.ctrl.emotes.length) ? npc.ctrl.emotes : npc.ctrl.dances;
          if (pool && pool.length && npc.ctrl.react) { npc.ctrl.react(pool[(Math.random() * pool.length) | 0]); npc.act = 'emote'; npc.nextMove = now + 2600; npc.actUntil = Math.max(npc.actUntil || 0, now + 2600); }
        }
      }
      let speed = 0;
      if (ctx._syncDance) { npc.group.position.set(npc.x, npc.baseY, npc.z); npc.group.rotation.y = npc.yaw - Math.PI / 2; npc.ctrl.tick(dt); continue; }   // partying: hold position, the pose() loops
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
            if (!door) { let bd = Infinity; for (const dw of (ctx.interior.doorways || [])) { const dd = (dw.x - npc.x) ** 2 + (dw.z - npc.z) ** 2; if (dd < bd) { bd = dd; door = dw; } } }   // graph said nothing → at least aim at the NEAREST opening, never a wall
            if (door && Math.hypot(door.x - npc.x, door.z - npc.z) > 0.3) { const px = gx - door.x, pz = gz - door.z, pl = Math.hypot(px, pz) || 1; tx = door.x + px / pl * 0.4; tz = door.z + pz / pl * 0.4; }   // aim ~0.4 m PAST the door toward the goal so the heading carries straight THROUGH the opening, not into the jamb
          }
          const dx = tx - npc.x, dz = tz - npc.z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d, want = NPC_SPD * dt;
          const r = ctx.interior.collide(npc.x, npc.z, npc.x + ux * want, npc.z + uz * want, NPC_RAD, true);
          const moved = Math.hypot(r.x - npc.x, r.z - npc.z);
          npc.x = r.x; npc.z = r.z; npc.yaw = Math.atan2(ux, uz); speed = moved / Math.max(dt, 1e-3);
          // "stuck" = collision is eating the step (a wall-jam) — judged by ACTUAL displacement, NOT
          // progress toward the final target, so routing to a side doorway waypoint can't false-trigger.
          if (moved < want * 0.35) { npc.stuckT += dt; if (npc.stuckT > 1.5) enterActivity(npc, now); } else npc.stuckT = 0;
        }
        npc.baseY = ctx.interior.floorY; npc.ctrl.locomotion(speed);
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
    if (entryPt) { ctx.CHAR.x = entryPt[0] + entryU[0] * 1.6; ctx.CHAR.z = entryPt[1] + entryU[1] * 1.6; ctx.CHAR.yaw = Math.atan2(entryU[0], entryU[1]); }
    ctx.camYawS = ctx.CHAR.yaw; ctx.CHAR.airY = 0; ctx.CHAR.vy = 0; ctx.camInit = false; ctx.szoom = 1; ctx.camGroundRef = null;
    ctx.doorT = now + 1200; ctx.entryArmed = false;
    if (ctx.audio.blip) ctx.audio.blip();
  }
  // A Drew + a CeCe hanging out inside (the original "a drew and cece inside") — decorative crowd
  // dancers, distinct from the playable avatar, gated to the interior scene. Re-added after a
  // pedestrian-density re-pool (placeCrowd calls this) so the slider doesn't wipe them.
  function placeInteriorDancers() {
    if (!ctx.interior || !ctx.ceceCrowd || !ctx.drewCrowd) return;
    if (crowdSpots.some(s => s.zone === 'interior')) return;
    const sp = ctx.interior.spawn, fwd = [Math.sin(sp.yaw), Math.cos(sp.yaw)];
    const c = ctx.interior.clearAt(sp.x + fwd[0] * 2.6, sp.z + fwd[1] * 2.6);   // open floor, not embedded in a sofa/table
    // Both stand at the same (cleared) spot; updateCrowd shows only the ONE you're not currently playing.
    const add = (crowd, charName, h, clip) => {
      crowdSpots.push({ rec: crowd.add(ctx.scene, { x: c.x, y: ctx.interior.floorY, z: c.z, yaw: sp.yaw + Math.PI, targetH: h, clip }), zone: 'interior', char: charName, onRoadHt: false, settleT: 0 });
    };
    add(ctx.drewCrowd, 'drew', DREW_HEIGHT_M, 'dance');
    add(ctx.ceceCrowd, 'cece', CECE_HEIGHT_M);
  }

  // ---------- controls (explore) ----------
  const ctl = {
    tx: ctx.house.c[0], ty: ctx.house.baseY + 5, tz: ctx.house.c[1], az: 0.85, po: 0.72, r: 330,
    gtx: ctx.house.c[0], gty: ctx.house.baseY + 5, gtz: ctx.house.c[1], gaz: 0.45, gpo: 0.92, gr: 185
  };
  if (ctx.reduceMotion) { ctl.az = 0.45; ctl.po = 0.92; ctl.r = 185; }
  function applyCam() {
    ctx.camera.position.set(
      ctl.tx + ctl.r * Math.sin(ctl.po) * Math.sin(ctl.az),
      ctl.ty + ctl.r * Math.cos(ctl.po),
      ctl.tz + ctl.r * Math.sin(ctl.po) * Math.cos(ctl.az));
    ctx.camera.lookAt(ctl.tx, ctl.ty, ctl.tz);
  }

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
    ctx.emit('mode', m); applyModeVisuals();
  };
  const ptrs = new Map(); let lastPinch = 0, lastMid = null, moved = 0;
  const lookPtrs = new Map();
  ctx.camOrbit = { yaw: 0, pitch: 0, t: 0 };
  ctx._orbitUserSet = false;   // has the user dragged to set the orbit angle? (until then, autodrive/follow runs cinematic "race day" camera sweeps)
  ctx._viewYaw = 0;            // smoothed heading the MAP views (overhead/aerial) + minimap orient to — car-heading normally, compass in follow. Eased so turns don't shimmer.
  ctx._cineAmt = 0;            // 0..1 amount of the cinematic "race day" sweep currently applied (eased out once the user takes the camera)
  ctx.movePtr = null, ctx.joyBX = 0, ctx.joyBY = 0, ctx.pinchD = 0, ctx.czoom = 1, ctx.szoom = 1;
  // Roblox-style controls: shared look/zoom feel across drive+scoop, a steering
  // stick + gas/brake pedals for touch driving, shift-lock for the keeper, and
  // flick momentum in explore. inp2 mixes stick (j*), keyboard (k*) and the
  // dedicated touch driving inputs (steer/gas/brake).
  const LOOK_YAW_PER_SCREEN = 2.8, LOOK_PITCH_PER_SCREEN = 2.4, ZOOM_RATE = 0.0011, MOVE_DEADZONE = 0.10;   // screen-normalized free-look
  const JOY_R = 66, JOY_MAX = 52;
  ctx.inp2 = { jx: 0, jy: 0, kx: 0, ky: 0, steer: 0, gas: 0, brake: 0, navActive: false, navX: 0, navZ: 0, hbrake: false, boost: false };
  ctx.camYawS = 0, ctx.scPitch = 0.34, ctx.bagWarned = false, ctx.spotless = false, ctx.nearCar = false;
  ctx.scoopMoveYaw = 0, ctx.scoopMoveActive = false;
  // Experimental "draw to drive": in the Top-down view, a drag projects the finger
  // onto the ground and the car steers toward it + auto-throttles, so you trace its
  // path with one finger. (Joystick/keyboard still drive the other camera views.)
  let navPtr = null, navDownX = 0, navDownY = 0, navMoved = false, navCurX = 0, navCurY = 0;   // tap (route along roads) vs drag (freeform draw-to-drive); navCur tracks the live finger for overhead pinch
  const _navRay = new THREE.Raycaster(), _navNDC = new THREE.Vector2();
  const _navPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _navHit = new THREE.Vector3();
  // drag-to-drive ("trace") is available in the overhead-style views (Top-down AND Aerial)
  const driveTopDown = () => ctx.mode === 'drive' && DRIVE_CAMS[ctx.camMode] && DRIVE_CAMS[ctx.camMode].dragdrive;
  // Overhead/Aerial zoom-out slider support: czoom is the altitude/orbit multiplier. Map it log-wise to
  // a 0..1 slider and push the value to the UI whenever it changes (pinch, wheel, view switch, slider).
  const driveZoomRange = () => (driveTopDown() ? [0.14, 7] : [0.4, 3.4]);
  function emitDriveZoom() { const [lo, hi] = driveZoomRange(); ctx.emit('driveZoom', { norm: clamp(Math.log(clamp(ctx.czoom, lo, hi) / lo) / Math.log(hi / lo), 0, 1), overhead: driveTopDown() }); }
  function setDriveZoom(norm) { const [lo, hi] = driveZoomRange(); ctx.czoom = lo * Math.pow(hi / lo, clamp(norm, 0, 1)); emitDriveZoom(); }
  function setNavFromPointer(clientX, clientY) {
    const r = ctx.canvas.getBoundingClientRect();
    _navNDC.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    _navRay.setFromCamera(_navNDC, ctx.camera);
    _navPlane.constant = -(ctx.car && ctx.car.groundY != null ? ctx.car.groundY : 0);   // ground plane at the car's height
    if (_navRay.ray.intersectPlane(_navPlane, _navHit)) { ctx.inp2.navX = _navHit.x; ctx.inp2.navZ = _navHit.z; ctx.inp2.navActive = true; }
  }
  ctx.lastLookT = -1e9;   // last manual look-drag time (ms); suppresses scoop follow-cam briefly
  ctx.shiftLock = false, ctx.azVel = 0, ctx.poVel = 0;

  function lookDelta(dx, dy) {
    const w = Math.max(320, ctx.canvas.clientWidth || innerWidth || 800);
    const h = Math.max(320, ctx.canvas.clientHeight || innerHeight || 600);
    return { yaw: dx / w * LOOK_YAW_PER_SCREEN, pitch: dy / h * LOOK_PITCH_PER_SCREEN };
  }
  function scaledDeadzoneMagnitude(x, y) {
    const m = Math.min(1, Math.hypot(x, y));
    return m <= MOVE_DEADZONE ? 0 : (m - MOVE_DEADZONE) / (1 - MOVE_DEADZONE);
  }

  function hideJoy() {
    ctx.movePtr = null; ctx.inp2.jx = 0; ctx.inp2.jy = 0;
    if (ctx.mode === 'scoop') ctx.scoopMoveActive = false;
    if (ctx.ui.joy) ctx.ui.joy.style.display = 'none';
  }

  function clearLiveInput() {
    navPtr = null; lookPtrs.clear(); ptrs.clear();
    lastPinch = 0; lastMid = null; ctx.pinchD = 0; moved = 0;
    ctx.inp2.jx = ctx.inp2.jy = ctx.inp2.kx = ctx.inp2.ky = 0;
    ctx.inp2.steer = ctx.inp2.gas = ctx.inp2.brake = 0;
    ctx.inp2.hbrake = false; ctx.inp2.boost = false; ctx.inp2.navActive = false;
    ctx.scoopMoveActive = false;
    if (ctx.ui.joy) ctx.ui.joy.style.display = 'none';
    ctx.canvas.classList.remove('dragging');
  }

  function onPointerDown(e) {
    if (ctx.mode !== 'explore') {
      ctx.canvas.setPointerCapture(e.pointerId);
      // Overhead views: ONE finger draws-to-drive; a SECOND finger is a pinch-zoom (the
      // phone-native way to zoom the map the user asked for) which suspends steering until
      // you lift back to one finger.
      if (ctx.followMode || (ctx.autoDrive && driveTopDown())) {
        // FOLLOWING, or AUTO-DRIVING in an overhead/aerial view: the whole screen ORBITS/pinches the camera
        // (one finger = look, two = pinch) so you can rotate the "race day" view freely — a drag must NOT
        // draw-to-drive or grab the joystick (which would cancel follow). Re-target via the minimap/search.
        lookPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (ctx.mode === 'drive') ctx.camOrbit.t = performance.now();
        if (lookPtrs.size === 2) { const a = [...lookPtrs.values()]; ctx.pinchD = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); }
        return;
      }
      if (driveTopDown()) {
        if (navPtr === null && lookPtrs.size === 0) {
          navPtr = e.pointerId; navDownX = navCurX = e.clientX; navDownY = navCurY = e.clientY; navMoved = false; ctx.showT = 0; setNavFromPointer(e.clientX, e.clientY);
        } else {
          if (navPtr !== null) { lookPtrs.set(navPtr, { x: navCurX, y: navCurY }); navPtr = null; ctx.inp2.navActive = false; }   // 2nd finger → stop driving, pinch instead
          lookPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (lookPtrs.size === 2) { const a = [...lookPtrs.values()]; ctx.pinchD = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); }
        }
        return;
      }
      const VW = ctx.canvas.clientWidth || innerWidth, VH = ctx.canvas.clientHeight || innerHeight;
      // Roblox touch convention, identical in drive + scoop: the LEFT HALF is the
      // movement zone — a press there SPAWNS the dynamic thumbstick under the thumb
      // (drag farther = move faster: full throttle / a run). The RIGHT HALF is dead
      // space for the camera — a single-finger drag there rotates (horizontal) and
      // tilts (vertical) the view; two fingers anywhere pinch-zoom. We reserve the
      // top strip from the move zone so a drag that begins up near the HUD reads as
      // a look, and so the thumbstick never spawns under the top bar.
      const steerZoneW = ctx.MOBILE ? 0.5 : 0.44;          // left half = move (slightly narrower with a mouse)
      const steerZoneTop = ctx.mode === 'drive' ? 0.14 : 0.18;
      if (ctx.movePtr === null && e.clientX < VW * steerZoneW && e.clientY > VH * steerZoneTop) {
        ctx.movePtr = e.pointerId; ctx.joyBX = e.clientX; ctx.joyBY = e.clientY;
        if (ctx.mode === 'scoop') { ctx.scoopMoveYaw = ctx.camYawS; ctx.scoopMoveActive = true; }
        if (ctx.ui.joy) {
          ctx.ui.joy.style.display = 'block';
          ctx.ui.joy.style.left = (e.clientX - JOY_R) + 'px'; ctx.ui.joy.style.top = (e.clientY - JOY_R) + 'px';
        }
        if (ctx.ui.knob) ctx.ui.knob.style.transform = 'translate(-50%,-50%)';
      } else {
        lookPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (ctx.mode === 'drive') ctx.camOrbit.t = performance.now();   // count a look-start as activity so the hold timer doesn't snap a resting finger back
        if (lookPtrs.size === 2) {
          const a = [...lookPtrs.values()];
          ctx.pinchD = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        }
      }
      return;
    }
    ctx.canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, b: e.button }); moved = 0;
    ctx.azVel = ctx.poVel = 0;
    ctx.canvas.classList.add('dragging');
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      lastPinch = Math.hypot(a.x - b.x, a.y - b.y); lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }

  function onPointerMove(e) {
    if (ctx.mode !== 'explore') {
      if (e.pointerId === navPtr) { navCurX = e.clientX; navCurY = e.clientY; if (Math.hypot(e.clientX - navDownX, e.clientY - navDownY) > 12) navMoved = true; setNavFromPointer(e.clientX, e.clientY); return; }   // draw-to-drive
      if (e.pointerId === ctx.movePtr) {
        let dx = e.clientX - ctx.joyBX, dy = e.clientY - ctx.joyBY;
        const d = Math.hypot(dx, dy), mx = JOY_MAX;
        if (d > mx) { dx *= mx / d; dy *= mx / d; }
        ctx.inp2.jx = dx / mx; ctx.inp2.jy = dy / mx;
        if (ctx.ui.knob) ctx.ui.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        if (Math.hypot(ctx.inp2.jx, ctx.inp2.jy) > 0.25) ctx.showT = 0;
        return;
      }
      const lp = lookPtrs.get(e.pointerId);
      if (!lp) return;
      const ox = lp.x, oy = lp.y;
      lp.x = e.clientX; lp.y = e.clientY;
      if (lookPtrs.size === 2) {
        const a = [...lookPtrs.values()];
        const nd = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (ctx.pinchD > 0 && nd > 0) {
          const f = ctx.pinchD / nd;
          if (ctx.mode === 'drive') { ctx.czoom = clamp(ctx.czoom * f, driveTopDown() ? 0.14 : 0.4, driveTopDown() ? 7 : 3.4); emitDriveZoom(); }   // overhead gets a much wider+finer range (read one intersection ↔ neighbourhood overview)
          else ctx.szoom = clamp(ctx.szoom * f, 0.32, 2.6);                   // close over-the-shoulder → wide yard overview
        }
        ctx.pinchD = nd;
        return;
      }
      const dx = e.clientX - ox, dy = e.clientY - oy;
      if (Math.abs(dx) + Math.abs(dy) < 4) return; // look deadzone (kill resting-finger jitter on high-DPI screens)
      const ld = lookDelta(dx, dy);
      if (ctx.mode === 'drive') {
        ctx.camOrbit.yaw = clamp(ctx.camOrbit.yaw - ld.yaw, -2.4, 2.4);   // clamp so a hard drag can't orbit under the map / lose the car
        ctx.camOrbit.pitch = clamp(ctx.camOrbit.pitch + ld.pitch, -0.45, 0.8);
        ctx.camOrbit.t = performance.now(); ctx._orbitUserSet = true;   // user grabbed the camera → stop the cinematic sweep, hold THEIR angle (relative to the car)
        ctx.showT = 0;
      } else {
        ctx.camYawS -= ld.yaw;
        ctx.scPitch = clamp(ctx.scPitch + ld.pitch, -0.3, 0.8);
        ctx.lastLookT = performance.now();   // pause follow-cam while the player looks
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
        ctx.azVel = -dx * 0.0052; ctx.poVel = -dy * 0.0042; // for flick momentum on release
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
      if (!navMoved) setDriveTarget(ctx.inp2.navX, ctx.inp2.navZ);
      else ctx.inp2.navActive = false;
    }
    if (e.pointerId === ctx.movePtr) hideJoy();
    lookPtrs.delete(e.pointerId);
    if (lookPtrs.size < 2) ctx.pinchD = 0;
    ptrs.delete(e.pointerId); lastPinch = 0; lastMid = null;
    if (!ptrs.size) ctx.canvas.classList.remove('dragging');
  }

  function onWheel(e) {
    e.preventDefault();
    if (ctx.mode === 'explore') ctl.gr = clamp(ctl.gr * Math.exp(e.deltaY * ZOOM_RATE), 14, 640);
    else if (ctx.mode === 'drive') { ctx.czoom = clamp(ctx.czoom * Math.exp(e.deltaY * ZOOM_RATE), driveTopDown() ? 0.14 : 0.4, driveTopDown() ? 7 : 3.4); emitDriveZoom(); }
    else if (ctx.mode === 'scoop') ctx.szoom = clamp(ctx.szoom * Math.exp(e.deltaY * ZOOM_RATE), 0.32, 2.6);
  }

  function onContextMenu(e) { e.preventDefault(); }

  function onDblClick() {
    if (ctx.mode === 'explore') { ctl.gtx = ctx.house.c[0]; ctl.gtz = ctx.house.c[1]; ctl.gr = 160; ctl.gpo = 0.95; }
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
    ctl.gtx = ctx.house.c[0]; ctl.gtz = ctx.house.c[1]; ctl.gty = ctx.house.baseY + 3.5;
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
    if (ctx.mode === 'drive' || ctx.mode === 'scoop') {
      if (ctx.mode === 'scoop' && e.key === 'Shift' && !e.repeat) {
        ctx.shiftLock = !ctx.shiftLock; ctx.emit('shiftLock', ctx.shiftLock);
        ctx.toast(ctx.shiftLock ? 'Shift-lock ON 🔒' : 'Shift-lock off', 900); e.preventDefault(); return;
      }
      if (ctx.mode === 'scoop' && (e.key === 'e' || e.key === 'E') && ctx.nearCar) { driveFromScoop(); e.preventDefault(); return; }
      if (ctx.mode === 'scoop' && e.key === ' ' && !e.repeat) { api.jump(); e.preventDefault(); return; }   // Space = hop
      if (ctx.mode === 'drive' && e.key === ' ') { ctx.inp2.hbrake = true; e.preventDefault(); return; }        // Space = handbrake
      const dk = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'Escape'];
      if (dk.indexOf(e.key) < 0) return;
      if (e.key === 'ArrowUp' || e.key === 'w') ctx.inp2.ky = -1;
      if (e.key === 'ArrowDown' || e.key === 's') ctx.inp2.ky = 1;
      if (e.key === 'ArrowLeft' || e.key === 'a') ctx.inp2.kx = -1;
      if (e.key === 'ArrowRight' || e.key === 'd') ctx.inp2.kx = 1;
      if (e.key === 'Escape') (ctx.mode === 'drive' ? exitDrive : exitScoop)();
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
    if (ctx.mode === 'explore') return;
    if (e.key === 'ArrowUp' || e.key === 'w') ctx.inp2.ky = 0;
    if (e.key === 'ArrowDown' || e.key === 's') ctx.inp2.ky = 0;
    if (e.key === 'ArrowLeft' || e.key === 'a') ctx.inp2.kx = 0;
    if (e.key === 'ArrowRight' || e.key === 'd') ctx.inp2.kx = 0;
    if (e.key === ' ') ctx.inp2.hbrake = false;
  }

  // ---------- scoop mode ----------
  function pushScoopHud() {
    ctx.emit('scoopHud', {
      lvl: ctx.CHAR.lvl, name: TOOLS[ctx.CHAR.lvl].name, bag: ctx.CHAR.bag,
      cap: TOOLS[ctx.CHAR.lvl].cap, total: ctx.CHAR.total, clean: cleanPct()
    });
  }
  function setTool(lvl) {
    ctx.CHAR.lvl = lvl;
    // voxel scoop props only show on the fallback keeper; Drew has no held tool
    for (let i = 0; i < 3; i++) if (ctx.CHAR.scoops[i]) ctx.CHAR.scoops[i].visible = !ctx.CHAR.drew && i === lvl;
    pushScoopHud();
  }
  function enterScoop() {
    setMode('scoop'); ctx.camInit = false; ctx.szoom = 1; ctx.camGroundRef = null; ctx.CHAR.groundY = null;   // fresh framing per scoop entry (pinch-zoom shouldn't leak in)
    setInside(false);
    for (const s of ctx.labelSprites) s.visible = false;
    ctx.CHAR.group.visible = true;
    // Spawn out in the OPEN sanctuary (between the coop and the pen), away from
    // the house, patio and driveway cars so the camera opens onto the play area
    // and animals, not flat house walls.
    ctx.CHAR.x = (SREC.coop[0] + SREC.pen[0]) / 2; ctx.CHAR.z = (SREC.coop[1] + SREC.pen[1]) / 2;
    ctx.CHAR.yaw = Math.atan2(SREC.barn[0] - ctx.CHAR.x, SREC.barn[1] - ctx.CHAR.z);
    ctx.camYawS = ctx.CHAR.yaw; ctx.scoopMoveYaw = ctx.camYawS; ctx.scoopMoveActive = false;
    ctx.scoopScene = 'yard'; ctx.entryArmed = true; ctx.exitArmed = false; doorMarker.visible = false; exitMarker.visible = false; exitRing.visible = false;
    ctx.emit('avatar', { name: ctx.CHAR.avatar, actions: ctx.CHAR.getActions() });
    ctx.audio.ensure();
    setTool(ctx.CHAR.lvl);
    ctx.toast('Scoop the sanctuary poop! 💩<br><small>Empty at the green compost bin · the 🚪 pad takes you inside the house</small>', 3200);
  }
  function exitScoop() {
    setMode('explore');
    ctx.camera.up.set(0, 1, 0);                 // symmetry with exitDrive; never leak a tilted up-vector
    setInside(false);                       // back to the yard scene (hide the interior if we left from inside)
    if (ctx.groundPatch) ctx.groundPatch.visible = false;
    if (ctx.scoopGrass) ctx.scoopGrass.visible = false;
    if (ctx.scoopFence) ctx.scoopFence.visible = false;
    marker.visible = false; carMarker.visible = false; compostMarker.visible = false; doorMarker.visible = false; exitMarker.visible = false; exitRing.visible = false;
    if (ctx.nearCar) { ctx.nearCar = false; ctx.emit('nearCar', false); }
    hideJoy();
    for (const s of ctx.labelSprites) s.visible = true;
    ctx.CHAR.group.visible = false;
    ctx.inp2.jx = ctx.inp2.jy = ctx.inp2.kx = ctx.inp2.ky = 0; ctx.scoopMoveActive = false;
    ctl.gtx = clamp(ctx.CHAR.x, -310, 310); ctl.gtz = clamp(ctx.CHAR.z, -310, 310);
    ctl.gty = terrainAt(ctl.gtx, ctl.gtz) + 3; ctl.gr = 60; ctl.gpo = 0.85;
    ctl.tx = ctl.gtx; ctl.tz = ctl.gtz;
  }

  function updateScoop(dt, now) {
    const inside = ctx.scoopScene === 'interior' && ctx.interior;
    // Keyboard Left/Right TURN the keeper (tank-style) instead of strafing sideways; the touch
    // joystick still strafes camera-relative. (Walking sideways on arrow keys felt wrong.)
    if (ctx.inp2.kx) { ctx.camYawS -= ctx.inp2.kx * 2.6 * dt; ctx.CHAR.yaw = ctx.camYawS; ctx.scoopMoveYaw = ctx.camYawS; ctx.lastLookT = now; }
    let jx = clamp(ctx.inp2.jx, -1, 1), jy = clamp(ctx.inp2.jy + ctx.inp2.ky, -1, 1);
    const rawMag = Math.min(1, Math.hypot(jx, jy));
    const mag = scaledDeadzoneMagnitude(jx, jy);
    if (ctx.shiftLock) ctx.CHAR.yaw = ctx.camYawS; // Roblox shift-lock: keeper faces the camera
    if (mag > 0) {
      if (!ctx.scoopMoveActive) { ctx.scoopMoveYaw = ctx.camYawS; ctx.scoopMoveActive = true; }
      // Capture the movement camera when the stick engages. Right-side look can
      // orbit freely while a walk is held without re-aiming that active walk.
      const basisYaw = ctx.shiftLock ? ctx.camYawS : ctx.scoopMoveYaw;
      const fX = Math.sin(basisYaw), fZ = Math.cos(basisYaw);
      const rX = -Math.cos(basisYaw), rZ = Math.sin(basisYaw);
      let mx = rX * jx - fX * jy, mz = rZ * jx - fZ * jy;
      const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
      if (!ctx.shiftLock) ctx.CHAR.yaw = Math.atan2(mx, mz); // else keep facing camera, strafe
      // Roblox follow cam: your right-side swipe OWNS the camera. We only add a very
      // gentle drift to bring it back behind the keeper, and only after you've left
      // the camera alone for a good while (2.5 s) — so looking around actually holds
      // instead of being yanked back the instant you start walking. Shift-lock opts
      // out entirely (the camera leads and the keeper strafes).
      if (!ctx.shiftLock && now - ctx.lastLookT > 2500) {
        let dyaw = ctx.CHAR.yaw - ctx.camYawS;
        while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
        while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
        ctx.camYawS += dyaw * Math.min(1, dt * 0.8);   // ~1.2 s settle, barely noticeable
      }
      const sp = 4.4 * mag;
      let nx = ctx.CHAR.x + mx * sp * dt, nz = ctx.CHAR.z + mz * sp * dt;
      const rad = 0.42;
      if (inside) {
        // per-wall + furniture pushout/slide with passable doorways (interior.collide)
        const r = ctx.interior.collide(ctx.CHAR.x, ctx.CHAR.z, nx, nz, 0.34); nx = r.x; nz = r.z;   // slimmer radius so doorways/tight spots pass
      } else {
        // collide against real building/structure footprints (not the oversized
        // AABBs) and slide along the wall — otherwise the house's AABB walls off
        // half the open lawn around the keeper's spawn.
        if (insideScoopBuilding(nx, nz)) {
          if (!insideScoopBuilding(nx, ctx.CHAR.z)) nz = ctx.CHAR.z;
          else if (!insideScoopBuilding(ctx.CHAR.x, nz)) nx = ctx.CHAR.x;
          else { nx = ctx.CHAR.x; nz = ctx.CHAR.z; }
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
      ctx.CHAR.x = nx; ctx.CHAR.z = nz;
      ctx.CHAR.bob += dt * 10 * mag;
    } else { ctx.scoopMoveActive = false; ctx.CHAR.bob += dt * 1.5; }
    // ground on the fixed interior floor, or the procedural yard terrain
    const cy = inside ? ctx.interior.floorY : terrainAt(ctx.CHAR.x, ctx.CHAR.z);
    // jump arc: integrate vertical velocity under gravity; land back on the ground
    if (ctx.CHAR.vy !== 0 || ctx.CHAR.airY > 0) {
      ctx.CHAR.airY += ctx.CHAR.vy * dt; ctx.CHAR.vy -= 22 * dt;
      if (ctx.CHAR.airY <= 0) { ctx.CHAR.airY = 0; ctx.CHAR.vy = 0; }
    }
    const bobY = (ctx.CHAR.airY > 0 || ctx.CHAR.drew) ? 0 : Math.abs(Math.sin(ctx.CHAR.bob)) * 0.05;
    ctx.CHAR.group.position.set(ctx.CHAR.x, cy + ctx.CHAR.airY + bobY, ctx.CHAR.z);
    ctx.CHAR.group.rotation.y = ctx.CHAR.yaw - Math.PI / 2;
    if (ctx.CHAR.drew) { ctx.CHAR.drew.locomotion(rawMag > MOVE_DEADZONE ? 4.4 * mag : 0); ctx.CHAR.drew.tick(dt); }
    if (inside) { updateScoopInterior(dt, now); return; }
    // ===== YARD =====
    // door ENTRY: stand on the front-yard pad to walk inside the house
    if (ctx.interior && entryPt) {
      doorMarker.visible = true;
      doorMarker.position.set(entryPt[0], terrainAt(entryPt[0], entryPt[1]) + 2.6 + Math.abs(Math.sin(now * 0.005)) * 0.3, entryPt[1]);
      const din = Math.hypot(ctx.CHAR.x - entryPt[0], ctx.CHAR.z - entryPt[1]);
      if (din > 4.0) ctx.entryArmed = true;
      if (ctx.entryArmed && din < 2.6 && now > ctx.doorT) { enterHouse(now); updateScoopInterior(dt, now); return; }   // run the interior frame now — no 1-frame yard flash
    } else doorMarker.visible = false;
    // always-on-top marker so Drew is never lost behind a real tree
    marker.visible = true;
    marker.position.set(ctx.CHAR.x, cy + 2.6 + Math.abs(Math.sin(now * 0.004)) * 0.22, ctx.CHAR.z);
    marker.rotation.y = now * 0.003;
    // scooping
    const tool = TOOLS[ctx.CHAR.lvl];
    for (let i = POOPS.length - 1; i >= 0; i--) {
      const p = POOPS[i];
      if (Math.hypot(ctx.CHAR.x - p.x, ctx.CHAR.z - p.z) < tool.r) {
        if (ctx.CHAR.bag >= tool.cap) {
          if (!ctx.bagWarned) { ctx.toast('Scoop is full! Empty it at the green bin ♻️'); ctx.bagWarned = true; }
          break;
        }
        removePoop(p); ctx.CHAR.bag++; ctx.CHAR.total++; ctx.audio.sfxScoop();
        const nl = toolAfterScoop(ctx.CHAR.lvl, ctx.CHAR.total);
        if (nl !== ctx.CHAR.lvl) {
          setTool(nl);
          ctx.audio.sfxChime(nl === 1 ? [523, 659, 784] : [523, 659, 784, 1047]);
          ctx.toast(nl === 1 ? 'Bigger scoop unlocked! 🥄✨' : 'MEGA SHOVEL unlocked! 🦾💩');
          if (ctx.CHAR.drew) ctx.CHAR.drew.react('cheer');     // Drew celebrates the upgrade
        } else pushScoopHud();
      }
    }
    if (ctx.COMPOST) {
      // green pin over the bin whenever you're carrying — makes the dump-off obvious
      compostMarker.visible = ctx.CHAR.bag > 0;
      if (compostMarker.visible) compostMarker.position.set(ctx.COMPOST[0], terrainAt(ctx.COMPOST[0], ctx.COMPOST[1]) + 3.2 + Math.abs(Math.sin(now * 0.005)) * 0.4, ctx.COMPOST[1]);
      if (ctx.CHAR.bag > 0 && Math.hypot(ctx.CHAR.x - ctx.COMPOST[0], ctx.CHAR.z - ctx.COMPOST[1]) < 3) {
        const dumped = ctx.CHAR.bag; ctx.CHAR.bag = 0; ctx.bagWarned = false; ctx.audio.sfxChime([392, 523]); pushScoopHud();
        ctx.toast('Composted ' + dumped + ' ♻️');
      }
    }
    if (POOPS.length === 0 && !ctx.spotless) { ctx.spotless = true; ctx.toast('Yard is spotless ✨ (for now…)', 2400); if (ctx.CHAR.drew) ctx.CHAR.drew.react('dance'); ctx._syncDanceNext = now; }   // clean yard → the house throws a dance party next time you step inside
    if (POOPS.length > 0) ctx.spotless = false;
    if (ctx.scoopHudDirty) { ctx.scoopHudDirty = false; pushScoopHud(); }
    // Scoop renders the full procedural world (its aerial-photo terrain IS the
    // backyard ground, with the real house + sanctuary structures), so the old
    // grass disc / fence ring (workarounds for the photoreal case) are off — they
    // would z-fight the terrain and the ring would cut through the house.
    if (ctx.groundPatch) ctx.groundPatch.visible = false;
    if (ctx.scoopGrass) ctx.scoopGrass.visible = false;
    if (ctx.scoopFence) ctx.scoopFence.visible = false;
    // follow cam — preset (Overhead / Angled / Close), cycled with the 🎥 button.
    const fx = Math.sin(ctx.camYawS), fz = Math.cos(ctx.camYawS);
    const SC = SCOOP_CAMS[ctx.scCam];
    // vertical look = TILT only (raise/lower the camera height); pinch/scroll
    // (szoom) is the sole distance control. Mirrors Drive (pitch->height, zoom->dist)
    // instead of the old dolly that stacked scPitch into both dist AND szoom.
    const dist = SC.dist * ctx.szoom, h = (SC.h + ctx.scPitch * 9) * Math.max(0.75, ctx.szoom);
    ctx.camGroundRef = ctx.camGroundRef == null ? cy : ctx.camGroundRef + (cy - ctx.camGroundRef) * Math.min(1, dt * 1.5);
    const camT = _camT.set(ctx.CHAR.x - fx * dist, ctx.camGroundRef + h, ctx.CHAR.z - fz * dist);
    if (!ctx.camInit) { camV.copy(camT); ctx.camInit = true; }
    camV.lerp(camT, Math.min(1, dt * 6));
    camV.y = Math.max(camV.y, terrainAt(camV.x, camV.z) + 1.2);
    ctx.camera.position.copy(camV);
    ctx.camera.lookAt(ctx.CHAR.x, cy + 1.0, ctx.CHAR.z);
    // walk-to-drive: prompt when Drew reaches a parked car in the driveway, and
    // float a pin over the nearest car so the handoff is discoverable from the yard.
    let near = false, best = null, bestD = 1e9;
    for (const s of parkedSpots) {
      const d = Math.hypot(ctx.CHAR.x - s.x, ctx.CHAR.z - s.z);
      if (d < 3.6) near = true;
      if (d < bestD) { bestD = d; best = s; }
    }
    if (near !== ctx.nearCar) { ctx.nearCar = near; ctx.emit('nearCar', near); }
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
    const fx = Math.sin(ctx.camYawS), fz = Math.cos(ctx.camYawS);
    const szi = clamp(ctx.szoom, 0.7, 1.35), ra = ctx.interior.roomAABB, MIND = 1.6;
    let dist = (4.0 + Math.max(0, ctx.scPitch) * 1.2) * szi;
    let camX = ctx.CHAR.x - fx * dist, camZ = ctx.CHAR.z - fz * dist;
    for (let k = 0; k < 6 && dist > MIND && (camX < ra[0] + 0.3 || camX > ra[1] - 0.3 || camZ < ra[2] + 0.3 || camZ > ra[3] - 0.3); k++) {
      dist = Math.max(MIND, dist * 0.78); camX = ctx.CHAR.x - fx * dist; camZ = ctx.CHAR.z - fz * dist;
    }
    const camY = ctx.interior.floorY + 2.1 + ctx.scPitch * 3.4 * Math.max(0.75, szi);
    const cc = ctx.interior.clampCam(camX, camY, camZ, 0.3);
    const camT = _camT.set(cc.x, cc.y, cc.z);
    if (!ctx.camInit) { camV.copy(camT); ctx.camInit = true; }
    camV.lerp(camT, Math.min(1, dt * 6));
    const cl = ctx.interior.clampCam(camV.x, camV.y, camV.z, 0.28);
    camV.set(cl.x, Math.max(cl.y, ctx.interior.floorY + 0.7), cl.z);
    // if an outer-wall corner clamped the camera in close, rise toward overhead so we look DOWN at the
    // kid instead of zooming into their head.
    const pd = Math.hypot(camV.x - ctx.CHAR.x, camV.z - ctx.CHAR.z);
    if (pd < MIND) camV.y = Math.min(ctx.interior.ceilingY - 0.3, Math.max(camV.y, ctx.interior.floorY + 1.1 + (MIND - pd) * 2.0 + 1.2));
    ctx.camera.position.copy(camV);
    ctx.camera.lookAt(ctx.CHAR.x, ctx.interior.floorY + 1.1, ctx.CHAR.z);
    // SEE-THROUGH: hide any non-floor mesh between the camera and a BOUNDARY around the avatar — not just
    // the one dead-centre ray (which left walls covering the kid's body/sides in the way). Cast a small fan
    // to the torso, head, and a ring around them, so a wall blocking ANY part of the kid (or right around
    // them) is cut — a clean cutout boundary. Collision still uses precomputed AABBs, so hidden walls block.
    const occ = ctx.interior.occluders;
    if (occ && now - _wallCutT > (ctx.MOBILE ? 75 : 45)) {
      _wallCutT = now;
      for (const w of occ) if (!w.userData.permaHidden) w.visible = true;
      const cp = ctx.camera.position, fy = ctx.interior.floorY;
      const hideAlong = (tx, ty, tz) => {
        const dx = tx - cp.x, dy = ty - cp.y, dz = tz - cp.z, len = Math.hypot(dx, dy, dz) || 1;
        _wallRay.set(cp, _wallDir.set(dx / len, dy / len, dz / len)); _wallRay.far = Math.max(0.1, len - 0.5);
        const hits = _wallRay.intersectObjects(occ, false);
        for (const h of hits) h.object.visible = false;
      };
      hideAlong(ctx.CHAR.x, fy + 1.1, ctx.CHAR.z);                                                            // torso
      hideAlong(ctx.CHAR.x, fy + 1.75, ctx.CHAR.z);                                                           // head
      // Ring boundary — clears walls right around the kid. SKIP ring points that fall outside the room
      // shell: when the kid hugs a perimeter wall the 0.85 radius overshoots PAST the outer wall, so a
      // camera->outside ray would punch through (hide) the exterior wall/window and expose the skybox.
      const RING = ctx.MOBILE ? 4 : 6;   // fewer perimeter rays on phones — intersectObjects has no BVH, so each cast is O(tris)
      for (let i = 0; i < RING; i++) {
        const a = i / RING * Math.PI * 2, rx = ctx.CHAR.x + Math.cos(a) * 0.85, rz = ctx.CHAR.z + Math.sin(a) * 0.85;
        if (rx > ra[0] + 0.2 && rx < ra[1] - 0.2 && rz > ra[2] + 0.2 && rz < ra[3] - 0.2) hideAlong(rx, fy + 0.9, rz);
      }
    }
  }
  // hop from walking straight into driving (the car spawns at the driveway)
  function driveFromScoop() {
    if (ctx.mode !== 'scoop' || !ctx.nearCar) return;
    ctx.nearCar = false; ctx.emit('nearCar', false);
    ctx.audio.blip();
    enterDrive();
  }

  // ---------- drive mode ----------
  function enterDrive() {
    setMode('drive'); ctx.camInit = false;
    setInside(false);
    clearDestination();
    if (navMarker) navMarker.visible = false;
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
    poiSeen.clear();                                      // re-arm the neighbourhood callouts
    for (const c of ctx.coins) { c.got = false; c.groundY = null; } ctx.coinsGot = 0;   // fresh coins each drive
    resetRun(); resetParticles();
    emitScore({ finishMs: 0 });
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
    ctx.camOrbit.yaw = 0; ctx.camOrbit.pitch = 0; ctx._orbitUserSet = false; ctx.camGroundRef = null; ctx._viewYaw = viewHeading(); ctx._miniYaw = viewHeading(); ctx._gmapHeading = ((180 - viewHeading() * 180 / Math.PI) % 360 + 360) % 360;   // re-arm the cinematic sweep + snap BOTH minimaps to the heading (no rotate-in)
    ctx.showT = 0;                                   // skip the low cinematic orbit (melty up close)
    for (const s of ctx.labelSprites) s.visible = false;
    ctx.audio.engineStart();
    if (ctx.soundOn && ctx.audio.startMusic) ctx.audio.startMusic();
    showCarCard();
    // TRUE free roam: never auto-set a destination on entry. The pink POI beacons still
    // point the way; pick a place with 🧭 or by tapping the map when YOU want a route+ETA.
    if (poiFound.size >= POIS.length) ctx.toast('🏆 All places found — free roam, beat your times!', 2400);
  }
  function exitDrive() {
    setMode('explore');
    stopFollow();
    ctx.camera.up.set(0, 1, 0);
    hideJoy();
    navPtr = null; ctx.inp2.navActive = false; if (navMarker) navMarker.visible = false;
    guideLine.visible = false; destPin.visible = false;
    if (ctx.ui.fx) ctx.ui.fx.classList.remove('on');
    if (ctx.camera.fov !== 46) { ctx.camera.fov = 46; ctx.camera.updateProjectionMatrix(); }
    for (const c of ctx.coins) c.mesh.visible = false;
    resetParticles();
    hideBeacons();
    hideTraffic();
    carLocator.visible = false;
    ctx.car.group.visible = false;
    if (ctx.groundPatch) ctx.groundPatch.visible = false;
    for (const s of ctx.labelSprites) s.visible = true;
    ctx.inp2.jx = ctx.inp2.jy = ctx.inp2.kx = ctx.inp2.ky = 0;
    ctx.audio.engineStop();
    if (ctx.audio.stopMusic) ctx.audio.stopMusic();
    ctl.gtx = clamp(ctx.car.x, -310, 310); ctl.gtz = clamp(ctx.car.z, -310, 310);
    ctl.gty = terrainAt(ctl.gtx, ctl.gtz) + 3; ctl.gr = 110; ctl.gpo = 0.95;
    ctl.tx = ctl.gtx; ctl.tz = ctl.gtz;
  }
  // Unstick: snap the car to the nearest point ON a drivable road segment, facing
  // along it, stopped. Projects onto each segment (not just vertices) for accuracy.
  function resetToRoad() {
    if (ctx.mode !== 'drive') return;
    if (ctx.followMode) stopFollow();   // FIX·ROAD must OWN the snap — else the follow spring drags the car right back, so the button looks dead
    // Build the candidate segment list: the live Google route (real roads, works
    // even far from home) if we have one, else EVERY mapped road (any type) near the
    // neighbourhood — the old residential/tertiary-only filter missed the road the
    // car was actually on, so it teleported you somewhere random.
    let bx = ctx.car.x, bz = ctx.car.z, bd = Infinity, dirX = 0, dirZ = 1, found = false;
    const consider = (ax, az, bx2, bz2) => {
      const vx = bx2 - ax, vz = bz2 - az, len2 = vx * vx + vz * vz || 1;
      let t = ((ctx.car.x - ax) * vx + (ctx.car.z - az) * vz) / len2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t, pz = az + vz * t;
      const d = (px - ctx.car.x) * (px - ctx.car.x) + (pz - ctx.car.z) * (pz - ctx.car.z);
      if (d < bd) { bd = d; bx = px; bz = pz; const L = Math.sqrt(len2); dirX = vx / L; dirZ = vz / L; found = true; }
    };
    const far = Math.hypot(ctx.car.x, ctx.car.z) > 320;
    if (ctx.ROUTE && ctx.ROUTE.length > 1) {
      for (let i = 0; i < ctx.ROUTE.length - 1; i++) consider(ctx.ROUTE[i].x, ctx.ROUTE[i].z, ctx.ROUTE[i + 1].x, ctx.ROUTE[i + 1].z);
    } else if (far) {
      // far from home: snap ONLY to the fetched OSM (Google-map) road network — NEVER the hood graph,
      // which would teleport the car all the way back to the neighbourhood (the reported bug).
      for (const s of ctx.osmRoadSegs) consider(s[0][0], s[0][1], s[1][0], s[1][1]);
    } else {
      for (const r of S.roads) for (let k = 0; k < r.p.length - 1; k++) { const a = W(r.p[k]), b = W(r.p[k + 1]); consider(a[0], a[1], b[0], b[1]); }
    }
    // Far from home with only sparse OSM coverage: if the nearest fetched road is still a long way off
    // (≥120 m), don't fling the car all the way onto it — force a fresh fetch and leave it put (below).
    const usedOSM = far && !(ctx.ROUTE && ctx.ROUTE.length > 1);
    if (found && usedOSM && bd > 250 * 250) found = false;   // snap to a road within 250 m; only force a refetch if the nearest known road is genuinely far (stale/sparse OSM)
    if (!found) {
      if (far) {
        // No local road data yet (the OSM fetch hasn't landed). Force a fetch now and LEAVE THE CAR PUT
        // rather than flinging it home; the next tap snaps onto the real nearest road once it arrives.
        updateAreaRoads(performance.now(), true);
        ctx.toast('Finding the nearest road… try again in a sec 🛰️', 1600);
        return;
      }
      // Near home: nearestRoadPoint consults the ROUTE + every mapped road, so it returns SOMETHING.
      const p = ctx.roads.nearestRoadPoint(ctx.car.x, ctx.car.z);
      bx = p.x; bz = p.z; found = true;
      dirX = Math.sin(ctx.car.yaw); dirZ = Math.cos(ctx.car.yaw);   // no segment tangent on this path — keep the car's current facing rather than snapping it to due-south
    }
    ctx.car.x = bx; ctx.car.z = bz; ctx.car.speed = 0; ctx.car.steer = 0; ctx.car.vlat = 0; ctx.car.revArmT = 0; ctx.car.groundY = null; ctx.car.yaw = Math.atan2(dirX, dirZ);
    clearRouteRail();   // if auto-drive is still on, reacquire rail arc from the snapped road point
    ctx.camInit = false; ctx.camGroundRef = null; ctx.camFloorRef = null; ctx.inp2.navActive = false; ctx.recoverCooldown = 1.8;   // re-seat the chase/orbit cam at the new spot; grace so auto-recover can't immediately re-fire
    ctx.audio.blip && ctx.audio.blip();
    ctx.toast('Back on the road 🛣️', 1000);
  }
  // ---- destination / routing / auto-drive ----
  // Real road route from Google Directions (via the Maps JS SDK, which works in the
  // browser — the Directions web service is CORS-blocked). Falls back to a straight
  // line if the SDK/Directions API isn't enabled on the key.
  let _mapsSDK = null;
  ctx.routeReqId = 0, ctx._quietRoute = false;
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
    const reqId = ++ctx.routeReqId;
    loadMapsSDK().then(maps => {
      const o = ctx.geo.worldToGeo(ctx.car.x, ctx.car.z);
      new maps.DirectionsService().route(
        { origin: { lat: o.lat, lng: o.lon }, destination: { lat: destLat, lng: destLon }, travelMode: 'DRIVING' },
        (result, status) => {
          if (reqId !== ctx.routeReqId || !ctx.DEST || !ctx.DEST.geo ||
            Math.abs(ctx.DEST.geo.lat - destLat) > 1e-7 || Math.abs(ctx.DEST.geo.lon - destLon) > 1e-7) return;
          if (status === 'OK' && result.routes && result.routes[0]) {
            const route = result.routes[0];
            const stepPath = [];
            for (const leg of route.legs || []) for (const step of leg.steps || []) for (const p of step.path || []) stepPath.push(p);
            const src = stepPath.length ? stepPath : route.overview_path;
            const pts = src.map(p => { const w = ctx.geo.geoToWorld(p.lat(), p.lng()); return { x: w[0], z: w[1] }; });
            if (pts.length > 1) {
              ctx.ROUTE = laneOffsetRoute(pts, LANE_OFFSET); ctx.routeIdx = 0;   // ride the correct lane, not the divider
              snapDestinationToRouteEnd(ctx.ROUTE);
              if (ctx.autoDrive && Math.abs(ctx.car.speed) < 6) faceRouteStart();   // just set off / was holding → aim down the real route
              if (!ctx._quietRoute) ctx.toast('🗺️ Route ready — follow the line', 1500);
            }
          } else console.warn('[directions] no route:', status);
        }
      );
    }).catch(e => console.warn('[maps sdk] route unavailable, using straight line —', e && e.message));
  }
  function snapDestinationToRouteEnd(pts) {
    if (!ctx.DEST || !pts || pts.length < 2) return;
    const end = pts[pts.length - 1];
    const rawX = ctx.DEST.rawX == null ? ctx.DEST.x : ctx.DEST.rawX;
    const rawZ = ctx.DEST.rawZ == null ? ctx.DEST.z : ctx.DEST.rawZ;
    // Google geocodes addresses to parcels/rooftops, but cars need to arrive at
    // the drivable road endpoint. Keep the raw geo for retries; move the in-world
    // pin/arrival target to the route's curb-side finish when it is plausibly close.
    const maxSnap = ctx.DEST.celebrate ? 450 : 240;
    if (Math.hypot(end.x - rawX, end.z - rawZ) > maxSnap) return;
    ctx.DEST.rawX = rawX; ctx.DEST.rawZ = rawZ;
    ctx.DEST.x = end.x; ctx.DEST.z = end.z;
    destPin.userData.groundY = null;
  }
  // fromSearch = the player explicitly chose this place from the GO address search;
  // only THOSE arrivals earn the "Arrived" banner (a casual map tap does not).
  function setDestination(lat, lon, label, isChain, fromSearch, opts = {}) {
    stopFollow();   // picking a new destination ends an active "follow me"
    const w = ctx.geo.geoToWorld(lat, lon);
    let seedRoute = null;
    if (opts.drive) {
      seedRoute = localRoadRoute(ctx.car.x, ctx.car.z, w[0], w[1]);
      if (!seedRoute) {
        const np = ctx.roads.nearestRoadPoint(w[0], w[1]);
        if (np && np.d < 90) seedRoute = localRoadRoute(ctx.car.x, ctx.car.z, np.x, np.z);
      }
    }
    ctx.DEST = { x: w[0], z: w[1], rawX: w[0], rawZ: w[1], label: label || 'Destination', geo: { lat, lon }, celebrate: (!!fromSearch || !!opts.celebrate) && !opts.quiet };   // geo kept so a failed route can self-retry
    ctx.ROUTE = seedRoute || null; ctx.routeIdx = 0;
    if (ctx.ROUTE) snapDestinationToRouteEnd(ctx.ROUTE);
    destPin.userData.groundY = null;
    ctx.emit('dest', { label: ctx.DEST.label });
    ctx._quietRoute = !!opts.quiet;   // suppress the follow-up "Route ready" toast on quiet (follow-mode) re-routes
    if (!isChain && !opts.quiet) { const km = (Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z) / 1000).toFixed(1); ctx.toast('📍 ' + ctx.esc(ctx.DEST.label) + ' · ' + km + ' km — routing…', 2200); }
    fetchRoute(lat, lon);
    if (opts.drive) {
      ctx.autoDrive = true; ctx.inp2.navActive = false;
      ctx.emit('autodrive', true);
      faceRouteStart();
    }
  }
  function clearDestination() {
    ctx.routeReqId++; ctx.DEST = null; ctx.ROUTE = null; ctx.routeIdx = 0; ctx.autoDrive = false; ctx.inp2.navActive = false;
    clearRouteRail(); clearRouteCaches();
    guideLine.visible = false; destPin.visible = false; destPin.userData.groundY = null;
    ctx.emit('dest', null); ctx.emit('autodrive', false);
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
        const w = ctx.geo.geoToWorld(g.lat, g.lon), ox = p.x, oz = p.z;
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
  ctx._gmap = null, ctx._gmapCar = null, ctx._gmapRoute = null, ctx._gmapClick = null, ctx._gmapT = 0, ctx._gmapDiv = null, ctx._gmapRouteFor = null, ctx._gmaps = null, ctx._gmapOverviewUntil = 0, ctx._gmapHeading = 0, ctx._gmapRot = 0, ctx._gmapScale = 1;
  function disposeMiniMap() {
    if (ctx._gmapDiv) ctx._gmapDiv.style.transform = '';   // drop any heading-up rotation so a re-mount starts clean
    if (ctx._gmapClick) { ctx._gmapClick.remove(); ctx._gmapClick = null; }
    if (ctx._gmapCar) { ctx._gmapCar.setMap(null); ctx._gmapCar = null; }
    if (ctx._gmapRoute) { ctx._gmapRoute.setMap(null); ctx._gmapRoute = null; }
    if (ctx._gmaps && ctx._gmap) ctx._gmaps.event.clearInstanceListeners(ctx._gmap);
    ctx._gmap = null; ctx._gmapDiv = null; ctx._gmapRouteFor = null; ctx._gmapOverviewUntil = 0;
  }
  function initMiniMap(div) {
    if (!div || ctx._gmapDiv === div) return;
    disposeMiniMap();
    ctx._gmapDiv = div;
    div.style.transformOrigin = '50% 50%'; div.style.willChange = 'transform';   // spin the heading-up map about its centre (the car)
    loadMapsSDK().then(maps => {
      if (ctx.disposed || ctx._gmapDiv !== div) return;
      ctx._gmaps = maps;
      const o = ctx.geo.worldToGeo(ctx.car.x, ctx.car.z);
      ctx._gmap = new maps.Map(div, {
        center: { lat: o.lat, lng: o.lon }, zoom: 12, disableDefaultUI: true,   // zoomed-out district view (~10 km across) so fast cross-town drives stay on the map
        gestureHandling: 'none', keyboardShortcuts: false, clickableIcons: false,
        styles: DARK_MAP_STYLE, backgroundColor: '#1b2027', isFractionalZoomEnabled: true,
      });
      ctx._gmapCar = new maps.Marker({ position: { lat: o.lat, lng: o.lon }, map: ctx._gmap, zIndex: 5,
        icon: { path: 'M0,-10 L7,8 L0,3 L-7,8 Z', fillColor: '#2D8CFF', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1.5, scale: 1.05, rotation: 0, anchor: new maps.Point(0, 0) } });
      ctx._gmapRoute = new maps.Polyline({ map: ctx._gmap, strokeColor: '#2D8CFF', strokeOpacity: 0.95, strokeWeight: 4, path: [], zIndex: 3 });
      // TAP-TO-DRIVE on the heading-up map: Google's own click→latLng is computed from the click's
      // offset within the container, which a CSS rotate()+scale() DISTORTS (taps land in the wrong
      // place). So handle the tap ourselves: undo the scale + rotation we applied, then convert the
      // map-local pixel offset to a world point via the live metres-per-pixel. Capture phase so it
      // beats any inner Google handler.
      const onTap = (e) => {
        if (!ctx._gmap) return;
        const r = div.getBoundingClientRect();
        const fcx = r.left + r.width / 2, fcy = r.top + r.height / 2;   // rotate/scale are about centre → bbox centre stays on the car
        const ox = (e.clientX - fcx) / ctx._gmapScale, oy = (e.clientY - fcy) / ctx._gmapScale;   // undo fill scale → layout px from centre
        const ar = ctx._gmapRot * Math.PI / 180, c = Math.cos(ar), s = Math.sin(ar);          // undo the heading-up rotation
        const mx = ox * c - oy * s, my = ox * s + oy * c;
        const ctr = ctx._gmap.getCenter(), lat = ctr.lat(), z = ctx._gmap.getZoom();
        const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);        // Web-Mercator metres per layout px
        const cw = ctx.geo.geoToWorld(lat, ctr.lng());   // anchor to the map's ACTUAL centre, not the car — during a route overview the view is fitBounds-centred, not on the car
        setDriveTarget(cw[0] + mx * mpp, cw[1] + my * mpp);   // screen x→east(+x), screen y(down)→south(+z)
      };
      div.addEventListener('click', onTap, true);
      ctx._gmapClick = { remove: () => div.removeEventListener('click', onTap, true) };   // disposeMiniMap calls _gmapClick.remove()
    }).catch(() => { });
  }
  function updateMiniMap(now) {
    if (!ctx._gmap || now - ctx._gmapT < 200) return;   // ~5 Hz pan
    ctx._gmapT = now;
    const o = ctx.geo.worldToGeo(ctx.car.x, ctx.car.z);
    // HEADING-UP: spin the whole map so the car's heading points UP — oriented like the driver/user,
    // the way a phone GPS does. World is x=east, z=-north and car.yaw=atan2(east,-north), so the
    // compass bearing (cw from north) = 180°−yaw. We counter-rotate the map div by that bearing (and
    // scale up to fill the corners the rotation exposes), then point the car marker the same way so it
    // sits pointing straight up. During a route OVERVIEW the map isn't car-centred, so stay north-up.
    const bearing = 180 - viewHeading() * 180 / Math.PI;   // viewHeading = COMPASS while following (map turns like the user), else the car heading
    const overview = now < ctx._gmapOverviewUntil;
    if (!overview) { const d = ((bearing - ctx._gmapHeading + 180) % 360 + 360) % 360 - 180; ctx._gmapHeading += d * 0.35; }   // smoothed, unwrapped → no shimmer / no 360° spin
    ctx._gmapRot = overview ? 0 : ctx._gmapHeading; ctx._gmapScale = overview ? 1 : 1.62;   // kept in sync with the transform below so the tap handler can invert it exactly
    if (ctx._gmapDiv) ctx._gmapDiv.style.transform = overview ? 'none' : `rotate(${(-ctx._gmapHeading).toFixed(2)}deg) scale(${ctx._gmapScale})`;
    if (ctx._gmapCar) {
      ctx._gmapCar.setPosition({ lat: o.lat, lng: o.lon });
      const ic = ctx._gmapCar.getIcon(); ic.rotation = overview ? bearing : ctx._gmapHeading; ctx._gmapCar.setIcon(ic);   // north-up: along bearing; heading-up: same as the div's counter-rotation → points UP
    }
    if (ctx._gmapRoute) {
      if (ctx.ROUTE && ctx.ROUTE.length && ctx._gmapRouteFor !== ctx.ROUTE) {
        ctx._gmapRouteFor = ctx.ROUTE;
        const pts = ctx.ROUTE.map(p => { const g = ctx.geo.worldToGeo(p.x, p.z); return { lat: g.lat, lng: g.lon }; });
        ctx._gmapRoute.setPath(pts);
        // ROUTE OVERVIEW: fit the whole start→finish into view for a few seconds when a new
        // route is set, then resume following the car (the user asked to see the full route).
        if (ctx._gmaps) { const b = new ctx._gmaps.LatLngBounds(); b.extend({ lat: o.lat, lng: o.lon }); for (const p of pts) b.extend(p); ctx._gmap.fitBounds(b, 12); ctx._gmapOverviewUntil = now + 3500; }
      } else if (!ctx.ROUTE && ctx._gmapRouteFor) { ctx._gmapRouteFor = null; ctx._gmapRoute.setPath([]); }
    }
    if (now >= ctx._gmapOverviewUntil) { ctx._gmap.setCenter({ lat: o.lat, lng: o.lon }); if (ctx._gmap.getZoom() !== 12) ctx._gmap.setZoom(12); }   // follow the car zoomed out (~10 km across); settle back to 12 after any route overview
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
  ctx.jumpReqId = 0, ctx._jumpSnap = null;   // after a FAR jump: { x, z, until } — snap onto the road once OSM/Google for the NEW area lands; time+position scoped so it self-expires and can't leak into a later drive
  // Full post-teleport reset in ONE place: zero the car's motion, force a fresh ground
  // sample, and RE-SEAT every camera reference (camGroundRef/camFloorRef were the ones the
  // old jump paths forgot — leaving the orbit cam floating at the OLD altitude for seconds,
  // which read as "we lost the car"). Short cooldown so a bad landing still recovers fast.
  function settleAfterTeleport() {
    ctx.car.speed = 0; ctx.car.vlat = 0; ctx.car.steer = 0; ctx.car.assistRate = 0; ctx.car.revArmT = 0; ctx.car.groundY = null;
    ctx.camInit = false; ctx.camGroundRef = null; ctx.camFloorRef = null; ctx.inp2.navActive = false; ctx.recoverCooldown = 0.6; ctx._viewYaw = viewHeading(); ctx._miniYaw = viewHeading(); ctx._gmapHeading = ((180 - viewHeading() * 180 / Math.PI) % 360 + 360) % 360;   // snap the overhead/aerial framing + BOTH minimaps to the new heading (no rotate-in after a jump/teleport)
  }
  function jumpTo(lat, lon, label) {
    stopFollow();   // a teleport OWNS the car — end any live GPS follow (else its glide springs the car back). Mirrors setDestination/setDriveTarget/driveToMyLocation/exitDrive.
    const ox = ctx.car.x, oz = ctx.car.z;                         // origin for the road-end query (captured before we teleport)
    const w = ctx.geo.geoToWorld(lat, lon);
    ctx.car.x = w[0]; ctx.car.z = w[1];
    // Snap onto the local street graph when one is near (the generous radius matches the
    // tap-to-drive snap, so jumps inside the neighborhood land in the street like a drive).
    // Even if no road is "near", if the rooftop geocode dropped us INSIDE a building, nudge
    // to the nearest road so the car never lands wedged (can't move in any gear).
    const np = ctx.roads.nearestRoadPoint(ctx.car.x, ctx.car.z);
    const onLocalRoad = np && np.d < 90;
    if (onLocalRoad) { ctx.car.x = np.x; ctx.car.z = np.z; }
    else if (np && insideBuilding(ctx.car.x, ctx.car.z)) { ctx.car.x = np.x; ctx.car.z = np.z; }
    clearDestination();
    settleAfterTeleport();
    ctx.toast('📍 Jumped to ' + ctx.esc(label || 'there'), 1500);
    // Far from the neighborhood there's no local road graph (osmRoadSegs still covers the OLD area), so
    // the geocode rooftop strands the car off-road and "Back to road" can't find anything until OSM
    // re-fetches. So: force an OSM fetch for the NEW area now AND ask Google for the curb (whichever lands
    // first snaps the car onto the road — see the _jumpSnap handler in updateAreaRoads + snapJumpToRoad).
    // The stamp (target + 8 s deadline) makes it single-use and self-expiring so it can never teleport the
    // car at some unrelated later moment if both fetches fail.
    if (!onLocalRoad) { ctx._jumpSnap = { x: ctx.car.x, z: ctx.car.z, until: performance.now() + 8000 }; updateAreaRoads(performance.now(), true); snapJumpToRoad(ox, oz, lat, lon, ++ctx.jumpReqId); }
  }
  // One-shot road-snap for a FAR jump: route origin→destination and move the car to the
  // route's final point — the same curb Drive-to arrives at. Bails if a newer jump fired or
  // the player has since set a destination, so it never yanks the car out from under them.
  function snapJumpToRoad(ox, oz, lat, lon, reqId) {
    loadMapsSDK().then(maps => {
      const o = ctx.geo.worldToGeo(ox, oz);
      new maps.DirectionsService().route(
        { origin: { lat: o.lat, lng: o.lon }, destination: { lat, lng: lon }, travelMode: 'DRIVING' },
        (result, status) => {
          if (reqId !== ctx.jumpReqId || ctx.DEST || !ctx._jumpSnap || Math.abs(ctx.car.speed) >= 4) return;   // a newer jump/destination fired, OSM already snapped (flag consumed), or the user drove off — don't double-snap or yank a moving car
          if (status !== 'OK' || !result.routes || !result.routes[0]) return;
          const path = [];
          for (const leg of result.routes[0].legs || []) for (const step of leg.steps || []) for (const p of step.path || []) path.push(p);
          const src = path.length ? path : result.routes[0].overview_path;
          if (!src || !src.length) return;
          const end = src[src.length - 1], e = ctx.geo.geoToWorld(end.lat(), end.lng());
          ctx.car.x = e[0]; ctx.car.z = e[1];
          // de-wedge: if the route end still sits inside a footprint, slide to the nearest road
          const np = ctx.roads.nearestRoadPoint(ctx.car.x, ctx.car.z);
          if (np && (np.d < 90 || insideBuilding(ctx.car.x, ctx.car.z))) { ctx.car.x = np.x; ctx.car.z = np.z; }
          ctx._jumpSnap = null;   // Google curb landed first — consume the stamp so the OSM-fetch snap won't double-fire
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
  ctx._geoWatch = null, ctx.followMode = false, ctx._followGeo = null, ctx._followHeading = null, ctx._followSeeded = false;
  ctx._followVx = 0, ctx._followVz = 0;   // spring VELOCITY for the follow glide — momentum so a new GPS fix accelerates smoothly instead of darting/stopping (no stop-and-go between sparse updates)
  ctx._headingOn = false, ctx._headingOff = null, ctx._headingGen = 0;
  function startHeading() {
    if (ctx._headingOn) return;
    ctx._headingOn = true;   // claim SYNCHRONOUSLY so a stopHeading()/dispose() during the async iOS permission prompt makes a late grant a no-op (else attach() would orphan window listeners)
    const myGen = ++ctx._headingGen;   // a stop→restart while a permission prompt is still pending must not let the OLD grant attach a second, unremovable listener pair
    const onOrient = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;   // iOS: degrees clockwise from true north
      else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;                                          // others: alpha rises counter-clockwise from north
      if (h != null) ctx._followHeading = Math.PI - h * Math.PI / 180;   // → world yaw (x=E, z=-N, forward=(sin,cos)): yaw = π − heading
    };
    const attach = () => {
      if (!ctx._headingOn || ctx.disposed || myGen !== ctx._headingGen) return;   // follow ended/restarted or engine torn down while the permission dialog was open → don't attach orphan listeners
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
      ctx._headingOff = () => { window.removeEventListener('deviceorientationabsolute', onOrient, true); window.removeEventListener('deviceorientation', onOrient, true); };
    };
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') DOE.requestPermission().then(s => { if (s === 'granted') attach(); }).catch(() => { });   // iOS 13+: gesture-gated permission
    else attach();
  }
  function stopHeading() { if (ctx._headingOff) { try { ctx._headingOff(); } catch (e) { } } ctx._headingOff = null; ctx._headingOn = false; ctx._followHeading = null; }
  function stopFollow() {
    const was = ctx.followMode || ctx._geoWatch != null;
    if (ctx._geoWatch != null) { try { navigator.geolocation.clearWatch(ctx._geoWatch); } catch (e) { } ctx._geoWatch = null; }
    ctx.followMode = false; ctx._followGeo = null; ctx._followSeeded = false; ctx._followVx = 0; ctx._followVz = 0; ctx._jumpSnap = null; stopHeading();
    if (was) ctx.emit('follow', false);
  }
  // Set the live follow target, CLAMPED to the 30 km sanity ring (beyond it the flat-earth ENU
  // mapping + ground tiles break down, and the glide — which bypasses the physics ring clamp — would
  // otherwise march the car off into the void chasing a far/garbage fix).
  function setFollowGeo(lat, lon) {
    const w = ctx.geo.geoToWorld(lat, lon); let wx = w[0], wz = w[1];
    const r = Math.hypot(wx, wz); if (r > 30000) { const s = 30000 / r; wx *= s; wz *= s; }
    if (!ctx._followSeeded) { ctx._followSeeded = true; ctx.car.x = wx; ctx.car.z = wz; ctx._followVx = 0; ctx._followVz = 0; settleAfterTeleport(); }   // JUMP to the user at the START (at rest) — don't drive/glide there. Subsequent fixes spring-track.
    ctx._followGeo = { x: wx, z: wz };
  }
  function driveToMyLocation(follow) {
    if (!navigator.geolocation) { ctx.toast('📍 Location unavailable on this device', 1800); return Promise.reject(new Error('no-geo')); }
    stopFollow();
    if (ctx.mode !== 'drive') enterDrive();
    if (follow) {
      startHeading();                                                  // request the compass NOW, inside the button-tap gesture (iOS requires that)
      ctx.followMode = true; ctx.autoDrive = false; clearRouteRail(); clearDestination();   // exact-follow OWNS the car — kill any rail/route
      ctx.emit('autodrive', false); ctx.emit('follow', true);
      ctx.toast('📍 Following you — the car tracks your location', 1700);
    }
    return new Promise((resolve, reject) => {
      let done = false;
      navigator.geolocation.getCurrentPosition(
        pos => {
          const lat = pos.coords.latitude, lon = pos.coords.longitude;
          if (Number.isFinite(lat) && Number.isFinite(lon) && ctx.mode === 'drive') {
            if (follow) { if (pos.coords.accuracy == null || pos.coords.accuracy <= 60) setFollowGeo(lat, lon); }   // gate the SEED too — a junk/stale first fix is exactly what put the car on the wrong street; the watcher supplies a good one if this is dropped
            else { driveToLatLon(lat, lon, '📍 Your location'); ctx.toast('📍 Driving to you', 1500); }
          }
          if (!done) { done = true; resolve({ lat, lon }); }
        },
        err => {
          // In FOLLOW the long-lived watch (below) is the resilient source — a cold/indoor SEED timeout
          // (10 s) routinely fires before the watch (15 s) delivers, so DON'T tear follow down here; let the
          // watch carry it. Only the non-follow one-shot "drive to me" truly fails on a seed error.
          if (!follow) { stopFollow(); ctx.toast('📍 Could not get your location (allow access?)', 2200); }
          if (!done) { done = true; reject(err); }
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 });   // fresh-ish seed (the 2 s cache could hand back a stale low-accuracy fix)
      if (follow) {
        ctx._geoWatch = navigator.geolocation.watchPosition(pos => {
          const lat = pos.coords.latitude, lon = pos.coords.longitude;
          if (!ctx.followMode || ctx.mode !== 'drive' || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
          if (pos.coords.accuracy != null && pos.coords.accuracy > 60) return;   // drop junk fixes — those caused the "wrong street" jumps
          setFollowGeo(lat, lon);                                       // just move the (ring-clamped) target; the glide in updateDrive smooths jitter + can't overshoot
        }, (werr) => { if (werr && werr.code === werr.PERMISSION_DENIED) { stopFollow(); ctx.toast('📍 Location access needed to follow you', 2200); } }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 });   // end follow only on a REAL permission failure, not a transient timeout (the watch keeps retrying)
      }
    });
  }
  // Autodrive max-speed cap (mph; 0 = uncapped). Persisted; applied in autoDriveTargetSpeed.
  ctx.autoMaxMph = (() => { try { return parseInt(localStorage.getItem('dahill.automax') || '0', 10) || 0; } catch (e) { return 0; } })();
  function setAutoMaxMph(mph) { ctx.autoMaxMph = Math.max(0, mph | 0); try { localStorage.setItem('dahill.automax', String(ctx.autoMaxMph)); } catch (e) { } ctx.emit('automax', ctx.autoMaxMph); }
  // Global driving-speed/accel multiplier (settings slider). Scales top speed AND accel so the
  // whole envelope slows together — a parent can dial it down for little kids on tight streets.
  ctx.speedMul = (() => { try { const v = parseFloat(localStorage.getItem('dahill.speedmul')); return v >= 0.3 && v <= 2 ? v : 1; } catch (e) { return 1; } })();
  function setSpeedMul(v) { ctx.speedMul = clamp(+v || 1, 0.3, 2); try { localStorage.setItem('dahill.speedmul', String(ctx.speedMul)); } catch (e) { } }
  // Tap-to-drive from the minimap: set a raw world point as the destination and let
  // the robot drive there (no Google route needed for a nearby local point). Reuses
  // DEST + auto-drive, so the guide ribbon, pin, ETA and arrival all just work.
  // Aim the car down the START of the route so auto-drive sets off FORWARD instead of a
  // rough U-turn / spin-around (the user's idea: "when autodrive starts it can just point
  // the car in the right direction"). Snaps the heading toward the first route point a few
  // metres out (or the destination if a route isn't ready yet).
  function faceRouteStart() {
    let tx = null, tz = null;
    if (ctx.ROUTE && ctx.ROUTE.length) {
      let i = Math.max(0, ctx.routeIdx);
      while (i < ctx.ROUTE.length - 1 && Math.hypot(ctx.ROUTE[i].x - ctx.car.x, ctx.ROUTE[i].z - ctx.car.z) < 6) i++;
      tx = ctx.ROUTE[i].x; tz = ctx.ROUTE[i].z;
    } else if (ctx.DEST) { tx = ctx.DEST.x; tz = ctx.DEST.z; }
    if (tx == null || Math.hypot(tx - ctx.car.x, tz - ctx.car.z) < 1) return;
    ctx.car.yaw = Math.atan2(tx - ctx.car.x, tz - ctx.car.z);
    ctx.car.steer = 0; ctx.car.vlat = 0; ctx.car.assistRate = 0; ctx.camInit = false;   // re-settle the chase cam behind the new heading
  }
  function setDriveTarget(wx, wz) {
    stopFollow();   // tapping the map to drive ENDS follow — else followMode stays true and its glide branch shadows the new route (tap looked dead). Covers both the canvas tap and the Google onTap.
    // ALWAYS follow a real ROAD path to the point — NEVER a straight line across the land.
    // Seed an instant on-road route from the local street graph so the car sets off at once,
    // and fetch the Google Directions path to refine/extend it. If neither is ready the car
    // simply HOLDS (idles) until a road route exists — it never cuts across the grass. Then
    // point the car down the route so it doesn't have to turn itself around.
    const g = ctx.geo.worldToGeo(wx, wz);
    let route = localRoadRoute(ctx.car.x, ctx.car.z, wx, wz);
    if (!route) { const np = ctx.roads.nearestRoadPoint(wx, wz); if (np && np.d < 90) route = localRoadRoute(ctx.car.x, ctx.car.z, np.x, np.z); }
    ctx.DEST = { x: wx, z: wz, rawX: wx, rawZ: wz, label: 'the map point', geo: g }; ctx.ROUTE = route || null; ctx.routeIdx = 0; destPin.userData.groundY = null;   // geo kept so a failed route can self-retry
    if (ctx.ROUTE) snapDestinationToRouteEnd(ctx.ROUTE);
    fetchRoute(g.lat, g.lon);                            // Google road path (async) → overwrites the seed when ready
    ctx.autoDrive = true; ctx.inp2.navActive = false;
    ctx.emit('dest', { label: ctx.DEST.label }); ctx.emit('autodrive', true);
    faceRouteStart();
    ctx.toast(route ? '🤖 Cruising the streets' : '🗺️ Finding a road route…', 1200);
  }
  // Live nav target: a look-ahead point ~32 m along the route from the car (so the
  // guide ribbon + auto-drive follow the road smoothly instead of snapping between
  // dense waypoints). Falls back to the destination (straight line) with no route.
  function navTarget() {
    if (!ctx.ROUTE || ctx.routeIdx >= ctx.ROUTE.length) return ctx.DEST;
    // SPEED-SCALED look-ahead: tight at low speed so the car HUGS the route (sticks to
    // the road through turns), longer at speed for a smooth line. A fixed 32 m look-ahead
    // cut every corner.
    const look = clamp(Math.abs(ctx.car.speed) * 0.42, 11, 42);   // tight at low speed (HUGS corners), longer at speed so the chauffeur can anticipate the next bend far from home
    let acc = 0, px = ctx.car.x, pz = ctx.car.z;
    for (let i = ctx.routeIdx; i < ctx.ROUTE.length; i++) {
      acc += Math.hypot(ctx.ROUTE[i].x - px, ctx.ROUTE[i].z - pz); px = ctx.ROUTE[i].x; pz = ctx.ROUTE[i].z;
      if (acc >= look) return laneOffset(i);
    }
    return ctx.DEST;
  }
  // LANE: aim ~1.7 m to the RIGHT of the route centreline so the car drives IN A LANE
  // instead of straddling the middle of the road (it follows the right perpendicular of the
  // local route direction). Only kicks in on faster/wider roads where lane-keeping reads.
  function laneOffset(i) {
    const a = ctx.ROUTE[Math.max(0, i - 1)], b = ctx.ROUTE[Math.min(ctx.ROUTE.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    // Lane offset only at highway speed, and SMALLER on the tight procedural
    // neighbourhood streets (onRoad mask, or within the ~340 m home block) so it
    // hugs the lane out on the wide real roads without scraping the curb in town.
    const narrow = ctx.onRoad(ctx.ROUTE[i].x, ctx.ROUTE[i].z) || Math.hypot(ctx.ROUTE[i].x, ctx.ROUTE[i].z) < 340;
    const off = clamp((Math.abs(ctx.car.speed) - 22) / 30, 0, 1) * (narrow ? 0.45 : 1.1);
    return { x: ctx.ROUTE[i].x + dz * off, z: ctx.ROUTE[i].z - dx * off };   // right perpendicular = (dz, -dx)
  }
  // distance along the route to the next real TURN (>~25° heading change) — lets the
  // chauffeur run FAST on long straights and only slow for corners/arrival.
  function distToNextTurn() {
    if (!ctx.ROUTE || ctx.routeIdx >= ctx.ROUTE.length - 1) return 40;
    let acc = 0, px = ctx.car.x, pz = ctx.car.z;
    let hx = ctx.ROUTE[ctx.routeIdx].x - px, hz = ctx.ROUTE[ctx.routeIdx].z - pz; let hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
    for (let i = ctx.routeIdx; i < ctx.ROUTE.length - 1 && acc < 500; i++) {
      acc += Math.hypot(ctx.ROUTE[i].x - px, ctx.ROUTE[i].z - pz); px = ctx.ROUTE[i].x; pz = ctx.ROUTE[i].z;
      let nx = ctx.ROUTE[i + 1].x - px, nz = ctx.ROUTE[i + 1].z - pz; const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
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
    if (!ctx.ROUTE) return 0;
    if (_routeLenFor === ctx.ROUTE) return _routeLen;
    _routeLenFor = ctx.ROUTE; _routeLen = 0;
    for (let i = 0; i < ctx.ROUTE.length - 1; i++) _routeLen += Math.hypot(ctx.ROUTE[i + 1].x - ctx.ROUTE[i].x, ctx.ROUTE[i + 1].z - ctx.ROUTE[i].z);
    return _routeLen;
  }
  function railArcAt(x, z) {   // arc-length (m from ROUTE[0]) of the nearest point on the route to (x,z)
    let bestS = 0, bd = 1e18, acc = 0;
    for (let i = 0; i < ctx.ROUTE.length - 1; i++) {
      const ax = ctx.ROUTE[i].x, az = ctx.ROUTE[i].z, vx = ctx.ROUTE[i + 1].x - ax, vz = ctx.ROUTE[i + 1].z - az, L = Math.hypot(vx, vz) || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / (L * L); t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t, pz = az + vz * t, d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bd) { bd = d; bestS = acc + t * L; }
      acc += L;
    }
    return bestS;
  }
  function railPointAt(s) {   // { x, z, yaw, i } at arc-length s along the route
    let acc = 0;
    for (let i = 0; i < ctx.ROUTE.length - 1; i++) {
      const ax = ctx.ROUTE[i].x, az = ctx.ROUTE[i].z, vx = ctx.ROUTE[i + 1].x - ax, vz = ctx.ROUTE[i + 1].z - az, L = Math.hypot(vx, vz) || 1;
      if (acc + L >= s || i === ctx.ROUTE.length - 2) {
        const t = clamp((s - acc) / L, 0, 1);
        return { x: ax + vx * t, z: az + vz * t, yaw: Math.atan2(vx, vz), i };
      }
      acc += L;
    }
    const last = ctx.ROUTE[ctx.ROUTE.length - 1], prev = ctx.ROUTE[ctx.ROUTE.length - 2];
    return { x: last.x, z: last.z, yaw: Math.atan2(last.x - prev.x, last.z - prev.z), i: ctx.ROUTE.length - 2 };
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
    if (ctx.autoMaxMph) s = Math.min(s, ctx.autoMaxMph / 2.237);   // user's autodrive speed-limit slider (mph → world u/s)
    return s;
  }
  function toggleAutoDrive() { if (!ctx.DEST) return; ctx.autoDrive = !ctx.autoDrive; clearRouteRail(); if (!ctx.autoDrive) ctx.inp2.navActive = false; else faceRouteStart(); ctx.emit('autodrive', ctx.autoDrive); ctx.toast(ctx.autoDrive ? '🤖 Fast auto-drive ON' : 'Auto-drive off', 1100); }
  // ---- road-graph queries (lane-keep / steer-back / face-along-street) ---- (see nav/road-graph.js)
  ctx.roads = createRoadGraph(ctx);   // ctx.roads.{roadTargetAhead, nearestRoadPoint, nearestRoadSeg}
  // The heading the MAP views (overhead/aerial main view + both minimaps) orient to: the live COMPASS
  // heading while following (so the map turns like the user/phone), else the car's own heading.
  function viewHeading() { return (ctx.followMode && ctx._followHeading != null) ? ctx._followHeading : ctx.car.yaw; }
  // Live "where am I" readout: reverse-geocode the car's position to a rough STREET · CITY, ST and push
  // it to the subline. Throttled hard (every ~4 s, and only after moving ~140 m) to stay well within the
  // geocoder quota; falls back silently on any error.
  let _geoT = 0, _geoBusy = false, _geoLabel = '', _geoLast = null;
  function updateLocationLabel(now) {
    if (_geoBusy && now - _geoT > 12000) _geoBusy = false;   // watchdog: a Geocoder callback that never fires must not wedge the readout dead for the session
    if (ctx.mode !== 'drive' || _geoBusy || now - _geoT < 4000) return;
    if (_geoLast && Math.hypot(ctx.car.x - _geoLast.x, ctx.car.z - _geoLast.z) < 140) return;
    _geoT = now; _geoLast = { x: ctx.car.x, z: ctx.car.z };
    const g = ctx.geo.worldToGeo(ctx.car.x, ctx.car.z);
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
        if (label && label !== _geoLabel) { _geoLabel = label; ctx.emit('subline', label); }
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
    if (ctx.mode !== 'drive') return;
    if (Math.hypot(ctx.car.x, ctx.car.z) < 300) return;                                  // the hood's own roadSegs already cover here
    if (_osmFetching) return;                                                    // one fetch at a time
    if (!force) {
      if (now - _osmT < 4000) return;                                            // min 4 s apart (unless forced, e.g. by Return-to-road)
      if (_osmCenter && Math.hypot(ctx.car.x - _osmCenter.x, ctx.car.z - _osmCenter.z) < 850) return;   // the current box still covers us
    }
    _osmFetching = true; _osmT = now;
    const fx = ctx.car.x, fz = ctx.car.z, R = 1300;                                      // ~2.6 km box around the car
    const cs = [ctx.geo.worldToGeo(fx - R, fz - R), ctx.geo.worldToGeo(fx + R, fz - R), ctx.geo.worldToGeo(fx - R, fz + R), ctx.geo.worldToGeo(fx + R, fz + R)];
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
              const a = ctx.geo.geoToWorld(g[i].lat, g[i].lon), b = ctx.geo.geoToWorld(g[i + 1].lat, g[i + 1].lon);
              segs.push([[a[0], a[1]], [b[0], b[1]]]);
            }
          }
          if (segs.length) {
            ctx.osmRoadSegs = segs; _osmCenter = { x: fx, z: fz }; _osmMirror = (_osmMirror + n) % OVERPASS_MIRRORS.length;   // stick with the mirror that worked
            // A far jump left the car off-road; now that we have THIS area's roads, snap it on — but ONLY if
            // it's still the SAME stopped, hands-off car the jump dropped (not following, no destination, still
            // near the jump target, within the deadline). Consume the stamp on the FIRST OSM landing either way
            // so it can never leak into a later drive.
            if (ctx._jumpSnap) {
              const j = ctx._jumpSnap; ctx._jumpSnap = null;
              if (!ctx.followMode && !ctx.DEST && Math.abs(ctx.car.speed) < 4 && performance.now() < j.until && Math.hypot(ctx.car.x - j.x, ctx.car.z - j.z) < 60) {
                const np = ctx.roads.nearestRoadPoint(ctx.car.x, ctx.car.z); if (np && np.d < 250) { ctx.car.x = np.x; ctx.car.z = np.z; settleAfterTeleport(); ctx.toast('🛣️ On the road', 900); }
              }
            }
          }
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
    if (!ctx.roadSegs.length) return null;
    const nodes = [], byKey = new Map(), edges = [];
    const segPts = ctx.roadSegs.map(() => []);
    const keyOf = (x, z) => Math.round(x * 10) / 10 + ',' + Math.round(z * 10) / 10;
    const addNode = (x, z) => {
      const key = keyOf(x, z);
      let id = byKey.get(key);
      if (id == null) { id = nodes.length; byKey.set(key, id); nodes.push({ x, z }); edges[id] = []; }
      return id;
    };
    const project = (x, z) => {
      let best = null, bd = 1e18;
      for (let i = 0; i < ctx.roadSegs.length; i++) {
        const s = ctx.roadSegs[i], ax = s[0][0], az = s[0][1], bx = s[1][0], bz = s[1][1];
        const vx = bx - ax, vz = bz - az, L2 = vx * vx + vz * vz || 1;
        let t = ((x - ax) * vx + (z - az) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + vx * t, pz = az + vz * t, d = (px - x) * (px - x) + (pz - z) * (pz - z);
        if (d < bd) { bd = d; best = { seg: i, t, x: px, z: pz, d: Math.sqrt(d) }; }
      }
      return best;
    };
    const start = project(sx, sz), finish = project(dx, dz);
    if (!start || !finish || start.d > 90 || finish.d > 90) return null;   // generous snap so taps near a road still route
    for (let i = 0; i < ctx.roadSegs.length; i++) {
      const s = ctx.roadSegs[i];
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
    if (_routeYFor !== ctx.ROUTE) { _routeYFor = ctx.ROUTE; _routeY = []; }
    const p = ctx.ROUTE[i], tA = terrainAt(p.x, p.z), nowMs = performance.now();
    let rec = _routeY[i];
    if (!rec || (!rec.confirmed && nowMs >= (rec.retryAt || 0))) {
      const base = rec ? rec.y : tA;
      let y = ctx.ground.rawTileY(p.x, p.z, base + 8);
      if (y == null && rec) y = ctx.ground.rawTileY(p.x, p.z, base + 24);
      if (y == null && !rec) y = ctx.ground.rawTileY(p.x, p.z);
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
    const raw = [[ctx.car.x + Math.sin(ctx.car.yaw) * 6, ctx.car.z + Math.cos(ctx.car.yaw) * 6, yC]];
    if (ctx.ROUTE && ctx.routeIdx < ctx.ROUTE.length) {
      let acc = 0, px = ctx.car.x, pz = ctx.car.z;
      for (let i = ctx.routeIdx; i < ctx.ROUTE.length && acc < 170; i++) { acc += Math.hypot(ctx.ROUTE[i].x - px, ctx.ROUTE[i].z - pz); raw.push([ctx.ROUTE[i].x, ctx.ROUTE[i].z, guideHeightAt(i)]); px = ctx.ROUTE[i].x; pz = ctx.ROUTE[i].z; }
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
  // `g` = the canvas 2D context (renamed from `ctx` so it doesn't shadow the engine ctx —
  // the procedural minimap reads engine state via ctx.* and draws via g.*).
  function drawMinimap(g, w, h) {
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, range = 620, scale = (w / 2) / range;   // wider view to match the live map zoom-out
    let _d = viewHeading() - ctx._miniYaw; while (_d > Math.PI) _d -= 2 * Math.PI; while (_d < -Math.PI) _d += 2 * Math.PI;
    ctx._miniYaw += _d * 0.2;                                                  // ease the map's rotation (viewHeading = compass while following) so jitter doesn't shimmer the whole map
    const ca = Math.cos(ctx._miniYaw), sa = Math.sin(ctx._miniYaw);
    const toPx = (wx, wz) => { const dx = wx - ctx.car.x, dz = wz - ctx.car.z; return [cx + (-dx * ca + dz * sa) * scale, cy + (-dx * sa - dz * ca) * scale]; };   // heading-up rotation: forward → screen-up
    g.lineWidth = 1.4; g.strokeStyle = 'rgba(255,255,255,0.55)'; g.beginPath();
    for (const s of ctx.roadSegs) {
      const a = toPx(s[0][0], s[0][1]), b = toPx(s[1][0], s[1][1]);
      if ((a[0] < -10 && b[0] < -10) || (a[0] > w + 10 && b[0] > w + 10) || (a[1] < -10 && b[1] < -10) || (a[1] > h + 10 && b[1] > h + 10)) continue;
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    }
    g.stroke();
    const hp = toPx(0, 0); g.fillStyle = '#4ea1ff'; g.beginPath(); g.arc(hp[0], hp[1], 3, 0, 7); g.fill();
    g.fillStyle = '#ffcb2e';                            // uncollected coins
    for (const c of ctx.coins) { if (c.got) continue; const p = toPx(c.x, c.z); if (p[0] > 0 && p[0] < w && p[1] > 0 && p[1] < h) { g.beginPath(); g.arc(p[0], p[1], 2, 0, 7); g.fill(); } }
    // neighbourhood landmarks — your 5 real places. On-map = dot; off-map = clamped to
    // the edge as a "that way" hint. Pink = still to find, green = found.
    for (const poi of POIS) {
      const p = toPx(poi.x, poi.z);
      const m = 7, edge = p[0] < m || p[0] > w - m || p[1] < m || p[1] > h - m;
      const px = clamp(p[0], m, w - m), py = clamp(p[1], m, h - m);
      const found = poiFound.has(poi.key);
      g.fillStyle = found ? '#3ad17a' : '#ff5ad0';
      g.beginPath(); g.arc(px, py, edge ? 2.6 : 3.4, 0, 7); g.fill();
      if (!found && !edge) { g.strokeStyle = 'rgba(255,90,208,0.8)'; g.lineWidth = 1.3; g.beginPath(); g.arc(px, py, 5.4, 0, 7); g.stroke(); }
    }
    if (ctx.DEST) {
      // draw the route from the CAR forward (not from ROUTE[0]) so the already-driven
      // part doesn't whip around the car-centred map during auto-drive.
      g.strokeStyle = '#2f8bff'; g.lineWidth = 2.6; g.lineJoin = 'round'; g.beginPath();
      g.moveTo(cx, cy);
      if (ctx.ROUTE && ctx.ROUTE.length > 1) for (let i = Math.max(0, ctx.routeIdx); i < ctx.ROUTE.length; i++) { const p = toPx(ctx.ROUTE[i].x, ctx.ROUTE[i].z); g.lineTo(p[0], p[1]); }
      else { const dp = toPx(ctx.DEST.x, ctx.DEST.z); g.lineTo(dp[0], dp[1]); }
      g.stroke();
      const dp = toPx(ctx.DEST.x, ctx.DEST.z);
      g.fillStyle = '#ffc21e'; g.beginPath(); g.arc(Math.max(5, Math.min(w - 5, dp[0])), Math.max(5, Math.min(h - 5, dp[1])), 4, 0, 7); g.fill();
    }
    // CAR: on a heading-up map the car always points straight UP (forward).
    g.fillStyle = '#d94f1e'; g.beginPath();
    g.moveTo(cx, cy - 7); g.lineTo(cx + 4, cy + 5); g.lineTo(cx - 4, cy + 5);
    g.closePath(); g.fill();
    // NORTH tick: world north (-z) maps to screen dir (-sin, cos) of the map heading — so the user can
    // still orient even as the whole map spins under them.
    const nlen = Math.min(cx, cy) - 8, nNx = cx - sa * nlen, nNy = cy + ca * nlen;
    g.fillStyle = 'rgba(255,255,255,0.92)'; g.font = 'bold 9px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', nNx, nNy);
  }

  // collision feedback: a thunk, a kick of camera shake, and a haptic buzz, scaled
  // by impact speed — so hits read as intentional, not a silent invisible-wall ping.
  ctx.shakeMag = 0, ctx.lastHitT = -1e9, ctx.timeScale = 1, ctx.slowmoHold = 0;
  // Returns true only when a FRESH hit registers (past the 200ms cooldown). The
  // caller gates its speed-scrub on that so a car overlapping geometry for several
  // frames isn't scrubbed to a dead stop every frame — the position push-out ejects
  // it while it keeps most of its momentum.
  function carHit(impact, kind) {
    const tnow = performance.now();
    if (impact < 4 || tnow - ctx.lastHitT < 200) return false;
    ctx.lastHitT = tnow;
    ctx.shakeMag = Math.max(ctx.shakeMag, clamp(impact * 0.05, 0.15, 1.4));
    if (ctx.audio.sfxThunk) ctx.audio.sfxThunk(clamp(impact / 60, 0.2, 1));
    if (navigator.vibrate) { try { navigator.vibrate(Math.round(clamp(impact * 1.4, 10, 55))); } catch (e) { } }
    if (kind === 'animal') ctx.toast('🦆 Watch the critters!', 900);
    // BIG hit → a celebrated moment: a beat of slow-mo, a white flash, a CRUNCH. It also
    // BREAKS your combo — that's the risk that makes near-misses worth the reward.
    else if (impact > 40) {
      if (!ctx.reduceMotion) { ctx.timeScale = 0.32; if (ctx.ui.fx) { ctx.ui.fx.classList.add('crash'); setTimeout(() => ctx.ui.fx && ctx.ui.fx.classList.remove('crash'), 320); } }
      // halve the combo (not a full wipe) — a hard knock on an invisible footprint
      // shouldn't erase a whole chain, but it should sting.
      const lost = ctx.combo > 2 ? '  ·  combo halved' : '';
      if (ctx.combo > 2) { ctx.combo = Math.floor(ctx.combo / 2); ctx.comboExpired = false; ctx.comboExpire = tnow + 4000; emitScore({}); }
      ctx.toast('💥 CRUNCH! ' + Math.round(impact * 2.237) + ' mph' + lost, 1200);
    }
    return true;
  }

  const camV = new THREE.Vector3();
  const _camT = new THREE.Vector3();      // per-frame camera target scratch (drive/scoop are mutually exclusive)
  const _lookT = new THREE.Vector3();     // desired chase look point (scratch)
  let _lookV = null;                       // smoothed chase look point — lags so the car whips toward frame edge
  let _lookYS = null;                      // low-passed look-point height — kills the per-bump vertical pitch on photoreal ground
  ctx.camGroundRef = null;                 // slow-smoothed ground height for a STATIC-feeling drone altitude
  ctx.camFloorRef = null;                   // low-passed anti-clip floor so per-bump groundAt spikes don't POP the cam
  let _camFloorT = 0, _camFloorRaw = 0;     // throttle the floor raycast (~14 Hz) — its output is low-passed to ~3 Hz anyway
  ctx.camMode = 0;
  ctx.camInit = false;
  ctx.driveCamUserPicked = false;
  // Drive cameras. Default "Cruise" is the high chase the user likes: well above
  // the melty ground-level photogrammetry, a little behind the car, looking DOWN
  // THE ROAD AHEAD (ahead = metres in front to aim at). "Close" is the low
  // cinematic chase; "Top-down" looks straight down, heading-up.
  function cycleCamera() {
    ctx.driveCamUserPicked = true;
    ctx.camMode = (ctx.camMode + 1) % DRIVE_CAMS.length; ctx.camInit = false;
    ctx.czoom = 1; ctx.camOrbit.yaw = 0; ctx.camOrbit.pitch = 0; ctx._orbitUserSet = false; ctx._viewYaw = viewHeading();   // fresh framing per view (pinch-zoom/look don't leak)
    const dd = DRIVE_CAMS[ctx.camMode].dragdrive;
    if (!DRIVE_CAMS[ctx.camMode].topdown) ctx.camera.up.set(0, 1, 0);   // only top-down is heading-up
    if (!dd) { ctx.inp2.navActive = false; navPtr = null; }         // leaving a drag-to-drive view ends it
    ctx.emit('driveCam', DRIVE_CAMS[ctx.camMode].name); emitDriveZoom();
    ctx.toast('Camera: ' + DRIVE_CAMS[ctx.camMode].name + (dd ? ' · drag to drive 🪄' : ''), dd ? 1700 : 1100);
  }
  // Jump straight to the one-finger draw-to-drive (top-down) view — the most phone-native
  // control, otherwise buried behind the 🎥 cycle.
  function traceDrive() {
    ctx.driveCamUserPicked = true;
    const i = DRIVE_CAMS.findIndex(c => c.topdown);
    if (i < 0) return;
    if (ctx.camMode === i) {
      ctx.camMode = 0; ctx.camInit = false; ctx.czoom = 1; ctx.camOrbit.yaw = 0; ctx.camOrbit.pitch = 0; ctx._orbitUserSet = false; ctx._viewYaw = viewHeading();
      ctx.inp2.navActive = false; navPtr = null; ctx.camera.up.set(0, 1, 0);
      ctx.emit('driveCam', DRIVE_CAMS[ctx.camMode].name); emitDriveZoom();   // keep the overhead zoom slider's show/hide + value in sync with the view (mirrors cycleCamera)
      ctx.toast('Camera: ' + DRIVE_CAMS[ctx.camMode].name, 1100);
      return;
    }
    ctx.camMode = i; ctx.camInit = false; ctx.czoom = 1; ctx.camOrbit.yaw = 0; ctx.camOrbit.pitch = 0; ctx._orbitUserSet = false; ctx._viewYaw = viewHeading();
    ctx.emit('driveCam', DRIVE_CAMS[i].name); emitDriveZoom();   // entering top-down → show the overhead zoom slider (mirrors cycleCamera)
    ctx.toast('🪄 Trace a path — drag your finger to drive!', 2000);
  }
  ctx.scCam = 0;
  function cycleScoopCamera() {
    ctx.scCam = (ctx.scCam + 1) % SCOOP_CAMS.length; ctx.camInit = false;
    ctx.toast('Camera: ' + SCOOP_CAMS[ctx.scCam].name, 1100);
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
      for (const bb of ctx.bldBoxes) {
        if (x > bb[0] && x < bb[1] && z > bb[2] && z < bb[3] && y < (bb[4] || 99)) {
          g = Math.max(0.2, (s - 1.5) / steps); s = steps + 1; break;
        }
      }
    }
    // photoreal tiles: raycast the same segment against the real (tall, dense)
    // tile geometry — the procedural bldBoxes are hidden, so this is what keeps
    // the chase/follow cam from burying itself in real trees & houses.
    if (ctx.p3dtiles && ctx.p3dtiles.holder.visible) {
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
        ctx.p3dtiles.raycast(camRay, _camHits);
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
  // ---- occlusion: drive tile cutaway ---- (see occlusion/tile-clip.js)
  ctx.occ = { ...createTileClip(ctx) };   // ctx.occ.updateTileClip; more occlusion methods folded in as they extract

  function updateDrive(dt, now) {
    // Mix stick (jx/jy), keyboard (kx/ky), and legacy pedal inputs. The left
    // thumbstick is a Roblox-style move stick: X steers, up is gas, down is
    // brake/reverse. Just steering gently auto-accelerates so kids still cruise.
    // keyboard arrows are binary ±1 — ramp them over ~0.15 s so desktop steering eases
    // in like the touch stick instead of snapping (kSteer feeds jx; touch jx stays direct).
    ctx.car.kSteer = (ctx.car.kSteer || 0) + (ctx.inp2.kx - (ctx.car.kSteer || 0)) * Math.min(1, dt * 7);
    let jx = clamp(ctx.inp2.jx + ctx.car.kSteer + ctx.inp2.steer, -1, 1);
    let throttleTarget = 0, brake = 0, reverse = false;
    // TWIN-STICK MOVE: the left stick's vertical axis IS the throttle/brake now.
    //   jy < 0 (push up)   → gas, proportional to how far up
    //   jy > 0 (pull down) → brake / reverse
    // (setGasAmount/setBrake still feed inp2.gas/inp2.brake for back-compat.)
    const jyGas = ctx.inp2.jy < -MOVE_DEADZONE ? clamp((-ctx.inp2.jy - MOVE_DEADZONE) / (1 - MOVE_DEADZONE), 0, 1) : 0;
    const jyBrake = ctx.inp2.jy > MOVE_DEADZONE;
    // BRAKE vs REVERSE — the fix for "too easy to end up backwards": a light/partial down-pull only
    // BRAKES (stop + hold at 0). Reverse needs a DELIBERATE near-full pull-down (or full brake button /
    // held down-arrow) AND the car already stopped for a moment, so steering with a little downward
    // drift — or a hard brake-to-stop — can no longer fling the car into reverse.
    const wantReverse = (ctx.inp2.jy > 0.62 || ctx.inp2.brake > 0.85 || ctx.inp2.ky > 0);
    if (wantReverse && Math.abs(ctx.car.speed) < 1.4) ctx.car.revArmT = (ctx.car.revArmT || 0) + dt; else if (!wantReverse) ctx.car.revArmT = 0;
    reverse = wantReverse && (ctx.car.revArmT || 0) > 0.32;
    if (ctx.inp2.brake || ctx.inp2.ky > 0 || jyBrake) brake = 1;
    else if (ctx.inp2.ky < 0) throttleTarget = 1;                  // keyboard = full
    else if (jyGas > 0) throttleTarget = jyGas;                // left stick up = analog gas
    else if (ctx.inp2.gas > 0) throttleTarget = ctx.inp2.gas;          // touch gas (analog 0..1)
    // Stick-only "auto-creep": cruise GENTLY toward ~18 u/s (≈40 mph) instead of
    // flooring it — a kid who only steers should roll at a corner-able pace, never
    // pin to the 220 mph top end. Push up for the real speed.
    else if (Math.abs(jx) > 0.05) throttleTarget = clamp((13 - ctx.car.speed) / 13, 0, 0.42);   // steer-only: roll at a gentle, corner-able pace
    // ANALOG pedal: squeeze the throttle up over ~0.4 s and bleed it off faster, so the
    // gas feels like a pedal you press (feather power out of a slide), not a switch.
    const cur = ctx.car.throttle || 0;
    const tRate = throttleTarget > cur ? 2.6 : 5.4;
    ctx.car.throttle = cur + (throttleTarget - cur) * Math.min(1, dt * tRate);
    let throttle = ctx.car.throttle;
    // GRAB THE WHEEL: any real steer/gas/brake input drops auto-drive so the player
    // instantly takes over instead of fighting the robot.
    const _userInput = Math.abs(ctx.inp2.jx + ctx.inp2.kx + ctx.inp2.steer) > 0.2 || Math.abs(ctx.inp2.jy) > MOVE_DEADZONE || ctx.inp2.gas || ctx.inp2.brake || ctx.inp2.ky;
    if (ctx.autoDrive && _userInput) {
      ctx.autoDrive = false; ctx.inp2.navActive = false; clearRouteRail(); stopFollow(); ctx.emit('autodrive', false); ctx.toast('🕹️ You took the wheel!', 900);
    }
    // FOLLOW runs with autoDrive OFF, so the grab-wheel check above won't catch it — let real input end it too.
    if (ctx.followMode && _userInput) { stopFollow(); ctx.toast('🕹️ You took the wheel!', 900); }
    // advance the route waypoint as the car passes it. Advance by PROJECTION (how far the car
    // has travelled along the current segment), not just proximity — at high speed the car
    // overshoots a 16 m radius without ever entering it, so routeIdx would stick and the car
    // would circle the same point. The while-loop clears several waypoints in one fast frame.
    while (ctx.ROUTE && ctx.routeIdx < ctx.ROUTE.length - 1) {
      const a = ctx.ROUTE[ctx.routeIdx], b = ctx.ROUTE[ctx.routeIdx + 1];
      const vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz || 1;
      const t = ((ctx.car.x - a.x) * vx + (ctx.car.z - a.z) * vz) / L2;
      if (t > 0.8 || Math.hypot(a.x - ctx.car.x, a.z - ctx.car.z) < 16) ctx.routeIdx++; else break;
    }
    // auto-drive: follow the road ROUTE. Arrival is reaching the END OF THE ROUTE (the road
    // point nearest the target) — NOT the raw target, so a tap that lands off-road doesn't
    // make the car circle forever trying to reach a point with no road. While no route is
    // ready it simply HOLDS (idles) rather than cutting straight across the land.
    if (ctx.autoDrive && ctx.DEST) {
      const end = ctx.ROUTE && ctx.ROUTE.length ? ctx.ROUTE[ctx.ROUTE.length - 1] : null;
      // When the RAIL is active (ROUTE has ≥2 pts) it OWNS the approach and the precise braked stop. Do NOT
      // let this physics check "arrive" early: at 12 m out the rail can still be doing ~79 m/s (its √(2·a·d)
      // cap), and clearing the destination there drops the car at speed with NO rail → it coasts straight
      // PAST the target. That was the "autodrive overshoot when it goes fast". Defer to the rail's own stop.
      const railActive = !!(ctx.ROUTE && ctx.ROUTE.length > 1);
      const atEnd = !railActive && end && (ctx.routeIdx >= ctx.ROUTE.length || Math.hypot(end.x - ctx.car.x, end.z - ctx.car.z) < 12);
      if (!ctx.ROUTE) { ctx.inp2.navActive = false; if (ctx.DEST.geo && now - (ctx.DEST._retryT || 0) > 4000) { ctx.DEST._retryT = now; fetchRoute(ctx.DEST.geo.lat, ctx.DEST.geo.lon); } }   // hold + self-retry the route every 4 s (transient API/network blip → self-heals)
      else if (atEnd) {
        if (!ctx.DEST.reached) { ctx.DEST.reached = true; if (ctx.DEST.celebrate && !POIS.some(p => Math.hypot(p.x - ctx.DEST.x, p.z - ctx.DEST.z) < 50)) arriveCelebrate(ctx.DEST.label, 0, now); }
        clearDestination();   // arrived — drop the nav card + route line (was sticking on "arriving…") and end auto-drive
      } else { const t = navTarget(); ctx.inp2.navActive = true; ctx.inp2.navX = t.x; ctx.inp2.navZ = t.z; }
    }
    // Reached a self-driven destination: clear the route either way, but only show the
    // ARRIVAL banner for a place chosen from the GO address search (DEST.celebrate). A
    // casual tap-to-trace is not an "arrival" worth a banner (the user: only show it if
    // you pick an address from GO). POIs run their own richer celebration via checkPOIs.
    else if (ctx.DEST && !ctx.DEST.reached && Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z) < 14) {
      ctx.DEST.reached = true;
      if (ctx.DEST.celebrate && !POIS.some(p => Math.hypot(p.x - ctx.DEST.x, p.z - ctx.DEST.z) < 50)) arriveCelebrate(ctx.DEST.label, 0, now);
      clearDestination();
    }
    // Point-and-drive override (Top-down drag + auto-drive): steer toward the target
    // ground point. Speed scales with DISTANCE (drag far = floor it, near = creep),
    // and if the target is BEHIND the car it reverses toward it instead of looping.
    let autoTurnLimit = Infinity;   // robot's heading-error speed governor; also feeds the autoCap below
    if (ctx.inp2.navActive) {
      const dx = ctx.inp2.navX - ctx.car.x, dz = ctx.inp2.navZ - ctx.car.z, dd = Math.hypot(dx, dz);
      let dyaw = Math.atan2(dx, dz) - ctx.car.yaw;
      while (dyaw > Math.PI) dyaw -= 2 * Math.PI; while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      const farT = clamp(dd / (ctx.autoDrive ? 52 : 40), 0, 1); // 0 near → 1 far; robot looks further ahead
      const robot = ctx.autoDrive && ctx.DEST;
      if (dd < 2.5) { jx = 0; throttle = 0; brake = Math.abs(ctx.car.speed) > 2 ? 0.7 : 0; }
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
          const dDest = Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z);
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
          const gap = want - Math.abs(ctx.car.speed);
          throttle = clamp(0.42 + gap / Math.max(22, want) * 0.95, 0, 1) * align;
          brake = gap < -6 ? clamp((-gap - 4) / 22, 0, 0.85) : 0;   // brake sooner + harder when overspeed for the bend
          if (brake > 0.05) throttle = 0;
        } else {
          throttle = clamp((0.22 + farT * 0.78) * align, 0, 1);
          brake = 0;
        }
      }
    }
    if (throttle > 0.1 || brake > 0.1) ctx.showT = 0;
    if (throttle > 0.1) startRun(now);                 // first gas starts the coin-rally clock
    const road = ctx.onRoad(ctx.car.x, ctx.car.z);
    // "Open road" = on a procedural street OR out past the neighbourhood block
    // (±340 m), where the only surface is the real photoreal road — let it rip there
    // so a cross-town blast to Meemaw's can hit triple digits. WITHIN the block,
    // off the streets means lawns: a real penalty so the pavement is the fast line.
    const fromHome = Math.hypot(ctx.car.x, ctx.car.z);
    const openRoad = road || fromHome > 340;
    const highway = fromHome > 340;   // the real open road / cross-town — let it RIP (way faster)
    // Per-car handling profile (Sienna heavy+grippy, Ferrari fast+slidey, Toy twitchy).
    const profActive = ctx.car.models[ctx.car.modelIdx];
    const prof = (profActive && profActive.profile) || { accel: 1, top: 1, grip: 1, slip: 0.7 };
    // High top speed on the open road (maxF 100 u/s ≈ 224 mph × per-car). Lawns cap
    // ~44 mph with heavy drag so you slow right down and steer back to the street.
    // NITRO: spend the meter (built from near-misses / drifts / arrivals) for a surge —
    // routes the skill economy into raw speed, the addictive part of an arcade loop.
    // auto-fire: flooring the throttle (or the Shift/🚀 input) with charge dumps nitro —
    // no spare thumb is free for a manual button (left=steer, right=pedals).
    const boosting = (ctx.inp2.boost || throttle > 0.92) && ctx.boost > 0.02 && Math.abs(ctx.car.speed) > 1.5;
    if (boosting) { ctx.boost = Math.max(0, ctx.boost - dt * 0.4); if (!ctx.boostWas) { if (ctx.audio.sfxWhoosh) ctx.audio.sfxWhoosh(1); ctx.toast('🚀 NITRO!', 700); if (!ctx.reduceMotion) { ctx.shakeMag = Math.max(ctx.shakeMag, 0.6); if (ctx.ui.fx) { ctx.ui.fx.classList.add('boost'); setTimeout(() => ctx.ui.fx && ctx.ui.fx.classList.remove('boost'), 160); } } } }   // hard-earned nitro gets a real punch: camera kick + a brief flash
    ctx.boostWas = boosting;
    const boostMul = boosting ? 1.34 : 1;
    let maxF = (highway ? 250 : openRoad ? 115 : 38) * prof.top * boostMul * ctx.speedMul; const maxR = -11;   // highway = supersonic; lawns crawl
    if (ctx.autoDrive && (highway || openRoad)) maxF = Math.max(maxF, 440 * boostMul * ctx.speedMul);   // let the chauffeur RIP — it follows the route on rails (see the rail block), so it can't overshoot; a cross-town trip should take ~30-90 s
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
    const manual = !ctx.autoDrive;
    // FINE-CONTROL low band: by hand, the first ~18% of pedal maps to a gentle linear crawl
    // (up to ~7 u/s ≈ 15 mph) you can HOLD for precise manoeuvring, instead of the cube curve's
    // near-zero-then-lunge bottom. Above that the cube curve takes over toward the top; floored
    // (throttle=1) the cube far exceeds the crawl band, so top speed is untouched.
    const fine = manual ? Math.min(throttle, 0.18) / 0.18 * Math.min(7, maxF * 0.5) : 0;   // cap the crawl band under maxF so a tiny lawn/slow-car maxF doesn't flat-line the upper pedal
    const pedalTgt = Math.max(fine, Math.pow(throttle, manual ? 3.4 : 2.4) * maxF);  // curved pedal → target speed; steeper manual = easier SLOW crawl at the bottom
    const aGap = pedalTgt - ctx.car.speed;
    const aMax = (highway ? 62 : openRoad ? 32 : 13) * prof.accel * boostMul * ctx.speedMul * (manual ? 0.50 : 1);   // peak engine pull (cap); manual builds speed more gradually (gentler off the line)
    let acc = clamp(aGap * (aGap > 0 ? (manual ? 1.25 : 2.6) : 0.9), -aMax, aMax);     // chase target; softer manual pull eases toward target (precision) + lift-off coast
    if (aGap > 0) acc *= 0.75 + 0.25 * clamp(Math.abs(ctx.car.speed) / 6, 0, 1);   // gentle off-the-line ramp — keeps a floored stab feeling punchy, not sluggish
    // PROGRESSIVE brake: ramp the brake force in over ~0.25 s so a quick tap trail-brakes
    // lightly (corner-entry finesse) while a long hold still hauls it down hard.
    const braking = brake > 0.1;
    const bcur = ctx.car.brakeAmt || 0;
    ctx.car.brakeAmt = bcur + ((braking ? 1 : 0) - bcur) * Math.min(1, dt * (braking ? 4 : 9));
    if (braking) acc = ctx.car.speed > 0.5 ? -32 * ctx.car.brakeAmt : ctx.car.speed < -0.5 ? 32 * ctx.car.brakeAmt : (reverse ? -13 : 0);   // forward → brake; rolling backward → brake forward to a stop; stopped → back up only on a DELIBERATE reverse
    // (engine-braking is now implicit: lifting off drops the pedal target below your speed,
    // so the curve above coasts you down on its own.)
    // LOAD TRANSFER: the body dives forward under braking and squats back under power —
    // gives the car visible weight (a Sienna wallows, a Ferrari is crisp via prof.grip).
    ctx.car.pitchDyn = (ctx.car.pitchDyn || 0) + (clamp(-acc * 0.012, -0.2, 0.2) / (0.6 + prof.grip * 0.5) - (ctx.car.pitchDyn || 0)) * Math.min(1, dt * 6);
    // Auto-drive cap scales with distance to the next turn / the destination — long
    // straight legs of a cross-town route run fast (up to maxF), only corners and the
    // final approach slow the chauffeur down, so the trip isn't a crawl.
    let autoCap = 200;
    if (ctx.autoDrive) {
      const dDest = ctx.DEST ? Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z) : 1e9;
      // FAST on the straights, still turn-aware. The throttle controller above aims at this
      // pace; this cap is the guardrail. The old +70 highway bonus let the cap stay high right
      // at a bend (so it blew the turn) — keep it modest, and ALSO respect the heading-error
      // governor so the cap actually drops as the route bends ahead.
      autoCap = Math.min(autoDriveTargetSpeed(dDest) + 20, autoTurnLimit + 16);
    }
    ctx.car.speed += acc * dt;
    ctx.car.speed -= ctx.car.speed * (highway ? 0.06 : openRoad ? 0.1 : 0.28) * dt;   // highway = slippery-fast, lawns drag
    ctx.car.speed = clamp(ctx.car.speed, maxR, maxF);
    if (ctx.autoDrive && ctx.car.speed > autoCap) ctx.car.speed += (autoCap - ctx.car.speed) * Math.min(1, dt * 7);   // brake to the cap FAST so a fast leg can still slow for the next turn (was dt*3.2 → too slow, overshot)
    if (throttle < 0.1 && brake < 0.1 && Math.abs(ctx.car.speed) < 0.4) ctx.car.speed = 0;
    // tighter turns at speed (makes corners) but softened up high so the open-road blast
    // the design invites stays pointable instead of going numb.
    const steerTarget = (-jx) * 0.5 / (1 + Math.abs(ctx.car.speed) * 0.05);   // tame yaw authority up top so the blast stays pointable
    ctx.car.steer += (steerTarget - ctx.car.steer) * Math.min(1, dt * 12);   // snappier wheel — less lag between thumb and tyres
    // brake-to-drift: stab the brake while turning fast (or the Space handbrake) and
    // the tail steps out; a handbrake yaw kick helps rotate through tight corners.
    const hb = (ctx.inp2.hbrake || (brake > 0.1 && Math.abs(ctx.car.speed) > 8)) ? 1 : 0;
    // High-speed yaw DAMPER: without this the speed/2.7 term overwhelms the steer-angle
    // falloff and net yaw rate climbs all the way up, making the flat-out blast twitchier
    // the faster you go. Authority now peaks ~mid-speed (~35 mph) and tapers above so a
    // 200 mph straight tracks with small corrections.
    const yawDamp = clamp(1 - (Math.abs(ctx.car.speed) - 20) * 0.008, 0.55, 1);   // keep enough authority to DODGE at speed
    ctx.car.yaw += (ctx.car.speed / 2.7) * Math.tan(ctx.car.steer) * (0.8 + prof.grip * 0.25) * (1 + hb * 0.4) * yawDamp * dt;
    // Distance to the nearest road, ALWAYS measured at the car's EXACT current position
    // (nearestRoadPoint now consults the live ROUTE + free-roam snap + every mapped road, so it's
    // valid even far from the procedural hood). inHood still gates the discrete snap-back below.
    const inHood = Math.hypot(ctx.car.x, ctx.car.z) < 330;
    const nrp = ctx.roads.nearestRoadPoint(ctx.car.x, ctx.car.z);
    const offRoadDist = nrp.d;
    updateAreaRoads(now);   // fetch/refresh the OSM road network around the car so the assist has real roads to hug far from home
    updateLocationLabel(now);   // live STREET · CITY, ST readout in the subline
    // AUTO-STEER assist: aim the car along the ROUTE (when navigating), or — in free-roam —
    // along the nearest road via a look-ahead point that takes street corners for you. When
    // you've drifted OFF the road it switches to RECOVERY: aim straight back at the nearest
    // tarmac from any angle, strongly, so it actively steers you home. Your steering always
    // overrides the corner/track assist (fades to 0 as you push the stick).
    let assistTargetRate = 0;
    if (!ctx.followMode && ctx.autoSteer && !ctx.inp2.navActive && !hb && Math.abs(ctx.car.speed) > 4) {   // follow OWNS the heading (street-tangent ease below) — don't let the steer-assist fight it
      let dir = null, recover = false; const onRoute = !!(ctx.ROUTE && ctx.routeIdx < ctx.ROUTE.length);
      if (onRoute) { const t = navTarget(); dir = [t.x - ctx.car.x, t.z - ctx.car.z]; }
      else if (offRoadDist > 8 && offRoadDist < 60) { dir = [nrp.x - ctx.car.x, nrp.z - ctx.car.z]; recover = true; }   // drifted off → steer straight back to the nearest road (hood OR the fetched OSM graph)
      else { const tp = ctx.roads.roadTargetAhead(ctx.car.x, ctx.car.z, ctx.car.yaw, ctx.car.speed); if (tp) dir = [tp[0] - ctx.car.x, tp[1] - ctx.car.z]; }   // hug the road ahead (roadTargetAhead uses the OSM graph far from home)
      if (dir && (dir[0] || dir[1])) {
        let d = Math.atan2(dir[0], dir[1]) - ctx.car.yaw;
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
          const k = (1 - yours) * clamp(Math.abs(ctx.car.speed) / 16, 0.5, 1) * (recover ? 2.8 : (onRoute ? 3.0 : 2.6));
          assistTargetRate = clamp(d, -1.1, 1.1) * k;
        }
      }
    }
    // SMOOTH the assist: low-pass the correction rate so a jump in the aim point (a segment
    // switch or a waypoint advance) eases in over a few frames instead of snapping the wheel
    // — this kills the "jerky road assist". Decays to 0 when the assist isn't engaged.
    ctx.car.assistRate = (ctx.car.assistRate || 0) + (assistTargetRate - (ctx.car.assistRate || 0)) * (1 - Math.exp(-dt * 7));
    ctx.car.yaw += ctx.car.assistRate * dt;
    // AUTO-RECOVER: if you're stranded well off the road — drove deep into a yard, or
    // crashed and stopped out there — the steer-back can't reach you, so snap to the
    // nearest road automatically (assist on, in the hood, not mid-route). While a ROUTE is
    // active the Google line need not lie on the procedural roadSegs, so measuring off-road
    // distance against roadSegs would ping-pong the reset (snap to route → "off roadSegs" →
    // snap again) and the camera never settles — that was the "crash hides the car". The
    // route-autosteer handles staying on a route; a cooldown blocks any immediate re-fire.
    ctx.recoverCooldown = Math.max(0, ctx.recoverCooldown - dt);
    const onRouteNow = !!(ctx.ROUTE && ctx.routeIdx < ctx.ROUTE.length);
    if (!ctx.followMode && ctx.autoSteer && inHood && !onRouteNow && ctx.recoverCooldown <= 0) {
      if (offRoadDist > 14) ctx.offRoadT += dt; else ctx.offRoadT = 0;
      const stuck = Math.abs(ctx.car.speed) < 3;
      if (offRoadDist > 42 || (ctx.offRoadT > 1.5 && offRoadDist > 22) || (ctx.offRoadT > 2.2 && stuck)) { ctx.offRoadT = 0; resetToRoad(); }
    } else if (ctx.autoDrive && onRouteNow && ctx.recoverCooldown <= 0) {
      // The chauffeur wandered off the ROUTE line — snap back so it re-syncs. Require PERSISTENCE
      // (off for a beat, or way off) so a single momentary overshoot on a bend doesn't teleport-loop.
      if (offRoadDist > 30) ctx.offRoadT += dt; else ctx.offRoadT = 0;
      if (offRoadDist > 80 || (ctx.offRoadT > 1.2 && offRoadDist > 45)) { ctx.offRoadT = 0; resetToRoad(); }
    } else ctx.offRoadT = 0;
    // HARD UNSTICK: a bad teleport/landing can bury the car inside a building footprint, where
    // the collision below collapses every move candidate to its own spot (can't budge in any
    // gear). If we're already inside one, snap back to the road now (resetToRoad uses the live
    // route far from home); the heading is re-derived from the corrected state just below.
    // Gate on recoverCooldown so it can't 60 Hz-spam (blip/toast/reset) if a snap point ever
    // lands back inside a footprint — it retries at most every ~1.8 s instead.
    if (!ctx.followMode && ctx.recoverCooldown <= 0 && insideBuilding(ctx.car.x, ctx.car.z)) resetToRoad();   // follow's glide phases through buildings and OWNS position — don't let recovery yank/fight it
    const fx = Math.sin(ctx.car.yaw), fz = Math.cos(ctx.car.yaw);
    // arcade drift: tail-out lateral slip — readable even WITHOUT the handbrake now;
    // grip recovers it. On THROTTLE the rear stays out (a power-slide you can hold on
    // exit), so we ease grip recovery while you're on the gas instead of killing it.
    const slip = prof.slip * (1 + hb * 1.9);
    ctx.car.vlat = (ctx.car.vlat || 0) + ctx.car.steer * Math.abs(ctx.car.speed) * slip * 1.4 * dt;
    // POWER-SLIDE reward: on the gas, at speed, while turning → the throttle actively
    // pushes the tail out (positive exit-yaw), so flooring it through a corner holds a
    // satisfying drift instead of just leaning on grip recovery being eased.
    if (throttle > 0.4 && !hb && Math.abs(ctx.car.speed) > 10) ctx.car.vlat += ctx.car.steer * throttle * prof.slip * 18 * dt;
    const gripK = (prof.grip * (hb ? 1.4 : 3.5)) * (throttle > 0.5 && !hb ? 0.55 : 1);
    ctx.car.vlat *= Math.exp(-gripK * dt);
    // spin-recovery assist: tail way out + you're NOT actively steering or handbraking
    // → it tucks back in faster, so an over-rotation is catchable, not a full spin-out.
    if (!hb && Math.abs(jx) < 0.3 && Math.abs(ctx.car.vlat) > 7) ctx.car.vlat *= Math.exp(-2.2 * dt);
    ctx.car.vlat = clamp(ctx.car.vlat, -26, 26);
    const rpx = Math.cos(ctx.car.yaw), rpz = -Math.sin(ctx.car.yaw);   // car's right vector
    let nx = ctx.car.x + (fx * ctx.car.speed + rpx * ctx.car.vlat) * dt, nz = ctx.car.z + (fz * ctx.car.speed + rpz * ctx.car.vlat) * dt;
    // SOFT WALL / gravity-well: once the car strays past the lane edge, pull it back toward the
    // nearest road point. A positional nudge folded into THIS frame's move (so the building/tree
    // collision below still clamps it) — works even stopped or pointed away, where the yaw assist
    // can't. Ramps in over a few metres (soft edge), clamps under driving speed (never yanks), and
    // fades as you steer, so it reads like an invisible berm on the shoulder. Only where a road
    // graph exists (the hood or a live route) so it never tugs you back into town from the open road.
    if (ctx.autoSteer && !hb && (inHood || onRouteNow || ctx.osmRoadSegs.length) && offRoadDist > LANE_HALF && offRoadDist < 120) {
      const over = offRoadDist - LANE_HALF;
      const ramp = clamp(over / 6, 0, 1);                       // ease in over the first 6 m
      const yours = clamp(Math.abs(jx) * 1.5, 0, 1);            // fade out as the player steers hard
      let ux = nrp.x - ctx.car.x, uz = nrp.z - ctx.car.z; const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
      const pull = Math.min(WALL_MAX, over * WALL_GAIN) * ramp * (1 - yours);
      nx += ux * pull * dt; nz += uz * pull * dt;
    }
    updateTraffic(dt, now);   // move the ambient cars (positions feed the collision below)
    const rad = 1.25;
    let hitThisFrame = false, nearThisFrame = false;
    const fast = Math.abs(ctx.car.speed) > 14;
    // buildings are solid only at their real footprint; slide along the wall
    // instead of stopping dead so you can scrape past a corner.
    if (insideBuilding(nx, nz)) {
      if (!insideBuilding(nx, ctx.car.z)) nz = ctx.car.z;
      else if (!insideBuilding(ctx.car.x, nz)) nx = ctx.car.x;
      else { nx = ctx.car.x; nz = ctx.car.z; }
      if (carHit(Math.abs(ctx.car.speed), 'wall')) ctx.car.speed *= 0.38;   // scrub only on a fresh hit (else position push-out frees you)
      hitThisFrame = true;
    }
    for (const t of ctx.treePts) {
      const dx = nx - t[0], dz = nz - t[1], d2 = dx * dx + dz * dz, rr = 0.75 + rad;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2); nx = t[0] + dx / d * rr; nz = t[1] + dz / d * rr;
        if (carHit(Math.abs(ctx.car.speed), 'tree')) ctx.car.speed *= 0.42;
        hitThisFrame = true;
      } else if (fast && d2 < (rr + 1.6) * (rr + 1.6)) nearThisFrame = true;   // skimmed it
    }
    // sanctuary-safe: animals always bounce the car, never get hurt
    for (const a of ANIMALS) {
      const dx = nx - a.x, dz = nz - a.z, d2 = dx * dx + dz * dz, rr = a.r + rad + 0.5;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2); nx = a.x + dx / d * rr; nz = a.z + dz / d * rr;
        if (carHit(Math.abs(ctx.car.speed), 'animal')) ctx.car.speed *= 0.5;   // deflect, don't fling backward
        hitThisFrame = true;
      } else if (fast && d2 < (rr + 1.6) * (rr + 1.6)) nearThisFrame = true;
    }
    // TRAFFIC: weave past it for a near-miss combo, clip it for a soft deflect (it yields
    // + keeps its lane, so a tap is a glancing bump you keep rolling through, not a wall).
    if (ctx.roadLifeOn) {
      for (const c of traffic) {
        if (c.x === undefined) continue;
        const dx = nx - c.x, dz = nz - c.z, d2 = dx * dx + dz * dz, rr = 1.9 + rad;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2); nx = c.x + dx / d * rr; nz = c.z + dz / d * rr;
          if (carHit(Math.abs(ctx.car.speed), 'car')) ctx.car.speed *= 0.72;
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
    if (Math.hypot(nx, nz) > lim) { const d = Math.hypot(nx, nz); nx *= lim / d; nz *= lim / d; ctx.car.speed *= 0.4; }  // soft edge: ease to a stop, don't shove back
    if (!ctx.followMode) { ctx.car.x = nx; ctx.car.z = nz; }   // in follow the glide below OWNS position — don't let the physics step creep the car forward each frame (it caused a ~1.5 m steady-state drift past the target)
    // AUTO-DRIVE RAIL: when the chauffeur has a route, ignore the physics result and glide the car
    // ALONG the route by arc-length at a fast cruise — so it follows the road EXACTLY (no overshoot,
    // no ping-pong) and a cross-town trip takes ~30-90 s. Position is overridden here (after the
    // collision step), so it phases through obstacles on the route — that's the point.
    if (ctx.followMode && ctx._followGeo) {
      // EXACT FOLLOW via a CRITICALLY-DAMPED SPRING toward the live GPS point. A raw lerp has no momentum,
      // so each new (sparse) fix made the car DART then stop — stop-and-go jerk. The spring carries velocity:
      // a fix-jump accelerates the car smoothly and it eases in with no overshoot (critical damping), so
      // motion stays continuous between updates. No routing/rail here (those snapped to the wrong street).
      const dx = ctx._followGeo.x - ctx.car.x, dz = ctx._followGeo.z - ctx.car.z;
      const K = 12, C = 2 * Math.sqrt(K);   // critical → no overshoot, ~1.2 s to close a gap, smooth speed-ups/downs
      ctx._followVx += (dx * K - ctx._followVx * C) * dt;
      ctx._followVz += (dz * K - ctx._followVz * C) * dt;
      let mx = ctx._followVx * dt, mz = ctx._followVz * dt;
      const step = Math.hypot(mx, mz), MAXSTEP = 520 * ctx.speedMul * dt;   // safety cap (a far/garbage target can't fling the car)
      if (step > MAXSTEP && step > 1e-4) { const s = MAXSTEP / step; mx *= s; mz *= s; ctx._followVx *= s; ctx._followVz *= s; }
      ctx.car.x += mx; ctx.car.z += mz; ctx.car.groundY = null; ctx.car.vlat = 0; ctx.car.steer = 0; ctx.car.assistRate = 0;   // assistRate=0 so a residual steer-assist rate can't keep rotating yaw under the street-tangent ease
      ctx.car.speed = Math.hypot(mx, mz) / Math.max(dt, 1e-3);   // for cam framing / wheel spin
      ctx.car.railS = null; ctx.car.railSpeed = null;
      // Face the car ALONG THE STREET (nearest road tangent, oriented toward travel) — NOT the compass.
      // The compass instead drives the MAP rotation (minimap + overhead/aerial view) via viewHeading().
      const mvx = Math.hypot(dx, dz) > 0.4 ? dx : Math.sin(ctx.car.yaw), mvz = Math.hypot(dx, dz) > 0.4 ? dz : Math.cos(ctx.car.yaw);
      let tgtYaw;
      const seg = ctx.roads.nearestRoadSeg(ctx.car.x, ctx.car.z);
      if (seg && seg.d < 60) { const dot = seg.tx * mvx + seg.tz * mvz, tx = dot < 0 ? -seg.tx : seg.tx, tz = dot < 0 ? -seg.tz : seg.tz; tgtYaw = Math.atan2(tx, tz); }   // align to the road, in the direction we're heading
      else tgtYaw = Math.hypot(dx, dz) > 0.5 ? Math.atan2(dx, dz) : ctx.car.yaw;   // off any known road → just face the way we're gliding
      let _fd = tgtYaw - ctx.car.yaw; while (_fd > Math.PI) _fd -= 2 * Math.PI; while (_fd < -Math.PI) _fd += 2 * Math.PI;
      ctx.car.yaw += _fd * (1 - Math.exp(-dt * 5));
    } else if (ctx.autoDrive && ctx.ROUTE && ctx.ROUTE.length > 1) {
      if (ctx.car.railS == null || ctx._railRoute !== ctx.ROUTE) { ctx.car.railS = railArcAt(ctx.car.x, ctx.car.z); ctx._railRoute = ctx.ROUTE; ctx.car.railSpeed = Math.abs(ctx.car.speed); }
      const total = routeTotalLen(), remain = total - ctx.car.railS;
      // MUCH FASTER on the way: scale hard with the open road ahead (up to ~520 m/s), easing only for
      // real bends. distToNextTurn looks ~500 m ahead, so long straights peg the cap. The rail OWNS the
      // speed via its own railSpeed (and overwrites car.speed) so the physics autodrive governor (autoCap,
      // pulled hard at dt*7 above) can't clamp it down — safe because the rail glues the car to the
      // polyline by arc-length, so it can't leave the route at ANY speed.
      const _cruise = clamp(150 + distToNextTurn() * 3.4, 150, 520 * ctx.speedMul);
      ctx.car.railSpeed += (_cruise - ctx.car.railSpeed) * Math.min(1, dt * 3);           // smooth ACCEL toward the cruise
      // GUARANTEED STOP AT THE DESTINATION: HARD-cap the speed to the fastest you could still brake to 0
      // within the distance left (v = √(2·a·d)) — a hard clamp, NOT a lagged ease. With the old ease the
      // speed stayed ABOVE this cap and the car ran in too hot and overshot; clamped, the car can always
      // stop in `remain` and decelerates at exactly BRAKE_A to rest at the end. Super-braking decel (~26 g,
      // it's on rails) so it never needs to start slowing early to make the stop.
      const BRAKE_A = 260;
      const stopCap = Math.sqrt(Math.max(0, 2 * BRAKE_A * remain));
      if (ctx.car.railSpeed > stopCap) ctx.car.railSpeed = stopCap;                       // hard clamp → always able to stop by the destination
      if (ctx.car.railSpeed < 0) ctx.car.railSpeed = 0;
      ctx.car.speed = ctx.car.railSpeed;
      ctx.car.railS = Math.min(total, ctx.car.railS + ctx.car.speed * dt);                    // never roll past the destination
      // Don't mistake the end of a still-loading route for ARRIVAL: if the real destination is still far
      // away (the full Directions route lands a beat after the seed/local route we set off on), hold at
      // the route end and let the rail re-acquire when the longer route arrives — give up after ~6 s so a
      // route that never comes can't soft-lock the car.
      if (remain <= 1.5) ctx.car.railEndT = (ctx.car.railEndT || 0) + dt; else ctx.car.railEndT = 0;
      const farFromDest = ctx.DEST && Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z) > 150;
      if (remain <= 1.5 && ctx.car.speed < 6 && (!farFromDest || ctx.car.railEndT > 6)) {  // braked to a near-stop AT the destination → arrive
        if (ctx.DEST) { const bx = ctx.DEST.rawX != null ? ctx.DEST.rawX : ctx.DEST.x, bz = ctx.DEST.rawZ != null ? ctx.DEST.rawZ : ctx.DEST.z; if (Math.hypot(bx - ctx.car.x, bz - ctx.car.z) > 1) ctx.car.yaw = Math.atan2(bx - ctx.car.x, bz - ctx.car.z); }   // PARK facing the actual BUILDING (rawX/rawZ), not the snapped curb point (≈ the car)
        ctx.car.speed = 0; ctx.car.railS = null; ctx.car.railSpeed = null; ctx.car.railEndT = 0;
        if (ctx.DEST && !ctx.DEST.reached) { ctx.DEST.reached = true; if (ctx.DEST.celebrate && !POIS.some(p => Math.hypot(p.x - ctx.DEST.x, p.z - ctx.DEST.z) < 50)) arriveCelebrate(ctx.DEST.label, 0, now); }
        clearDestination();
      } else {
        const rp = railPointAt(ctx.car.railS);
        ctx.car.x = rp.x; ctx.car.z = rp.z; ctx.routeIdx = rp.i;
        // PARK IN FRONT: over the last few metres, turn from the route tangent to FACE the actual
        // address so the car pulls up looking at the building instead of stopping mid-lane.
        let aimYaw = rp.yaw;
        if (ctx.DEST && remain < 9) { const bx = ctx.DEST.rawX != null ? ctx.DEST.rawX : ctx.DEST.x, bz = ctx.DEST.rawZ != null ? ctx.DEST.rawZ : ctx.DEST.z; if (Math.hypot(bx - ctx.car.x, bz - ctx.car.z) > 1.5) { const fy = Math.atan2(bx - ctx.car.x, bz - ctx.car.z); let d = fy - rp.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; aimYaw = rp.yaw + d * clamp(1 - remain / 9, 0, 1); } }   // turn to face the actual BUILDING (rawX/rawZ) on the final approach; the >1.5 m guard avoids atan2 noise
        let _dy = aimYaw - ctx.car.yaw; while (_dy > Math.PI) _dy -= 2 * Math.PI; while (_dy < -Math.PI) _dy += 2 * Math.PI;
        ctx.car.yaw += _dy * Math.min(1, dt * 12);                                    // ease the heading onto the route tangent / toward the address on arrival
        ctx.car.vlat = 0; ctx.car.steer = 0;                                             // no physics slide while on rails
      }
    }
    // Ride the real photoreal ROAD surface (canopy-skipped + clamped to topology),
    // tracked ASYMMETRICALLY: settle DOWN gently (smooth on descents + bumps) but catch
    // UP quickly, and never let the smoothed height sink more than a hair below the real
    // surface. A symmetric low-pass used to lag BELOW a road that climbs faster than it
    // can track (uphill/onto a bridge at speed) — and once the car was under the surface,
    // the canopy-skipping down-ray (cast from just above the car) could no longer see the
    // road ABOVE it, so it stayed buried. The hard floor keeps that from ever happening.
    const yr = ctx.ground.actorGroundY(ctx.car.x, ctx.car.z, ctx.car.groundY);
    if (ctx.car.groundY == null) ctx.car.groundY = yr;
    else { const rate = yr > ctx.car.groundY ? dt * 18 : dt * 9; ctx.car.groundY += (yr - ctx.car.groundY) * Math.min(1, rate); }
    if (yr != null && ctx.car.groundY < yr - 0.8) ctx.car.groundY = yr - 0.8;   // anti-bury backstop, loose enough that a brief canopy/roof spike can't snap the car up
    const yC = ctx.car.groundY;
    const rxv = Math.cos(ctx.car.yaw), rzv = -Math.sin(ctx.car.yaw);
    // The 4 corner probes feed only the visual pitch/roll, which tolerates a lower rate, so
    // refresh these tile raycasts ~every 3rd frame and reuse the result between. (These were
    // the single biggest per-frame CPU cost on mobile — 4 brute-force tile casts every frame.)
    if ((ctx.car._tiltTick = (ctx.car._tiltTick | 0) + 1) % 3 === 0 || ctx.car._pitchS == null) {
      const tF = ctx.ground.actorGroundY(ctx.car.x + fx * 1.4, ctx.car.z + fz * 1.4, ctx.car.groundY), tB = ctx.ground.actorGroundY(ctx.car.x - fx * 1.4, ctx.car.z - fz * 1.4, ctx.car.groundY);
      const tR = ctx.ground.actorGroundY(ctx.car.x + rxv * 0.9, ctx.car.z + rzv * 0.9, ctx.car.groundY), tL = ctx.ground.actorGroundY(ctx.car.x - rxv * 0.9, ctx.car.z - rzv * 0.9, ctx.car.groundY);
      ctx.car._pitchS = Math.atan2(tB - tF, 2.8); ctx.car._rollS = Math.atan2(tR - tL, 1.8);
    }
    const pitch = ctx.car._pitchS, roll = ctx.car._rollS;
    ctx.car.group.position.set(ctx.car.x, yC + 0.06, ctx.car.z);
    ctx.car.group.rotation.set(0, 0, 0);
    // point the body slightly into the slide so drifts read visually
    const driftYaw = clamp(Math.atan2(ctx.car.vlat || 0, Math.max(6, Math.abs(ctx.car.speed))) * 0.7, -0.5, 0.5);
    ctx.car.group.rotateY(ctx.car.yaw - Math.PI / 2 + driftYaw);
    ctx.car.group.rotateZ(-pitch + (ctx.car.pitchDyn || 0));   // terrain pitch + dynamic load-transfer dive/squat
    ctx.car.group.rotateX(roll);
    // AERIAL / OVERHEAD: blow the car up so it's easy to spot from way up high and more fun
    // — roughly street-sized on the map. Purely cosmetic: collision uses fixed radii, never
    // this scale. Lerp so cycling views doesn't pop; aerial floats highest so it gets biggest.
    const _camV = DRIVE_CAMS[ctx.camMode] || {};
    const _zoomGrow = clamp(Math.sqrt(Math.max(0.05, ctx.czoom)), 0.85, 2.2);   // car GROWS (within limits) as you zoom OUT so it stays findable from way up, and shrinks a touch up close
    const dispTarget = (_camV.aerial ? 4.4 : _camV.topdown ? 2.9 : 1.3) * _zoomGrow;
    ctx.car.dispScale = ctx.car.dispScale == null ? dispTarget : ctx.car.dispScale + (dispTarget - ctx.car.dispScale) * (1 - Math.exp(-dt * 6));
    ctx.car.group.scale.setScalar(ctx.car.dispScale);
    const overhead = _camV.aerial || _camV.topdown;
    // On arrival, briefly ease the camera's look-ahead to 0 so the car frames DEAD-CENTRE
    // (the constant look-ahead otherwise leaves it offset toward the bottom even when stopped).
    const aheadScale = 1 - (ctx.arriveCenterT && now < ctx.arriveCenterT ? clamp((ctx.arriveCenterT - now) / 1400, 0, 1) : 0);
    carLocator.visible = overhead;
    if (overhead) {
      carLocator.position.set(ctx.car.x, yC + (_camV.aerial ? 13 : 8) + Math.abs(Math.sin(now * 0.004)) * 0.5, ctx.car.z);
      carLocator.scale.setScalar(_camV.aerial ? 1.25 : 0.9);
      if (carLocator.children[0]) carLocator.children[0].material.opacity = _camV.aerial ? 0.75 : 0.55;
      if (carLocator.children[1]) carLocator.children[1].material.opacity = _camV.aerial ? 0.5 : 0.34;
    }
    // collectible coins: spin + bob, picked up by driving over them
    ctx.coinGroundCursor = ctx.coins.length ? (ctx.coinGroundCursor + 1) % ctx.coins.length : 0;
    for (let i = 0; i < ctx.coins.length; i++) {
      const c = ctx.coins[i];
      c.mesh.visible = !c.got;
      if (c.got) continue;
      c.mesh.rotation.y += dt * 3.2;
      if (c.groundY == null || i === ctx.coinGroundCursor) c.groundY = ctx.ground.actorGroundY(c.x, c.z, c.groundY);
      const coinY = c.groundY != null ? c.groundY : terrainAt(c.x, c.z);
      c.mesh.position.y = coinY + 1.15 + Math.abs(Math.sin(now * 0.004 + c.x)) * 0.35;
      if (Math.hypot(ctx.car.x - c.x, ctx.car.z - c.z) < 3.4) {
        c.got = true; ctx.coinsGot++;
        spawnCoinBurst(c.x, c.z, coinY, now);
        const wasBest = !ctx.bestMs || (now - ctx.runStart) <= ctx.bestMs;
        collectCoin(now);
        if (ctx.coinsGot === ctx.coins.length) {
          ctx.toast('💛 All ' + ctx.coins.length + ' coins in ' + fmtTime(ctx.lastRunMs) + '! ' + (wasBest ? '🏆 New best!' : 'Best ' + fmtTime(ctx.bestMs)), 3600);
          if (ctx.ui.fx && !ctx.reduceMotion) { ctx.ui.fx.classList.add('arrive'); setTimeout(() => ctx.ui.fx && ctx.ui.fx.classList.remove('arrive'), 650); }
        }
      }
    }
    // tyre marks + smoke + screech while the tail is out (drift or handbrake) and moving
    const slipping = (Math.abs(ctx.car.vlat) > 6 || hb) && Math.abs(ctx.car.speed) > 5;
    if (slipping && now - ctx.lastSkidT > 26) {
      ctx.lastSkidT = now;
      const bx = ctx.car.x - fx * 1.5, bz = ctx.car.z - fz * 1.5;           // rear axle
      const rpx2 = Math.cos(ctx.car.yaw), rpz2 = -Math.sin(ctx.car.yaw);    // right vector
      spawnSkid(bx - rpx2 * 0.7, bz - rpz2 * 0.7, yC, ctx.car.yaw, now);
      spawnSkid(bx + rpx2 * 0.7, bz + rpz2 * 0.7, yC, ctx.car.yaw, now);
      if (ctx.FX.si % 2 === 0) spawnSmoke(bx, bz, yC, now, openRoad);
    }
    // ride the tyre-screech: louder the more the tail is out (and on the handbrake)
    if (ctx.audio.screech) ctx.audio.screech(slipping ? clamp((Math.abs(ctx.car.vlat) - 3) / 13, 0.18, 1) * (hb ? 1.1 : 1) : 0);
    // brake squeal: a tyre chirp on a hard stop, gated so it's silent when coasting/parked
    if (ctx.audio.brakeSqueech) ctx.audio.brakeSqueech((ctx.car.brakeAmt || 0) * clamp((Math.abs(ctx.car.speed) - 5) / 15, 0, 1));
    // DRIFT reward: a held slide glows the ✋ button + a 'DRIFT' chip, and every ~0.9 s of
    // sustained drift ticks the combo + trip score — the best mechanic finally pays out.
    const drifting = Math.abs(ctx.car.vlat) > 6 && Math.abs(ctx.car.speed) > 9;
    if (drifting !== ctx.driftState) { ctx.driftState = drifting; ctx.emit('drift', drifting); }
    if (drifting) {
      ctx.driftAccum += dt;
      if (ctx.driftAccum > 0.9) {
        ctx.driftAccum = 0;
        ctx.combo = (!ctx.comboExpired && now < ctx.comboExpire) ? ctx.combo + 1 : 1; ctx.comboExpire = now + 4000; ctx.comboExpired = false;
        ctx.tripScore += 30 + ctx.combo * 15; addBoost(0.09); comboFx(now); emitScore({});
      }
    } else ctx.driftAccum = 0;
    tickParticles(now, dt);
    checkPOIs(now);
    updateBeacons(now);
    // live rally clock (direct DOM, no React churn) + combo expiry
    if (ctx.ui.runTime) ctx.ui.runTime.textContent = fmtTime(ctx.runActive ? now - ctx.runStart : ctx.lastRunMs);
    if (!ctx.comboExpired && now > ctx.comboExpire) { ctx.comboExpired = true; ctx.combo = 0; emitScore({}); }
    // reverse tell-tales: 'R' in the speedo + the STOP pedal flips to REV
    const reversing = ctx.car.speed < -0.4;
    if (ctx.ui.rev) ctx.ui.rev.style.opacity = reversing ? '1' : '0';
    if (ctx.ui.brakeLbl && ctx.ui.brakeLbl.textContent !== (reversing ? 'REV' : 'STOP')) ctx.ui.brakeLbl.textContent = reversing ? 'REV' : 'STOP';
    // GEAR readout for the dash cluster: R reverse · P parked · N coasting · D driving.
    if (ctx.ui.gear) {
      const g = reversing ? 'R' : (Math.abs(ctx.car.speed) < 0.4 && throttle < 0.1) ? 'P' : (throttle > 0.05 ? 'D' : 'N');
      if (ctx.ui.gear.textContent !== g) { ctx.ui.gear.textContent = g; ctx.ui.gear.dataset.gear = g; }
    }
    if (ctx.ui.eta) {
      if (ctx.DEST) {
        const dd = Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z);
        const etaMs = dd / Math.max(9, Math.abs(ctx.car.speed)) * 1000;
        ctx.ui.eta.textContent = dd < 18 ? 'arriving…'
          : (dd > 950 ? (dd / 1000).toFixed(1) + ' km' : Math.round(dd) + ' m') + ' · ~' + fmtTime(etaMs);
      } else ctx.ui.eta.textContent = '';
    }
    if (navMarker) {
      navMarker.visible = ctx.inp2.navActive && !ctx.autoDrive;   // hide the finger ring during auto-drive
      if (navMarker.visible) {
        navMarker.userData.groundY = ctx.ground.actorGroundY(ctx.inp2.navX, ctx.inp2.navZ, navMarker.userData.groundY);
        navMarker.position.set(ctx.inp2.navX, navMarker.userData.groundY + 0.16, ctx.inp2.navZ);
      } else navMarker.userData.groundY = null;
    }
    // address guide: a continuous line along the actual ROUTE (every turn), draped on
    // the road just ahead of the car; + a pin at the destination when near.
    if (ctx.DEST) {
      updateGuide(yC);
      const ddDest = Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z);
      destPin.visible = ddDest < 700;
      if (destPin.visible) {
        destPin.userData.groundY = ctx.ground.actorGroundY(ctx.DEST.x, ctx.DEST.z, destPin.userData.groundY);
        destPin.position.set(ctx.DEST.x, destPin.userData.groundY + 6 + Math.abs(Math.sin(now * 0.004)) * 0.6, ctx.DEST.z);
      }
    } else { guideLine.visible = false; destPin.visible = false; }
    // The flat aerial patch under the car read as an ugly disc (a different, lower-res
    // texture than the Google tiles). Keep the car riding the same sampled road
    // HEIGHT (actorGroundY), but leave the patch hidden so only the photoreal shows.
    if (ctx.groundPatch) ctx.groundPatch.visible = false;
    const spin = ctx.car.speed * dt / 0.37;
    const active = ctx.car.models[ctx.car.modelIdx];
    if (active) {
      // GLB vehicle: only the Ferrari has named wheel nodes; others ride static
      if (active.wheels) for (const w of active.wheels) w.rotation.x += spin;
    } else {
      // procedural fallback car
      for (const w of ctx.car.wheels) w.rotation.z -= spin;
      for (const f of ctx.car.fronts) f.rotation.y = ctx.car.steer * 1.6;
    }
    // Smoothed MAP-view heading (compass while following, car heading otherwise) for the overhead/aerial
    // framing + a gentle "race day" cinematic sweep that runs during autodrive/follow until the user
    // grabs the camera. Eased so it never shimmers and bows out smoothly when the user takes over.
    { let _d = viewHeading() - ctx._viewYaw; while (_d > Math.PI) _d -= 2 * Math.PI; while (_d < -Math.PI) _d += 2 * Math.PI; ctx._viewYaw += _d * (1 - Math.exp(-dt * 3)); }
    const _cineWant = (!ctx._orbitUserSet && (ctx.autoDrive || ctx.followMode)) ? 1 : 0;
    ctx._cineAmt += (_cineWant - ctx._cineAmt) * (1 - Math.exp(-dt * 1.5));
    const _cineYaw = ctx._cineAmt * Math.sin(now * 0.00012) * 0.6;     // slow ±0.6 rad hero orbit
    const _cinePit = ctx._cineAmt * Math.sin(now * 0.00009) * 0.12;    // subtle crane
    if (ctx.showT > 0) {
      // showcase orbit on entry; any input skips it
      ctx.showT -= dt;
      const a = ctx.car.yaw + 2.4 + (2.8 - ctx.showT) * 1.35;
      let cx2 = ctx.car.x + Math.sin(a) * 6.6, cy2 = Math.max(yC + 1.7, ctx.ground.groundAt(cx2, ctx.car.z) + 1.2), cz2 = ctx.car.z + Math.cos(a) * 6.6;
      const g = resolveCam(ctx.car.x, yC + 1.0, ctx.car.z, cx2, cy2, cz2); // don't orbit into real tiles
      cx2 = ctx.car.x + (cx2 - ctx.car.x) * g; cy2 = yC + 1.0 + (cy2 - yC - 1.0) * g; cz2 = ctx.car.z + (cz2 - ctx.car.z) * g;
      ctx.camera.position.set(cx2, cy2, cz2);
      ctx.camera.lookAt(ctx.car.x, yC + 0.7, ctx.car.z);
    } else if (DRIVE_CAMS[ctx.camMode].aerial) {
      // Explore's look while driving: the same high orbit framing (az/polar/range as
      // the page-load Explore view), just centred on the car. Drag orbits it, pinch
      // zooms, and the altitude is slow-smoothed so it floats like the aerial view.
      ctx.camera.up.set(0, 1, 0);
      const sp = clamp(Math.abs(ctx.car.speed) / feelRef, 0, 1);          // gentle speed breathe (keep the Explore feel)
      // HEADING-UP + FOLLOWS TURNS: orbit BEHIND the (smoothed) heading so the car's forward points away/up
      // — matches the heading-up minimap. camOrbit.yaw is the user's offset, kept RELATIVE to the car so it
      // holds as the car turns; the cinematic sweep runs until the user grabs the camera.
      const a = ctx._viewYaw + Math.PI + ctx.camOrbit.yaw + _cineYaw;
      const po = clamp(0.92 - (ctx.camOrbit.pitch + _cinePit) * 0.45, 0.18, 1.4);
      const r = (185 + sp * 38) * ctx.czoom;                             // float higher/further as you wind it out
      ctx.camGroundRef = ctx.camGroundRef == null ? yC : ctx.camGroundRef + (yC - ctx.camGroundRef) * Math.min(1, dt * 1.0);
      const camT = _camT.set(ctx.car.x + r * Math.sin(po) * Math.sin(a), ctx.camGroundRef + r * Math.cos(po), ctx.car.z + r * Math.sin(po) * Math.cos(a));
      if (!ctx.camInit) { camV.copy(camT); ctx.camInit = true; }
      // track TIGHTER the faster you go so a 700 mph autodrive never outruns the orbit cam
      camV.lerp(camT, 1 - Math.exp(-(4.6 + clamp(Math.abs(ctx.car.speed) / 16, 0, 13)) * dt));
      // hard backstop: never let the camera trail the orbit target by more than ~45% of the
      // range, so a hard turn at top speed can't swing the car out of frame (invisible car).
      const lagMax = r * 0.45, dxc = camV.x - camT.x, dzc = camV.z - camT.z, lc = Math.hypot(dxc, dzc);
      if (lc > lagMax) { const f = lagMax / lc; camV.x = camT.x + dxc * f; camV.z = camT.z + dzc * f; }
      ctx.camera.position.copy(camV);
      ctx.camera.lookAt(ctx.car.x + fx * sp * 26 * aheadScale, ctx.camGroundRef + 1, ctx.car.z + fz * sp * 26 * aheadScale);   // bias the gaze where you're heading (→ centred on arrival)
      const fovT = 46 + 5 * sp;
      ctx.camera.fov += (fovT - ctx.camera.fov) * (1 - Math.exp(-3 * dt)); ctx.camera.updateProjectionMatrix();
    } else if (DRIVE_CAMS[ctx.camMode].topdown) {
      const CAM = DRIVE_CAMS[ctx.camMode];
      const sp = clamp(Math.abs(ctx.car.speed) / feelRef, 0, 1);          // sense of speed even from overhead
      // almost directly overhead, but offset a little behind and aimed a touch
      // forward so you can read the road ahead (not perfectly straight down).
      // At speed: float a touch higher, ease back, and push the look-ahead WAY
      // forward so the car slides toward the bottom of frame and you see the road
      // rushing up — the overhead read of velocity.
      const vfx = Math.sin(ctx._viewYaw), vfz = Math.cos(ctx._viewYaw);   // map-view forward (compass while following) — keeps this overhead view oriented like the minimap
      const camT = _camT.set(ctx.car.x - vfx * (CAM.dist + sp * 4), yC + CAM.h * ctx.czoom + sp * 9, ctx.car.z - vfz * (CAM.dist + sp * 4));   // czoom = pure altitude (wide pinch range), speed-float added on top
      if (!ctx.camInit) { camV.copy(camT); ctx.camInit = true; }
      camV.lerp(camT, 1 - Math.exp(-(5 + clamp(Math.abs(ctx.car.speed) / 16, 0, 13)) * dt));   // keep up at top speed
      ctx.camera.position.copy(camV);
      ctx.camera.up.set(vfx, 0, vfz); // heading-up = same orientation as the minimap
      const spHiT = clamp((Math.abs(ctx.car.speed) - feelRef) / (feelRef * 2.7), 0, 1);
      const ahead = (CAM.ahead + sp * sp * 16 + spHiT * 14) * aheadScale;     // see further down the road flat-out (→ centred on arrival)
      ctx.camera.lookAt(ctx.car.x + vfx * ahead, yC, ctx.car.z + vfz * ahead);
      const fovT = 46 + 9 * sp + 12 * spHiT;                   // a real widen when truly flying
      ctx.camera.fov += (fovT - ctx.camera.fov) * (1 - Math.exp(-3 * dt)); ctx.camera.updateProjectionMatrix();
      if (!ctx.reduceMotion && spHiT > 0.1) { const r = spHiT * 0.04; ctx.camera.position.x += (Math.random() - 0.5) * r; ctx.camera.position.z += (Math.random() - 0.5) * r; }
    } else {
      const CAM = DRIVE_CAMS[ctx.camMode];
      ctx.camera.up.set(0, 1, 0);
      // free look: hold wherever you dragged, then auto-recenter behind the car shortly
      // after you let go — but HOLD the view for a while first so you can actually look
      // around / explore the scene (the old 600 ms snap made it feel impossible to look).
      // Recentre only after ~1.8 s of no look input, and ease back gently.
      // Free-look HOLDS far longer, then eases only YAW back behind the car (re-frame forward)
      // while PITCH stays where you set it — look up at the skyline / down at the road and it
      // sticks. The longer idle delay means a resting finger studying the view doesn't snap back.
      if (now - ctx.camOrbit.t > 2600) {
        ctx.camOrbit.yaw *= Math.exp(-dt * 0.9);                                       // slow yaw recentre
        ctx.camOrbit.pitch += (0.1 - ctx.camOrbit.pitch) * (1 - Math.exp(-dt * 0.35));     // drift pitch to a gentle rest, very slowly
      }
      const sp = clamp(Math.abs(ctx.car.speed) / feelRef, 0, 1);          // 0..1 of the FEEL range (~60 mph)
      // spHi keeps building ABOVE the feel range up to the real top (~180-220), so the
      // open-road blast the design invites actually reads as faster than a 40 mph cruise.
      const spHi = clamp((Math.abs(ctx.car.speed) - feelRef) / (feelRef * 2.7), 0, 1);
      const a = ctx.car.yaw + Math.PI + ctx.camOrbit.yaw - ctx.car.steer * 0.6 + (CAM.side || 0) + _cineYaw * 0.5;   // lead the camera into corners; CAM.side = a 3/4 above-and-to-the-side hero angle (Cruise); cine = gentle race-day sway during autodrive/follow
      const dist = (CAM.dist + sp * sp * 9 + spHi * 6) * ctx.czoom;       // sink the car back further when truly flying
      const h = (CAM.h + ctx.camOrbit.pitch * 4.5 + sp * 3) * Math.max(0.7, ctx.czoom);
      // hold a STATIC altitude (drone cams): slow-smooth the ground ref so terrain
      // rolls don't bob the high cam; the low Close cam snaps to the ground.
      ctx.camGroundRef = ctx.camGroundRef == null ? yC : ctx.camGroundRef + (yC - ctx.camGroundRef) * (1 - Math.exp(-dt * (CAM.drone ? 1.2 : 6)));
      const camT = _camT.set(ctx.car.x + Math.sin(a) * dist, ctx.camGroundRef + h, ctx.car.z + Math.cos(a) * dist);
      if (!CAM.drone) {
        const g = resolveCam(ctx.car.x, yC + 1.2, ctx.car.z, camT.x, camT.y, camT.z);
        // Boxed in by buildings (e.g. arriving on a tight residential street): pull the
        // camera in toward the car, but RISE as it closes so it looks DOWN at the car from
        // above instead of burying into the wall / staring at the car's own roof.
        if (g < 1) { const lift = (1 - g) * 7; camT.set(ctx.car.x + (camT.x - ctx.car.x) * g, yC + 1.2 + (camT.y - yC - 1.2) * g + lift, ctx.car.z + (camT.z - ctx.car.z) * g); }
      }
      if (!ctx.camInit) { camV.copy(camT); ctx.camInit = true; _lookV = null; _lookYS = null; ctx.camFloorRef = null; }
      camV.lerp(camT, 1 - Math.exp(-(4.6 + clamp(Math.abs(ctx.car.speed) / 16, 0, 13)) * dt));   // frame-rate-independent + keeps up at top speed
      // Anti-clip floor based on the CAR's road level (yC = actorGroundY, which is
      // overpass/canopy-skipped). A high groundAt() raycast at the camera's xz used to hit an
      // OVERPASS deck above and shove the camera up over it — hiding the car under an
      // underpass / when changing levels. Tracking the car's own level fixes that (and the
      // low-pass keeps photogrammetry bumps from popping the cam).
      _camFloorRaw = yC + 1.3;
      ctx.camFloorRef = ctx.camFloorRef == null ? _camFloorRaw : ctx.camFloorRef + (_camFloorRaw - ctx.camFloorRef) * (1 - Math.exp(-dt * 2.2));   // softer low-pass → fewer cam pops on photoreal bumps
      if (camV.y < ctx.camFloorRef) camV.y = ctx.camFloorRef;
      ctx.camera.position.copy(camV);
      // WHIP: the look point isn't nailed to the car — it lags and carries a lateral
      // lead from the drift/steer, so on a hard corner the car slides toward the edge of
      // frame then snaps back. Sells corners far more than a rigid lookAt.
      // Scale the look-ahead with SPEED: parked/slow → look almost AT the car so it sits centred
      // (a fixed forward look-ahead dropped the car to the bottom of the steep cruise frame — "falling
      // behind the camera"); at speed it pushes forward so you read the road. Also lift the look point
      // toward the car's roof when slow so the car frames higher, not at its wheels.
      const lookAhead = (CAM.ahead * (0.32 + 0.68 * sp) + sp * 6) * aheadScale;
      const lookYRaw = yC + 1.0 + (1 - sp) * 0.9;
      _lookYS = _lookYS == null ? lookYRaw : _lookYS + (lookYRaw - _lookYS) * (1 - Math.exp(-dt * 4));   // smooth ONLY the vertical so road bumps don't pitch the whole view (x/z keep the snappy whip)
      const lookY = _lookYS;
      const rpxL = Math.cos(ctx.car.yaw), rpzL = -Math.sin(ctx.car.yaw);
      const latLead = (ctx.car.vlat * 0.05 + ctx.car.steer * 2.0) * (1 - 0.3 * sp) * aheadScale;
      _lookT.set(ctx.car.x + fx * lookAhead + rpxL * latLead, lookY, ctx.car.z + fz * lookAhead + rpzL * latLead);
      if (!_lookV) _lookV = _lookT.clone(); else _lookV.lerp(_lookT, 1 - Math.exp(-7 * dt));
      ctx.camera.up.set(0, 1, 0);
      ctx.camera.lookAt(_lookV);
      // asymmetric FOV: a stab of GO shoves the view wide FAST, then it relaxes slow.
      // The spHi term adds a second, smaller kick that only opens up at true top speed.
      const fovT = 46 + 30 * Math.pow(sp, 1.25) + 8 * spHi;           // ~76° at cruise top, ~84° flat out
      ctx.camera.fov += (fovT - ctx.camera.fov) * (1 - Math.exp(-(fovT > ctx.camera.fov ? 6 : 2.2) * dt)); ctx.camera.updateProjectionMatrix();
      if (!ctx.reduceMotion) {
        const roll = clamp(-ctx.car.steer * 2.0 - ctx.car.vlat * 0.012, -0.1, 0.1) * (0.4 + sp);   // Dutch-tilt into corners/drift
        ctx.camera.rotateZ(roll);
        const rumble = (clamp((sp - 0.55) / 0.45, 0, 1) * 0.5 + spHi * 0.5) * 0.06;        // grows past the feel cap when flat out
        if (rumble > 0.001) { ctx.camera.position.x += (Math.random() - 0.5) * rumble; ctx.camera.position.y += (Math.random() - 0.5) * rumble; }
      }
    }
    if (ctx.shakeMag > 0.01 && !ctx.reduceMotion) {                          // decaying collision shake
      ctx.camera.position.x += (Math.random() - 0.5) * ctx.shakeMag;
      ctx.camera.position.y += (Math.random() - 0.5) * ctx.shakeMag;
      ctx.camera.position.z += (Math.random() - 0.5) * ctx.shakeMag;
      ctx.shakeMag *= Math.exp(-dt * 9);
    } else ctx.shakeMag = 0;
    if (ctx.vehicleFill.visible) {
      ctx.vehicleFill.position.copy(ctx.camera.position);
      ctx.vehicleFill.position.y += 8;
      ctx.vehicleFillTarget.position.set(ctx.car.x, yC + 1.1, ctx.car.z);
      ctx.vehicleFillTarget.updateMatrixWorld();
    }
    ctx.occ.updateTileClip(ctx.car.x, yC, ctx.car.z, DRIVE_CAMS[ctx.camMode] || {});   // R8: with the camera now placed, cut tile geometry between it and the car (ALL views)
    if (ctx.ui.mph) ctx.ui.mph.textContent = Math.round(Math.abs(ctx.car.speed) * 2.237);
    {
      const f = clamp(Math.abs(ctx.car.speed) / feelRef, 0, 1);
      if (ctx.ui.speedBar) {                                 // speed-bar fill + colour band
        ctx.ui.speedBar.style.width = (f * 100).toFixed(1) + '%';
        ctx.ui.speedBar.style.background = f < 0.45 ? '#3ad17a' : f < 0.78 ? '#ffc21e' : '#ff5a3c';
      }
      if (ctx.ui.boostBar) {                                 // nitro meter (direct DOM, no React churn)
        ctx.ui.boostBar.style.width = (ctx.boost * 100).toFixed(0) + '%';
        ctx.ui.boostBar.parentElement.classList.toggle('ready', ctx.boost > 0.25 && !boosting);
        ctx.ui.boostBar.parentElement.classList.toggle('firing', boosting);
      }
      if (ctx.ui.fx && !ctx.reduceMotion) {                      // speed streaks + vignette: build from ~18%, keep growing flat out
        const fHi = clamp((Math.abs(ctx.car.speed) - feelRef) / (feelRef * 2.7), 0, 1);
        const v = clamp((f - 0.18) / 0.62, 0, 1) * 0.82 + fHi * 0.18;
        ctx.ui.fx.style.setProperty('--spd', v.toFixed(2));
        ctx.ui.fx.style.setProperty('--ox', (50 - (ctx.car.steer + ctx.camOrbit.yaw * 0.4) * 16).toFixed(1) + '%');  // streaks flow from where you're heading
        ctx.ui.fx.classList.toggle('on', v > 0.01);
        ctx.ui.fx.classList.toggle('fast', v > 0.6);         // motion-blur the streaks only when truly flying
      }
    }
    ctx.audio.engineUpdate(ctx.car.speed, feelRef, throttle); // rev maps to the feel reference; load brightens it
    if (ctx.audio.musicSpeed) ctx.audio.musicSpeed(clamp(Math.abs(ctx.car.speed) / feelRef, 0, 1));   // the tune lifts on the blast
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
  ctx.prev = performance.now();
  ctx.raf = 0, ctx.paused = false, ctx.ctxLost = false, ctx._miniT = 0, ctx._miniCtx = null, ctx._miniEl = null, ctx._shadowT = 0, ctx._miniYaw = 0;
  // Google 3D Tiles ToS: surface the LIVE data attribution for the tiles currently
  // in view whenever the photoreal world is shown. Throttled; emits only on change.
  const _attrTarget = []; let _attrStr = '', _attrT = 0;
  function updateAttribution(now) {
    if (now - _attrT < 500) return;
    _attrT = now; _attrTarget.length = 0;
    try { ctx.p3dtiles.getAttributions(_attrTarget); } catch (e) { return; }
    const s = _attrTarget.filter(a => a && a.type === 'string').map(a => a.value).filter(Boolean).join(' · ');
    if (s !== _attrStr) { _attrStr = s; ctx.emit('attribution', s); }
  }
  function loop(now) {
    if (ctx.disposed || ctx.paused || ctx.ctxLost) return;
    const rawDt = Math.min(0.05, (now - ctx.prev) / 1000); ctx.prev = now;
    if (ctx.slowmoHold > 0) { ctx.slowmoHold -= rawDt; }              // hold the arrival slow-mo before recovering
    else ctx.timeScale += (1 - ctx.timeScale) * Math.min(1, rawDt * 4.5);   // recover from slow-mo back to real time
    const dt = rawDt * ctx.timeScale;
    if (ctx.waterMat) ctx.waterMat.uniforms.uTime.value = now * 0.001; // flowing creek
    updateAnimals(dt, now, (ctx.mode === 'scoop' && ctx.scoopScene === 'yard') ? ctx.CHAR : null); // ambient life every mode; spooks away from the player while scooping the yard
    updateCrowd(dt, now);   // dancing CeCe/Drew crowd (mode + distance gated) + hit-launch
    if (ctx.mode === 'drive') {
      updateDrive(dt, now);
    } else if (ctx.mode === 'scoop') {
      updateScoop(dt, now);
    } else {
      // frame-rate-INDEPENDENT blend (was a fixed 0.16/frame → converged twice as fast on a
      // 120 Hz phone and micro-stuttered under variable dt — the "aerial orbit isn't smooth").
      const k = ctx.reduceMotion ? 1 : (1 - Math.exp(-rawDt * 10.6));
      if (!ctx.reduceMotion && !ptrs.size && (Math.abs(ctx.azVel) > 1e-4 || Math.abs(ctx.poVel) > 1e-4)) {
        ctl.gaz += ctx.azVel * rawDt * 60; ctl.gpo = clamp(ctl.gpo + ctx.poVel * rawDt * 60, 0.14, 1.46);
        const decay = Math.exp(-dt * 4); ctx.azVel *= decay; ctx.poVel *= decay; // flick momentum
      }
      ctl.tx += (ctl.gtx - ctl.tx) * k; ctl.ty += (ctl.gty - ctl.ty) * k; ctl.tz += (ctl.gtz - ctl.tz) * k;
      ctl.az += (ctl.gaz - ctl.az) * k; ctl.po += (ctl.gpo - ctl.po) * k; ctl.r += (ctl.gr - ctl.r) * k;
      applyCam();
      ctx.camInit = false;
    }
    if (!ctx.reduceMotion) {
      const s = 1 + 0.04 * Math.sin(now * 0.0023);
      ctx.ring.scale.set(s, s, 1);
      ctx.ring.material.opacity = 0.5 + 0.22 * Math.sin(now * 0.0023);
    }
    if (ctx.sun.castShadow && now - ctx._shadowT > 140) { ctx.renderer.shadowMap.needsUpdate = true; ctx._shadowT = now; }
    ctx.camera.getWorldDirection(dirV);
    if (ctx.ui.needle) ctx.ui.needle.style.transform = `rotate(${(Math.atan2(dirV.x, dirV.z) * 180 / Math.PI).toFixed(1)}deg)`;
    updateTilePrefetch(now);                                         // warm tiles along the route ahead (self-gates to drive + active destination)
    if (ctx.p3dtiles && photoModes(ctx.mode)) { ctx.camera.updateMatrixWorld(); if (now - ctx._tilesUpdT > 55) { ctx.p3dtiles.update(); ctx._tilesUpdT = now; } updateAttribution(now); }   // ~18 Hz LOD traversal
    else if (_attrStr) { _attrStr = ''; ctx.emit('attribution', ''); }   // no tiles shown → no credit
    if (ctx.mode === 'drive') {
      updateMiniMap(now);                                            // live Google minimap (when up)
      if (!ctx._gmap && ctx.ui.minimap && now - ctx._miniT > 80) {              // procedural fallback until/unless it loads
        ctx._miniT = now;
        if (ctx._miniEl !== ctx.ui.minimap) { ctx._miniEl = ctx.ui.minimap; ctx._miniCtx = ctx.ui.minimap.getContext('2d'); }
        if (ctx._miniCtx) drawMinimap(ctx._miniCtx, ctx.ui.minimap.width, ctx.ui.minimap.height);
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
  function suspend() { clearLiveInput(); _clearKbd(); if (!ctx.paused) { ctx.paused = true; cancelAnimationFrame(ctx.raf); if (ctx.audio.suspendAudio) ctx.audio.suspendAudio(); } }
  function resume() { if (ctx.paused && !ctx.disposed && !ctx.ctxLost) { ctx.paused = false; ctx.prev = performance.now(); if (ctx.audio.resumeAudio) ctx.audio.resumeAudio(); else ctx.audio.ensure(); ctx.raf = requestAnimationFrame(loop); } }
  function onVisibility() { if (document.hidden) suspend(); else resume(); }
  function onContextLost(e) { e.preventDefault(); ctx.ctxLost = true; cancelAnimationFrame(ctx.raf); }
  function onContextRestored() { if (!ctx.disposed) location.reload(); }   // rebuild streamed GPU state via reload

  // ---------- wire up ----------
  ctx.canvas.addEventListener('pointerdown', onPointerDown);
  ctx.canvas.addEventListener('pointermove', onPointerMove);
  ctx.canvas.addEventListener('pointerup', onPointerEnd);
  ctx.canvas.addEventListener('pointercancel', onPointerEnd);
  ctx.canvas.addEventListener('contextmenu', onContextMenu);
  ctx.canvas.addEventListener('dblclick', onDblClick);
  ctx.canvas.addEventListener('wheel', onWheel, { passive: false });
  ctx.canvas.addEventListener('webglcontextlost', onContextLost, false);
  ctx.canvas.addEventListener('webglcontextrestored', onContextRestored, false);
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

  ctx.emit('subline', 'Castro Valley, CA');   // clean default for the live location readout; the reverse-geocoder refines it to STREET · CITY, ST as you drive
  applyCam();
  ctx.renderer.render(ctx.scene, ctx.camera);
  ctx.emit('ready');
  emitPOIs();                 // seed the start-card "places found" badge from saved progress
  if (ctx.audio.setMuted) ctx.audio.setMuted(!ctx.soundOn);   // sync the master mute with the saved pref
  ctx.emit('sound', ctx.soundOn);   // seed the 🔊 toggle state
  ctx.emit('autosteer', ctx.autoSteer);
  ctx.emit('roadlife', ctx.roadLifeOn);
  checkFerrariUnlock();       // reconcile a prior 5/5 completion → keep the Ferrari unlocked
  if (document.hidden) ctx.paused = true;   // born in a background tab → don't render/stream until shown
  else ctx.raf = requestAnimationFrame(loop);

  function dispose() {
    ctx.disposed = true;
    cancelAnimationFrame(ctx.raf);
    clearTimeout(t1); clearTimeout(t2); clearTimeout(_crowdReplaceT);
    ctx.canvas.removeEventListener('pointerdown', onPointerDown);
    ctx.canvas.removeEventListener('pointermove', onPointerMove);
    ctx.canvas.removeEventListener('pointerup', onPointerEnd);
    ctx.canvas.removeEventListener('pointercancel', onPointerEnd);
    ctx.canvas.removeEventListener('contextmenu', onContextMenu);
    ctx.canvas.removeEventListener('dblclick', onDblClick);
    ctx.canvas.removeEventListener('wheel', onWheel);
    ctx.canvas.removeEventListener('webglcontextlost', onContextLost);
    ctx.canvas.removeEventListener('webglcontextrestored', onContextRestored);
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
    ctx.audio.engineStop();
    if (ctx.audio.stopMusic) ctx.audio.stopMusic();      // kill the 30ms music scheduler interval (was leaking)
    if (ctx.audio.close) ctx.audio.close();              // close the AudioContext so it isn't left running
    if (cancelCarLoad) cancelCarLoad();          // late car load/timeout can't touch a dead scene
    for (const cancel of modelLoadCancels) if (cancel) cancel();
    disposeMiniMap();
    if (ctx.ceceCrowd) ctx.ceceCrowd.dispose();          // stop crowd mixers + detach the dancers
    if (ctx.drewCrowd) ctx.drewCrowd.dispose();
    if (ctx.dadCrowd) ctx.dadCrowd.dispose();
    if (ctx.momCrowd) ctx.momCrowd.dispose();
    for (const npc of ctx.npcs) { if (npc.ctrl.reset) npc.ctrl.reset(); if (npc.group.parent) npc.group.parent.remove(npc.group); }   // tear down the house NPCs
    setScout(false);                             // unregister the prefetch scout camera
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
    enterDrive, exitDrive, enterScoop, exitScoop,
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
    enterHouse: () => { if (ctx.mode === 'scoop' && ctx.interior && ctx.scoopScene === 'yard') enterHouse(performance.now()); },
    leaveHouse: () => { if (ctx.mode === 'scoop' && ctx.scoopScene === 'interior') leaveHouse(performance.now()); },
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
    setAutoMaxMph, getAutoMaxMph: () => ctx.autoMaxMph,
    setSpeedMul, getSpeedMul: () => ctx.speedMul, setDriveZoom,
    setCrowdDensity, getCrowdDensity: () => CROWD_DENSITY,
    setTrafficDensity: (d) => {
      ctx.trafficDensity = clamp(+d || 0, 0, 2);
      try { localStorage.setItem('dahill.trafficdensity', String(ctx.trafficDensity)); } catch (e) { }
      const active = trafficActiveCount();
      for (let i = active; i < traffic.length; i++) traffic[i].group.visible = false;   // park any now-over-cap cars at once
      return ctx.trafficDensity;
    },
    getTrafficDensity: () => ctx.trafficDensity,
    preloadMaps: () => loadMapsSDK().catch(() => {}),   // warm the SDK so the first keystroke in the address box doesn't jank
    initMiniMap,                                         // mount the live Google minimap into a div
    setHandbrake: (on) => { ctx.inp2.hbrake = !!on; },
    // LOOK stick (right thumb): orbit the drive camera. dx/dy are screen-pixel deltas,
    // same convention as a look-drag on the canvas, so it feeds the existing camOrbit.
    nudgeLook: (dx, dy) => {
      const ld = lookDelta(dx, dy);
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
      if (!ctx.roadLifeOn) { hideTraffic(); hideCrowd(); }
      ctx.toast(ctx.roadLifeOn ? 'People + traffic ON' : 'People + traffic off', 1300);
      return ctx.roadLifeOn;
    },
    // tap-to-drive: convert a minimap pixel (HEADING-UP, car-centred) to a world point and let the
    // robot drive there. Inverts the SAME rotation drawMinimap drew with (via _miniYaw) so a tap lands
    // where the user pointed. range/scale mirror drawMinimap exactly.
    tapMinimap: (px, py, w, h) => {
      const range = 620, scale = (w / 2) / range, ca = Math.cos(ctx._miniYaw), sa = Math.sin(ctx._miniYaw);
      const ox = px - w / 2, oy = py - h / 2;
      setDriveTarget(ctx.car.x + (-ca * ox - sa * oy) / scale, ctx.car.z + (sa * ox - ca * oy) / scale);
    },
    dispose,
    get mode() { return ctx.mode; }
  };
  // tiny debug handle for headless verification + on-phone debugging
  window.__dahill = {
    api,
    scoop: () => ({ scene: ctx.scoopScene, ready: !!ctx.interior, avatar: ctx.CHAR.avatar, entry: entryPt && entryPt.map(v => +v.toFixed(1)), char: [+ctx.CHAR.x.toFixed(1), +ctx.CHAR.z.toFixed(1)], dDoor: entryPt ? +Math.hypot(ctx.CHAR.x - entryPt[0], ctx.CHAR.z - entryPt[1]).toFixed(1) : null, occ: ctx.interior ? ctx.interior.occluders.length : 0, hiddenOcc: ctx.interior ? ctx.interior.occluders.filter(o => !o.visible).length : 0 }),
    crowd: () => ({ on: ctx.roadLifeOn, cece: !!ctx.ceceCrowd, drew: !!ctx.drewCrowd, spots: crowdSpots.map(s => ({ zone: s.zone, x: Math.round(s.rec.x), z: Math.round(s.rec.z), vis: s.rec.grp.visible, road: !!s.onRoadHt, scale: +s.rec.grp.scale.x.toFixed(2), y: +s.rec.grp.position.y.toFixed(1), dCar: Math.round(Math.hypot(s.rec.x - ctx.car.x, s.rec.z - ctx.car.z)) })) }),
    traffic: () => ({ on: ctx.roadLifeOn, total: traffic.length, visible: traffic.filter(c => c.group.visible).length, cars: traffic.map(c => ({ x: Math.round(c.x || 0), z: Math.round(c.z || 0), vis: c.group.visible, speed: c.speed })) }),
    p3dt: P3DT,                       // mutate {yOffset,xOffset,zOffset,spin} then call nudge()
    nudge: applyP3DT,
    tiles: () => ctx.p3dtiles,
    setProcedural: (on) => { ctx.staticGroup.visible = on; },
    beacons: () => poiBeacons.map(b => ({ key: b.poi.key, vis: b.mesh.visible, op: +b.mat.opacity.toFixed(2), d: Math.round(Math.hypot(b.poi.x - ctx.car.x, b.poi.z - ctx.car.z)) })),
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
        const a = -s * DEG, ca = Math.cos(a), sa = Math.sin(a);
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
      poops: POOPS.length, car: { x: +ctx.car.x.toFixed(1), z: +ctx.car.z.toFixed(1), speed: +ctx.car.speed.toFixed(1), yaw: +ctx.car.yaw.toFixed(2), glb: !!ctx.car.glb },
      dest: ctx.DEST ? { x: +ctx.DEST.x.toFixed(1), z: +ctx.DEST.z.toFixed(1) } : null,
      char: { x: +ctx.CHAR.x.toFixed(1), z: +ctx.CHAR.z.toFixed(1), bag: ctx.CHAR.bag, total: ctx.CHAR.total, lvl: ctx.CHAR.lvl }
    })
  };
  return api;
}
