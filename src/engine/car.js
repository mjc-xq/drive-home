import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DracoShim } from './draco-shim.js';

// Maps the GLB's +Z length onto nose-forward +X. If a future model swap makes
// the chase cam show headlights instead of taillights, flip this.
export const CARYAW = -Math.PI / 2;

// Fixed-slot vehicle roster: index = the order the swap button cycles through,
// regardless of which GLB finishes loading first. credit feeds the car card;
// VEHICLES[0] also doubles as the fallback card when no GLB has loaded yet.
// Order = the cycle order; slot 0 is the DEFAULT driven vehicle (the minivan).
// profile: per-car handling — accel (pull), top (×maxF), grip (steer authority +
// drift recovery), slip (how easily the tail steps out). Read in updateDrive.
export const VEHICLES = [
  { slot: 0, name: 'Toyota Granvia', spec: '2.5L HYBRID · 189 HP · 8-SEAT MINIVAN', credit: 'model: Sketchfab', profile: { accel: 0.85, top: 0.82, grip: 1.35, slip: 0.4 } },
  { slot: 1, name: 'Toyota RAV4', spec: '2.5L HYBRID · AWD · COMPACT SUV', credit: '', profile: { accel: 1.0, top: 0.92, grip: 1.1, slip: 0.7 } },
  { slot: 2, name: 'Ferrari 458', spec: '4.5L V8 · 562 HP · RWD', credit: 'model: vicent091036', profile: { accel: 1.35, top: 1.0, grip: 0.9, slip: 1.1 } },
  { slot: 3, name: 'Mustang Shelby GT500', spec: '5.2L SUPERCHARGED V8 · 760 HP', credit: 'model: Sketchfab', profile: { accel: 1.3, top: 0.97, grip: 0.9, slip: 1.05 } },
  { slot: 4, name: 'Mini Cooper S', spec: '2.0L TURBO · GO-KART HANDLING', credit: 'model: Sketchfab', profile: { accel: 1.1, top: 0.82, grip: 1.4, slip: 0.65 } },
  { slot: 5, name: 'Corvette Stingray', spec: 'LEGO TECHNIC · 6.2L V8 VIBES', credit: 'model: Sketchfab', profile: { accel: 1.25, top: 0.92, grip: 1.05, slip: 0.95 } },
  { slot: 6, name: 'Rolls-Royce Dawn', spec: '6.6L V12 · LUXURY CRUISER', credit: 'model: Sketchfab', profile: { accel: 0.8, top: 0.88, grip: 1.25, slip: 0.45 } },
  { slot: 7, name: 'SCG 004CS', spec: 'TWIN-TURBO V8 · TRACK WEAPON', credit: 'model: Sketchfab', profile: { accel: 1.4, top: 1.0, grip: 1.0, slip: 1.0 } },
  { slot: 8, name: 'Pininfarina Battista', spec: '1900 HP · ELECTRIC HYPERCAR', credit: 'model: Sketchfab', profile: { accel: 1.55, top: 1.15, grip: 0.95, slip: 1.1 } },
  // Newer additions — loaded LAZILY (only fetched when picked from the garage), so they never
  // weigh down a session where they're not driven.
  { slot: 9, name: 'Lamborghini Murciélago', spec: '6.2L V12 · AWD · 580 HP', credit: 'model: Sketchfab', profile: { accel: 1.35, top: 1.02, grip: 1.05, slip: 0.95 } },
  { slot: 10, name: 'Jiotto Caspita', spec: 'F1-DERIVED · GROUP-C V12', credit: 'model: alex.ka', profile: { accel: 1.45, top: 1.05, grip: 1.0, slip: 1.0 } },
  { slot: 11, name: "'65 Mustang Convertible", spec: 'CLASSIC PONY · 4.7L V8 · RWD', credit: 'model: Sketchfab', profile: { accel: 1.05, top: 0.85, grip: 0.85, slip: 1.15 } },
  { slot: 12, name: "'65 Mini Cooper S", spec: 'CLASSIC · 1.3L · GO-KART', credit: 'model: Sketchfab', profile: { accel: 0.9, top: 0.7, grip: 1.45, slip: 0.6 } },
  { slot: 13, name: 'Hot Rod Coupe', spec: 'CHOPPED · BIG-BLOCK V8', credit: 'model: Sketchfab', profile: { accel: 1.2, top: 0.9, grip: 0.85, slip: 1.2 } },
  { slot: 14, name: 'Rat Rod', spec: 'BARE-METAL · BLOWN V8', credit: 'model: Sketchfab', profile: { accel: 1.25, top: 0.88, grip: 0.8, slip: 1.25 } }
];

