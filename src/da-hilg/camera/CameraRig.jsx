// The one camera. Runs in a priority-10 useFrame so it reads transforms AFTER
// the sim has moved bodies this frame. First-person: eye at the active actor's
// head, quaternion straight from (pitch, yaw). Third-person: an over-the-shoulder,
// collision-avoided boom behind a shoulder pivot, smoothed. Reads cameraRig (plain
// ref) + the active actor; reads cameraModeAtom imperatively (no re-render). Writes
// only to the three camera — never game state. No per-frame allocation.

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
  TP_SHOULDER_X,
  TP_SHOULDER_Y,
  CAM_FOV,
  SPEED_FOV_GAIN,
  SPEED_FOV_SMOOTH,
  LANDING_DIP_VEL,
  LANDING_DIP_MAX,
  LANDING_DIP_RECOVER,
  RUN_SPEED,
  WALK_SPEED,
  SMOOTH_BOOM,
  SMOOTH_BOOM_IN,
  SMOOTH_CAM,
  SMOOTH_LOOK,
  DEOCCLUDE_RADIUS,
  DEOCCLUDE_MIN_OPACITY,
  DEOCCLUDE_FADE_OUT,
  DEOCCLUDE_FADE_IN,
  CAPSULE_CENTER_Y,
} from '../constants.js';
import { cameraRig, activePlayer, registry } from '../state/refs.js';
import { daHilgStore } from '../state/store.js';
import { cameraModeAtom } from '../state/atoms.js';

// Reused scratch — the camera loop never allocates.
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _feet = new THREE.Vector3();
const _pivot = new THREE.Vector3();   // boom anchor (shoulder-shifted)
const _look = new THREE.Vector3();    // look target (shoulder-shifted, raised)
const _dir = new THREE.Vector3();     // forward (pitch,yaw)
const _right = new THREE.Vector3();   // camera-right on XZ (for shoulder offset)
const _desired = new THREE.Vector3();
const _lookSmooth = new THREE.Vector3(); // smoothed look target (cinematic settle)
let _lookInit = false;

// De-occlusion scratch — reused so the per-frame check never allocates.
const _camPos = new THREE.Vector3();  // camera position
const _segDir = new THREE.Vector3();  // camera → player segment direction (unit)
const _toActor = new THREE.Vector3(); // camera → actor
const _actorPos = new THREE.Vector3();// actor torso center (feet + half capsule)

/**
 * Fade NPC actors that sit between the camera and the active player so they never
 * block the view; restore them when they clear. Per-frame, over the tiny actor set.
 *
 * We treat the camera→player line as a segment, project each other actor onto it,
 * and if the actor is BETWEEN the two (param in (0,1)) and within DEOCCLUDE_RADIUS
 * of the line, drive its target opacity toward DEOCCLUDE_MIN_OPACITY (else back to
 * 1). The smoothed opacity is stored on actor.ref so we only touch materials when
 * it actually changes. The active player is never faded.
 *
 * @param {import('three').Camera} camera
 * @param {import('../actors/actorRegistry.js').Actor} player active player actor
 * @param {number} dt clamped frame delta (s)
 */
