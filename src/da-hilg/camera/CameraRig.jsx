// The one camera. Runs in a priority-10 useFrame so it reads transforms AFTER
// the sim has moved bodies this frame. First-person: eye at the active actor's
// head, quaternion straight from (pitch, yaw). Third-person: a collision-avoided
// boom behind a shoulder pivot, smoothed. Reads cameraRig (plain ref) + the
// active actor; reads cameraModeAtom imperatively (no re-render). Writes only to
// the three camera — never game state.

import { useFrame, useThree } from '@react-three/fiber';
import { useRapier } from '@react-three/rapier';
import * as THREE from 'three';
import {
  FP_NEAR,
  TP_NEAR,
  EYE_HEIGHT,
  FP_FORWARD_NUDGE,
  TP_PIVOT_HEIGHT,
  TP_DISTANCE,
  TP_MIN_DISTANCE,
  TP_COLLISION_SKIN,
  SMOOTH_BOOM,
  SMOOTH_CAM,
} from '../constants.js';
import { cameraRig, activePlayer } from '../state/refs.js';
import { daHilgStore } from '../state/store.js';
import { cameraModeAtom } from '../state/atoms.js';

// Reused scratch — the camera loop never allocates.
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _feet = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _desired = new THREE.Vector3();

export default function CameraRig() {
  const camera = useThree((s) => s.camera);
  const { world, rapier } = useRapier();

  useFrame((_, dtRaw) => {
    const actor = activePlayer();
    if (!actor || !actor.ref.rigid) return;

    const dt = Math.min(dtRaw, 1 / 30);
    // Read the discrete camera mode imperatively to avoid per-frame re-renders.
    // cameraRig.mode mirrors it for systems that prefer the ref.
    const mode = daHilgStore.get(cameraModeAtom);
    const isFirst = mode !== 'third';
    cameraRig.mode = isFirst ? 'first' : 'third';

    const yaw = cameraRig.yaw;
    const pitch = cameraRig.pitch;

    // Feet = the actor's authored foot plane (motion.pos tracks it each frame).
    const p = actor.motion.pos;
    _feet.set(p.x, p.y, p.z);

    if (isFirst) {
      // --- First person -------------------------------------------------
      if (camera.near !== FP_NEAR) {
        camera.near = FP_NEAR;
        camera.updateProjectionMatrix();
      }
      _euler.set(pitch, yaw, 0, 'YXZ');
      camera.quaternion.setFromEuler(_euler);
      // Eye = feet + EYE_HEIGHT, nudged slightly forward so the capsule front
      // doesn't poke through the near plane.
      camera.position.set(_feet.x, _feet.y + EYE_HEIGHT, _feet.z);
      _dir.set(-Math.sin(yaw), 0, -Math.cos(yaw)); // forward on XZ from yaw
      camera.position.addScaledVector(_dir, FP_FORWARD_NUDGE);
    } else {
      // --- Third person -------------------------------------------------
      if (camera.near !== TP_NEAR) {
        camera.near = TP_NEAR;
        camera.updateProjectionMatrix();
      }
      _pivot.set(_feet.x, _feet.y + TP_PIVOT_HEIGHT, _feet.z);

      // Forward from yaw+pitch — SAME convention as first-person (yaw 0 → -Z) so
      // the boom sits BEHIND the character, not in front. forward = quaternion
      // (pitch,yaw,'YXZ') applied to (0,0,-1) = (-sin·cos, sin(pitch), -cos·cos).
      const cp = Math.cos(pitch);
      _dir.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);

      // One backward ray from pivot to find any wall between us and the boom.
      let len = TP_DISTANCE;
      const ray = new rapier.Ray(_pivot, {
        x: -_dir.x,
        y: -_dir.y,
        z: -_dir.z,
      });
      const hit = world.castRay(
        ray,
        TP_DISTANCE,
        true,
        rapier.QueryFilterFlags.EXCLUDE_SENSORS, // don't let the boom snap on invisible zones
        undefined,
        actor.ref.collider ?? undefined,
        actor.ref.rigid ?? undefined,
      );
      if (hit) {
        len = Math.max(TP_MIN_DISTANCE, hit.timeOfImpact - TP_COLLISION_SKIN);
      }

      // Smooth the boom length so it doesn't pop through doorways.
      const kBoom = 1 - Math.exp(-SMOOTH_BOOM * dt);
      cameraRig.tpDistance += (len - cameraRig.tpDistance) * kBoom;

      // Desired position = pivot pulled back along -forward by the boom length.
      _desired.copy(_pivot).addScaledVector(_dir, -cameraRig.tpDistance);

      const kCam = 1 - Math.exp(-SMOOTH_CAM * dt);
      camera.position.lerp(_desired, kCam);
      camera.lookAt(_pivot);
    }
  }, 10);

  return null;
}
