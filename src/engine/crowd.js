import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { DracoShim } from './draco-shim.js';
import ceceUrl from '../assets/cece.glb';
import drewUrl from '../assets/drew.glb';
import dadUrl from '../assets/dad.glb';
import momUrl from '../assets/mom.glb';
import drewDanceUrl from '../assets/anim/drew-dance.glb';
import drewWalkUrl from '../assets/anim/drew-walk.glb';
import drewCheerUrl from '../assets/anim/drew-cheer.glb';
import drewIdleUrl from '../assets/anim/drew-idle.glb';

// A crowd of animated background characters (CeCe + Drew) dancing/roaming in the world.
// The rigged model + its clips load once; each placement is a SkeletonUtils clone (so the
// skeleton is deep-copied) wrapped in a group, with its OWN AnimationMixer playing a looped
// clip. tick(dt) drives every mixer; the engine distance-gates visibility so only a handful
// animate at a time (skinned meshes are not cheap on mobile).
function makeCrowd(base, clips, nativeH, moveNames, innerYaw, hitNames = [], defaultH = 1.75) {
  const insts = [];
  // Force the model OPAQUE + single-sided: Meshy exports the character as a BLEND /
  // double-sided material that renders near-invisible (and doubles the fill). Materials are
  // shared into every clone, so fixing them once on the base fixes all dancers.
  base.traverse(o => {
    if (!o.isMesh) return;
    o.frustumCulled = false; o.castShadow = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.transparent = false; m.opacity = 1; m.alphaTest = 0; m.depthWrite = true; m.side = THREE.FrontSide;
      if (m.metalness !== undefined) m.metalness = Math.min(m.metalness, 0.2);   // not env-map-dark
      // lift the textured character OUT of the dim photogrammetry so it reads clearly:
      // self-emit the texture at a low level (same trick as the traffic cars).
      if (m.emissive) { if (m.map) m.emissiveMap = m.map; m.emissive.setHex(0x999999); m.emissiveIntensity = 0.5; }
    }
  });
  // Keep only the clip names this rig actually has. `moves` = the ambient loop pool a
  // dancer rotates through; `hits` = one-shot "ow!" reactions played when a car clips them.
  const moves = moveNames.filter(n => clips[n]);
  const hits = hitNames.filter(n => clips[n]);
  const fallback = moves[0] || Object.keys(clips)[0];
  const pick = arr => arr[(Math.random() * arr.length) | 0];
  // Crossfade `rec` onto clip `name`. Looped for ambient moves; LoopOnce + hold-last-frame
  // for hit reactions so a knocked-down dancer stays down until it respawns.
  function play(rec, name, { fade = 0.35, once = false } = {}) {
    const cl = clips[name] || clips[fallback];
    if (!cl) return;
    const act = rec.mixer.clipAction(cl);
    act.reset(); act.enabled = true; act.setEffectiveWeight(1); act.setEffectiveTimeScale(1);
    if (once) { act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; }
    else { act.setLoop(THREE.LoopRepeat, Infinity); act.clampWhenFinished = false; }
    act.fadeIn(fade); act.play();
    if (rec.act && rec.act !== act) rec.act.fadeOut(fade);
    rec.act = act; rec.clipName = name;
  }
  return {
    moveNames: moves,
    // add one dancer: world (x,y,z), facing `yaw`, scaled to ~targetH metres. Starts on
    // `clip` (or a random move) and then cycles its whole move pool via tick().
    add(scene, { x, y, z, yaw = 0, targetH = defaultH, clip }) {
      const inst = cloneSkinned(base);
      inst.rotation.y = innerYaw;                       // per-model facing correction (nose → +Z)
      const grp = new THREE.Group();
      grp.add(inst);
      grp.scale.setScalar(targetH / nativeH);
      grp.position.set(x, y, z);
      grp.rotation.y = yaw;
      grp.visible = false;
      scene.add(grp);
      const mixer = new THREE.AnimationMixer(inst);
      const rec = { grp, mixer, x, z, baseX: x, baseY: y, baseZ: z, baseYaw: yaw, vel: null, spin: 0, axisX: 1, axisZ: 0, respawnAt: 0, nextSwitch: 0, act: null, clipName: null };
      const start = (clip && clips[clip]) ? clip : (moves.length ? pick(moves) : fallback);
      play(rec, start, { fade: 0 });
      if (rec.act) rec.act.time = Math.random() * (rec.act.getClip().duration || 1);   // desync the loops
      insts.push(rec);
      return rec;
    },
    list: insts,
    // HIT: launch the nearest VISIBLE, not-already-flying dancer within `rad` of (x,z)
    // comically through the air along the car's heading, playing a pain reaction (where the
    // rig has one — CeCe does, Drew doesn't). Returns true on a hit.
    launchNear(x, z, vx, vz, speed, rad = 3.2) {
      let best = null, bd = rad * rad;
      for (const i of insts) { if (!i.grp.visible || i.vel) continue; const dx = i.grp.position.x - x, dz = i.grp.position.z - z, d2 = dx * dx + dz * dz; if (d2 < bd) { bd = d2; best = i; } }
      if (!best) return false;
      const L = Math.hypot(vx, vz) || 1, s = Math.max(10, speed);
      best.vel = { x: vx / L * s * 0.9, y: 8 + s * 0.32, z: vz / L * s * 0.9 };   // up + away
      best.spin = (9 + Math.random() * 9) * (Math.random() < 0.5 ? -1 : 1);       // tumble
      best.axisX = Math.random(); best.axisZ = 1 - best.axisX;
      if (hits.length) play(best, pick(hits), { fade: 0.06, once: true });        // "ow!" — knocked-back reaction
      return true;
    },
    tick(dt, now) {
      for (const i of insts) {
        if (i.vel) {                                                              // mid-flight: ballistic + tumble
          i.grp.position.x += i.vel.x * dt; i.grp.position.y += i.vel.y * dt; i.grp.position.z += i.vel.z * dt;
          i.vel.y -= 26 * dt;
          i.grp.rotation.x += i.spin * i.axisX * dt; i.grp.rotation.z += i.spin * i.axisZ * dt;
          if (i.grp.position.y <= i.baseY && i.vel.y < 0) { i.grp.position.y = i.baseY; i.vel = null; i.respawnAt = (now || 0) + 2600; }
          i.mixer.update(dt);                                                     // keep the reaction playing — funnier
        } else if (i.respawnAt && now >= i.respawnAt) {                           // pop back up where it started
          i.grp.position.set(i.baseX, i.baseY, i.baseZ); i.grp.rotation.set(0, i.baseYaw, 0); i.respawnAt = 0;
          if (moves.length) { play(i, pick(moves), { fade: 0 }); i.nextSwitch = (now || 0) + 4000 + Math.random() * 5000; }
        } else if (i.grp.visible) {
          // Rotate through the whole move pool on a staggered timer so a dancer never looks
          // frozen on a single loop. Only visible dancers cycle (and crossfade), so it's cheap.
          if (moves.length > 1) {
            if (!i.nextSwitch) i.nextSwitch = now + 3000 + Math.random() * 5000;
            else if (now >= i.nextSwitch) {
              let n = pick(moves); if (n === i.clipName) n = pick(moves);
              play(i, n); i.nextSwitch = now + 4000 + Math.random() * 5000;
            }
          }
          i.mixer.update(dt);
        }
      }
    },
    dispose() { for (const i of insts) { i.mixer.stopAllAction(); if (i.grp.parent) i.grp.parent.remove(i.grp); } insts.length = 0; },
    // Like dispose but reusable: drop every instance so the engine can re-place a fresh pool
    // (used when the pedestrian-density slider changes). The base rig + clips stay loaded.
    removeAll() { for (const i of insts) { i.mixer.stopAllAction(); if (i.grp.parent) i.grp.parent.remove(i.grp); } insts.length = 0; },
  };
}