function liftVehicleMaterials(scene, lift = 0.22) {
  scene.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      const nm = ((m.name || '') + (o.name || '')).toLowerCase();
      if (/glass|window|light|tail|head|lamp|mirror|chrome|plate|signal|amber/.test(nm)) continue;
      if (m.emissive && m.color) {
        m.emissive.copy(m.color).multiplyScalar(lift);
        m.emissiveIntensity = Math.max(m.emissiveIntensity || 0, 0.24);
      }
      if (m.metalness !== undefined) m.metalness = Math.min(m.metalness, 0.42);
      if (m.roughness !== undefined) m.roughness = Math.max(m.roughness, 0.36);
    }
  });
}

// Procedural supercar — stays in the scene as the fallback if the GLB fails.
export function createCar(scene) {
  const car = { x: 0, z: 0, yaw: 0, speed: 0, steer: 0, group: new THREE.Group(), wheels: [], fronts: [], bodyMat: null, models: [], modelIdx: 0, userPicked: false };
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe02818, metalness: .45, roughness: .26 });
  car.bodyMat = bodyMat;
  const carbon = new THREE.MeshStandardMaterial({ color: 0x141518, metalness: .3, roughness: .5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0c0e12, metalness: .5, roughness: .08 });
  const s = new THREE.Shape();
  s.moveTo(2.32, 0.10);
  s.quadraticCurveTo(2.44, 0.26, 2.2, 0.44);
  s.quadraticCurveTo(1.3, 0.64, 0.0, 0.74);
  s.quadraticCurveTo(-1.3, 0.83, -2.16, 0.84);
  s.quadraticCurveTo(-2.38, 0.62, -2.3, 0.34);
  s.lineTo(-2.12, 0.16); s.lineTo(1.95, 0.12); s.closePath();
  const hull = new THREE.ExtrudeGeometry(s, { depth: 1.84, curveSegments: 10, bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.09, bevelSegments: 3 });
  hull.translate(0, 0, -0.92);
  const hullM = new THREE.Mesh(hull, bodyMat); hullM.castShadow = true; car.group.add(hullM);
  const c = new THREE.Shape();
  c.moveTo(0.95, 0.60);
  c.quadraticCurveTo(0.45, 0.98, 0.1, 1.06);
  c.quadraticCurveTo(-0.3, 1.11, -0.6, 1.08);
  c.quadraticCurveTo(-1.0, 0.96, -1.18, 0.72);
  c.closePath();
  const can = new THREE.ExtrudeGeometry(c, { depth: 1.38, curveSegments: 8, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2 });
  can.translate(0, 0, -0.69);
  const canM = new THREE.Mesh(can, glass); canM.castShadow = true; car.group.add(canM);
  for (let i = 0; i < 3; i++) {
    const lv = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.035, 1.2), carbon);
    lv.position.set(-1.32 - i * 0.24, 0.85, 0); car.group.add(lv);
  }
  for (const [fx, fz] of [[1.42, 0.96], [1.42, -0.96], [-1.38, 1.0], [-1.38, -1.0]]) {
    const fl = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.3, 0.18), bodyMat);
    fl.position.set(fx, 0.52, fz); car.group.add(fl);
  }
  const sp = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.05, 2.02), carbon);
  sp.position.set(2.05, 0.10, 0); car.group.add(sp);
  const df = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 1.78), carbon);
  df.position.set(-2.06, 0.18, 0); car.group.add(df);
  for (const z of [-0.5, 0, 0.5]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.22, 0.03), carbon);
    fin.position.set(-2.06, 0.18, z); car.group.add(fin);
  }
  for (const sgn of [1, -1]) {
    const rk = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.14, 0.1), carbon);
    rk.position.set(0, 0.16, 1.0 * sgn); car.group.add(rk);
    const intake = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.34, 0.1), carbon);
    intake.rotation.y = 0.18 * sgn;
    intake.position.set(-0.78, 0.52, 0.99 * sgn); car.group.add(intake);
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.16),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdde6f2, emissiveIntensity: .9 }));
    hl.rotation.y = -0.5 * sgn; hl.position.set(2.16, 0.5, 0.6 * sgn); car.group.add(hl);
    const mr = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.18), bodyMat);
    mr.position.set(0.78, 0.78, 1.02 * sgn); car.group.add(mr);
    const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.16, 8), carbon);
    ex.rotation.z = Math.PI / 2; ex.position.set(-2.3, 0.3, 0.3 * sgn); car.group.add(ex);
  }
  const tl = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 1.9),
    new THREE.MeshStandardMaterial({ color: 0x3a0000, emissive: 0xc11a0a, emissiveIntensity: 0.75 }));
  tl.position.set(-2.31, 0.64, 0); car.group.add(tl);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 1.96), bodyMat);
  wing.position.set(-2.0, 1.06, 0); car.group.add(wing);
  for (const sgn of [1, -1]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.26, 0.04), carbon);
    ep.position.set(-2.0, 0.93, 0.94 * sgn); car.group.add(ep);
  }
  const tireG = new THREE.CylinderGeometry(0.37, 0.37, 0.32, 22); tireG.rotateX(Math.PI / 2);
  const ringG = new THREE.CylinderGeometry(0.22, 0.22, 0.33, 12); ringG.rotateX(Math.PI / 2);
  const spokeG = new THREE.BoxGeometry(0.07, 0.36, 0.34);
  const tireM = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: .85 });
  const rimM = new THREE.MeshStandardMaterial({ color: 0xc6cbd3, metalness: .9, roughness: .25 });
  for (const [wx, wz, front] of [[1.42, 0.86, 1], [1.42, -0.86, 1], [-1.38, 0.9, 0], [-1.38, -0.9, 0]]) {
    const grp = new THREE.Group(); grp.position.set(wx, 0.37, wz);
    const spinner = new THREE.Group();
    spinner.add(new THREE.Mesh(tireG, tireM));
    spinner.add(new THREE.Mesh(ringG, rimM));
    for (let i = 0; i < 5; i++) {
      const sk = new THREE.Mesh(spokeG, rimM);
      sk.rotation.z = i * Math.PI * 2 / 5; spinner.add(sk);
    }
    spinner.children[0].castShadow = true;
    grp.add(spinner);
    car.group.add(grp); car.wheels.push(spinner);
    if (front) car.fronts.push(grp);
  }
  car.group.visible = false;
  scene.add(car.group);
  return car;
}

