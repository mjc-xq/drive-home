import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { makeController } from './drew.js';
import dadUrl from '../assets/dad.glb';

// "Dad" — a non-playable NPC who lives in the house (a Jack-Hartmann-Rocks dancing dad). The GLB
// is a plain Meshy biped (no Draco) carrying its mesh + 15 merged clips, so the stock GLTFLoader
// loads it. Same controller shape as Drew/CeCe, but the player can never BE him — he's wired only
// as an ambient walk-out-of-a-room NPC in engine.js.
const DAD_YAW = Math.PI / 2;            // Meshy rig faces like the (fixed) CeCe: spin nose -> +X
const DAD_HEIGHT_M = 1.778;            // 5'10" — a grown-up, taller than the kids
const DAD_NAME_MAP = { idle: 'Arm_Circle_Shuffle', walk: 'Walking', run: 'Running', dance: 'All_Night_Dance', cheer: 'Bass_Beats' };

function nativeHeight(obj) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  return (b.max.y - b.min.y) || 1;
}

export function loadDadController(onReady, onFail) {
  new GLTFLoader().load(dadUrl, g => {
    const model = g.scene;
    model.traverse(o => {
      if (!o.isMesh) return;
      o.frustumCulled = false; o.castShadow = false;   // interior is far outside the sun's shadow frustum — skip the wasted pass
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m) continue;
        m.transparent = false; m.opacity = 1; m.alphaTest = 0; m.depthWrite = true; m.side = THREE.FrontSide;
        if (m.metalness !== undefined) m.metalness = Math.min(m.metalness, 0.2);
        if (m.emissive) { if (m.map) m.emissiveMap = m.map; m.emissive.setHex(0x999999); m.emissiveIntensity = 0.5; }
      }
    });
    const inner = new THREE.Group();
    inner.rotation.y = DAD_YAW;
    inner.scale.setScalar(DAD_HEIGHT_M / nativeHeight(model));
    inner.add(model);
    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    for (const c of g.animations) actions[c.name] = mixer.clipAction(c);
    onReady(makeController(inner, mixer, actions, { kind: 'dad', nameMap: DAD_NAME_MAP, actionList: [],
      dances: ['All_Night_Dance', 'Bass_Beats', 'Arm_Circle_Shuffle'] }));   // upright moves the NPC cycler rotates through
  }, undefined, e => { console.warn('[dad] load failed', e); onFail && onFail(e); });
}
