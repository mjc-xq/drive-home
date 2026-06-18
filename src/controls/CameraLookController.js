// CameraLookController — translates a single drag pointer (touch or mouse) into
// free-look camera deltas. It owns ONE active drag gesture: start() latches the
// initial pointer position, move() turns each subsequent pointer position into a
// pixel delta, scales it by the current orientation's LOOK_SENS, and ACCUMULATES
// it into an internal {lookX, lookY} buffer. The camera update loop calls
// consume() once per frame to read that accumulated delta and zero it, so each
// pixel of drag is applied to the camera exactly once.
//
// Deliberately tiny and renderer-agnostic (no three import): it only produces raw
// look deltas. It does NOT clamp pitch or wrap yaw — the camera owns PITCH_LIMITS
// and applies these deltas to its own state. It also doesn't write to the shared
// InputState directly; the owner wires consume() into state.lookX / state.lookY
// (or reads it however it likes). That keeps this class testable in isolation.

import { LOOK_SENS } from './types.js';

/**
 * @typedef {{ x: number, y: number }} LookSens
 */

/**
 * Single-pointer free-look controller. One instance per camera/session.
 *
 * Lifecycle per gesture: start(x,y) → move(x,y) … move(x,y) → end(). Between
 * frames the owner calls consume() to drain the accumulated delta. start/move/end
 * may be called for many gestures over the controller's lifetime; the accumulator
 * persists across gestures until consume() drains it.
 */
export class CameraLookController {
  /**
   * @param {Object} [opts]
   * @param {() => LookSens} [opts.sens] Returns the look sensitivity {x,y} to use
   *   for the CURRENT orientation. Called on every move() so rotating the device
   *   mid-drag picks up the right row. Defaults to LOOK_SENS.portrait so the
   *   controller is usable with no wiring.
   */
  constructor({ sens } = {}) {
    /**
     * Sensitivity provider — read fresh each move() so orientation changes apply
     * immediately. Falls back to a constant portrait lookup.
     * @type {() => LookSens}
     * @private
     */
    this._sens = typeof sens === 'function' ? sens : () => LOOK_SENS.portrait;

    /**
     * Whether a drag is currently active (between start() and end()). move() is a
     * no-op until start() latches a reference point.
     * @type {boolean}
     * @private
     */
    this._active = false;

    /**
     * Last seen pointer x/y (pixels). Each move() diffs against these, then
     * updates them, so deltas are incremental (not relative to the start point).
     * @type {number}
     * @private
     */
    this._lastX = 0;
    /** @type {number} @private */
    this._lastY = 0;

    /**
     * Accumulated, sensitivity-scaled look delta awaiting consumption. Additive
     * across every move() since the last consume(); drained (zeroed) by consume().
     * @type {number}
     * @private
     */
    this._lookX = 0;
    /** @type {number} @private */
    this._lookY = 0;
  }

  /**
   * Begin a drag gesture. Latches the pointer position as the reference for the
   * first move() and marks the controller active. Does NOT emit any delta itself.
   * @param {number} x Pointer x in pixels.
   * @param {number} y Pointer y in pixels.
   */
  start(x, y) {
    this._active = true;
    this._lastX = x;
    this._lastY = y;
  }

  /**
   * Advance the drag. Computes the pixel delta from the previous pointer
   * position, scales it by the current orientation's sensitivity, and adds it to
   * the look accumulator. No-op if no gesture is active (start() not called).
   * @param {number} x Pointer x in pixels.
   * @param {number} y Pointer y in pixels.
   */
  move(x, y) {
    if (!this._active) return;
    const dx = x - this._lastX;
    const dy = y - this._lastY;
    this._lastX = x;
    this._lastY = y;
    const s = this._sens() || LOOK_SENS.portrait;
    this._lookX += dx * s.x;
    this._lookY += dy * s.y;
  }

  /**
   * End the current drag gesture. Any accumulated delta REMAINS buffered for the
   * next consume() (ending a drag doesn't discard unread motion).
   */
  end() {
    this._active = false;
  }

  /**
   * Drain the accumulated look delta and zero the buffer. Call once per frame
   * from the camera update loop so each pixel of drag is applied exactly once.
   * @returns {{ lookX: number, lookY: number }} The delta since the last consume.
   */
  consume() {
    const lookX = this._lookX;
    const lookY = this._lookY;
    this._lookX = 0;
    this._lookY = 0;
    return { lookX, lookY };
  }
}
