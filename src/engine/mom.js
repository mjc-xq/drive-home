import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { makeController } from './drew.js';
import momUrl from '../assets/mom.glb';

// "Mom" — a non-playable NPC who lives in the house (dances + walks around, never controllable).
// Plain Meshy biped (no Draco) with its mesh + 17 merged clips → stock GLTFLoader. Same controller
// shape as Drew/CeCe/Dad; wired only as an ambient NPC in engine.js (the player can never be her).
const MOM_YAW = Math.PI / 2;            // Meshy rig: spin nose -> +X like the others
const MOM_HEIGHT_M = 1.651;             // ~5'5"
const MOM_NAME_MAP = { idle: 'Phone_Conversation', walk: 'Walking', run: 'Running', dance: 'Shake_It_Off_Dance', cheer: 'You_Groove' };

function nativeHeight(obj) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  return (b.max.y - b.min.y) || 1;
}

export function loadMomController(onReady, onFail) {
  new GLTFLoader().load(momUrl, g => {
    const model = g.scene;
    model.traverse(o => {
      if (!o.isMesh) return;
      o.frustumCulled = false; o.castShadow = false;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m) continue;
        m.transparent = false; m.opacity = 1; m.alphaTest = 0; m.depthWrite = true; m.side = THREE.FrontSide;
        if (m.metalness !== undefined) m.metalness = Math.min(m.metalness, 0.2);
        if (m.emissive) { if (m.map) m.emissiveMap = m.map; m.emissive.setHex(0x999999); m.emissiveIntensity = 0.5; }
      }
    });
    const inner = new THREE.Group();
    inner.rotation.y = MOM_YAW;
    inner.scale.setScalar(MOM_HEIGHT_M / nativeHeight(model));
    inner.add(model);
    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    for (const c of g.animations) actions[c.name] = mixer.clipAction(c);
    onReady(makeController(inner, mixer, actions, { kind: 'mom', nameMap: MOM_NAME_MAP, actionList: [],
      dances: ['Shake_It_Off_Dance', 'You_Groove', 'All_Night_Dance'] }));   // upright moves the NPC cycler rotates through
  }, undefined, e => { console.warn('[mom] load failed', e); onFail && onFail(e); });
}
