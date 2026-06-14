import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import drewUrl from '../assets/drew.glb';
import walkUrl from '../assets/anim/drew-walk.glb';
import runUrl from '../assets/anim/drew-run.glb';
import idleUrl from '../assets/anim/drew-idle.glb';
import danceUrl from '../assets/anim/drew-dance.glb';
import cheerUrl from '../assets/anim/drew-cheer.glb';

// Facing correction: spin the model so its nose runs +X (the engine then yaws the
// parent group by CHAR.yaw - PI/2, the same convention the voxel keeper used).
const DREW_YAW = Math.PI / 2;
const CLIPS = { idle: idleUrl, walk: walkUrl, run: runUrl, dance: danceUrl, cheer: cheerUrl };

// Loads the rigged Drew + the clip-only GLBs, binds every clip to the one shared
// skeleton, and hands back a small animation controller. Fails soft: onFail fires
// and the caller keeps the procedural voxel keeper.
export function loadDrew(onReady, onFail) {
  const loader = new GLTFLoader();
  loader.load(drewUrl, g => {
    const model = g.scene;
    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    const inner = new THREE.Group();
    inner.rotation.y = DREW_YAW;
    inner.add(model);

    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    let pending = Object.keys(CLIPS).length;
    const done = () => { if (--pending === 0) onReady(makeController(inner, mixer, actions)); };
    for (const [key, url] of Object.entries(CLIPS)) {
      loader.load(url, cg => {
        const clip = cg.animations[0];
        if (clip) actions[key] = mixer.clipAction(clip, model);
        done();
      }, undefined, () => done());
    }
  }, undefined, e => { console.warn('drew model failed, keeping voxel keeper', e); onFail && onFail(e); });
}

function makeController(group, mixer, actions) {
  let cur = null, reacting = false;
  const fadeTo = (name, dur = 0.25) => {
    if (name === cur || !actions[name]) return;
    actions[name].reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(dur).play();
    if (actions[cur]) actions[cur].fadeOut(dur);
    cur = name;
  };
  if (actions.idle) { actions.idle.play(); cur = 'idle'; }

  return {
    group,
    // pick idle/walk/run from ground speed (m/s); skip while a reaction plays
    locomotion(speed) {
      if (reacting) return;
      const to = speed > 3.4 ? 'run' : speed > 0.35 ? 'walk' : 'idle';
      if (to === 'walk' && actions.walk) actions.walk.setEffectiveTimeScale(THREE.MathUtils.clamp(speed / 1.5, 0.7, 1.7));
      if (to === 'run' && actions.run) actions.run.setEffectiveTimeScale(THREE.MathUtils.clamp(speed / 4.0, 0.8, 1.4));
      fadeTo(to);
    },
    // one-shot reaction (dance / cheer); returns to idle when it finishes
    react(name) {
      const a = actions[name];
      if (!a || reacting) return;
      reacting = true;
      a.reset().setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true;
      a.setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.2).play();
      if (actions[cur]) actions[cur].fadeOut(0.2);
      const prev = cur; cur = name;
      const onFinished = e => {
        if (e.action !== a) return;
        mixer.removeEventListener('finished', onFinished);
        reacting = false; cur = null; fadeTo('idle', 0.2);
      };
      mixer.addEventListener('finished', onFinished);
    },
    tick(dt) { mixer.update(dt); }
  };
}
