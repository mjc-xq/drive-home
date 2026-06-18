// CharacterController — ONE shared, camera-relative movement model for the player
// avatar. There is deliberately NO desktop/mobile fork: every input source (touch
// joystick, keyboard, gamepad) funnels into the same InputState.moveX / moveY, so
// this class reads those two persisted axes and nothing else about WHERE the intent
// came from. Camera-relative means "push up on the stick" always walks the avatar
// toward the way the camera is facing, projected onto the flat ground — the classic
// third-person traversal feel.
//
// Pure kinematics: this moves and rotates the object every frame with zero collision
// or terrain awareness. The HOST scene is responsible for clamping the result (ground
// height, walls, NPC push-out, etc.) — either by overriding `move()` (see below) or by
// reading `velocity` and integrating position itself. Keeping collision OUT keeps this
// unit-testable and reusable across very different worlds.
//
// Depends only on three + the shared InputState shape from src/controls/types.js.

import * as THREE from 'three';

// Scratch vectors reused every update() so the hot path allocates nothing.
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _moveDir = new THREE.Vector3();
const _camQuat = new THREE.Quaternion();

// World up — movement is solved on the ground plane (y = 0), so both the camera
// forward and right basis vectors get their vertical component stripped.
const UP = new THREE.Vector3(0, 1, 0);

// Below this planar magnitude the avatar is treated as idle: we stop moving and stop
// re-aiming the yaw so a resting thumb / tiny residual axis doesn't cause drift or
// spin. Inputs should already be dead-zoned upstream (applyDeadzone), so this is just
// a final floor.
const IDLE_EPS = 1e-4;

/**
 * @typedef {import('../controls/types.js').InputState} InputState
 */

/**
 * Shared camera-relative character controller.
 *
 * Each frame, {@link CharacterController#update} converts the camera's facing into a
 * ground-plane basis, combines it with the joystick intent (`input.moveX/moveY`) into a
 * world move direction, advances `object.position`, and eases the object's yaw to FACE
 * that direction. It also publishes `velocity` and `moveMagnitude` so an animation layer
 * can blend idle → walk → run.
 */
export class CharacterController {
  /**
   * @param {Object} opts
   * @param {THREE.Object3D} opts.object  The avatar to drive (its position is moved and
   *   its yaw is rotated to face travel). Must live in world space (not parented under a
   *   moving rig) for the world-space math to read correctly.
   * @param {InputState} opts.input  The shared, per-session InputState. Read-only here —
   *   this class consumes `moveX` / `moveY` (persisted axes) and never writes to it.
   * @param {THREE.Camera} opts.camera  The camera whose facing defines "forward". Its
   *   world orientation is sampled each frame, so a chase cam that orbits the player
   *   naturally rotates the move basis with it.
   * @param {number} [opts.speed=4]  Max planar move speed in world units per second at
   *   full stick deflection.
   * @param {number} [opts.turnRate=12]  Yaw easing rate (1/seconds). Higher snaps to the
   *   travel direction faster; the easing is frame-rate-corrected so feel is constant at
   *   any FPS.
   */
  constructor({ object, input, camera, speed = 4, turnRate = 12 }) {
    /** @type {THREE.Object3D} Avatar driven by this controller. */
    this.object = object;
    /** @type {InputState} Shared input buffer (read-only here). */
    this.input = input;
    /** @type {THREE.Camera} Camera that defines the move basis. */
    this.camera = camera;

    /** @type {number} Max planar speed (world units / second) at full deflection. */
    this.speed = speed;
    /** @type {number} Yaw easing rate (1/seconds), frame-rate-corrected. */
    this.turnRate = turnRate;

    // World-space planar velocity from the LAST update(). y stays 0 (ground-plane
    // movement). The host can read this to do its own position integration / collision
    // instead of letting update() move the object directly.
    /** @type {THREE.Vector3} Last frame's world velocity (units/sec), y = 0. */
    this.velocity = new THREE.Vector3();

    // Current planar move magnitude, 0..1 (post dead-zone, pre-speed). An animation
    // layer reads this to pick idle (~0) / walk (mid) / run (~1). This is the magnitude
    // of the INTENT, not the realized speed, so it stays meaningful even if the host
    // cancels the actual motion via collision.
    /** @type {number} Planar move magnitude this frame, 0..1. */
    this.moveMagnitude = 0;
  }

