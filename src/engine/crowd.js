import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { DracoShim } from './draco-shim.js';
import ceceUrl from '../assets/cece.glb';
import drewUrl from '../assets/drew.glb';
import drewDanceUrl from '../assets/anim/drew-dance.glb';
import drewWalkUrl from '../assets/anim/drew-walk.glb';
import drewCheerUrl from '../assets/anim/drew-cheer.glb';

// A crowd of animated background characters (CeCe + Drew) dancing/roaming in the world.
// The rigged model + its clips load once; each placement is a SkeletonUtils clone (so the
// skeleton is deep-copied) wrapped in a group, with its OWN AnimationMixer playing a looped
// clip. tick(dt) drives every mixer; the engine distance-gates visibility so only a handful
// animate at a time (skinned meshes are not cheap on mobile).
function makeCrowd(base, clips, nativeH, danceNames, innerYaw) {
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
  return {
    danceNames,
    // add one dancer: world (x,y,z), facing `yaw`, scaled to ~targetH metres, playing `clip`.
    add(scene, { x, y, z, yaw = 0, targetH = 1.75, clip }) {
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
      const name = clip || danceNames[(Math.random() * danceNames.length) | 0];
      const cl = clips[name] || clips[danceNames[0]] || Object.values(clips)[0];
      if (cl) { const act = mixer.clipAction(cl); act.play(); mixer.setTime(Math.random() * (cl.duration || 1)); }   // desync the loops
      const rec = { grp, mixer, x, z };
      insts.push(rec);
      return rec;
    },
    list: insts,
    tick(dt) { for (const i of insts) if (i.grp.visible) i.mixer.update(dt); },
    dispose() { for (const i of insts) { i.mixer.stopAllAction(); if (i.grp.parent) i.grp.parent.remove(i.grp); } insts.length = 0; },
  };
}

function nativeHeight(obj) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  return (b.max.y - b.min.y) || 1;
}

// CeCe: a single GLB with all clips merged. Nose runs -Z out of Meshy, so spin it to +Z.
const CECE_DANCES = ['All_Night_Dance', 'FunnyDancing_01', 'FunnyDancing_03', 'Gangnam_Groove', 'Bass_Beats', 'Funky_Walk', 'Cheer_with_Both_Hands_1'];
export function loadCeceCrowd(onReady, onFail) {
  const loader = new GLTFLoader();
  loader.setDRACOLoader(DracoShim);
  loader.load(ceceUrl, g => {
    const base = g.scene;
    const clips = {};
    for (const c of g.animations) clips[c.name] = c;
    onReady(makeCrowd(base, clips, nativeHeight(base), CECE_DANCES, Math.PI));
  }, undefined, e => { console.warn('[crowd] cece failed', e); onFail && onFail(e); });
}

// Drew: base rig + a couple of clip-only GLBs bound by shared bone names. DREW_YAW (+PI/2)
// is the same facing correction the keeper uses.
export function loadDrewCrowd(onReady, onFail) {
  const loader = new GLTFLoader();
  loader.load(drewUrl, g => {
    const base = g.scene;
    const clips = {};
    let pending = 3;
    const done = () => { if (--pending === 0) onReady(makeCrowd(base, clips, nativeHeight(base), ['dance', 'cheer', 'walk'], Math.PI / 2)); };
    const grab = (url, key) => loader.load(url, cg => { if (cg.animations[0]) clips[key] = cg.animations[0]; done(); }, undefined, () => done());
    grab(drewDanceUrl, 'dance'); grab(drewCheerUrl, 'cheer'); grab(drewWalkUrl, 'walk');
  }, undefined, e => { console.warn('[crowd] drew failed', e); onFail && onFail(e); });
}
