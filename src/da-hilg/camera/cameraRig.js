// Pure camera-rig helpers. No React, no Rapier, no side effects — just math the
// CameraRig and any look source can lean on. The mutable `cameraRig` singleton
// itself lives in state/refs.js; this module only computes derived values.

import * as THREE from 'three';
import { PITCH_MAX, EYE_HEIGHT } from '../constants.js';

/**
 * Clamp a pitch value to the legal look range (±PITCH_MAX radians).
 * @param {number} p pitch in radians
 * @returns {number}
 */
export function clampPitch(p) {
  if (p > PITCH_MAX) return PITCH_MAX;
  if (p < -PITCH_MAX) return -PITCH_MAX;
  return p;
}

/**
 * Horizontal forward direction for a given yaw (XZ plane, unit length).
 * Matches the engine's convention: yaw 0 looks toward -Z, +yaw turns right.
 * @param {number} yaw radians
 * @returns {{x:number, z:number}}
 */
export function forwardFromYaw(yaw) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

// Reused scratch so eyeWorld never allocates in the frame loop.
const _eye = new THREE.Vector3();

/**
 * World-space eye position for an actor: feet (motion.pos) + EYE_HEIGHT up.
 * Returns a shared scratch Vector3 — copy it if you need to retain the value.
 * @param {import('../actors/actorRegistry.js').Actor} actor
 * @returns {THREE.Vector3}
 */
export function eyeWorld(actor) {
  const p = actor.motion.pos;
  return _eye.set(p.x, p.y + EYE_HEIGHT, p.z);
}
