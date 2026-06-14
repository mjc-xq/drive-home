import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DracoShim } from './draco-shim.js';

// Maps the GLB's +Z length onto nose-forward +X. If a future model swap makes
// the chase cam show headlights instead of taillights, flip this.
export const CARYAW = -Math.PI / 2;

// Fixed-slot vehicle roster: index = the order the swap button cycles through,
// regardless of which GLB finishes loading first. credit feeds the car card;
// VEHICLES[0] also doubles as the fallback card when no GLB has loaded yet.
export const VEHICLES = [
  { slot: 0, name: 'GT-12 ROSSO', spec: '6.5L V12 · 620 HP · RWD', credit: 'Ferrari 458 · vicent091036' },
  { slot: 1, name: 'TRAIL XSE', spec: '2.5L HYBRID · AWD · COMPACT SUV', credit: 'Toyota RAV4' },
  { slot: 2, name: 'GLIDE LE', spec: '2.5L HYBRID · 8-SEAT MINIVAN', credit: 'Toyota Sienna' }
];

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
          car.paint.metalness = 0.6; car.paint.roughness = 0.32;
        }
        const gls = m.getObjectByName('glass');
        if (gls && gls.material) {
          gls.material.color.setHex(0x14181d);
          gls.material.transparent = true; gls.material.opacity = 0.94;
          gls.material.metalness = 0.6; gls.material.roughness = 0.1;
        }
        const wheels = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']
          .map(n => m.getObjectByName(n)).filter(Boolean);
        const inner = new THREE.Group();
        inner.rotation.y = CARYAW;
        inner.add(m);
        registerVehicle(car, inner, 0, VEHICLES[0]);
        if (car.models[0]) car.models[0].wheels = wheels;   // Ferrari wheels spin on X
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
  new GLTFLoader().load(url, g => {
    const grp = new THREE.Group();
    grp.add(normalizeCarGLB(g.scene, length, black));
    grp.position.set(x, y, z);
    grp.rotation.y = yaw + (flip ? Math.PI : 0);   // some GLBs' nose runs the opposite way
    parent.add(grp);
    if (onReady) onReady(grp);
  }, undefined, err => console.warn('parked car failed', url, err));
}

// ---- Drivable vehicle roster ------------------------------------------------
// Each driven model is one group parented under car.group, stored at a FIXED
// slot so cycle order is stable no matter which GLB resolves first. Exactly one
// model (or, until any loads, the procedural fallback) is visible at a time.
function registerVehicle(car, group, slot, meta) {
  group.visible = false;
  car.group.add(group);
  car.models[slot] = { group, ...meta };
  // retire the procedural fallback meshes the moment any real model arrives
  for (const ch of car.group.children) {
    if (!car.models.some(m => m && m.group === ch)) ch.visible = false;
  }
  // until the user picks, show the lowest loaded slot (Ferrari if present)
  if (!car.userPicked) {
    const first = car.models.findIndex(Boolean);
    if (first < 0) return;                          // unreachable (slot just set), but never deref [-1]
    car.modelIdx = first;
    for (const m of car.models) if (m) m.group.visible = false;
    car.models[first].group.visible = true;
  }
}

// Advance to the next loaded vehicle; returns its meta (or null if none loaded).
export function cycleVehicle(car) {
  const loaded = car.models.map((m, i) => (m ? i : -1)).filter(i => i >= 0);
  if (!loaded.length) return null;
  car.userPicked = true;
  const next = loaded[(loaded.indexOf(car.modelIdx) + 1) % loaded.length];
  car.modelIdx = next;
  for (const m of car.models) if (m) m.group.visible = false;
  car.models[next].group.visible = true;
  return car.models[next];
}

// Load a plain (non-Draco) car GLB as a swappable DRIVEN vehicle: normalize to
// ~`length` m, centre on the origin sitting on the ground, optionally paint it
// near-black, rotate its nose to +X (`spin`, default CARYAW), and register it at
// `slot`. Fails soft — the roster simply keeps whatever else loaded.
export function loadDrivableCar(car, url, slot, opts = {}) {
  const { length = 4.6, black = true, flip = false, meta = {} } = opts;
  const spin = CARYAW + (flip ? Math.PI : 0);     // +180° if the GLB's nose runs -Z
  new GLTFLoader().load(url, g => {
    const inner = new THREE.Group();
    inner.rotation.y = spin;
    inner.add(normalizeCarGLB(g.scene, length, black));
    registerVehicle(car, inner, slot, meta);
  }, undefined, err => console.warn('drivable car failed', url, err));
}