  /**
   * Advance one frame.
   *
   * Steps: (1) build the camera-relative ground basis (forward + right, y-flattened,
   * normalized); (2) mix by the joystick axes into a world move direction; (3) if there's
   * intent, move the object and ease its yaw to face travel; (4) publish `velocity` /
   * `moveMagnitude`. When intent is below {@link IDLE_EPS} the avatar idles: no movement,
   * no re-aiming, velocity zeroed.
   *
   * @param {number} dt  Delta time in seconds since the previous frame.
   */
  update(dt) {
    const { input, camera } = this;

    // --- Camera-relative ground basis ----------------------------------------
    // Sample the camera's WORLD orientation (works even if it's nested in a rig).
    camera.getWorldQuaternion(_camQuat);

    // Forward = camera -Z, then flatten to the ground plane and normalize. If the
    // camera is looking nearly straight down, the flattened forward can collapse to
    // ~0; setLength/normalize on a near-zero vector would be unstable, so guard it.
    _forward.set(0, 0, -1).applyQuaternion(_camQuat);
    _forward.y = 0;
    if (_forward.lengthSq() < IDLE_EPS) {
      // Degenerate (camera straight up/down): fall back to the object's own facing so
      // movement still has a sane forward instead of snapping to a world axis.
      _forward.set(0, 0, 1).applyQuaternion(this.object.quaternion);
      _forward.y = 0;
    }
    _forward.normalize();

    // Right = forward × up (left-handed-safe via cross), already on the ground plane.
    _right.crossVectors(_forward, UP).normalize();

    // --- Mix joystick intent into a world move direction ----------------------
    // moveY drives forward(+)/back(-), moveX drives right(+)/left(-). Axes are expected
    // to be dead-zoned upstream; we just combine and clamp the magnitude to 1 so a
    // diagonal isn't faster than a cardinal push.
    _moveDir
      .copy(_forward).multiplyScalar(input.moveY)
      .addScaledVector(_right, input.moveX);

    const mag = _moveDir.length();
    this.moveMagnitude = mag > 1 ? 1 : mag;

    if (mag < IDLE_EPS) {
      // Idle: zero velocity, leave position and yaw untouched (no drift, no spin).
      this.velocity.set(0, 0, 0);
      return;
    }

    // Normalize the direction; speed scales by the clamped magnitude so partial stick
    // deflection gives partial speed (the dead-zone already re-normalized 0..1).
    _moveDir.divideScalar(mag);
    const speed = this.speed * this.moveMagnitude;

    // --- Move ----------------------------------------------------------------
    this.velocity.copy(_moveDir).multiplyScalar(speed);
    // Route through move() so a host can subclass/override it to inject collision.
    this.move(this.velocity, dt);

    // --- Face travel (eased, frame-rate-correct) ------------------------------
    this._faceDirection(_moveDir, dt);
  }

  /**
   * Apply one frame of translation. Default behavior is pure kinematics:
   * `position += velocity * dt`. HOSTS THAT NEED COLLISION should override this — e.g.
   * sweep the proposed delta against the world, clamp to ground height, resolve wall
   * penetration — while still being handed the intended world velocity. Kept as its own
   * method precisely so that wrap is a one-method override with no fork of update().
   *
   * @param {THREE.Vector3} velocity  Intended world velocity (units/sec), y = 0.
   * @param {number} dt  Delta time in seconds.
   */
  move(velocity, dt) {
    this.object.position.addScaledVector(velocity, dt);
  }

  /**
   * Ease the object's yaw toward `dir` (a normalized ground-plane direction) so it FACES
   * the way it's travelling. The lerp factor uses 1 - exp(-turnRate * dt) so the angular
   * approach is identical regardless of frame rate (a fixed per-second easing), avoiding
   * the faster-turn-at-higher-FPS bug of a raw `slerp(target, k)`.
   *
   * @param {THREE.Vector3} dir  Normalized ground-plane travel direction.
   * @param {number} dt  Delta time in seconds.
   * @private
   */
  _faceDirection(dir, dt) {
    // Desired yaw: atan2 of the planar direction. We build the world-space "look along
    // dir, stay upright" rotation directly rather than via lookAt(point) to avoid a
    // temporary target and any roll/pitch leaking in.
    const targetYaw = Math.atan2(dir.x, dir.z);
    _camQuat.setFromAxisAngle(UP, targetYaw); // reuse scratch quat as the target

    // Frame-rate-correct easing factor in [0,1].
    const t = 1 - Math.exp(-this.turnRate * dt);
    this.object.quaternion.slerp(_camQuat, t);
  }
}

export default CharacterController;
