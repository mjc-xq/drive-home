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
import {
  MAX_NIBBLERS,
  NIBBLER_NPC_CHAR_IX,
  S_DESPAWN,
  S_ATTACHED,
  CLIP_ATTACK,
  NIBBLER_BODY_HALF,
  ATTACHED_SCALE_MUL,
  CLIMB_SETTLE_T,
  CLIMB_SETTLE_DROP,
  CLIMB_SETTLE_OUT,
} from '../constants.js';
import { px, py, pz, heading, scale, state, clip, stateT } from '../swarm/swarmState.js';
import { setNpcClip, advanceNpc } from './npcAnim.js';

// Reused scratch for the on-body cling orientation (no per-frame allocation).
const _up = new THREE.Vector3();      // local +Y (head) — points UP the body
const _fwd = new THREE.Vector3();     // local +Z (face/belly) — pressed radially INWARD
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

/** The fixed character (registry charIx) for SoA slot i — slots cycle the roster. */
export function slotCharIx(i) {
  return NIBBLER_NPC_CHAR_IX[i % NIBBLER_NPC_CHAR_IX.length];
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
    // place the root group directly at the slot's feet (attachment.js already wrote the
    // body-surface anchor into px/py/pz for ATTACHED slots).
    g.position.set(px[i], py[i], pz[i]);
    const s = scale[i];

    if (state[i] === S_ATTACHED) {
      // CLING ON the body like a creature gripping a tree trunk — belly-in, head up:
      //   • local +Z (face/belly) presses radially INWARD toward the body axis,
      //   • local +Y (head) points UP the body (world up),
      // so the visible body lies ON the surface rather than juts out beside the player.
      // attachment.js faces `heading` at the body center (inward), so radial-OUT is
      // (-sin h, -cos h) and radial-IN is its negation.
      const h = heading[i];
      const radOutX = -Math.sin(h);
      const radOutZ = -Math.cos(h);
      _fwd.set(-radOutX, 0, -radOutZ).normalize(); // belly faces radially inward
      _up.set(0, 1, 0);                            // head up the body
      _right.crossVectors(_up, _fwd).normalize();
      _up.crossVectors(_fwd, _right).normalize();  // re-orthogonalize
      _basis.makeBasis(_right, _up, _fwd);
      g.quaternion.setFromRotationMatrix(_basis);

      // Shrink a touch so the pile hugs the 0.30 m capsule, then drop by half the scaled
      // body height so the TORSO (not the feet) centers on the anchor band — otherwise a
      // feet-on-anchor body floats above the player's head.
      const sAtt = s * ATTACHED_SCALE_MUL;
      g.scale.set(sAtt, sAtt, sAtt);
      g.position.y -= NIBBLER_BODY_HALF * sAtt;

      // Climb-on settle: for the first CLIMB_SETTLE_T s after attaching, ease the body up
      // from below + slightly outward into the anchor so it visibly CLIMBS on (instead of
      // snapping). stateT[i] is reset to 0 on attach, so this is free over the SoA.
      const settle = 1 - Math.min(1, stateT[i] / CLIMB_SETTLE_T); // 1 → 0
      if (settle > 0) {
        const e2 = settle * settle; // ease-out as it arrives
        g.position.y -= CLIMB_SETTLE_DROP * NIBBLER_BODY_HALF * sAtt * e2;
        g.position.x += radOutX * CLIMB_SETTLE_OUT * e2;
        g.position.z += radOutZ * CLIMB_SETTLE_OUT * e2;
        setNpcClip(e, CLIP_ATTACK); // force the climb clip during the climb-on beat
      } else {
        setNpcClip(e, clip[i]);
      }
      advanceNpc(e, dt);
      continue;
    }

    g.scale.set(s, s, s);
    // Free-standing on the ground: upright, yaw to face travel direction. The swarm
    // computes heading = atan2(velX, velZ); a +Z-authored mesh rotated by that angle
    // already points its FRONT along (velX, velZ) — its travel dir — so we DON'T add
    // MODEL_FACING_OFFSET here (the family's heading uses atan2(-velX,-velZ) and DOES add
    // the offset; both end up facing forward — adding it on top of the swarm's heading was
    // the 180° "walking backwards" flip).
    g.quaternion.identity();
    g.rotation.set(0, heading[i], 0);

    // Pick + cross-fade the clip for this slot's SoA clip band, then tick the mixer.
    setNpcClip(e, clip[i]);
    advanceNpc(e, dt);
  }
}