function nativeHeight(obj) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  return (b.max.y - b.min.y) || 1;
}

// CeCe: a single GLB with all clips merged. Nose runs -Z out of Meshy, so spin it to +Z.
// MOVES = the ambient pool she rotates through; HITS = pain reactions for car strikes (the
// rig ships BeHit_FlyUp / Fall_Down / falling_down — kid-friendly knockbacks, no gore clip).
// NB: Big_Heart_Gesture + bicycle_crunch are deliberately OUT of the ambient loop — the heart read as
// "she only ever does the heart", and the crunch lies her on the floor. Both remain HUD emotes.
const CECE_MOVES = ['All_Night_Dance', 'FunnyDancing_01', 'FunnyDancing_03', 'Gangnam_Groove', 'Bass_Beats', 'Funky_Walk', 'Cheer_with_Both_Hands_1', '360_Power_Spin_Jump', 'Angry_Stomp'];
const CECE_HITS = ['BeHit_FlyUp', 'Fall_Down', 'falling_down'];
export function loadCeceCrowd(onReady, onFail) {
  const loader = new GLTFLoader();
  loader.setDRACOLoader(DracoShim);
  loader.load(ceceUrl, g => {
    const base = g.scene;
    const clips = {};
    for (const c of g.animations) clips[c.name] = c;
    onReady(makeCrowd(base, clips, nativeHeight(base), CECE_MOVES, Math.PI, CECE_HITS));
  }, undefined, e => { console.warn('[crowd] cece failed', e); onFail && onFail(e); });
}

