import * as THREE from 'three';
import { merge, critterBuilder, makeRand } from './geom.js';
import { clamp } from './coords.js';
import { loadPigPrototype, loadPoopGeometry } from './models.js';
import { loadDrew } from './drew.js';
import { loadCeceController } from './cece.js';
import pigUrl from '../assets/pig.glb';
import poopUrl from '../assets/poop.glb';

// Facing correction for the GLB pig (radians). Tune if the model drives
// sideways/backwards relative to its motion.
const PIG_YAW = Math.PI / 2;

export const TOOLS = [
  { name: '🥄 Trowel', r: 1.6, cap: 16 },
  { name: '🥄 Big Scoop', r: 2.3, cap: 32 },
  { name: '🦾 MEGA Shovel', r: 3.2, cap: 80 }
];

// Pure progression rule: lifetime total scooped unlocks bigger tools.
export function toolAfterScoop(lvl, total) {
  if (lvl === 0 && total >= 12) return 1;
  if (lvl === 1 && total >= 35) return 2;
  return lvl;
}

// Two instanced pools of POOP_MAX; spawning stops 2 short of the combined cap.
export const POOP_MAX = 34;
export const POOP_ACTIVE_CAP = POOP_MAX * 2 - 2;

const critterMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9 });

function buildPig() {
  const b = critterBuilder();
  const BLACK = 0x29241f, DARK = 0x1b1815, PINK = 0x9c7068;
  b.add(new THREE.SphereGeometry(0.46, 14, 10), 0, 0.52, 0, BLACK, 0, 0, 0, 1.32, 0.96, 1.04); // round belly
  b.add(new THREE.SphereGeometry(0.27, 12, 9), 0.64, 0.56, 0, BLACK);                          // head
  b.add(new THREE.CylinderGeometry(0.10, 0.125, 0.16, 10), 0.88, 0.5, 0, BLACK, 0, 0, Math.PI / 2);   // snout
  b.add(new THREE.CylinderGeometry(0.098, 0.098, 0.025, 10), 0.965, 0.5, 0, PINK, 0, 0, Math.PI / 2); // snout disc
  b.add(new THREE.ConeGeometry(0.09, 0.22, 7), 0.6, 0.82, 0.15, BLACK, -0.45, 0, -0.55);       // ears
  b.add(new THREE.ConeGeometry(0.09, 0.22, 7), 0.6, 0.82, -0.15, BLACK, 0.45, 0, -0.55);
  for (const [lx, lz] of [[0.32, 0.21], [0.32, -0.21], [-0.34, 0.21], [-0.34, -0.21]])
    b.add(new THREE.CylinderGeometry(0.062, 0.082, 0.36, 9), lx, 0.17, lz, DARK);              // legs
  b.add(new THREE.TorusGeometry(0.075, 0.025, 6, 12, 4.6), -0.64, 0.6, 0, BLACK, 0, Math.PI / 2, 0); // curly tail
  return b.build();
}

// Smooth-shaded duck (same treatment as the pigs — was a box stack before).
function buildDuck() {
  const b = critterBuilder();
  const WHT = 0xf2efe6, CRM = 0xe6e2d4, ORG = 0xe08a28, EYE = 0x1b1815;
  b.add(new THREE.SphereGeometry(0.22, 12, 9), 0, 0.26, 0, WHT, 0, 0, 0, 1.5, 1.0, 1.05);        // body
  b.add(new THREE.SphereGeometry(0.16, 10, 8), -0.26, 0.34, 0, CRM, 0, 0, 0.7, 1.1, 0.7, 0.8);   // tail puff, tilted up
  b.add(new THREE.CylinderGeometry(0.045, 0.06, 0.16, 8), 0.24, 0.42, 0, WHT, 0, 0, -0.5);       // neck
  b.add(new THREE.SphereGeometry(0.105, 10, 8), 0.3, 0.52, 0, WHT);                              // head
  b.add(new THREE.ConeGeometry(0.05, 0.16, 8), 0.43, 0.5, 0, ORG, 0, 0, -Math.PI / 2);           // beak
  b.add(new THREE.SphereGeometry(0.018, 6, 5), 0.345, 0.555, 0.065, EYE);
  b.add(new THREE.SphereGeometry(0.018, 6, 5), 0.345, 0.555, -0.065, EYE);
  for (const s of [1, -1])
    b.add(new THREE.SphereGeometry(0.12, 10, 8), -0.02, 0.27, 0.16 * s, CRM, 0, 0, 0, 1.35, 0.55, 0.5); // wings
  for (const s of [1, -1])
    b.add(new THREE.BoxGeometry(0.1, 0.03, 0.09), 0.04, 0.015, 0.07 * s, ORG);                   // feet
  return b.build();
}

