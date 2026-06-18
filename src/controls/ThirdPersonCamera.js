// Smooth third-person follow ("chase") camera. STAGED, standalone module: it
// reads the shared InputState (free-look + pinch-zoom) and orbits a fixed boom
// around a target Object3D, easing toward the desired pose every frame so motion
// stays buttery on jittery touch input. Depends only on three + the shared
// controls contract — it does NOT touch the live engine.
//
// Coordinate model: a spherical boom (yaw, pitch, distance) anchored at the
// target's position + a vertical targetHeight offset. yaw is rotation about the
// world Y axis (0 = camera behind the target looking down -Z is NOT assumed; see
// _sphericalOffset for the exact mapping); pitch tilts the boom up/down and is
// HARD-CLAMPED to PITCH_LIMITS so the boom can never cross the poles — that
// clamp is the entire reason there's no gimbal flip or look-at jitter.

import * as THREE from 'three';
import { clamp, PITCH_LIMITS, CAMERA_PRESET } from './types.js';

// Exponential-smoothing rate (1/seconds). Higher = snappier follow. The lerp
// alpha is derived per-frame as 1-exp(-dt*k) so the SETTLING SPEED is identical
// regardless of frame rate (a naive constant alpha would chase faster at high
// FPS). k≈12 settles ~63% of the gap in ~83ms — tight but not twitchy.
const SMOOTH_K = 12;

/**
 * @typedef {Object} ThirdPersonCameraOptions
 * @property {THREE.PerspectiveCamera|THREE.Camera} camera The camera to drive.
 * @property {THREE.Object3D|{position: THREE.Vector3}} target Followed object (anything with a .position).
 * @property {import('./types.js').InputState} input Shared input buffer (look/zoom are consumed here).
 * @property {number} [distance] Initial boom length (metres). Defaults to the orientation preset.
 * @property {number} [minDistance] Min zoom distance (metres). Default 3.
 * @property {number} [maxDistance] Max zoom distance (metres). Default 12.
 * @property {number} [targetHeight] Look-at height above target origin (metres). Defaults to preset.
 * @property {import('./types.js').Orientation} [orientation] 'portrait' | 'landscape'. Default 'portrait'.
 */

/**
 * Smooth third-person follow camera.
 *
 * Per frame, call {@link ThirdPersonCamera#update} with the frame delta. It
 * consumes accumulated look + zoom from the shared InputState, integrates them
 * into the public {@link ThirdPersonCamera#yaw}/{@link ThirdPersonCamera#pitch}/
 * {@link ThirdPersonCamera#distance} state, then eases the camera toward the
 * resulting pose. yaw/pitch/distance are PUBLIC and survive orientation changes
 * — {@link ThirdPersonCamera#setOrientation} only swaps the *default* tuning, it
 * never stomps the live values.
 */
export class ThirdPersonCamera {
  /**
   * @param {ThirdPersonCameraOptions} opts
   */
  constructor({
    camera,
    target,
    input,
    distance,
    minDistance,
    maxDistance,
    targetHeight,
    orientation = 'portrait',
  }) {
    /** @type {THREE.Camera} */
    this.camera = camera;
    /** @type {THREE.Object3D|{position: THREE.Vector3}} */
    this.target = target;
    /** @type {import('./types.js').InputState} */
    this.input = input;
    /** @type {import('./types.js').Orientation} */
    this.orientation = orientation;

    const preset = CAMERA_PRESET[orientation] || CAMERA_PRESET.portrait;

    // --- Public, live orbit state (read/write freely; preserved across setOrientation) ---
    /** Yaw about world Y (radians), unbounded/free-spinning. @type {number} */
    this.yaw = 0;
    /** Pitch of the boom (radians), clamped to PITCH_LIMITS. @type {number} */
    this.pitch = preset.pitch;
    /** Boom length (metres), clamped to [minDistance, maxDistance]. @type {number} */
    this.distance = distance != null ? distance : preset.distance;
    /** @type {number} */
    this.minDistance = minDistance != null ? minDistance : 3;
    /** @type {number} */
    this.maxDistance = maxDistance != null ? maxDistance : 12;
    /** Vertical look-at offset above the target origin (metres). @type {number} */
    this.targetHeight = targetHeight != null ? targetHeight : preset.targetHeight;

    // Keep the starting values inside their legal ranges from the outset.
    this.pitch = clamp(this.pitch, PITCH_LIMITS.min, PITCH_LIMITS.max);
    this.distance = clamp(this.distance, this.minDistance, this.maxDistance);

    // Scratch vectors reused every frame — never allocate inside update().
    /** @private */ this._desired = new THREE.Vector3();
    /** @private */ this._lookAt = new THREE.Vector3();
    /** @private */ this._offset = new THREE.Vector3();

    // Snap the camera to the correct pose on construction so the very first
    // frame doesn't start with a visible lerp from wherever the camera was.
    this.snap();
  }