function deoccludeActors(camera, player, dt) {
  _camPos.copy(camera.position);
  // Aim at the player's torso (feet + ~half capsule), the part the camera frames.
  const pp = player.motion.pos;
  _segDir.set(pp.x, pp.y + CAPSULE_CENTER_Y, pp.z).sub(_camPos);
  const segLen = _segDir.length();
  if (segLen < 1e-3) return;
  _segDir.multiplyScalar(1 / segLen); // unit camera→player

  registry.forEach((actor) => {
    if (actor === player || actor.id === player.id) return; // never fade the player
    const grp = actor.ref && actor.ref.group;
    if (!grp) return;

    // Actor torso center in world space (group sits at the feet).
    const ap = actor.motion.pos;
    _actorPos.set(ap.x, ap.y + CAPSULE_CENTER_Y, ap.z);
    _toActor.copy(_actorPos).sub(_camPos);
    const t = _toActor.dot(_segDir); // projection distance along the segment

    // Occluding only if it's BETWEEN cam and player and close to the sight line.
    let occluding = false;
    if (t > 0.2 && t < segLen - 0.2) {
      // Perpendicular distance from the actor to the cam→player line.
      const perp = Math.sqrt(Math.max(0, _toActor.lengthSq() - t * t));
      occluding = perp < DEOCCLUDE_RADIUS;
    }

    const target = occluding ? DEOCCLUDE_MIN_OPACITY : 1;
    let cur = actor.ref._deoccludeOpacity;
    if (cur === undefined) cur = 1;
    const rate = target < cur ? DEOCCLUDE_FADE_OUT : DEOCCLUDE_FADE_IN;
    cur += (target - cur) * (1 - Math.exp(-rate * dt));
    if (Math.abs(cur - target) < 0.01) cur = target; // settle exactly so we can stop touching mats
    if (cur === actor.ref._deoccludeOpacity) return;  // unchanged — skip the traverse
    actor.ref._deoccludeOpacity = cur;

    applyOpacity(grp, cur);
  });
}

/** Set a uniform opacity across all of an actor group's materials (cheap, in place). */
function applyOpacity(grp, opacity) {
  const transparent = opacity < 0.999;
  grp.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (let i = 0; i < mats.length; i++) {
      const mat = mats[i];
      mat.transparent = transparent;
      mat.opacity = opacity;
      mat.depthWrite = !transparent; // faded body shouldn't write depth and punch holes
    }
  });
}

// Persistent camera-only state (the useFrame closure outlives a single frame).
// Kept here, not on the shared ref, so refs.js stays untouched.
let _fov = CAM_FOV;        // smoothed FOV currently applied to the camera
let _dip = 0;              // current landing-dip drop (m, >= 0 pulls cam down)
let _dipVel = 0;           // spring velocity of the dip
let _prevGrounded = true;  // last frame's grounded state (touchdown edge detect)
let _prevVelY = 0;         // last frame's vertical velocity (impact strength)