// Swap in the real Ferrari 458 (Draco GLB decoded on the main thread by
// DracoShim). On ANY failure — load error, decode error, hang, or a post-resolve
// throw on a malformed-but-resolved GLB — the procedural car stays and
// onFallback fires exactly once so the UI can toast. Returns a canceller the
// engine calls on dispose so a late load/timeout can't touch a torn-down scene.
export function loadRealCar(car, url, onFallback) {
  let settled = false;
  const fail = err => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    console.warn('car model failed, using fallback', err);
    if (onFallback) onFallback(err);
  };
  // r128's GLTFLoader never rejects when the draco callback doesn't fire, so a
  // decode failure would otherwise hang silently with no fallback toast.
  const timer = setTimeout(() => fail(new Error('car model load timed out')), 20000);
  try {
    DracoShim.onError = e => fail(e);
    const gl = new GLTFLoader();
    gl.setDRACOLoader(DracoShim);
    gl.load(url, g => {
      if (settled) return;
      try {
        const m = g.scene;
        if (!m) throw new Error('car GLB resolved with no scene');
        m.traverse(o => { if (o.isMesh) o.castShadow = true; });
        const body = m.getObjectByName('body');
        if (body && body.material) {
          car.paint = body.material;
          car.paint.color.setHex(0xe02818);
          car.paint.metalness = 0.45; car.paint.roughness = 0.32;   // less mirror-like → the body's own colour reads brighter against bright photoreal tiles
        }
        const gls = m.getObjectByName('glass');
        if (gls && gls.material) {
          gls.material.color.setHex(0x14181d);
          gls.material.transparent = true; gls.material.opacity = 0.94;
          gls.material.metalness = 0.6; gls.material.roughness = 0.1;
        }
        const wheels = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']
          .map(n => m.getObjectByName(n)).filter(Boolean);
        liftVehicleMaterials(m, 0.24);
        const inner = new THREE.Group();
        inner.rotation.y = CARYAW;
        inner.add(m);
        registerVehicle(car, inner, 2, VEHICLES[2]);        // Ferrari is slot 2 now
        if (car.models[2]) car.models[2].wheels = wheels;   // Ferrari wheels spin on X
        car.glb = true;
        settled = true;                                     // last: a throw above still hits fallback
        clearTimeout(timer);
      } catch (e) { fail(e); }
    }, undefined, err => fail(err));
  } catch (e) { fail(e); }
  return () => { settled = true; clearTimeout(timer); };
}

