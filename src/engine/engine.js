import * as THREE from 'three';
import { S, C, W, uvAt, terrainAt, SREC, GRID_ANG } from './data.js';
import { clamp } from './coords.js';
import { buildWorld } from './world.js';
import { createAnimals, createCharacter, TOOLS, toolAfterScoop, POOP_ACTIVE_CAP } from './animals.js';
import { createCar, loadRealCar, CARSPECS } from './car.js';
import { installDracoDecoder } from './draco-install.js';
import { createAudio } from './audio.js';
import aerialUrl from '../assets/aerial_opt.jpg';
import carGlbUrl from '../assets/ferrari.glb';

// Real Street View photos for the drive level, baked at build time by
// scripts/fetch_streetview.py (runtime fetches would die in the offline
// artifact webview). Streets absent from the manifest get no billboard.
const SV_IMGS = import.meta.glob('../assets/streetview/*.jpg', { eager: true, query: '?url', import: 'default' });
const SV_MANIFEST = Object.values(
  import.meta.glob('../assets/streetview/manifest.json', { eager: true, import: 'default' })
)[0] || {};

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

  // Upgraded to three r184. The scene's colours and light intensities were all
  // hand-tuned under r128's un-managed, linear-output pipeline, so opt back out
  // of r152+ colour management and keep linear output to preserve that look;
  // the lights are re-scaled below for r155+ physically-correct units.
  THREE.ColorManagement.enabled = false;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LITE, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(LITE ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = !LITE;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
  sun.shadow.mapSize.set(2048, 2048);
  const sc2 = sun.shadow.camera;
  sc2.left = -300; sc2.right = 300; sc2.top = 300; sc2.bottom = -300; sc2.far = 900;
  sun.shadow.bias = -0.0009;
  scene.add(sun);

  const world = buildWorld(scene, renderer, { S, C, W, uvAt, terrainAt, SREC, GRID_ANG, aerialUrl });
  const { onRoad, house, bldBoxes, bldPolys, treePts, frontPt, frontDir, COMPOST, ring, interiorGroup, labelSprites, waterMat } = world;

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

  const car = createCar(scene);
  if (!flags.has('nocar')) {
    installDracoDecoder();
    loadRealCar(car, carGlbUrl, () => toast('Using fallback car model'));
  }
  let showT = 0;

  function showCarCard() {
    const cs = CARSPECS[car.red ? 0 : 1];
    emit('carCard', { name: cs.name, spec: cs.spec });
  }
  function toggleCarColor() {
    car.red = !car.red;
    const cs = CARSPECS[car.red ? 0 : 1];
    car.bodyMat.color.setHex(cs.color);
    if (car.paint) car.paint.color.setHex(cs.color);
    emit('carColor', cs.css);
    showCarCard();
  }

  // ---------- checkpoint rings + street view billboards ----------
  const SVBOARDS = [];
  function addStreetViewBoard(name, r, mid, m) {
    const info = SV_MANIFEST[name];
    const url = info && SV_IMGS['../assets/streetview/' + info.file];
    if (!url) return;
    const a = W(r.p[Math.max(0, mid - 1)]), b = W(r.p[Math.min(r.p.length - 1, mid + 1)]);
    let dx = b[0] - a[0], dz = b[1] - a[1]; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    const off = r.w / 2 + 3.4;
    let bx = 0, bz = 0;
    for (const s of [1, -1]) {
      bx = m[0] - dz * off * s; bz = m[1] + dx * off * s;
      if (!onRoad(bx, bz) && !bldBoxes.some(bb => bx > bb[0] - 1 && bx < bb[1] + 1 && bz > bb[2] - 1 && bz < bb[3] + 1)) break;
    }
    const g = new THREE.Group();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x6e5340, roughness: 1 });
    for (const px of [-1.45, 1.45]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.35, 0.12), postMat);
      leg.position.set(px, 0.67, 0); g.add(leg);
    }
    // photo + caption strip composited onto a canvas once the (inlined data
    // URI) image decodes — unlit so the photo reads true at any sun angle
    const tex = new THREE.Texture();
    tex.minFilter = THREE.LinearFilter;
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = 640; cv.height = 440;
      const c = cv.getContext('2d');
      c.drawImage(img, 0, 0, 640, 400);
      c.fillStyle = '#10151c'; c.fillRect(0, 400, 640, 40);
      c.fillStyle = '#f5efe2'; c.font = '600 22px system-ui, sans-serif';
      c.fillText(name.toUpperCase(), 12, 428);
      c.fillStyle = '#9fb2c5'; c.font = '15px system-ui, sans-serif'; c.textAlign = 'right';
      c.fillText('Street View © Google ' + (info.date || ''), 628, 427);
      tex.image = cv; tex.needsUpdate = true;
    };
    img.src = url;
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 2.27),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    pane.position.y = 2.3; g.add(pane);
    g.position.set(bx, terrainAt(bx, bz), bz);
    g.rotation.y = Math.atan2(m[0] - bx, m[1] - bz);
    g.visible = false;
    scene.add(g);
    SVBOARDS.push(g);
  }
  {
    const byName = {};
    for (const r of S.roads) {
      if (!r.n || ['residential', 'tertiary'].indexOf(r.k) < 0) continue;
      let len = 0; for (let k = 0; k < r.p.length - 1; k++) { const a = W(r.p[k]), b = W(r.p[k + 1]); len += Math.hypot(b[0] - a[0], b[1] - a[1]); }
      if (!byName[r.n] || byName[r.n].len < len) byName[r.n] = { len, r };
    }
    const names = Object.keys(byName).sort((a, b) => byName[b].len - byName[a].len).slice(0, 6);
    // Checkpoint rings removed — drive mode is free-roam now. The street-view
    // billboards still mark these six streets.
    for (const n of names) {
      const r = byName[n].r, mid = Math.floor(r.p.length / 2), m = W(r.p[mid]);
      addStreetViewBoard(n, r, mid, m);
    }
  }

  // ---------- dollhouse roof ----------
  let insideOpen = false, roofAnim = 0; // 0 closed -> 1 open
  function setInside(open) {
    insideOpen = open;
    emit('inside', open);
    if (open) { ctl.gtx = house.c[0]; ctl.gtz = house.c[1]; ctl.gty = house.baseY + 3; ctl.gr = 30; ctl.gpo = 0.48; }
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
  const setMode = m => { mode = m; emit('mode', m); };
  const ptrs = new Map(); let lastPinch = 0, lastMid = null, moved = 0;
  const lookPtrs = new Map();
  const camOrbit = { yaw: 0, pitch: 0, t: 0 };
  let movePtr = null, joyBX = 0, joyBY = 0, pinchD = 0, czoom = 1, szoom = 1;
  // Roblox-style controls: shared look/zoom feel across drive+scoop, a steering
  // stick + gas/brake pedals for touch driving, shift-lock for the keeper, and
  // flick momentum in explore. inp2 mixes stick (j*), keyboard (k*) and the
  // dedicated touch driving inputs (steer/gas/brake).
  const LOOK_SENS = 0.0046, PITCH_SENS = 0.003, ZOOM_RATE = 0.0011, MOVE_DEADZONE = 0.12;
  const inp2 = { jx: 0, jy: 0, kx: 0, ky: 0, steer: 0, gas: 0, brake: 0 };
  let camYawS = 0, scPitch = 0.34, bagWarned = false, spotless = false;
  let shiftLock = false, moveMag = 0, azVel = 0, poVel = 0;

  function hideJoy() {
    movePtr = null; inp2.jx = 0; inp2.jy = 0;
    if (ui.joy) ui.joy.style.display = 'none';
  }

  function onPointerDown(e) {
    if (mode !== 'explore') {
      canvas.setPointerCapture(e.pointerId);
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
    if (e.pointerId === movePtr) hideJoy();
    lookPtrs.delete(e.pointerId);
    if (lookPtrs.size < 2) pinchD = 0;
    if (mode === 'explore' && ptrs.size === 1 && moved < 6) tapAt(e.clientX, e.clientY);
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

  function tapAt(x, y) {
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, camera);
    if (rc.intersectObjects(house.meshes).length) setInside(!insideOpen);
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
    for (let i = 0; i < 3; i++) CHAR.scoops[i].visible = i === lvl;
    pushScoopHud();
  }
  function enterScoop() {
    setMode('scoop'); camInit = false;
    setInside(false);
    for (const s of labelSprites) s.visible = false;
    CHAR.group.visible = true;
    CHAR.x = SREC.shed[0] - 2.5; CHAR.z = SREC.shed[1] - 2.5; // shed's door side, clear of the house box
    CHAR.yaw = Math.atan2(SREC.pen[0] - CHAR.x, SREC.pen[1] - CHAR.z);
    camYawS = CHAR.yaw;
    audio.ensure();
    setTool(CHAR.lvl);
    toast('Scoop the sanctuary poop! 💩<br><small>Empty your scoop at the green compost bin</small>', 2600);
  }
  function exitScoop() {
    setMode('explore');
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
      const sp = 4.4 * mag;
      let nx = CHAR.x + mx * sp * dt, nz = CHAR.z + mz * sp * dt;
      const rad = 0.42;
      for (const bb of bldBoxes) {
        if (nx > bb[0] - rad && nx < bb[1] + rad && nz > bb[2] - rad && nz < bb[3] + rad) {
          const pl = [nx - (bb[0] - rad), (bb[1] + rad) - nx, nz - (bb[2] - rad), (bb[3] + rad) - nz];
          const m = Math.min(...pl);
          if (m === pl[0]) nx = bb[0] - rad; else if (m === pl[1]) nx = bb[1] + rad;
          else if (m === pl[2]) nz = bb[2] - rad; else nz = bb[3] + rad;
        }
      }
      for (const t of treePts) {
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
    const cy = terrainAt(CHAR.x, CHAR.z);
    CHAR.group.position.set(CHAR.x, cy + Math.abs(Math.sin(CHAR.bob)) * 0.05, CHAR.z);
    CHAR.group.rotation.y = CHAR.yaw - Math.PI / 2;
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
        } else pushScoopHud();
      }
    }
    if (COMPOST && CHAR.bag > 0 && Math.hypot(CHAR.x - COMPOST[0], CHAR.z - COMPOST[1]) < 2.3) {
      CHAR.bag = 0; bagWarned = false; audio.sfxChime([392, 523]); pushScoopHud();
      toast('Composted ♻️');
    }
    if (POOPS.length === 0 && !spotless) { spotless = true; toast('Yard is spotless ✨ (for now…)', 2400); }
    if (POOPS.length > 0) spotless = false;
    if (scoopHudDirty) { scoopHudDirty = false; pushScoopHud(); }
    // follow cam — subject centered
    const fx = Math.sin(camYawS), fz = Math.cos(camYawS);
    const dist = 6.2 * szoom, h = (2.1 + scPitch * 4.5) * Math.max(0.75, szoom);
    const camT = new THREE.Vector3(CHAR.x - fx * dist, cy + h, CHAR.z - fz * dist);
    const g = resolveCam(CHAR.x, cy + 1.1, CHAR.z, camT.x, camT.y, camT.z);
    if (g < 1) { camT.set(CHAR.x + (camT.x - CHAR.x) * g, cy + 1.1 + (camT.y - cy - 1.1) * g, CHAR.z + (camT.z - CHAR.z) * g); }
    if (!camInit) { camV.copy(camT); camInit = true; }
    camV.lerp(camT, Math.min(1, dt * 6));
    camV.y = Math.max(camV.y, terrainAt(camV.x, camV.z) + 1.2);
    camera.position.copy(camV);
    camera.lookAt(CHAR.x, cy + 1.0, CHAR.z);
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
    car.speed = 0; car.group.visible = true;
    camOrbit.yaw = 0; camOrbit.pitch = 0;
    showT = 2.8;
    for (const b of SVBOARDS) b.visible = true;
    for (const s of labelSprites) s.visible = false;
    audio.engineStart();
    showCarCard();
    toast('Free roam — drive anywhere!', 2200);
  }
  function exitDrive() {
    setMode('explore');
    camera.up.set(0, 1, 0);
    hideJoy();
    car.group.visible = false;
    for (const b of SVBOARDS) b.visible = false;
    for (const s of labelSprites) s.visible = true;
    inp2.jx = inp2.jy = inp2.kx = inp2.ky = 0;
    audio.engineStop();
    ctl.gtx = clamp(car.x, -310, 310); ctl.gtz = clamp(car.z, -310, 310);
    ctl.gty = terrainAt(ctl.gtx, ctl.gtz) + 3; ctl.gr = 110; ctl.gpo = 0.95;
    ctl.tx = ctl.gtx; ctl.tz = ctl.gtz;
  }

  const camV = new THREE.Vector3();
  let camMode = 0;
  let camInit = false;
  const CAMNAMES = ['Chase', 'High', 'Top-down'];
  function cycleCamera() {
    camMode = (camMode + 1) % 3; camInit = false;
    if (camMode !== 2) camera.up.set(0, 1, 0);
    toast('Camera: ' + CAMNAMES[camMode], 1100);
  }
  // March the subject->camera segment and pull the camera in before it would
  // enter a building below that building's roofline.
  function resolveCam(tx, ty, tz, px, py, pz) {
    const steps = 14;
    for (let s = 3; s <= steps; s++) {
      const f = s / steps;
      const x = tx + (px - tx) * f, y = ty + (py - ty) * f, z = tz + (pz - tz) * f;
      for (const bb of bldBoxes) {
        if (x > bb[0] && x < bb[1] && z > bb[2] && z < bb[3] && y < (bb[4] || 99)) {
          return Math.max(0.2, (s - 1.5) / steps);
        }
      }
    }
    return 1;
  }

  function updateDrive(dt, now) {
    // mix stick (jx/jy) + keyboard (kx/ky) + dedicated touch steer/gas/brake
    const jx = clamp(inp2.jx + inp2.kx + inp2.steer, -1, 1), jy = clamp(inp2.jy + inp2.ky, -1, 1);
    const throttle = clamp(Math.max(0, -jy) + inp2.gas, 0, 1), brake = clamp(Math.max(0, jy) + inp2.brake, 0, 1);
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
    const lim = 314;
    if (Math.hypot(nx, nz) > lim) { const d = Math.hypot(nx, nz); nx *= lim / d; nz *= lim / d; car.speed *= -0.2; }
    car.x = nx; car.z = nz;
    const yC = terrainAt(car.x, car.z);
    const yF = terrainAt(car.x + fx * 1.4, car.z + fz * 1.4), yB = terrainAt(car.x - fx * 1.4, car.z - fz * 1.4);
    const rxv = Math.cos(car.yaw), rzv = -Math.sin(car.yaw);
    const yR = terrainAt(car.x + rxv * 0.9, car.z + rzv * 0.9), yL = terrainAt(car.x - rxv * 0.9, car.z - rzv * 0.9);
    const pitch = Math.atan2(yB - yF, 2.8), roll = Math.atan2(yR - yL, 1.8);
    car.group.position.set(car.x, yC + 0.06, car.z);
    car.group.rotation.set(0, 0, 0);
    car.group.rotateY(car.yaw - Math.PI / 2);
    car.group.rotateZ(-pitch);
    car.group.rotateX(roll);
    const spin = car.speed * dt / 0.37;
    if (car.glb) {
      for (const w of car.wheelsGLB) w.rotation.x += spin;
    } else {
      for (const w of car.wheels) w.rotation.z -= spin;
      for (const f of car.fronts) f.rotation.y = car.steer * 1.6;
    }
    if (showT > 0) {
      // showcase orbit on entry; any input skips it
      showT -= dt;
      const a = car.yaw + 2.4 + (2.8 - showT) * 1.35;
      const cx2 = car.x + Math.sin(a) * 6.6, cz2 = car.z + Math.cos(a) * 6.6;
      camera.position.set(cx2, Math.max(yC + 1.7, terrainAt(cx2, cz2) + 1.2), cz2);
      camera.lookAt(car.x, yC + 0.7, car.z);
    } else if (camMode === 2) {
      const camT = new THREE.Vector3(car.x, yC + 52 * czoom, car.z);
      if (!camInit) { camV.copy(camT); camInit = true; }
      camV.lerp(camT, Math.min(1, dt * 5));
      camera.position.copy(camV);
      camera.up.set(fx, 0, fz); // heading-up top-down
      camera.lookAt(car.x, yC, car.z);
    } else {
      camera.up.set(0, 1, 0);
      if (now - camOrbit.t > 1400 && Math.abs(car.speed) > 2) camOrbit.yaw *= Math.exp(-dt * 2.2);
      const a = car.yaw + Math.PI + camOrbit.yaw;
      const dist = (camMode === 1 ? 14.5 : 9.4) * czoom, h = ((camMode === 1 ? 7.8 : 3.7) + camOrbit.pitch * 4.5) * Math.max(0.7, czoom);
      const camT = new THREE.Vector3(car.x + Math.sin(a) * dist, yC + h, car.z + Math.cos(a) * dist);
      const g = resolveCam(car.x, yC + 1.2, car.z, camT.x, camT.y, camT.z);
      if (g < 1) { camT.set(car.x + (camT.x - car.x) * g, yC + 1.2 + (camT.y - yC - 1.2) * g, car.z + (camT.z - car.z) * g); }
      if (!camInit) { camV.copy(camT); camInit = true; }
      camV.lerp(camT, Math.min(1, dt * 4.6));
      camV.y = Math.max(camV.y, terrainAt(camV.x, camV.z) + 1.3);
      camera.position.copy(camV);
      camera.lookAt(car.x, yC + 1.0, car.z);
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
  }

  // ---------- loop ----------
  const dirV = new THREE.Vector3();
  let prev = performance.now();
  let raf = 0;
  let disposed = false;
  function loop(now) {
    if (disposed) return;
    const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
    if (waterMat) waterMat.uniforms.uTime.value = now * 0.001; // flowing creek
    // roof animation
    const target = insideOpen ? 1 : 0;
    roofAnim += (target - roofAnim) * Math.min(1, dt * 5);
    if (house.roof) {
      house.roof.position.y = roofAnim * 9;
      house.roof.material.opacity = 1 - roofAnim * 0.92;
      house.roof.material.emissiveIntensity = 0.4 * (1 - roofAnim);
    }
    interiorGroup.visible = roofAnim > 0.04 || mode === 'explore';
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
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }

  // ---------- wire up ----------
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
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
  emit('carColor', CARSPECS[0].css);
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
    removeEventListener('keydown', onKeyDown);
    removeEventListener('keyup', onKeyUp);
    removeEventListener('resize', resize);
    if (window.visualViewport) {
      visualViewport.removeEventListener('resize', resize);
      visualViewport.removeEventListener('scroll', resize);
    }
    audio.engineStop();
    renderer.dispose();
    delete window.__dahill;
  }

  const api = {
    enterDrive, exitDrive, enterScoop, exitScoop,
    toggleInside: () => setInside(!insideOpen),
    toggleShiftLock: () => { shiftLock = !shiftLock; emit('shiftLock', shiftLock); },
    focusHouse, cycleCamera, toggleCarColor, dispose,
    get mode() { return mode; }
  };
  // tiny debug handle for headless verification + on-phone debugging
  window.__dahill = {
    api,
    state: () => ({
      mode, buildings: S.buildings.length,
      poops: POOPS.length, car: { x: +car.x.toFixed(1), z: +car.z.toFixed(1), speed: +car.speed.toFixed(1), glb: !!car.glb },
      char: { x: +CHAR.x.toFixed(1), z: +CHAR.z.toFixed(1), bag: CHAR.bag, total: CHAR.total, lvl: CHAR.lvl }
    })
  };
  return api;
}