export default function CameraRig() {
  const camera = useThree((s) => s.camera);
  const { world, rapier } = useRapier();
  // One Rapier Ray, reused every frame (its origin/dir are plain mutable vectors).
  let _ray = null;

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
    const m = actor.motion;

    // Feet = the actor's authored foot plane (motion.pos tracks it each frame).
    const p = m.pos;
    _feet.set(p.x, p.y, p.z);

    // ── Landing dip ────────────────────────────────────────────────────────
    // On the falling→grounded edge, kick a downward impulse scaled by impact
    // speed; a critically-damped spring eases it back out. Subtle, never jarring.
    if (m.grounded && !_prevGrounded) {
      const impact = Math.min(1, Math.abs(Math.min(_prevVelY, 0)) / LANDING_DIP_VEL);
      _dipVel += impact * LANDING_DIP_MAX * LANDING_DIP_RECOVER;
    }
    _prevGrounded = m.grounded;
    _prevVelY = m.velY;
    // Spring: accel toward 0 with the dip offset as displacement (k = recover²).
    const k = LANDING_DIP_RECOVER * LANDING_DIP_RECOVER;
    const c = 2 * LANDING_DIP_RECOVER; // critical damping
    _dipVel += (-k * _dip - c * _dipVel) * dt;
    _dip += _dipVel * dt;
    if (Math.abs(_dip) < 1e-4 && Math.abs(_dipVel) < 1e-4) { _dip = 0; _dipVel = 0; }

    // ── Speed-FOV ──────────────────────────────────────────────────────────
    // Widen a few degrees as realized planar speed ramps walk → run.
    const speedNorm = THREE.MathUtils.clamp(
      (m.speed - WALK_SPEED) / Math.max(RUN_SPEED - WALK_SPEED, 1e-3),
      0,
      1,
    );
    const fovTarget = CAM_FOV + SPEED_FOV_GAIN * speedNorm;
    _fov += (fovTarget - _fov) * (1 - Math.exp(-SPEED_FOV_SMOOTH * dt));
    if (Math.abs(camera.fov - _fov) > 0.01) {
      camera.fov = _fov;
      camera.updateProjectionMatrix();
    }

    if (isFirst) {
      // --- First person -------------------------------------------------
      if (camera.near !== FP_NEAR) {
        camera.near = FP_NEAR;
        camera.updateProjectionMatrix();
      }
      _euler.set(pitch, yaw, 0, 'YXZ');
      camera.quaternion.setFromEuler(_euler);
      // Eye = feet + EYE_HEIGHT, nudged slightly forward so the capsule front
      // doesn't poke through the near plane. Landing dip drops the eye briefly.
      camera.position.set(_feet.x, _feet.y + EYE_HEIGHT - _dip, _feet.z);
      _dir.set(-Math.sin(yaw), 0, -Math.cos(yaw)); // forward on XZ from yaw
      camera.position.addScaledVector(_dir, FP_FORWARD_NUDGE);
      _lookInit = false; // re-seat the TP look smoother on next TP frame
    } else {
      // --- Third person -------------------------------------------------
      if (camera.near !== TP_NEAR) {
        camera.near = TP_NEAR;
        camera.updateProjectionMatrix();
      }

      // Forward from yaw+pitch — SAME convention as first-person (yaw 0 → -Z) so
      // the boom sits BEHIND the character, not in front. forward = quaternion
      // (pitch,yaw,'YXZ') applied to (0,0,-1) = (-sin·cos, sin(pitch), -cos·cos).
      const cp = Math.cos(pitch);
      _dir.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
      // Camera-right on the ground plane (yaw 0 → +X), for the shoulder shift.
      _right.set(Math.cos(yaw), 0, -Math.sin(yaw));

      // Shoulder pivot = chest height, slid right so the character sits left of
      // center. The boom hangs off this; the look target is the same point a
      // touch higher (headroom). Dip drops both.
      _pivot
        .set(_feet.x, _feet.y + TP_PIVOT_HEIGHT - _dip, _feet.z)
        .addScaledVector(_right, TP_SHOULDER_X);
      _look.copy(_pivot);
      _look.y += TP_SHOULDER_Y;

      // One backward ray from the shoulder pivot to find any wall behind us.
      if (!_ray) _ray = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
      _ray.origin.x = _pivot.x; _ray.origin.y = _pivot.y; _ray.origin.z = _pivot.z;
      _ray.dir.x = -_dir.x; _ray.dir.y = -_dir.y; _ray.dir.z = -_dir.z;
      let len = TP_DISTANCE;
      const hit = world.castRay(
        _ray,
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

      // Asymmetric boom smoothing: snap IN fast when a wall crowds us (never clip),
      // ease OUT slowly when the way clears (no pop).
      const rate = len < cameraRig.tpDistance ? SMOOTH_BOOM_IN : SMOOTH_BOOM;
      cameraRig.tpDistance += (len - cameraRig.tpDistance) * (1 - Math.exp(-rate * dt));

      // Desired position = pivot pulled back along -forward by the boom length.
      _desired.copy(_pivot).addScaledVector(_dir, -cameraRig.tpDistance);

      camera.position.lerp(_desired, 1 - Math.exp(-SMOOTH_CAM * dt));

      // Smooth the look target a hair so quick pivots glide instead of snapping,
      // then aim at it. Seed it on the first TP frame to avoid a swing-in.
      if (!_lookInit) { _lookSmooth.copy(_look); _lookInit = true; }
      else _lookSmooth.lerp(_look, 1 - Math.exp(-SMOOTH_LOOK * dt));
      camera.lookAt(_lookSmooth);
    }

    // De-occlude: now that the camera is placed, fade any actor caught between it
    // and the player (third-person mainly; harmless and cheap in first-person).
    deoccludeActors(camera, actor, dt);
  }, 10);

  return null;
}