  /**
   * Compute the boom offset (camera position relative to the look-at point) for
   * the current yaw/pitch/distance, writing it into the supplied vector.
   *
   * Mapping: at pitch 0 and yaw 0 the camera sits at +Z behind the look-at
   * point (a standard "looking down -Z" rest pose). Positive pitch raises the
   * camera (it looks DOWN at the target), matching the preset's resting tilt.
   * Because pitch is clamped well inside ±π/2 the boom never reaches a pole, so
   * the horizontal component never collapses and lookAt stays stable.
   * @private
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3} out
   */
  _sphericalOffset(out) {
    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);
    const horiz = this.distance * cosP;
    out.set(
      horiz * Math.sin(this.yaw),
      this.distance * sinP, // +pitch -> camera above target -> looks down
      horiz * Math.cos(this.yaw),
    );
    return out;
  }

  /**
   * Current world-space look-at point: target origin + (0, targetHeight, 0).
   * @private
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3} out
   */
  _lookAtPoint(out) {
    const p = this.target.position;
    out.set(p.x, p.y + this.targetHeight, p.z);
    return out;
  }

  /**
   * Advance the camera one frame.
   *
   * 1. CONSUME look: add input.lookX -> yaw, input.lookY -> pitch, then zero
   *    them (the buffer accumulates between frames; we drain it here). pitch is
   *    hard-clamped to PITCH_LIMITS so it can never flip past the poles.
   * 2. CONSUME zoom: add input.zoomDelta -> distance, clamp to bounds, zero it.
   * 3. EASE position toward target + height + spherical(yaw,pitch,distance)
   *    using a frame-rate-correct exponential lerp, then lookAt the target.
   *
   * @param {number} dt Frame delta in seconds.
   */
  update(dt) {
    const input = this.input;

    // 1) Drain accumulated free-look. lookX/lookY are already scaled by
    //    LOOK_SENS upstream, so they add straight into yaw/pitch radians.
    if (input) {
      this.yaw += input.lookX;
      this.pitch += input.lookY;
      input.lookX = 0;
      input.lookY = 0;
      // 2) Drain accumulated zoom (pinch/wheel), then bound the boom.
      this.distance += input.zoomDelta;
      input.zoomDelta = 0;
    }

    // Hard clamp pitch INSIDE the poles — this is what prevents flip/jitter.
    this.pitch = clamp(this.pitch, PITCH_LIMITS.min, PITCH_LIMITS.max);
    this.distance = clamp(this.distance, this.minDistance, this.maxDistance);

    // 3) Desired pose = look-at point + boom offset.
    const lookAt = this._lookAtPoint(this._lookAt);
    const desired = this._desired.copy(lookAt).add(this._sphericalOffset(this._offset));

    // Frame-rate-correct exponential smoothing: alpha = 1 - e^(-dt*k). This
    // yields the SAME settling speed at any FPS (a fixed alpha would over-chase
    // at high frame rates). Guard dt<=0 so a paused/zero frame is a clean snap.
    const alpha = dt > 0 ? 1 - Math.exp(-dt * SMOOTH_K) : 1;
    this.camera.position.lerp(desired, alpha);
    this.camera.lookAt(lookAt);
  }

  /**
   * Teleport the camera to its exact desired pose with no smoothing. Useful on
   * spawn, respawn, or teleport so the boom doesn't visibly slide into place.
   */
  snap() {
    const lookAt = this._lookAtPoint(this._lookAt);
    this.camera.position.copy(lookAt).add(this._sphericalOffset(this._offset));
    this.camera.lookAt(lookAt);
  }

  /**
   * Switch orientation preset. Swaps the DEFAULT distance / targetHeight / pitch
   * to the new orientation's CAMERA_PRESET row — but ONLY for fields the caller
   * hasn't diverged from the old preset on, so an active zoom or look is
   * preserved. The live yaw is always preserved (it has no preset). No-ops if
   * the orientation is unchanged or unknown.
   * @param {import('./types.js').Orientation} o
   */
  setOrientation(o) {
    const next = CAMERA_PRESET[o];
    if (!next || o === this.orientation) return;
    const prev = CAMERA_PRESET[this.orientation] || CAMERA_PRESET.portrait;

    // Only retarget a default if the user hasn't manually moved it off the old
    // preset value; otherwise their live tweak (zoom/pitch) wins and is kept.
    if (this.distance === prev.distance) {
      this.distance = clamp(next.distance, this.minDistance, this.maxDistance);
    }
    if (this.targetHeight === prev.targetHeight) {
      this.targetHeight = next.targetHeight;
    }
    if (this.pitch === prev.pitch) {
      this.pitch = clamp(next.pitch, PITCH_LIMITS.min, PITCH_LIMITS.max);
    }

    this.orientation = o;
  }
}