// Smooth-shaded iguana with tapering tail and dorsal crest.
function buildIguana() {
  const b = critterBuilder();
  const GRN = 0x5f8f3e, LITE = 0x6f9d4a, DRK = 0x4c7634, BELLY = 0x8aa45c, EYE = 0x1b1815;
  b.add(new THREE.SphereGeometry(0.14, 12, 9), 0, 0.13, 0, GRN, 0, 0, 0, 2.3, 0.8, 1.0);         // body
  b.add(new THREE.SphereGeometry(0.085, 10, 8), 0.38, 0.16, 0, LITE, 0, 0, 0, 1.5, 0.85, 0.9);   // head
  b.add(new THREE.SphereGeometry(0.05, 8, 6), 0.5, 0.13, 0, LITE, 0, 0, 0, 1.4, 0.7, 0.8);       // snout
  b.add(new THREE.SphereGeometry(0.045, 8, 6), 0.36, 0.09, 0, BELLY, 0, 0, 0, 1.0, 1.1, 0.8);    // dewlap
  b.add(new THREE.SphereGeometry(0.016, 6, 5), 0.43, 0.2, 0.05, EYE);
  b.add(new THREE.SphereGeometry(0.016, 6, 5), 0.43, 0.2, -0.05, EYE);
  b.add(new THREE.CylinderGeometry(0.045, 0.07, 0.34, 8), -0.46, 0.11, 0, GRN, 0, 0, Math.PI / 2);   // tail base
  b.add(new THREE.CylinderGeometry(0.022, 0.045, 0.34, 8), -0.78, 0.1, 0, DRK, 0, 0, Math.PI / 2);   // tail mid
  b.add(new THREE.CylinderGeometry(0.006, 0.022, 0.3, 6), -1.08, 0.09, 0, DRK, 0, 0, Math.PI / 2);   // tail tip
  for (let i = 0; i < 6; i++)
    b.add(new THREE.ConeGeometry(0.022, 0.07 - i * 0.006, 5), 0.26 - i * 0.11, 0.245 - i * 0.012, 0, DRK); // crest
  for (const [lx, lz] of [[0.2, 0.13], [0.2, -0.13], [-0.2, 0.13], [-0.2, -0.13]])
    b.add(new THREE.CylinderGeometry(0.022, 0.03, 0.12, 6), lx, 0.06, lz * 1.25, GRN, lz > 0 ? -0.5 : 0.5, 0, 0); // legs
  return b.build();
}