// Normalize a plain car GLB scene in place: scale so its longest horizontal axis
// is ~`length` m, sit it on the ground centred on the origin, and (optionally)
// paint it near-black skipping glass/lights/chrome. Returns the same scene so it
// can be wrapped and placed. Shared by the parked + drivable Toyota loaders.
function normalizeCarGLB(scene, length, black) {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene), size = new THREE.Vector3();
  box.getSize(size);
  const s = length / (Math.max(size.x, size.z) || 1);
  scene.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true;
    if (!black || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      const nm = ((m.name || '') + (o.name || '')).toLowerCase();
      if (m.color && !/glass|light|tail|head|lamp|mirror|chrome|window|plate|signal|amber/.test(nm)) {
        m.color.setHex(0x17191d);
        if (m.metalness !== undefined) m.metalness = 0.45;
        if (m.roughness !== undefined) m.roughness = 0.5;
      }
    }
  });
  scene.scale.setScalar(s);
  scene.position.set(-(box.min.x + box.max.x) / 2 * s, -box.min.y * s, -(box.min.z + box.max.z) / 2 * s);
  return scene;
}

// Load a plain (non-Draco) car GLB (RAV4 / Sienna) as a static prop, normalize
// it, and place it at (x,y,z)+yaw under `parent`. onReady fires only on success
// (so the caller can add a footprint collider only when the car actually exists).
export function loadParkedCar(parent, url, opts = {}, onReady) {
  const { x = 0, y = 0, z = 0, yaw = 0, length = 4.6, black = true, flip = false } = opts;
  let cancelled = false;
  new GLTFLoader().load(url, g => {
    if (cancelled) return;
    const grp = new THREE.Group();
    grp.add(normalizeCarGLB(g.scene, length, black));
    grp.position.set(x, y, z);
    grp.rotation.y = yaw + (flip ? Math.PI : 0);   // some GLBs' nose runs the opposite way
    parent.add(grp);
    if (onReady) onReady(grp);
  }, undefined, err => { if (!cancelled) console.warn('parked car failed', url, err); });
  return () => { cancelled = true; };
}

// ---- Drivable vehicle roster ------------------------------------------------
// Each driven model is one group parented under car.group, stored at a FIXED
// slot so cycle order is stable no matter which GLB resolves first. Exactly one
// model (or, until any loads, the procedural fallback) is visible at a time.

// Hide the procedural FALLBACK meshes — every car.group child that isn't a
// registered model group (createCar adds the placeholder supercar as loose
// meshes straight under car.group). This is the single guarantee that the red
// placeholder never lingers BENEATH a real car: it must run on EVERY path that
// reveals a model — first load, the slow-default reveal-timeout, AND every user
// swap — not just the first registerVehicle (the bug was that swaps skipped it).
function retireFallback(car) {
  for (const ch of car.group.children) {
    if (!car.models.some(m => m && m.group === ch)) ch.visible = false;
  }
}
// Show exactly one model group (and retire the fallback), hiding all others.
function showOnly(car, slot) {
  retireFallback(car);
  for (const m of car.models) if (m) m.group.visible = false;
  car.models[slot].group.visible = true;
}

