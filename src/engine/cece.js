import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DracoShim } from './draco-shim.js';
import { installDracoDecoder } from './draco-install.js';
import { makeController, CECE_HEIGHT_M } from './drew.js';
import ceceUrl from '../assets/cece.glb';

// CeCe's rig faces the opposite way from Drew's; +PI/2 turns her nose to run +X (forward) so she
// plugs into the same parent yaw (CHAR.yaw - PI/2) Drew uses — an interchangeable playable avatar.
const CECE_YAW = Math.PI / 2;

// Map the engine's logical animation names onto CeCe's actual merged clips. cece.glb ships
// real 'Walking'/'Running' (verified in the GLB) — the curated crowd list just used Funky_Walk.
// No literal idle clip, so a gentle 'Big_Heart_Gesture' loop stands in.
const CECE_NAME_MAP = {
  idle: 'Big_Heart_Gesture', walk: 'Walking', run: 'Running',
  dance: 'All_Night_Dance', cheer: 'Cheer_with_Both_Hands_1',
};

// Every emote the action menu can fire while controlling CeCe (locomotion + face-plant clips
// excluded). react() takes the raw clip name, so each button maps straight to a clip.
export const CECE_ACTIONS = [
  { key: 'All_Night_Dance', label: '💃 All-Night' },
  { key: 'Gangnam_Groove', label: '🕺 Gangnam' },
  { key: 'FunnyDancing_01', label: '🤪 Silly' },
  { key: 'FunnyDancing_03', label: '😜 Goofy' },
  { key: 'Bass_Beats', label: '🎧 Bass Drop' },
  { key: 'Cheer_with_Both_Hands_1', label: '🙌 Cheer' },
  { key: '360_Power_Spin_Jump', label: '🌀 Spin Jump' },
  { key: 'Big_Heart_Gesture', label: '❤️ Big Heart' },
  { key: 'bicycle_crunch', label: '🚴 Bicycle' },
  { key: 'Angry_Stomp', label: '😤 Stomp' },
  { key: 'Angry_To_Tantrum_Sit', label: '😡 Tantrum' },
];

function nativeHeight(obj) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  return (b.max.y - b.min.y) || 1;
}

// Loads the rigged CeCe and hands back the SAME controller shape as drew.js
// ({group, kind, actions, locomotion, react, reset, tick}) so animals.js can hold either in
// CHAR.drew. Fail-soft: a timeout latch fires onFail if the Draco decode never completes
// (a decode error surfaces via the shared DracoShim, not the loader's onError) so the avatar
// swap can fall back instead of hanging.
export function loadCeceController(onReady, onFail) {
  installDracoDecoder();
  let settled = false;
  const fail = e => { if (settled) return; settled = true; console.warn('[cece] playable load failed', e); onFail && onFail(e); };
  const timer = setTimeout(() => fail(new Error('cece load timeout')), 20000);
  // installDracoDecoder injects a classic script that parses ASYNCHRONOUSLY — wait for the decoder
  // to be ready before loading, so a CeCe swap that happens before the car path warmed Draco (or a
  // ?nocar session) still decodes instead of silently failing the swap.
  const begin = () => {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(DracoShim);
    loader.load(ceceUrl, g => {
    if (settled) return; settled = true; clearTimeout(timer);
    const model = g.scene;
    // Meshy exports a BLEND / double-sided material that renders near-invisible — force opaque,
    // single-sided, and self-emit the texture a touch so she reads (same fix the crowd uses).
    model.traverse(o => {
      if (!o.isMesh) return;
      o.frustumCulled = false; o.castShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        m.transparent = false; m.opacity = 1; m.alphaTest = 0; m.depthWrite = true; m.side = THREE.FrontSide;
        if (m.metalness !== undefined) m.metalness = Math.min(m.metalness, 0.2);
        if (m.emissive) { if (m.map) m.emissiveMap = m.map; m.emissive.setHex(0x999999); m.emissiveIntensity = 0.5; }
      }
    });
    const inner = new THREE.Group();
    inner.rotation.y = CECE_YAW;
    inner.scale.setScalar(CECE_HEIGHT_M / nativeHeight(model));   // size to CeCe's real height (4'10")
    inner.add(model);
    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    for (const clip of g.animations) actions[clip.name] = mixer.clipAction(clip);
    onReady(makeController(inner, mixer, actions, { kind: 'cece', nameMap: CECE_NAME_MAP, actionList: CECE_ACTIONS }));
  }, undefined, e => { clearTimeout(timer); fail(e); });
  };
  let waited = 0;
  (function ready() {
    if (settled) return;
    if (typeof globalThis.DracoDecoderModule === 'function') begin();
    else if (waited < 15000) { waited += 120; setTimeout(ready, 120); }
    else fail(new Error('Draco decoder not installed'));
  })();
}
