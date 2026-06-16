import * as THREE from 'three';
import { S, C, W, uvAt, terrainAt, SREC, GRID_ANG } from './data.js';
import { clamp } from './coords.js';
import { merge } from './geom.js';
import { buildWorld } from './world.js';
import { createAnimals, createCharacter, TOOLS, toolAfterScoop, POOP_ACTIVE_CAP } from './animals.js';
import { loadCeceCrowd, loadDrewCrowd } from './crowd.js';
import { createCar, loadRealCar, loadParkedCar, loadDrivableCar, loadCarProto, cycleVehicle, setVehicle, vehicleList, VEHICLES } from './car.js';
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
  renderer.setPixelRatio(LITE ? 1 : Math.min(window.devicePixelRatio, MOBILE ? 1.25 : 2));   // 1.25² vs 2² ≈ 30% fewer fragments on the full-screen photoreal tiles
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
  sun.castShadow = true;                 // gated to Scoop at runtime (see applyModeVisuals)
  sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);   // casters sit in a tight frustum; 1024 is plenty on a phone
  const sc2 = sun.shadow.camera;
  // tighter frustum (±170 vs ±300) ~= 3× the texel density where shadows actually
  // land (the scoop sanctuary + driveway); distant procedural shadows aren't missed.
  sc2.left = -170; sc2.right = 170; sc2.top = 170; sc2.bottom = -170; sc2.far = 900;
  sun.shadow.bias = -0.0009;
  scene.add(sun);

  const world = buildWorld(scene, renderer, { S, C, W, uvAt, terrainAt, SREC, GRID_ANG, aerialUrl });
  const { onRoad, house, bldBoxes, bldPolys, treePts, frontPt, frontDir, COMPOST, ring, interiorGroup, labelSprites, waterMat, staticGroup, aerialMat } = world;

  // ---- minimap + address navigation ----
  // World-frame road segments for the minimap (drawn as a 2D map).
  const roadSegs = [];
  for (const r of S.roads) {
    if (r.k !== 'residential' && r.k !== 'tertiary') continue;
    for (let k = 0; k < r.p.length - 1; k++) roadSegs.push([W(r.p[k]), W(r.p[k + 1])]);
  }
  // geo -> world: the orig/tile frame is anchored at 1840 Dahill Lane (flat tangent
  // plane — fine across the East Bay for a toy nav line/auto-drive).
  const GEO0 = { lat: 37.6835313, lon: -122.0686199 };
  const M_LAT = 110540, M_LON = Math.cos(GEO0.lat * Math.PI / 180) * 111320;
  function geoToWorld(lat, lon) {
    const N = (lat - GEO0.lat) * M_LAT, E = (lon - GEO0.lon) * M_LON;
    return [E - C[0], -(N - C[1])];
  }
  function worldToGeo(x, z) {
    const E = x + C[0], N = C[1] - z;
    return { lat: GEO0.lat + N / M_LAT, lon: GEO0.lon + E / M_LON };
  }
  let DEST = null;        // { x, z, label }
  let soundOn = (() => { try { return localStorage.getItem('dahill.sound') !== '0'; } catch (e) { return true; } })();   // master sound on by default
  let autoSteer = (() => { try { return localStorage.getItem('dahill.autosteer') !== '0'; } catch (e) { return true; } })();   // road/lane-keep assist, on by default
  let offRoadT = 0;       // seconds the car has been stranded off the road (drives the auto-recover snap-back)
  let recoverCooldown = 0;   // grace after a reset so the auto-recover can't immediately re-fire (no ping-pong → no "hidden car")
  let ROUTE = null;       // [{x,z}, ...] road-following path from Google Directions
  let routeIdx = 0;       // current target waypoint along ROUTE
  let autoDrive = false;

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
      scene.add(m); coins.push({ mesh: m, x: mx, z: mz, got: false });
    }
  }

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
  const POIS = [{ key: 'home', x: house.c[0], z: house.c[1], lat: homeGeo.lat, lon: homeGeo.lon, icon: '🏠', label: 'your house', msg: "👋 That's YOUR house — 1840 Dahill Lane!" }].concat(
    [['meemaw', 37.6995618, -122.0639216, '🏡', "Meemaw's", "🏡 Meemaw's house!"],
     ['canyon', 37.7046462, -122.0524363, '🏫', 'Canyon Middle', '🏫 Canyon Middle School!'],
     ['stanton', 37.7005734, -122.0940411, '🏫', 'Stanton Elem', '🏫 Stanton Elementary!'],
     ['dad', 37.8004778, -122.2739559, '💼', "Dad's work", "💼 Dad's work — the XQ Institute!"]
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
    toast('🏁 Next stop: floor it to ' + best.label + ' — follow the pink beam! 🏁', 2600);
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
  const traffic = [];
  {
    const tSegs = roadSegs.filter(s => Math.hypot((s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2) < 330 && Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) > 3);
    const cols = [0xb53a32, 0x2f5fb0, 0xd9d9d9, 0x2a2a2a, 0xd6a52e, 0x3f9e63, 0x8a8f96];
    const bodyGeo = new THREE.BoxGeometry(1.9, 1.0, 4.0), cabGeo = new THREE.BoxGeometry(1.6, 0.72, 1.9);
    // shared materials: one cab + 7 body colours, reused across all cars (was 22 clones)
    const bodyMats = cols.map(c => new THREE.MeshStandardMaterial({ color: c, metalness: 0.35, roughness: 0.55 }));
    const cabMat = new THREE.MeshStandardMaterial({ color: 0x1b2735, metalness: 0.2, roughness: 0.35 });
    for (let i = 0; i < 8 && tSegs.length; i++) {
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
      loadCarProto(def[0], def[1], false, proto => {
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
      });
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
    trafficTick++;
    for (const c of traffic) {
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
      // STAGGER the ground raycast (≤2 cars/frame) and low-pass it so streamed-in tiles don't
      // pop the car vertically — same look, a fraction of the cost.
      if (c.gy === undefined || (trafficTick + c.ti) % 4 === 0) c.gyT = groundAt(x, z) + 0.05;
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
  function arriveCelebrate(label, points, now) {
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
  // Address guide: a ground-draped ribbon that FOLLOWS THE ROUTE through its turns — a
  // real navigation line over the road, not a single rotating bar. The geometry is a
  // triangle-strip rebuilt each frame from the route polyline just ahead of the car,
  // resampled + draped to the ground and drawn on top so road bumps don't hide it.
  const GUIDE_N = 90;                                   // max cross-sections (~5 m apart)
  const guidePos = new Float32Array(GUIDE_N * 2 * 3);
  const guideGeo = new THREE.BufferGeometry();
  guideGeo.setAttribute('position', new THREE.BufferAttribute(guidePos, 3));
  { const idx = []; for (let i = 0; i < GUIDE_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } guideGeo.setIndex(idx); }
  // depthTest TRUE so the solid CAR (and hills/buildings) occlude the ribbon — the car
  // drives OVER the line, the line never paints on top of the car. depthWrite stays off so
  // it doesn't disturb other transparent sorting.
  const guideLine = new THREE.Mesh(guideGeo, new THREE.MeshBasicMaterial({ color: 0x2f8bff, transparent: true, opacity: 0.7, depthWrite: false, depthTest: true, side: THREE.DoubleSide }));
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
    // SHADOWS only in Scoop: in Drive/Explore the procedural receivers are hidden and the
    // Google tiles are MeshBasicMaterial (can't receive), so a full extra depth pass each
    // frame would render onto nothing. Gate the whole shadow pass off there.
    sun.castShadow = (mode === 'scoop') && !LITE;
    renderer.shadowMap.enabled = sun.castShadow;
  }
  if (!flags.has('flat')) {
    const LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * DEG);
    const houseLat = (LAT0 + C[1] / 110540) * DEG;
    const houseLon = (LON0 + C[0] / (COSLAT * 111320)) * DEG;
    import('./tiles3d.js').then(({ createPhotorealTiles }) => {
      p3dtiles = createPhotorealTiles(scene, camera, renderer, {
        // raise errorTarget on phones (coarser tiles) — leaf-tile geometry/texture
        // is the dominant iOS memory cost, and Drive can now roam far and stream more.
        lat: houseLat, lon: houseLon, azimuth: Math.PI, errorTarget: MOBILE ? 16 : 10, mobile: MOBILE
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

  // ---- CROWD: dancing CeCe + Drew characters. Yard dancers liven up Scoop; street
  // dancers + a cluster at Stanton Elementary liven up Drive. Visibility is mode- and
  // distance-gated so only a handful animate at once (skinned meshes aren't cheap).
  let ceceCrowd = null, drewCrowd = null;
  const crowdSpots = [];   // { rec, zone }
  function placeCrowd() {
    const put = (crowd, x, z, zone, onRoadHt, opts = {}) => {
      if (!crowd) return;
      const y = (onRoadHt ? actorGroundY(x, z) : terrainAt(x, z)) + 0.02;
      const yaw = opts.yaw != null ? opts.yaw : Math.random() * Math.PI * 2;
      crowdSpots.push({ rec: crowd.add(scene, { x, y, z, yaw, clip: opts.clip }), zone });
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
    // STREETS near home (Drive): on the sidewalk beside nearby road segments, facing the road
    const nearRoads = roadSegs.filter(s => Math.hypot((s[0][0] + s[1][0]) / 2 - hx, (s[0][1] + s[1][1]) / 2 - hz) < 150 && Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) > 6);
    for (let i = 0; i < Math.min(6, nearRoads.length); i++) {
      const s = nearRoads[(i * 7 + 2) % nearRoads.length];
      const mx = (s[0][0] + s[1][0]) / 2, mz = (s[0][1] + s[1][1]) / 2;
      const dx = s[1][0] - s[0][0], dz = s[1][1] - s[0][1], L = Math.hypot(dx, dz) || 1, nx = -dz / L, nz = dx / L, side = (i % 2) ? 2.6 : -2.6;
      put(i % 2 ? ceceCrowd : drewCrowd, mx + nx * side, mz + nz * side, 'street', true, { yaw: Math.atan2(-nx * side, -nz * side) });
    }
    // STANTON ELEMENTARY (Drive): a cluster of CeCes dancing at the school
    const stanton = POIS.find(p => p.key === 'stanton');
    if (stanton) for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2, r = 4 + (i % 2) * 2.5; put(ceceCrowd, stanton.x + Math.cos(a) * r, stanton.z + Math.sin(a) * r, 'stanton', true); }
    // CANYON MIDDLE (Drive): a few dancing Drews at the school
    const canyon = POIS.find(p => p.key === 'canyon');
    if (canyon) for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2 + 0.6, r = 4 + (i % 2) * 2.5; put(drewCrowd, canyon.x + Math.cos(a) * r, canyon.z + Math.sin(a) * r, 'canyon', true, { clip: i % 2 ? 'dance' : 'cheer' }); }
  }
  let _crowdN = 0; const _onCrowd = () => { if (++_crowdN === 2) { placeCrowd(); geocodePOIs(); } };
  if (!flags.has('nochar')) {
    loadCeceCrowd(c => { ceceCrowd = c; _onCrowd(); }, () => _onCrowd());
    loadDrewCrowd(c => { drewCrowd = c; _onCrowd(); }, () => _onCrowd());
  } else geocodePOIs();
  let _crowdHitT = 0;
  function updateCrowd(dt, now) {
    if (!crowdSpots.length) return;
    const inDrive = mode === 'drive', inScoop = mode === 'scoop';
    for (const sp of crowdSpots) {
      sp.rec.grp.visible = sp.zone === 'yard' ? inScoop
        : inDrive && Math.hypot(sp.rec.x - car.x, sp.rec.z - car.z) < 150;
    }
    // COMEDY: plough into a pedestrian and they cartwheel off the road (then pop back up).
    if (inDrive && Math.abs(car.speed) > 6 && now - _crowdHitT > 250) {
      const dir = Math.sign(car.speed) || 1, vx = Math.sin(car.yaw) * dir, vz = Math.cos(car.yaw) * dir, sp = Math.abs(car.speed);
      const hit = (ceceCrowd && ceceCrowd.launchNear(car.x, car.z, vx, vz, sp)) || (drewCrowd && drewCrowd.launchNear(car.x, car.z, vx, vz, sp));
      if (hit) { _crowdHitT = now; if (audio.sfxThunk) audio.sfxThunk(0.5); toast('🎳 WHEEE!', 700); if (navigator.vibrate) { try { navigator.vibrate(22); } catch (e) { } } }
    }
    if (ceceCrowd) ceceCrowd.tick(dt, now);   // tick() advances visible mixers + any in-flight launch
    if (drewCrowd) drewCrowd.tick(dt, now);
  }

  let disposed = false;
  const car = createCar(scene);
  car.group.scale.setScalar(1.1);   // the player car renders ~10% bigger
  let cancelCarLoad = null;
  if (!flags.has('nocar')) {
    installDracoDecoder();
    car.heldForDefault = true;   // don't reveal a car until the default (Granvia) loads — no wrong-car flash
    // fallback: if slot 0 is slow/fails, after ~2.8 s show whatever HAS loaded so there's always a car
    setTimeout(() => { if (!disposed && car.heldForDefault) { car.heldForDefault = false; const f = car.models.findIndex(Boolean); if (f >= 0) setVehicle(car, f); } }, 2800);
    cancelCarLoad = loadRealCar(car, carGlbUrl, () => { if (!disposed) toast('Using fallback car model'); });
    // The swappable roster (🚗). All the new GLBs were Draco+WebP compressed and run nose
    // -Z, so flip:true points them forward (matches the Granvia). Ferrari is slot 2 (loaded
    // above via loadRealCar). Profiles live in VEHICLES.
    loadDrivableCar(car, granviaUrl, 0, { length: 5.1, flip: true, black: false, meta: VEHICLES[0] });
    loadDrivableCar(car, rav4Url, 1, { length: 4.6, flip: true, black: false, meta: VEHICLES[1] });
    loadDrivableCar(car, mustangUrl, 3, { length: 4.9, flip: true, black: false, meta: VEHICLES[3] });
    loadDrivableCar(car, miniUrl, 4, { length: 3.85, flip: true, black: false, meta: VEHICLES[4] });
    loadDrivableCar(car, corvetteUrl, 5, { length: 4.6, flip: true, black: false, meta: VEHICLES[5] });
    loadDrivableCar(car, rollsroyceUrl, 6, { length: 5.4, flip: true, black: false, meta: VEHICLES[6] });
    loadDrivableCar(car, scgUrl, 7, { length: 4.5, flip: true, black: false, meta: VEHICLES[7] });
    loadDrivableCar(car, battistaUrl, 8, { length: 4.8, flip: true, black: false, meta: VEHICLES[8] });
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
    if (!setVehicle(car, slot)) { toast('That one is still loading…'); return; }
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
  const LOOK_SENS = 0.0072, PITCH_SENS = 0.0048, ZOOM_RATE = 0.0011, MOVE_DEADZONE = 0.12;   // more responsive free-look
  const inp2 = { jx: 0, jy: 0, kx: 0, ky: 0, steer: 0, gas: 0, brake: 0, navActive: false, navX: 0, navZ: 0, hbrake: false, boost: false };
  let camYawS = 0, scPitch = 0.34, bagWarned = false, spotless = false, nearCar = false;
  // Experimental "draw to drive": in the Top-down view, a drag projects the finger
  // onto the ground and the car steers toward it + auto-throttles, so you trace its
  // path with one finger. (Joystick/keyboard still drive the other camera views.)
  let navPtr = null, navDownX = 0, navDownY = 0, navMoved = false;   // tap (route along roads) vs drag (freeform draw-to-drive)
  const _navRay = new THREE.Raycaster(), _navNDC = new THREE.Vector2();
  const _navPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _navHit = new THREE.Vector3();
  // drag-to-drive ("trace") is available in the overhead-style views (Top-down AND Aerial)
  const driveTopDown = () => mode === 'drive' && DRIVE_CAMS[camMode] && DRIVE_CAMS[camMode].dragdrive;
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
      if (driveTopDown()) { navPtr = e.pointerId; navDownX = e.clientX; navDownY = e.clientY; navMoved = false; showT = 0; setNavFromPointer(e.clientX, e.clientY); return; }
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
      if (e.pointerId === navPtr) { if (Math.hypot(e.clientX - navDownX, e.clientY - navDownY) > 12) navMoved = true; setNavFromPointer(e.clientX, e.clientY); return; }   // draw-to-drive
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
          if (mode === 'drive') czoom = clamp(czoom * f, 0.4, 3.4);   // wide range: pull right in on the car or way out for an overview
          else szoom = clamp(szoom * f, 0.32, 2.6);                   // close over-the-shoulder → wide yard overview
        }
        pinchD = nd;
        return;
      }
      const dx = e.clientX - ox, dy = e.clientY - oy;
      if (Math.abs(dx) + Math.abs(dy) < 4) return; // look deadzone (kill resting-finger jitter on high-DPI screens)
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
    else if (mode === 'drive') czoom = clamp(czoom * Math.exp(e.deltaY * ZOOM_RATE), 0.4, 3.4);
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
  function onKeyDown(e) {
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
    marker.visible = false; carMarker.visible = false; compostMarker.visible = false;
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
    // jump arc: integrate vertical velocity under gravity; land back on the ground
    if (CHAR.vy !== 0 || CHAR.airY > 0) {
      CHAR.airY += CHAR.vy * dt; CHAR.vy -= 22 * dt;
      if (CHAR.airY <= 0) { CHAR.airY = 0; CHAR.vy = 0; }
    }
    const bobY = (CHAR.airY > 0 || CHAR.drew) ? 0 : Math.abs(Math.sin(CHAR.bob)) * 0.05;
    CHAR.group.position.set(CHAR.x, cy + CHAR.airY + bobY, CHAR.z);
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
    if (COMPOST) {
      // green pin over the bin whenever you're carrying — makes the dump-off obvious
      compostMarker.visible = CHAR.bag > 0;
      if (compostMarker.visible) compostMarker.position.set(COMPOST[0], terrainAt(COMPOST[0], COMPOST[1]) + 3.2 + Math.abs(Math.sin(now * 0.005)) * 0.4, COMPOST[1]);
      if (CHAR.bag > 0 && Math.hypot(CHAR.x - COMPOST[0], CHAR.z - COMPOST[1]) < 3) {
        const dumped = CHAR.bag; CHAR.bag = 0; bagWarned = false; audio.sfxChime([392, 523]); pushScoopHud();
        toast('Composted ' + dumped + ' ♻️');
      }
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
    DEST = null; ROUTE = null; routeIdx = 0; autoDrive = false; inp2.navActive = false;
    guideLine.visible = false; destPin.visible = false; if (navMarker) navMarker.visible = false;
    emit('dest', null); emit('autodrive', false);
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
    for (const c of coins) c.got = false; coinsGot = 0;   // fresh coins each drive
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
    car.speed = 0; car.throttle = 0; car.brakeAmt = 0; car.pitchDyn = 0; car.kSteer = 0; boost = 0; car.group.visible = true; car.groundY = null;
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
    if (ROUTE && ROUTE.length > 1) {
      for (let i = 0; i < ROUTE.length - 1; i++) consider(ROUTE[i].x, ROUTE[i].z, ROUTE[i + 1].x, ROUTE[i + 1].z);
    } else {
      for (const r of S.roads) for (let k = 0; k < r.p.length - 1; k++) { const a = W(r.p[k]), b = W(r.p[k + 1]); consider(a[0], a[1], b[0], b[1]); }
    }
    if (!found) { toast('No road nearby — drive back toward town'); return; }
    car.x = bx; car.z = bz; car.speed = 0; car.steer = 0; car.vlat = 0; car.groundY = null; car.yaw = Math.atan2(dirX, dirZ);
    camInit = false; inp2.navActive = false; recoverCooldown = 1.8;   // grace so auto-recover can't immediately re-fire
    audio.blip && audio.blip();
    toast('Back on the road 🛣️', 1000);
  }
  // ---- destination / routing / auto-drive ----
  // Real road route from Google Directions (via the Maps JS SDK, which works in the
  // browser — the Directions web service is CORS-blocked). Falls back to a straight
  // line if the SDK/Directions API isn't enabled on the key.
  let _mapsSDK = null;
  function loadMapsSDK() {
    if (window.google && window.google.maps && window.google.maps.DirectionsService) return Promise.resolve(window.google.maps);
    if (_mapsSDK) return _mapsSDK;
    const key = import.meta.env.VITE_GOOGLE_MAPS_KEY;
    if (!key) return Promise.reject(new Error('no key'));
    _mapsSDK = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + key + '&libraries=places';   // places = address autocomplete
      s.async = true; s.defer = true;
      s.onload = () => (window.google && window.google.maps) ? res(window.google.maps) : rej(new Error('maps unavailable'));
      s.onerror = () => rej(new Error('maps script failed'));
      document.head.appendChild(s);
    });
    return _mapsSDK;
  }
  function fetchRoute(destLat, destLon) {
    loadMapsSDK().then(maps => {
      const o = worldToGeo(car.x, car.z);
      new maps.DirectionsService().route(
        { origin: { lat: o.lat, lng: o.lon }, destination: { lat: destLat, lng: destLon }, travelMode: 'DRIVING' },
        (result, status) => {
          if (status === 'OK' && result.routes && result.routes[0] && DEST) {
            const pts = result.routes[0].overview_path.map(p => { const w = geoToWorld(p.lat(), p.lng()); return { x: w[0], z: w[1] }; });
            if (pts.length > 1) {
              ROUTE = pts; routeIdx = 0;
              if (autoDrive && Math.abs(car.speed) < 6) faceRouteStart();   // just set off / was holding → aim down the real route
              toast('🗺️ Route ready — follow the line', 1500);
            }
          } else console.warn('[directions] no route:', status);
        }
      );
    }).catch(e => console.warn('[maps sdk] route unavailable, using straight line —', e && e.message));
  }
  // fromSearch = the player explicitly chose this place from the GO address search;
  // only THOSE arrivals earn the "Arrived" banner (a casual map tap does not).
  function setDestination(lat, lon, label, isChain, fromSearch) {
    const w = geoToWorld(lat, lon);
    DEST = { x: w[0], z: w[1], label: label || 'Destination', geo: { lat, lon }, celebrate: !!fromSearch };   // geo kept so a failed route can self-retry
    ROUTE = null; routeIdx = 0;
    emit('dest', { label: DEST.label });
    if (!isChain) { const km = (Math.hypot(DEST.x - car.x, DEST.z - car.z) / 1000).toFixed(1); toast('📍 ' + DEST.label + ' · ' + km + ' km — routing…', 2200); }
    fetchRoute(lat, lon);
  }
  function clearDestination() { DEST = null; ROUTE = null; routeIdx = 0; autoDrive = false; inp2.navActive = false; guideLine.visible = false; destPin.visible = false; emit('dest', null); emit('autodrive', false); }
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
        for (const sp of crowdSpots) if (sp.zone === p.key) { sp.rec.grp.position.x += p.x - ox; sp.rec.grp.position.z += p.z - oz; sp.rec.x += p.x - ox; sp.rec.z += p.z - oz; }   // shift this POI's dancers (stanton/canyon)
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
  let _gmap = null, _gmapCar = null, _gmapRoute = null, _gmapT = 0, _gmapDiv = null, _gmapRouteFor = null, _gmaps = null, _gmapOverviewUntil = 0;
  function initMiniMap(div) {
    if (!div || _gmapDiv === div) return;
    _gmapDiv = div;
    loadMapsSDK().then(maps => {
      if (_gmapDiv !== div) return;
      _gmaps = maps;
      const o = worldToGeo(car.x, car.z);
      _gmap = new maps.Map(div, {
        center: { lat: o.lat, lng: o.lon }, zoom: 15, disableDefaultUI: true,   // neighbourhood context, not a tight street view
        gestureHandling: 'none', keyboardShortcuts: false, clickableIcons: false,
        styles: DARK_MAP_STYLE, backgroundColor: '#1b2027', isFractionalZoomEnabled: true,
      });
      _gmapCar = new maps.Marker({ position: { lat: o.lat, lng: o.lon }, map: _gmap, zIndex: 5,
        icon: { path: 'M0,-10 L7,8 L0,3 L-7,8 Z', fillColor: '#2D8CFF', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1.5, scale: 1.05, rotation: 0, anchor: new maps.Point(0, 0) } });
      _gmapRoute = new maps.Polyline({ map: _gmap, strokeColor: '#2D8CFF', strokeOpacity: 0.95, strokeWeight: 4, path: [], zIndex: 3 });
      _gmap.addListener('click', e => { const w = geoToWorld(e.latLng.lat(), e.latLng.lng()); setDriveTarget(w[0], w[1]); });
    }).catch(() => { });
  }
  function updateMiniMap(now) {
    if (!_gmap || now - _gmapT < 200) return;   // ~5 Hz pan
    _gmapT = now;
    const o = worldToGeo(car.x, car.z);
    if (_gmapCar) { _gmapCar.setPosition({ lat: o.lat, lng: o.lon }); const ic = _gmapCar.getIcon(); ic.rotation = car.yaw * 180 / Math.PI; _gmapCar.setIcon(ic); }
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
    if (now >= _gmapOverviewUntil) { _gmap.setCenter({ lat: o.lat, lng: o.lon }); if (_gmap.getZoom() < 14) _gmap.setZoom(15); }   // follow the car at neighbourhood zoom (after the overview)
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
  function placeSuggest(text) {
    if (!text || text.trim().length < 3) return Promise.resolve([]);
    return loadMapsSDK().then(maps => new Promise(res => {
      if (!maps.places) { res([]); return; }
      if (!_acSvc) _acSvc = new maps.places.AutocompleteService();
      if (!_acTok) _acTok = new maps.places.AutocompleteSessionToken();
      _acSvc.getPlacePredictions({ input: text, sessionToken: _acTok }, (preds, status) => {
        res((status === 'OK' && preds) ? preds.slice(0, 5).map(p => ({ description: p.description, placeId: p.place_id })) : []);
      });
    })).catch(() => []);
  }
  // Relocate the START: teleport the car to an address (snap onto the nearest road if one is
  // near), clear any destination, re-settle the camera. Lets you start anywhere on the map.
  function jumpTo(lat, lon, label) {
    const w = geoToWorld(lat, lon);
    car.x = w[0]; car.z = w[1]; car.speed = 0; car.vlat = 0; car.steer = 0; car.assistRate = 0; car.groundY = null;
    const np = nearestRoadPoint(car.x, car.z);
    if (np && np.d < 40) { car.x = np.x; car.z = np.z; }
    clearDestination();
    camInit = false; recoverCooldown = 1.8;
    toast('📍 Jumped to ' + (label || 'there'), 1500);
  }
  // Destination by address / place — geocode then route there (and auto-drive on request).
  function setDestinationByText(text, drive) {
    return geocodeAddress(text).then(g => { setDestination(g.lat, g.lon, g.label, false, true); if (drive) { autoDrive = true; emit('autodrive', true); faceRouteStart(); } return g; });
  }
  function setDestinationByPlace(placeId, label, drive) {
    return geocodePlaceId(placeId, label).then(g => { setDestination(g.lat, g.lon, g.label, false, true); if (drive) { autoDrive = true; emit('autodrive', true); faceRouteStart(); } return g; });
  }
  // Autodrive max-speed cap (mph; 0 = uncapped). Persisted; applied in autoDriveTargetSpeed.
  let autoMaxMph = (() => { try { return parseInt(localStorage.getItem('dahill.automax') || '0', 10) || 0; } catch (e) { return 0; } })();
  function setAutoMaxMph(mph) { autoMaxMph = Math.max(0, mph | 0); try { localStorage.setItem('dahill.automax', String(autoMaxMph)); } catch (e) { } emit('automax', autoMaxMph); }
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
    DEST = { x: wx, z: wz, label: 'the map point', geo: g }; ROUTE = route || null; routeIdx = 0;   // geo kept so a failed route can self-retry
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
    const look = clamp(Math.abs(car.speed) * 0.42, 11, 28);   // tighter look-ahead → HUGS the route (less corner-cutting off the road)
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
  function toggleAutoDrive() { if (!DEST) return; autoDrive = !autoDrive; if (!autoDrive) inp2.navActive = false; else faceRouteStart(); emit('autodrive', autoDrive); toast(autoDrive ? '🤖 Fast auto-drive ON' : 'Auto-drive off', 1100); }
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
    let carD = 1e18;                                 // how far the car is from the road right now
    for (const s of roadSegs) {
      const ax = s[0][0], az = s[0][1], vx = s[1][0] - ax, vz = s[1][1] - az, L2 = vx * vx + vz * vz || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + vx * t - x, ez = az + vz * t - z, d = ex * ex + ez * ez;
      if (d < carD) carD = d;
    }
    if (carD > 100) return null;                     // >10 m off any road → no assist
    const La = clamp(Math.abs(speed) * 0.55, 7, 24); // look further ahead the faster you go
    const px = x + Math.sin(yaw) * La, pz = z + Math.cos(yaw) * La;
    let btx = 0, btz = 0, bd = 1e18; let found = false;
    for (const s of roadSegs) {
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
    for (const s of roadSegs) {
      const ax = s[0][0], az = s[0][1], vx = s[1][0] - ax, vz = s[1][1] - az, L2 = vx * vx + vz * vz || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t, pz = az + vz * t, d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bd) { bd = d; bx = px; bz = pz; }
    }
    return { x: bx, z: bz, d: Math.sqrt(bd) };
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
  // Cached canopy-skipped ROAD height per ROUTE point (one raycast each, reused every
  // frame). Auto-invalidates when ROUTE changes identity. This is what lets the ribbon
  // sit ON the street instead of floating on the tree/roof canopy that a top-down
  // groundAt() (cast from far above) hits first.
  let _routeYFor = null, _routeY = [];
  function guideHeightAt(i) {
    if (_routeYFor !== ROUTE) { _routeYFor = ROUTE; _routeY = []; }
    if (_routeY[i] == null) _routeY[i] = actorGroundY(ROUTE[i].x, ROUTE[i].z);
    return _routeY[i];
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
    const hw = 1.8;
    for (let i = 0; i < GUIDE_N; i++) {
      const k = Math.min(i, pts.length - 1), p = pts[k];
      const pp = pts[Math.max(0, k - 1)], pn = pts[Math.min(pts.length - 1, k + 1)];
      let tx = pn[0] - pp[0], tz = pn[1] - pp[1]; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const nx = -tz, nz = tx, y = p[2] + 0.12, o = i * 6;
      guidePos[o] = p[0] + nx * hw; guidePos[o + 1] = y; guidePos[o + 2] = p[1] + nz * hw;
      guidePos[o + 3] = p[0] - nx * hw; guidePos[o + 4] = y; guidePos[o + 5] = p[1] - nz * hw;
    }
    guideGeo.attributes.position.needsUpdate = true;
    guideGeo.setDrawRange(0, (Math.min(pts.length, GUIDE_N) - 1) * 6);   // only the built segments
    guideLine.visible = true;
  }
  // 2D minimap (north-up, centred on the car): roads, house, destination + line, car.
  function drawMinimap(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, range = 460, scale = (w / 2) / range;
    const toPx = (wx, wz) => [cx + (wx - car.x) * scale, cy + (wz - car.z) * scale];
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
    const hx = Math.sin(car.yaw), hz = Math.cos(car.yaw), pxv = Math.cos(car.yaw), pzv = -Math.sin(car.yaw);
    ctx.fillStyle = '#d94f1e'; ctx.beginPath();
    ctx.moveTo(cx + hx * 7, cy + hz * 7);
    ctx.lineTo(cx - hx * 5 + pxv * 4, cy - hz * 5 + pzv * 4);
    ctx.lineTo(cx - hx * 5 - pxv * 4, cy - hz * 5 - pzv * 4);
    ctx.closePath(); ctx.fill();
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
    { name: 'Top-down', dist: 7, h: 85, ahead: 12, drone: true, topdown: true, dragdrive: true },   // proper high overhead map view
    { name: 'Aerial', aerial: true, dragdrive: true },   // the Explore look (high orbit), drag to drive there
  ];
  function cycleCamera() {
    driveCamUserPicked = true;
    camMode = (camMode + 1) % DRIVE_CAMS.length; camInit = false;
    czoom = 1; camOrbit.yaw = 0; camOrbit.pitch = 0;   // fresh framing per view (pinch-zoom/look don't leak)
    const dd = DRIVE_CAMS[camMode].dragdrive;
    if (!DRIVE_CAMS[camMode].topdown) camera.up.set(0, 1, 0);   // only top-down is heading-up
    if (!dd) { inp2.navActive = false; navPtr = null; }         // leaving a drag-to-drive view ends it
    emit('driveCam', DRIVE_CAMS[camMode].name);
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
      emit('driveCam', DRIVE_CAMS[camMode].name);
      toast('Camera: ' + DRIVE_CAMS[camMode].name, 1100);
      return;
    }
    camMode = i; camInit = false; czoom = 1; camOrbit.yaw = 0; camOrbit.pitch = 0;
    emit('driveCam', DRIVE_CAMS[i].name);
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

  function updateDrive(dt, now) {
    // mix stick (jx/jy) + keyboard (kx/ky) + dedicated touch steer/gas/brake
    // DECOUPLED controls: the left stick STEERS only (X). Throttle is the gas pedal
    // (or W), brake is the brake pedal (or S); just steering gently auto-accelerates
    // so kids who only push the stick still cruise. (Touch jy is no longer throttle.)
    // keyboard arrows are binary ±1 — ramp them over ~0.15 s so desktop steering eases
    // in like the touch stick instead of snapping (kSteer feeds jx; touch jx stays direct).
    car.kSteer = (car.kSteer || 0) + (inp2.kx - (car.kSteer || 0)) * Math.min(1, dt * 7);
    let jx = clamp(inp2.jx + car.kSteer + inp2.steer, -1, 1);
    let throttleTarget = 0, brake = 0;
    // TWIN-STICK MOVE: the left stick's vertical axis IS the throttle/brake now.
    //   jy < 0 (push up)   → gas, proportional to how far up
    //   jy > 0 (pull down) → brake / reverse
    // (setGasAmount/setBrake still feed inp2.gas/inp2.brake for back-compat.)
    const jyGas = inp2.jy < -MOVE_DEADZONE ? clamp((-inp2.jy - MOVE_DEADZONE) / (1 - MOVE_DEADZONE), 0, 1) : 0;
    const jyBrake = inp2.jy > MOVE_DEADZONE;
    if (inp2.brake || inp2.ky > 0 || jyBrake) brake = 1;
    else if (inp2.ky < 0) throttleTarget = 1;                  // keyboard = full
    else if (jyGas > 0) throttleTarget = jyGas;                // left stick up = analog gas
    else if (inp2.gas > 0) throttleTarget = inp2.gas;          // touch gas (analog 0..1)
    // Stick-only "auto-creep": cruise GENTLY toward ~18 u/s (≈40 mph) instead of
    // flooring it — a kid who only steers should roll at a corner-able pace, never
    // pin to the 220 mph top end. Push up for the real speed.
    else if (Math.abs(jx) > 0.05) throttleTarget = clamp((18 - car.speed) / 18, 0, 0.5);
    // ANALOG pedal: squeeze the throttle up over ~0.4 s and bleed it off faster, so the
    // gas feels like a pedal you press (feather power out of a slide), not a switch.
    const cur = car.throttle || 0;
    const tRate = throttleTarget > cur ? 2.6 : 5.4;
    car.throttle = cur + (throttleTarget - cur) * Math.min(1, dt * tRate);
    let throttle = car.throttle;
    // GRAB THE WHEEL: any real steer/gas/brake input drops auto-drive so the player
    // instantly takes over instead of fighting the robot.
    if (autoDrive && (Math.abs(inp2.jx + inp2.kx + inp2.steer) > 0.2 || Math.abs(inp2.jy) > MOVE_DEADZONE || inp2.gas || inp2.brake || inp2.ky)) {
      autoDrive = false; inp2.navActive = false; emit('autodrive', false); toast('🕹️ You took the wheel!', 900);
    }
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
        throttle = 0; brake = clamp(0.35 + farT * 0.45, 0, 0.85);   // brake reverses once stopped
      } else {                                             // drive forward toward it — a robot with a FAR
        // target behind it arcs around (forward U-turn) at full steering lock instead of
        // reversing the whole way across lawns into whatever's behind it.
        jx = clamp(-dyaw * (robot ? 1.6 : 2.0), -1, 1);   // gentler robot gain → no overshoot/wobble on angled (non-90°) turns
        const align = clamp(1 - Math.abs(dyaw) / 1.7, robot ? 0.42 : 0.22, 1); // robot keeps pace through bends
        if (robot) {
          const dDest = Math.hypot(DEST.x - car.x, DEST.z - car.z);
          const want = autoDriveTargetSpeed(dDest);
          const gap = want - Math.abs(car.speed);
          throttle = clamp(0.42 + gap / Math.max(22, want) * 0.95, 0, 1) * align;
          brake = gap < -12 ? clamp((-gap - 8) / 30, 0, 0.58) : 0;
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
    if (boosting) { boost = Math.max(0, boost - dt * 0.4); if (!boostWas) { if (audio.sfxWhoosh) audio.sfxWhoosh(1); toast('🚀 NITRO!', 700); } }
    boostWas = boosting;
    const boostMul = boosting ? 1.34 : 1;
    let maxF = (highway ? 250 : openRoad ? 115 : 38) * prof.top * boostMul; const maxR = -11;   // highway = supersonic; lawns crawl
    if (autoDrive && (highway || openRoad)) maxF = Math.max(maxF, 330 * boostMul);   // the chauffeur can hit ~700 mph on a clear straight
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
    const pedalTgt = Math.pow(throttle, 2.4) * maxF;                 // curved pedal → target speed; steeper = easy SLOW crawl at the bottom
    const aGap = pedalTgt - car.speed;
    const aMax = (highway ? 62 : openRoad ? 32 : 13) * prof.accel * boostMul;   // peak engine pull (cap)
    let acc = clamp(aGap * (aGap > 0 ? 2.6 : 0.9), -aMax, aMax);     // chase target; gentler on lift-off coast
    if (aGap > 0) acc *= 0.75 + 0.25 * clamp(Math.abs(car.speed) / 6, 0, 1);   // gentle off-the-line ramp (the ^2.4 pedal curve already kills standstill jerk) — keeps a floored stab feeling punchy, not sluggish
    // PROGRESSIVE brake: ramp the brake force in over ~0.25 s so a quick tap trail-brakes
    // lightly (corner-entry finesse) while a long hold still hauls it down hard.
    const braking = brake > 0.1;
    const bcur = car.brakeAmt || 0;
    car.brakeAmt = bcur + ((braking ? 1 : 0) - bcur) * Math.min(1, dt * (braking ? 4 : 9));
    if (braking) acc = car.speed > 0.5 ? -34 * car.brakeAmt : -13 * brake;
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
      // FAST on the straights, still turn-aware. The throttle controller above aims at
      // this pace; this cap is only a soft guardrail so auto-drive feels quick, not jerky.
      autoCap = autoDriveTargetSpeed(dDest) + (highway ? 70 : 18);
    }
    car.speed += acc * dt;
    car.speed -= car.speed * (highway ? 0.06 : openRoad ? 0.1 : 0.28) * dt;   // highway = slippery-fast, lawns drag
    car.speed = clamp(car.speed, maxR, maxF);
    if (autoDrive && car.speed > autoCap) car.speed += (autoCap - car.speed) * Math.min(1, dt * 3.2);   // soft capped cruise while the robot drives
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
    // Distance to the nearest neighbourhood road (only meaningful in the procedural hood;
    // far out the car rides photoreal roads with no graph, so we don't measure/recover).
    const inHood = Math.hypot(car.x, car.z) < 330;
    const nrp = inHood ? nearestRoadPoint(car.x, car.z) : null;
    const offRoadDist = nrp ? nrp.d : 0;
    // AUTO-STEER assist: aim the car along the ROUTE (when navigating), or — in free-roam —
    // along the nearest road via a look-ahead point that takes street corners for you. When
    // you've drifted OFF the road it switches to RECOVERY: aim straight back at the nearest
    // tarmac from any angle, strongly, so it actively steers you home. Your steering always
    // overrides the corner/track assist (fades to 0 as you push the stick).
    let assistTargetRate = 0;
    if (autoSteer && !inp2.navActive && !hb && Math.abs(car.speed) > 4) {
      let dir = null, recover = false; const onRoute = !!(ROUTE && routeIdx < ROUTE.length);
      if (onRoute) { const t = navTarget(); dir = [t.x - car.x, t.z - car.z]; }
      else if (nrp && offRoadDist > 8 && offRoadDist < 60) { dir = [nrp.x - car.x, nrp.z - car.z]; recover = true; }
      else { const tp = roadTargetAhead(car.x, car.z, car.yaw, car.speed); if (tp) dir = [tp[0] - car.x, tp[1] - car.z]; }
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
    } else offRoadT = 0;
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
    for (const c of traffic) {
      if (c.x === undefined) continue;
      const dx = nx - c.x, dz = nz - c.z, d2 = dx * dx + dz * dz, rr = 1.9 + rad;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2); nx = c.x + dx / d * rr; nz = c.z + dz / d * rr;
        if (carHit(Math.abs(car.speed), 'car')) car.speed *= 0.72;
        hitThisFrame = true;
      } else if (fast && d2 < (rr + 2.4) * (rr + 2.4)) nearThisFrame = true;
    }
    if (nearThisFrame && !hitThisFrame) nearMiss(now);   // Burnout-style close-call reward
    // Roam far across the streamed Google tiles. The procedural neighborhood (and
    // its collision) only spans ~±340 m; past that the car rides the real
    // photoreal road directly (see actorGroundY), so the only bound is a generous
    // sanity ring at the metro scale where the flat-earth frame stays accurate.
    const lim = 30000;   // 30 km: reach the East Bay address presets (Oakland ≈ 22 km) across the streamed tiles
    if (Math.hypot(nx, nz) > lim) { const d = Math.hypot(nx, nz); nx *= lim / d; nz *= lim / d; car.speed *= 0.4; }  // soft edge: ease to a stop, don't shove back
    car.x = nx; car.z = nz;
    // Ride the real photoreal ROAD surface (canopy-skipped + clamped to topology),
    // tracked ASYMMETRICALLY: settle DOWN gently (smooth on descents + bumps) but catch
    // UP quickly, and never let the smoothed height sink more than a hair below the real
    // surface. A symmetric low-pass used to lag BELOW a road that climbs faster than it
    // can track (uphill/onto a bridge at speed) — and once the car was under the surface,
    // the canopy-skipping down-ray (cast from just above the car) could no longer see the
    // road ABOVE it, so it stayed buried. The hard floor keeps that from ever happening.
    const yr = actorGroundY(car.x, car.z, car.groundY);
    if (car.groundY == null) car.groundY = yr;
    else { const rate = yr > car.groundY ? dt * 12 : dt * 5; car.groundY += (yr - car.groundY) * Math.min(1, rate); }
    if (yr != null && car.groundY < yr - 0.25) car.groundY = yr - 0.25;
    const yC = car.groundY;
    const rxv = Math.cos(car.yaw), rzv = -Math.sin(car.yaw);
    const tF = terrainAt(car.x + fx * 1.4, car.z + fz * 1.4), tB = terrainAt(car.x - fx * 1.4, car.z - fz * 1.4);
    const tR = terrainAt(car.x + rxv * 0.9, car.z + rzv * 0.9), tL = terrainAt(car.x - rxv * 0.9, car.z - rzv * 0.9);
    const pitch = Math.atan2(tB - tF, 2.8), roll = Math.atan2(tR - tL, 1.8);
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
    const dispTarget = _camV.aerial ? 4.0 : _camV.topdown ? 2.6 : 1.1;   // big enough to spot from up high, not cartoonish
    car.dispScale = car.dispScale == null ? dispTarget : car.dispScale + (dispTarget - car.dispScale) * (1 - Math.exp(-dt * 6));
    car.group.scale.setScalar(car.dispScale);
    // car locator removed — the scaled-up car IS its own marker in the overhead views, so
    // the bobbing chevron/ring was just "garbage on the car" obscuring it.
    carLocator.visible = false;
    // collectible coins: spin + bob, picked up by driving over them
    for (const c of coins) {
      c.mesh.visible = !c.got;
      if (c.got) continue;
      c.mesh.rotation.y += dt * 3.2;
      c.mesh.position.y = terrainAt(c.x, c.z) + 1.0 + Math.abs(Math.sin(now * 0.004 + c.x)) * 0.3;
      if (Math.hypot(car.x - c.x, car.z - c.z) < 3.4) {
        c.got = true; coinsGot++;
        spawnCoinBurst(c.x, c.z, terrainAt(c.x, c.z), now);
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
      if (navMarker.visible) navMarker.position.set(inp2.navX, yC + 0.12, inp2.navZ);
    }
    // address guide: a continuous line along the actual ROUTE (every turn), draped on
    // the road just ahead of the car; + a pin at the destination when near.
    if (DEST) {
      updateGuide(yC);
      const ddDest = Math.hypot(DEST.x - car.x, DEST.z - car.z);
      destPin.visible = ddDest < 700;
      if (destPin.visible) destPin.position.set(DEST.x, terrainAt(DEST.x, DEST.z) + 6 + Math.abs(Math.sin(now * 0.004)) * 0.6, DEST.z);
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
      camera.lookAt(car.x + fx * sp * 26, camGroundRef + 1, car.z + fz * sp * 26);   // bias the gaze where you're heading
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
      const camT = _camT.set(car.x - fx * (CAM.dist + sp * 4), yC + (CAM.h + sp * 9) * czoom, car.z - fz * (CAM.dist + sp * 4));
      if (!camInit) { camV.copy(camT); camInit = true; }
      camV.lerp(camT, 1 - Math.exp(-(5 + clamp(Math.abs(car.speed) / 16, 0, 13)) * dt));   // keep up at top speed
      camera.position.copy(camV);
      camera.up.set(fx, 0, fz); // heading-up
      const spHiT = clamp((Math.abs(car.speed) - feelRef) / (feelRef * 2.7), 0, 1);
      const ahead = CAM.ahead + sp * sp * 16 + spHiT * 14;     // see further down the road flat-out
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
      if (now - camOrbit.t > 1800) { const k = 1 - Math.exp(-dt * 1.3); camOrbit.yaw *= (1 - k); camOrbit.pitch *= (1 - k); }
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
      const lookAhead = CAM.ahead + sp * 6;
      const rpxL = Math.cos(car.yaw), rpzL = -Math.sin(car.yaw);
      const latLead = (car.vlat * 0.05 + car.steer * 2.0) * (1 - 0.3 * sp);
      _lookT.set(car.x + fx * lookAhead + rpxL * latLead, yC + 1.0, car.z + fz * lookAhead + rpzL * latLead);
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
  let raf = 0, paused = false, ctxLost = false, _miniT = 0, _miniCtx = null, _miniEl = null;
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
    updateAnimals(dt, now); // ambient life in every mode
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
    camera.getWorldDirection(dirV);
    if (ui.needle) ui.needle.style.transform = `rotate(${(Math.atan2(dirV.x, dirV.z) * 180 / Math.PI).toFixed(1)}deg)`;
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
  function suspend() { if (!paused) { paused = true; cancelAnimationFrame(raf); if (audio.suspendAudio) audio.suspendAudio(); } }
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
  emitPOIs();                 // seed the start-card "places found" badge from saved progress
  if (audio.setMuted) audio.setMuted(!soundOn);   // sync the master mute with the saved pref
  emit('sound', soundOn);   // seed the 🔊 toggle state
  emit('autosteer', autoSteer);
  checkFerrariUnlock();       // reconcile a prior 5/5 completion → keep the Ferrari unlocked
  if (document.hidden) paused = true;   // born in a background tab → don't render/stream until shown
  else raf = requestAnimationFrame(loop);

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
    removeEventListener('pagehide', suspend); removeEventListener('freeze', suspend);
    removeEventListener('pageshow', resume); removeEventListener('resume', resume);
    removeEventListener('keydown', onKeyDown);
    removeEventListener('keyup', onKeyUp);
    removeEventListener('resize', resize);
    if (window.visualViewport) {
      visualViewport.removeEventListener('resize', resize);
      visualViewport.removeEventListener('scroll', resize);
    }
    audio.engineStop();
    if (audio.stopMusic) audio.stopMusic();      // kill the 30ms music scheduler interval (was leaking)
    if (audio.close) audio.close();              // close the AudioContext so it isn't left running
    if (cancelCarLoad) cancelCarLoad();          // late car load/timeout can't touch a dead scene
    if (ceceCrowd) ceceCrowd.dispose();          // stop crowd mixers + detach the dancers
    if (drewCrowd) drewCrowd.dispose();
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
    // hop: only from the ground; a keyboard Space also jumps (wired in onKeyDown)
    jump: () => { if (mode === 'scoop' && CHAR.airY <= 0 && CHAR.vy === 0) { CHAR.vy = 8.5; if (audio.blip) audio.blip(); } },
    // random little celebration (rigged Drew only)
    dance: () => {
      if (mode !== 'scoop' || !CHAR.drew) return;
      const moves = ['dance', 'cheer'];
      CHAR.drew.react(moves[Math.floor(Math.random() * moves.length)]);
      if (audio.blip) audio.blip();
    },
    focusHouse, cycleCamera, traceDrive, cycleCar, getCars, pickCar, cycleScoopCamera, driveFromScoop, resetToRoad,
    setDestination, clearDestination, toggleAutoDrive,
    // address search + jump-to + autodrive speed cap (Google JS SDK, in-browser)
    placeSuggest, geocodeAddress, geocodePlaceId,
    jumpToAddress: (lat, lon, label) => jumpTo(lat, lon, label),
    jumpToText: (text) => geocodeAddress(text).then(g => { jumpTo(g.lat, g.lon, g.label); return g; }),
    jumpToPlace: (placeId, label) => geocodePlaceId(placeId, label).then(g => { jumpTo(g.lat, g.lon, g.label); return g; }),
    driveToText: (text) => setDestinationByText(text, true),
    driveToPlace: (placeId, label) => setDestinationByPlace(placeId, label, true),
    setAutoMaxMph, getAutoMaxMph: () => autoMaxMph,
    preloadMaps: () => loadMapsSDK().catch(() => {}),   // warm the SDK so the first keystroke in the address box doesn't jank
    initMiniMap,                                         // mount the live Google minimap into a div
    setHandbrake: (on) => { inp2.hbrake = !!on; },
    // LOOK stick (right thumb): orbit the drive camera. dx/dy are screen-pixel deltas,
    // same convention as a look-drag on the canvas, so it feeds the existing camOrbit.
    nudgeLook: (dx, dy) => {
      camOrbit.yaw -= dx * LOOK_SENS;
      camOrbit.pitch = clamp(camOrbit.pitch + dy * PITCH_SENS, -0.45, 0.8);
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
    // tap-to-drive: convert a minimap pixel (north-up, car-centred) to a world point
    // and let the robot drive there. range/scale mirror drawMinimap exactly.
    tapMinimap: (px, py, w, h) => { const range = 460, scale = (w / 2) / range; setDriveTarget(car.x + (px - w / 2) / scale, car.z + (py - h / 2) / scale); },
    dispose,
    get mode() { return mode; }
  };
  // tiny debug handle for headless verification + on-phone debugging
  window.__dahill = {
    api,
    crowd: () => ({ cece: !!ceceCrowd, drew: !!drewCrowd, spots: crowdSpots.map(s => ({ zone: s.zone, x: Math.round(s.rec.x), z: Math.round(s.rec.z), vis: s.rec.grp.visible, scale: +s.rec.grp.scale.x.toFixed(2), y: +s.rec.grp.position.y.toFixed(1), dCar: Math.round(Math.hypot(s.rec.x - car.x, s.rec.z - car.z)) })) }),
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
      poops: POOPS.length, car: { x: +car.x.toFixed(1), z: +car.z.toFixed(1), speed: +car.speed.toFixed(1), glb: !!car.glb },
      char: { x: +CHAR.x.toFixed(1), z: +CHAR.z.toFixed(1), bag: CHAR.bag, total: CHAR.total, lvl: CHAR.lvl }
    })
  };
  return api;
}
