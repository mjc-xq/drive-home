// The sim ↔ render bridge for the real-NPC pool. This replaces the old swarmGpu VAT
// bridge: instead of uploading instance matrices to a GPU InstancedMesh, the sim now
// drives a fixed pool of REAL skinned NPC characters (Cece + Drew), each a skinned
// clone with its own AnimationMixer and the shared animation clips. They move like
// people because their mixers cross-fade real clips (run / walk / idle / attack /
// dance) the same way the four family members do.
//
// Binding is 1:1 and STABLE: pool slot k renders SoA slot k forever. Each slot's
// character is fixed by slot parity (even → cece, odd → drew), and NibblerNpcs mounts
// the pool the same way, so slot k's NPC is always the right body — no per-frame
// matching, no popping bodies. Dead SoA slots hide their NPC (visible=false), which is
// cheap, so activation is just flipping a flag + warming the mixer.
//
// publishToNpcPool(dt) is called from the tail of updateSwarm (inside the ONE sim
// useFrame), so the mixers advance with the SAME shared dt as the rest of the sim —
// there is NO second useFrame. The pool entries are registered by NibblerNpcs on mount.

import * as THREE from 'three';
import { MAX_NIBBLERS, NIBBLER_NPC_CHAR_IX, S_DESPAWN, S_ATTACHED } from '../constants.js';
import { MODEL_FACING_OFFSET } from '../../constants.js';
import { px, py, pz, heading, scale, state, clip } from '../swarm/swarmState.js';
import { setNpcClip, advanceNpc } from './npcAnim.js';

// Reused scratch for the on-body cling orientation (no per-frame allocation).
const _up = new THREE.Vector3();      // model up = radial-out from the player's rig axis
const _fwd = new THREE.Vector3();     // local +Z basis; visible front is local -Z
const _right = new THREE.Vector3();
const _basis = new THREE.Matrix4();

/**
 * @typedef {Object} NpcEntry
 * @property {import('three').Group} group       the visual root (positioned/rotated here)
 * @property {import('three').AnimationMixer} mixer
 * @property {Record<string, import('three').AnimationAction>} actions  clipKey -> action
 * @property {string|null} current               current animState driving the mixer
 * @property {string} character                  'cece' | 'drew'
 */

// One entry per SoA slot (null until NibblerNpcs mounts that slot's NPC).
/** @type {(NpcEntry|null)[]} */
export const npcPool = new Array(MAX_NIBBLERS).fill(null);

/** The fixed character (registry charIx) for SoA slot i — even=cece, odd=drew. */
export function slotCharIx(i) {
  return NIBBLER_NPC_CHAR_IX[i & 1];
}

/**
 * Register a mounted NPC into the pool at its slot. Called by NibblerNpcs on mount,
 * and again with null on unmount.
 * @param {number} slot
 * @param {NpcEntry|null} entry
 */
export function registerNpc(slot, entry) {
  if (slot < 0 || slot >= MAX_NIBBLERS) return;
  npcPool[slot] = entry;
  if (entry && entry.group) entry.group.visible = false; // hidden until the sim shows it
}

/** True once at least one NPC has mounted (the publish loop is a no-op before that). */
export function poolReady() {
  for (let i = 0; i < npcPool.length; i++) if (npcPool[i]) return true;
  return false;
}

/**
 * Per-frame: drive every pooled NPC from its SoA slot. Live slots (scale>0 and not
 * despawned) are shown, positioned at the slot's feet, faced to its heading, scaled,
 * given the right clip (cross-faded), and ticked. Dead slots are hidden (visible=false)
 * and skipped entirely, so an inactive NPC costs nothing — no mixer tick, no transforms.
 * Called from updateSwarm's tail with the shared dt.
 * @param {number} dt clamped seconds
 */
export function publishToNpcPool(dt) {
  for (let i = 0; i < MAX_NIBBLERS; i++) {
    const e = npcPool[i];
    if (!e) continue;
    const g = e.group;
    if (!g) continue;

    const live = scale[i] > 0 && state[i] !== S_DESPAWN;
    if (!live) {
      if (g.visible) g.visible = false; // hide dead slots (no mixer cost)
      continue;
    }

    if (!g.visible) g.visible = true;

    // Position: SoA holds feet pos; the clone's own group sits at feet already, so we
    // place the root group directly at the slot's feet.
    g.position.set(px[i], py[i], pz[i]);
    const s = scale[i];
    g.scale.set(s, s, s);

    if (state[i] === S_ATTACHED) {
      // CLING ON the body: the player's body is the ground and gravity points at its
      // central rig axis, so the nibbler's UP is the radial-out direction from that axis
      // (its feet press onto the body surface). `heading` faces the axis (inward), so the
      // radial-out unit vector is (-sin, -cos). Forward = "up the body" (toward the head),
      // i.e. world-up projected into the tangent plane (== world-up since up is horizontal).
      const h = heading[i];
      _up.set(-Math.sin(h), 0, -Math.cos(h)).normalize();
      // The mesh's authored front is -Z, so to make the nibbler FACE UP the body (head
      // toward the player's head, climbing up) we target +Z at world-DOWN.
      _fwd.set(0, -1, 0);
      _right.crossVectors(_fwd, _up).normalize(); // x = forward × up
      _fwd.crossVectors(_up, _right).normalize(); // re-orthogonalize forward
      // Build a rotation whose columns are (right, up, forward): three's lookAt-style
      // basis maps local +X/+Y/+Z onto these world axes.
      _basis.makeBasis(_right, _up, _fwd);
      g.quaternion.setFromRotationMatrix(_basis);
    } else {
      // Free-standing on the ground: upright, yaw to travel/look direction (+ the model's
      // authored-forward offset, same convention as stepMotion).
      g.quaternion.identity();
      g.rotation.set(0, heading[i] + MODEL_FACING_OFFSET, 0);
    }

    // Pick + cross-fade the clip for this slot's SoA clip band, then tick the mixer.
    setNpcClip(e, clip[i]);
    advanceNpc(e, dt);
  }
}