function registerVehicle(car, group, slot, meta) {
  group.visible = false;
  car.group.add(group);
  car.models[slot] = { group, ...meta };
  // A car the player asked for while it was still loading (lazy garage pick) wins as soon as it
  // arrives — show it and mark the choice made.
  if (car.pendingPick === slot) { car.userPicked = true; car.modelIdx = slot; showOnly(car, slot); car.pendingPick = null; return; }
  // until the user picks, show the DEFAULT slot (random per session — car.defaultSlot). Hold the
  // reveal until the default arrives so the player never sees a wrong car flash in first; the
  // engine clears `heldForDefault` after a short fallback timeout so a slow/failed default still
  // ends up showing whatever loaded.
  if (!car.userPicked) {
    const def = car.defaultSlot || 0;
    if (car.heldForDefault && slot !== def && !car.models[def]) return;
    const first = (car.heldForDefault && car.models[def]) ? def : car.models.findIndex(Boolean);
    if (first < 0) return;                          // unreachable (slot just set), but never deref [-1]
    car.modelIdx = first;
    showOnly(car, first);
    car.heldForDefault = false;
  }
}

// Pick a specific loaded vehicle by slot (for the car picker menu).
export function setVehicle(car, slot) {
  if (!car.models[slot]) return null;
  car.userPicked = true;
  car.modelIdx = slot;
  showOnly(car, slot);
  return car.models[slot];
}
// Roster snapshot for the picker UI: every known vehicle + whether it's loaded/current.
export function vehicleList(car) {
  return VEHICLES.map(v => ({ slot: v.slot, name: v.name, spec: v.spec, credit: v.credit, loaded: !!car.models[v.slot], current: car.modelIdx === v.slot }));
}

// Advance to the next loaded vehicle; returns its meta (or null if none loaded).
export function cycleVehicle(car) {
  const loaded = car.models.map((m, i) => (m ? i : -1)).filter(i => i >= 0);
  if (!loaded.length) return null;
  car.userPicked = true;
  const next = loaded[(loaded.indexOf(car.modelIdx) + 1) % loaded.length];
  car.modelIdx = next;
  showOnly(car, next);
  return car.models[next];
}

// Load a plain (non-Draco) car GLB as a swappable DRIVEN vehicle: normalize to
// ~`length` m, centre on the origin sitting on the ground, optionally paint it
// near-black, rotate its nose to +X (`spin`, default CARYAW), and register it at
// `slot`. Fails soft — the roster simply keeps whatever else loaded.
// Load + normalize a car GLB into a reusable PROTOTYPE group (nose at +Z, sat on the
// ground) for AMBIENT TRAFFIC — the engine clone()s it across many cars (shared
// geometry/materials, cheap). onReady(group) fires on success only.
export function loadCarProto(url, length, flip, onReady) {
  let cancelled = false;
  const gl = new GLTFLoader(); gl.setDRACOLoader(DracoShim);
  gl.load(url, g => {
    if (cancelled) return;
    const inner = new THREE.Group();
    inner.rotation.y = flip ? Math.PI : 0;          // face nose +Z (traffic groups rotate by atan2(dx,dz))
    inner.add(normalizeCarGLB(g.scene, length, false));
    onReady(inner);
  }, undefined, err => { if (!cancelled) console.warn('traffic model failed', url, err); });
  return () => { cancelled = true; };
}

export function loadDrivableCar(car, url, slot, opts = {}) {
  const { length = 4.6, black = true, flip = false, meta = {}, onReady } = opts;
  const spin = CARYAW + (flip ? Math.PI : 0);     // +180° if the GLB's nose runs -Z
  let cancelled = false;
  const gl = new GLTFLoader();
  gl.setDRACOLoader(DracoShim);                   // decode Draco-compressed GLBs (e.g. the Granvia)
  gl.load(url, g => {
    if (cancelled) return;
    const inner = new THREE.Group();
    inner.rotation.y = spin;
    const model = normalizeCarGLB(g.scene, length, black);
    liftVehicleMaterials(model, black ? 0.16 : 0.22);
    inner.add(model);
    registerVehicle(car, inner, slot, meta);
    if (onReady) onReady(slot);
  }, undefined, err => { if (!cancelled) { console.warn('drivable car failed', url, err); if (onReady) onReady(slot, err); } });
  return () => { cancelled = true; };
}
