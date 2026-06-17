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

// Real-world heights (the kids): Drew is 5'4", CeCe is 4'10". The playable models are
// scaled to these so they read at the right size and CeCe is correctly the shorter one.
// Shared so the interior ambient pair (crowd.add targetH) matches the playable avatars.
export const DREW_HEIGHT_M = 1.6256;   // 5'4"
export const CECE_HEIGHT_M = 1.4732;   // 4'10"

function nativeHeight(obj) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  return (b.max.y - b.min.y) || 1;
}

// Drew's one-shot emotes the action menu can trigger (locomotion clips excluded).
export const DREW_ACTIONS = [
  { key: 'dance', label: '🕺 Dance' },
  { key: 'cheer', label: '🙌 Cheer' },
];

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
    inner.scale.setScalar(DREW_HEIGHT_M / nativeHeight(model));   // size to Drew's real height (5'4")
    inner.add(model);

    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    let pending = Object.keys(CLIPS).length;
    const done = () => { if (--pending === 0) onReady(makeController(inner, mixer, actions, { kind: 'drew', actionList: DREW_ACTIONS })); };
    for (const [key, url] of Object.entries(CLIPS)) {
      loader.load(url, cg => {
        const clip = cg.animations[0];
        if (clip) actions[key] = mixer.clipAction(clip, model);
        done();
      }, undefined, () => done());
    }
  }, undefined, e => { console.warn('drew model failed, keeping voxel keeper', e); onFail && onFail(e); });
}

// Shared playable-character controller. `actions` is a dict of clip-name -> AnimationAction.
// `opts.nameMap` maps the logical names the engine uses (idle/walk/run/dance/cheer) onto this
// rig's actual clip names — so CeCe (whose clips are 'Walking'/'All_Night_Dance'/…) plugs into
// the exact same {group, locomotion, react, tick} interface Drew exposes (animals.js holds either
// one in CHAR.drew). `opts.actionList` is the [{key,label}] of emotes the side menu can fire;
// react(key) accepts a logical name OR a raw clip name, so every emote button just works.
export function makeController(group, mixer, actions, opts = {}) {
  const nameMap = opts.nameMap || {};
  const idleTS = opts.idleTimeScale || 1, walkTS = opts.walkTS || 1, runTS = opts.runTS || 1;
  const resolve = name => nameMap[name] || name;          // logical -> raw clip name (identity for Drew)
  let cur = null, reacting = false, _reactL = null;
  // Capture the REST pose. Some clips (Sit/Fall/bicycle_crunch/…) animate the hip/root bone to lie the
  // body down; crossfading to a clip that doesn't track those bones leaves them stuck there. After a
  // one-shot we stopAllAction + restore this pose so the body always stands back up.
  const rest = [];
  group.traverse(o => { if (o.isBone) rest.push({ b: o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }); });
  const resetPose = () => { for (const r of rest) { r.b.position.copy(r.p); r.b.quaternion.copy(r.q); r.b.scale.copy(r.s); } };
  const playIdle = () => { const k = resolve('idle'); if (actions[k]) { const a = actions[k]; a.reset().setLoop(THREE.LoopRepeat, Infinity); a.clampWhenFinished = false; a.setEffectiveTimeScale(idleTS).setEffectiveWeight(1).play(); cur = k; } else cur = null; };
  // Crossfade to a LOOPING clip (resets loop mode so a clip can serve as both idle and an emote).
  const fadeTo = (name, dur = 0.25, ts = 1) => {
    const key = resolve(name);
    if (key === cur || !actions[key]) return;
    const a = actions[key];
    a.reset().setLoop(THREE.LoopRepeat, Infinity); a.clampWhenFinished = false;
    a.setEffectiveTimeScale(ts).setEffectiveWeight(1).fadeIn(dur).play();
    if (actions[cur]) actions[cur].fadeOut(dur);
    cur = key;
  };
  const idleKey = resolve('idle');
  if (actions[idleKey]) { actions[idleKey].setEffectiveTimeScale(idleTS).play(); cur = idleKey; }

  return {
    group,
    kind: opts.kind || 'drew',
    actions: opts.actionList || [],         // [{key,label}] emotes for the HUD action menu
    dances: opts.dances || [],              // upright LOOP pool the NPC cycler rotates through
    emotes: opts.emotes || [],              // one-shot expressive clips the NPC FSM sprinkles in
    sitClip: opts.sitClip || null,          // a held sitting clip (e.g. mom's Sit_and_Doze_Off), or null
    // pick idle/walk/run from ground speed (m/s); skip while a reaction plays
    locomotion(speed) {
      if (reacting) return;
      const to = speed > 3.4 ? 'run' : speed > 0.35 ? 'walk' : 'idle';
      if (to === 'walk' && actions[resolve('walk')]) actions[resolve('walk')].setEffectiveTimeScale(THREE.MathUtils.clamp(speed / 1.5, 0.7, 1.7) * walkTS);
      if (to === 'run' && actions[resolve('run')]) actions[resolve('run')].setEffectiveTimeScale(THREE.MathUtils.clamp(speed / 4.0, 0.8, 1.4) * runTS);
      fadeTo(to, 0.25, to === 'idle' ? idleTS : 1);
    },
    // one-shot reaction (dance / cheer / any emote). INTERRUPTIBLE (rapid clicks crossfade). On finish
    // it STOPS everything + restores the rest pose so a lying/sitting clip can't leave the body stuck,
    // then idles cleanly.
    react(name) {
      const key = resolve(name);
      const a = actions[key];
      if (!a) return;
      if (_reactL) { mixer.removeEventListener('finished', _reactL); _reactL = null; }
      const prev = cur;
      reacting = true;
      a.reset().setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true;
      a.setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.15).play();
      if (actions[prev] && prev !== key) actions[prev].fadeOut(0.15);
      cur = key;
      _reactL = e => {
        if (e.action !== a) return;
        mixer.removeEventListener('finished', _reactL); _reactL = null;
        mixer.stopAllAction(); resetPose(); reacting = false; playIdle();   // stand back up, then idle
      };
      mixer.addEventListener('finished', _reactL);
    },
    // Hold a LOOPING clip indefinitely (no auto-return) — used to sit an NPC on a couch. Caller must
    // NOT drive locomotion() while posed (it would crossfade back to idle); reset()/react() ends it.
    pose(name) { if (_reactL) { mixer.removeEventListener('finished', _reactL); _reactL = null; } reacting = false; fadeTo(name, 0.3, 1); },
    // Hard-reset to rest + idle (avatar swap, stand up from a sit, or un-stick a clamped/lying pose).
    reset() { if (_reactL) { mixer.removeEventListener('finished', _reactL); _reactL = null; } reacting = false; mixer.stopAllAction(); resetPose(); playIdle(); },
    tick(dt) { mixer.update(dt); }
  };
}