// Drew: base rig + clip-only GLBs bound by shared bone names. +PI/2 is the same facing
// correction the keeper uses. Drew's rig has no pain clip, so a car strike just launches him.
const DREW_MOVES = ['dance', 'cheer', 'walk', 'idle'];
export function loadDrewCrowd(onReady, onFail) {
  const loader = new GLTFLoader();
  loader.load(drewUrl, g => {
    const base = g.scene;
    const clips = {};
    let pending = 4;
    const done = () => { if (--pending === 0) onReady(makeCrowd(base, clips, nativeHeight(base), DREW_MOVES, Math.PI / 2)); };
    const grab = (url, key) => loader.load(url, cg => { if (cg.animations[0]) clips[key] = cg.animations[0]; done(); }, undefined, () => done());
    grab(drewDanceUrl, 'dance'); grab(drewCheerUrl, 'cheer'); grab(drewWalkUrl, 'walk'); grab(drewIdleUrl, 'idle');
  }, undefined, e => { console.warn('[crowd] drew failed', e); onFail && onFail(e); });
}

// Dad + Mom as occasional GROWN-UP pedestrians mixed into the street crowd (taller than the kids).
// Same single-merged-GLB shape as CeCe; their rigs face -Z out of Meshy → +PI/2 like the others.
const DAD_MOVES = ['Walking', 'All_Night_Dance', 'Bass_Beats', 'Arm_Circle_Shuffle', '360_Power_Spin_Jump'];
export function loadDadCrowd(onReady, onFail) {
  new GLTFLoader().load(dadUrl, g => {
    const base = g.scene; const clips = {};
    for (const c of g.animations) clips[c.name] = c;
    onReady(makeCrowd(base, clips, nativeHeight(base), DAD_MOVES, Math.PI / 2, [], 1.85));
  }, undefined, e => { console.warn('[crowd] dad failed', e); onFail && onFail(e); });
}
const MOM_MOVES = ['Walking', 'Shake_It_Off_Dance', 'You_Groove', 'All_Night_Dance', 'Phone_Conversation'];
export function loadMomCrowd(onReady, onFail) {
  new GLTFLoader().load(momUrl, g => {
    const base = g.scene; const clips = {};
    for (const c of g.animations) clips[c.name] = c;
    onReady(makeCrowd(base, clips, nativeHeight(base), MOM_MOVES, Math.PI / 2, [], 1.7));
  }, undefined, e => { console.warn('[crowd] mom failed', e); onFail && onFail(e); });
}