export function createAnimals(scene, { terrainAt, SREC, bldBoxes = [], onPoopChange }) {
  const rand = makeRand(8341);
  const pigGeo = buildPig(), duckGeo = buildDuck(), iguanaGeo = buildIguana();
  const ANIMALS = [];

  function spawnAnimal(kind, geo, hx, hz, wanderR, speed, scale) {
    const m = new THREE.Mesh(geo, critterMat);
    m.castShadow = true; m.scale.set(scale, scale, scale);
    scene.add(m);
    const a = {
      kind, mesh: m, scale, hx, hz, x: hx, z: hz, tx: hx, tz: hz, yaw: rand() * 6.28,
      wanderR, speed, wait: rand() * 3, bob: rand() * 6.28, poopT: 5 + rand() * 10, r: 0.55 * scale
    };
    ANIMALS.push(a);
    return a;
  }

  for (let i = 0; i < 5; i++) {
    const a = spawnAnimal('pig', pigGeo, SREC.pen[0] + (rand() - 0.5) * 7, SREC.pen[1] + (rand() - 0.5) * 5, 5.5, 0.55, 0.95 + rand() * 0.35);
    a.hx = SREC.pen[0]; a.hz = SREC.pen[1];
  }
  for (let i = 0; i < 2; i++) {
    // home/spawn clear of the coop's collision box (+z is its open, door side)
    const a = spawnAnimal('duck', duckGeo, SREC.coop[0] + (rand() - 0.5) * 3, SREC.coop[1] + 3 + (rand() - 0.5) * 2, 4.5, 0.8, 1);
    a.hx = SREC.coop[0]; a.hz = SREC.coop[1] + 2.8;
  }
  {
    // bask in the open yard on the shed's door side (away from the house)
    const a = spawnAnimal('iguana', iguanaGeo, SREC.shed[0] - 1.6, SREC.shed[1] - 1.4, 1.5, 0.22, 1);
    a.hx = SREC.shed[0] - 1.6; a.hz = SREC.shed[1] - 1.4; a.poopT = 20 + rand() * 15;
  }

  // Swap the procedural pigs for the black GLB pig once it loads (fallback
  // stays on failure). Each pig keeps its own scale; the inner mesh carries the
  // model-facing correction so the group can still steer by yaw.
  loadPigPrototype(pigUrl, PIG_YAW, proto => {
    for (const a of ANIMALS) {
      if (a.kind !== 'pig') continue;
      scene.remove(a.mesh);
      const grp = new THREE.Group();
      grp.add(proto.clone());
      grp.scale.setScalar(a.scale);
      scene.add(grp);
      a.mesh = grp;
    }
  });

  // --- poop: two instanced pools because r128 per-instance color is unreliable ---
  const poopGeoB = new THREE.IcosahedronGeometry(0.26, 0); poopGeoB.scale(1, 0.62, 1);
  const poopBrown = new THREE.InstancedMesh(poopGeoB, new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 }), POOP_MAX);
  const poopPale = new THREE.InstancedMesh(poopGeoB, new THREE.MeshStandardMaterial({ color: 0xb9bda4, roughness: 1 }), POOP_MAX);
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < POOP_MAX; i++) { poopBrown.setMatrixAt(i, ZERO); poopPale.setMatrixAt(i, ZERO); }
  poopBrown.instanceMatrix.needsUpdate = poopPale.instanceMatrix.needsUpdate = true;
  scene.add(poopBrown, poopPale);
  // Swap both pools to the emoji-poop GLB once it loads (existing per-instance
  // transforms are preserved). The merged geometry carries its own face colors.
  loadPoopGeometry(poopUrl, (geo, mat) => {
    for (const m of [poopBrown, poopPale]) { m.geometry = geo; m.material = mat; }
  });
  const POOPS = [];
  const VANISH = [];        // poops mid scoop-pop animation (idx still reserved)
  const poopM = new THREE.Matrix4();

  function spawnPoop(a) {
    if (POOPS.length >= POOP_ACTIVE_CAP) return;
    const pale = a.kind === 'duck';
    const mesh = pale ? poopPale : poopBrown;
    let idx = -1;
    // skip indices still in use by a live poop OR one mid-vanish (else the pop
    // animation would fight a freshly spawned poop on the same instance slot)
    const used = [...POOPS, ...VANISH].filter(p => p.mesh === mesh).map(p => p.idx);
    for (let i = 0; i < POOP_MAX; i++) if (used.indexOf(i) < 0) { idx = i; break; }
    if (idx < 0) return;
    const x = a.x - Math.sin(a.yaw) * 0.55, z = a.z - Math.cos(a.yaw) * 0.55;
    const s = a.kind === 'pig' ? 1.25 : a.kind === 'iguana' ? 0.9 : 0.6;
    const y = terrainAt(x, z) + 0.12 * s;
    poopM.makeScale(s, s, s); poopM.setPosition(x, y, z);
    mesh.setMatrixAt(idx, poopM); mesh.instanceMatrix.needsUpdate = true;
    POOPS.push({ mesh, idx, x, z, s, y });
    if (onPoopChange) onPoopChange();
  }

  // Scoop juice: a quick squash-pop (scale up then poof to 0 with a hop) instead
  // of snapping the instance to scale 0 — the core reward verb gets real feedback.
  function removePoop(p) {
    POOPS.splice(POOPS.indexOf(p), 1);
    VANISH.push({ mesh: p.mesh, idx: p.idx, x: p.x, z: p.z, y: p.y, s: p.s || 0.8, t: 0 });
    if (onPoopChange) onPoopChange();
  }
  function tickVanish(dt) {
    for (let i = VANISH.length - 1; i >= 0; i--) {
      const v = VANISH[i]; v.t += dt;
      const k = v.t / 0.16;
      if (k >= 1) { v.mesh.setMatrixAt(v.idx, ZERO); v.mesh.instanceMatrix.needsUpdate = true; VANISH.splice(i, 1); continue; }
      const m = k < 0.3 ? 1 + (k / 0.3) * 0.45 : 1.45 * (1 - (k - 0.3) / 0.7);  // 1 -> 1.45 -> 0
      const sc = v.s * Math.max(0, m);
      poopM.makeScale(sc, sc, sc); poopM.setPosition(v.x, v.y + Math.sin(k * Math.PI) * 0.35, v.z);
      v.mesh.setMatrixAt(v.idx, poopM); v.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function updateAnimals(dt, now) {
    if (VANISH.length) tickVanish(dt);   // scoop-pop animations
    for (const a of ANIMALS) {
      if (a.wait > 0) { a.wait -= dt; }
      else {
        const dx = a.tx - a.x, dz = a.tz - a.z, d = Math.hypot(dx, dz);
        if (d < 0.15) {
          a.wait = 1 + rand() * 4;
          const ang = rand() * 6.28, rr = rand() * a.wanderR;
          a.tx = a.hx + Math.cos(ang) * rr; a.tz = a.hz + Math.sin(ang) * rr;
        } else {
          const want = Math.atan2(dx, dz);
          let dy = want - a.yaw; while (dy > Math.PI) dy -= 6.283; while (dy < -Math.PI) dy += 6.283;
          a.yaw += clamp(dy, -2.4 * dt, 2.4 * dt);
          a.x += Math.sin(a.yaw) * a.speed * dt; a.z += Math.cos(a.yaw) * a.speed * dt;
        }
      }
      a.bob += dt * (a.wait > 0 ? 2 : 7);
      const y = terrainAt(a.x, a.z);
      a.mesh.position.set(a.x, y + 0.02 + (a.wait > 0 ? 0 : Math.abs(Math.sin(a.bob)) * 0.04), a.z);
      a.mesh.rotation.y = a.yaw - Math.PI / 2;
      a.poopT -= dt;
      if (a.poopT <= 0) {
        spawnPoop(a);
        a.poopT = a.kind === 'pig' ? 9 + rand() * 11 : a.kind === 'duck' ? 8 + rand() * 10 : 26 + rand() * 18;
      }
    }
    resolveCritters();
  }

  // Keep the (now chunky) pigs out of their barn and from piling into each
  // other. Pigs push off any structure box; every critter separates from peers.
  function resolveCritters() {
    for (const a of ANIMALS) {
      if (a.kind === 'iguana') continue;            // iguana basks in the open; pigs + ducks push off structures
      for (const bb of bldBoxes) {
        if (a.x > bb[0] - a.r && a.x < bb[1] + a.r && a.z > bb[2] - a.r && a.z < bb[3] + a.r) {
          const pl = [a.x - (bb[0] - a.r), (bb[1] + a.r) - a.x, a.z - (bb[2] - a.r), (bb[3] + a.r) - a.z];
          const m = Math.min(...pl);
          if (m === pl[0]) a.x = bb[0] - a.r; else if (m === pl[1]) a.x = bb[1] + a.r;
          else if (m === pl[2]) a.z = bb[2] - a.r; else a.z = bb[3] + a.r;
        }
      }
    }
    for (let i = 0; i < ANIMALS.length; i++) for (let j = i + 1; j < ANIMALS.length; j++) {
      const a = ANIMALS[i], b = ANIMALS[j];
      const dx = b.x - a.x, dz = b.z - a.z, d2 = dx * dx + dz * dz, rr = a.r + b.r;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2), push = (rr - d) / 2, ux = dx / d, uz = dz / d;
        a.x -= ux * push; a.z -= uz * push; b.x += ux * push; b.z += uz * push;
      }
    }
    for (const a of ANIMALS) { a.mesh.position.x = a.x; a.mesh.position.z = a.z; }
  }

  // Seed ~7 droppings so the yard starts dirty.
  for (let i = 0; i < 7; i++) { updateAnimals(2.5, 0); ANIMALS[i % ANIMALS.length].poopT = 0; }
  updateAnimals(0.01, 0);

  return { ANIMALS, POOPS, updateAnimals, spawnPoop, removePoop };
}

// The walking keeper (poppy cap) with the three swappable scooper tools.
export function createCharacter(scene, SREC) {
  // spawn in the open yard on the shed's door side, clear of the house box
  const CHAR = { x: SREC.shed[0] - 2.5, z: SREC.shed[1] - 2.5, yaw: Math.PI, group: new THREE.Group(), scoops: [], lvl: 0, bag: 0, total: 0, bob: 0, vy: 0, airY: 0 };
  const b = critterBuilder();
  b.addBox(0.16, 0.34, 0.13, 0, 0.17, 0.1, 0x33424e); b.addBox(0.16, 0.34, 0.13, 0, 0.17, -0.1, 0x33424e);
  b.addBox(0.34, 0.42, 0.26, 0, 0.56, 0, 0x3f6b6b);
  b.addBox(0.07, 0.3, 0.07, 0.02, 0.6, 0.22, 0x3f6b6b); b.addBox(0.07, 0.3, 0.07, 0.02, 0.6, -0.22, 0xd9b08c);
  b.addBox(0.22, 0.22, 0.22, 0, 0.92, 0, 0xd9b08c);
  b.addBox(0.24, 0.08, 0.24, 0, 1.05, 0, 0xd94f1e); b.addBox(0.14, 0.04, 0.1, 0.16, 1.02, 0, 0xd94f1e);
  const bm = new THREE.Mesh(b.build(), critterMat); bm.castShadow = true;
  CHAR.group.add(bm);
  const mk = (len, w) => {
    const grp = new THREE.Group();
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, len, 6),
      new THREE.MeshStandardMaterial({ color: 0x9a7c5a, roughness: .9 }));
    stick.position.y = len / 2; grp.add(stick);
    const head = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, w * 0.8),
      new THREE.MeshStandardMaterial({ color: 0xb9bec6, metalness: .6, roughness: .4 }));
    head.position.y = 0.02; grp.add(head);
    grp.position.set(0.12, 0.18, -0.34); grp.rotation.z = -0.5;
    grp.visible = false; CHAR.group.add(grp); CHAR.scoops.push(grp);
    return grp;
  };
  mk(0.5, 0.16); mk(0.75, 0.26); mk(1.05, 0.42);
  CHAR.scoops[0].visible = true;
  CHAR.group.visible = false;
  scene.add(CHAR.group);

  // Swap the voxel keeper for a rigged avatar once it loads (fail-soft: the voxel stays on any
  // error). CHAR.drew is the GENERIC "active avatar" controller slot (kept that name to avoid a
  // wide rename) — it holds Drew OR CeCe, both sharing the {group,locomotion,react,reset,tick}
  // interface. The side-menu switch flips between them; the inactive controller is cached so the
  // swap is instant the second time.
  CHAR.drew = null;
  CHAR.avatar = 'drew';        // which avatar is active
  CHAR.wantAvatar = 'drew';    // which the player last asked for (guards async-load races)
  const avatars = { drew: null, cece: null };
  let swapping = false;
  function mount(name, ctrl) {
    if (CHAR.drew === ctrl) return;
    if (CHAR.drew && CHAR.drew.group.parent) CHAR.group.remove(CHAR.drew.group);
    if (CHAR.drew && CHAR.drew.reset) CHAR.drew.reset();   // stop the one we're leaving mid-emote
    bm.visible = false;
    for (const s of CHAR.scoops) s.visible = false;
    if (ctrl.reset) ctrl.reset();
    CHAR.group.add(ctrl.group);
    CHAR.drew = ctrl; CHAR.avatar = name;
  }
  loadDrew(ctrl => { avatars.drew = ctrl; if (CHAR.wantAvatar === 'drew') mount('drew', ctrl); });

  // Switch the playable avatar (avatar swap only — no companion). Lazy-loads CeCe the first time.
  CHAR.swapAvatar = (name, onDone) => {
    if (name !== 'drew' && name !== 'cece') return;
    CHAR.wantAvatar = name;
    if (avatars[name]) { mount(name, avatars[name]); onDone && onDone(name); return; }
    if (name === 'drew') { onDone && onDone(CHAR.avatar); return; }   // Drew still loading; stay put
    if (swapping) return;
    swapping = true;
    loadCeceController(
      ctrl => { swapping = false; avatars.cece = ctrl; if (CHAR.wantAvatar === 'cece') mount('cece', ctrl); onDone && onDone(CHAR.avatar); },
      () => { swapping = false; CHAR.wantAvatar = CHAR.avatar; onDone && onDone(CHAR.avatar); }
    );
  };
  // The active avatar's emote list ([{key,label}]) for the HUD action menu.
  CHAR.getActions = () => (CHAR.drew && CHAR.drew.actions) || [];
  return CHAR;
}
