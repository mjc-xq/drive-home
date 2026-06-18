// Two-finger pinch + desktop mouse-wheel -> accumulated zoom delta. Standalone,
// depends only on the shared contract (no three import). It does NOT touch the
// camera or know about distance: it just measures gestures and accumulates a raw
// zoomDelta. The camera/update loop calls consume() once per frame, applies the
// delta to its boom length, and clamps the result to ZOOM_LIMITS — this class is
// deliberately ignorant of those limits so it stays a pure gesture measurer.
//
// Sign convention: zoomDelta > 0 means "zoom IN" (get closer / shrink boom).
//  - Pinch IN  (fingers move together, distance shrinks) -> prevDist - dist > 0 -> zoom in.
//  - Pinch OUT (fingers spread, distance grows)          -> prevDist - dist < 0 -> zoom out.
//  - Wheel: scrolling up (deltaY < 0, the platform convention for "zoom in") maps
//    to a positive delta.
//
// Multitouch ownership lives in the higher-level router; this controller only
// acts as a pinch when EXACTLY two pointers are tracked. A 1st/3rd/Nth finger is
// still recorded so the gesture starts/stops cleanly, but only the two-pointer
// state produces pinch deltas.

import { ZOOM_LIMITS } from '../controls/types.js';

/**
 * Pixels of finger-separation change -> zoom-delta scale. Pinch distance is in
 * raw CSS pixels, which would be a huge number relative to the boom range
 * (ZOOM_LIMITS spans ~9 metres), so scale it down to metres-per-frame-ish.
 * @type {number}
 */
const PINCH_SCALE = 0.02;

/**
 * Mouse-wheel deltaY -> zoom-delta scale. One notch of a typical wheel is
 * deltaY ≈ ±100 (DOM_DELTA_PIXEL); this maps a notch to ~0.5 m of boom travel.
 * Negated because wheel-up (deltaY < 0) should zoom IN (positive delta).
 * @type {number}
 */
const WHEEL_SCALE = 0.005;

/**
 * Tracks two-pointer pinch gestures and desktop wheel events, accumulating a raw
 * zoom delta that the camera consumes once per frame.
 *
 * Usage:
 *   const zoom = new PinchZoomController();
 *   // on pointer events (touch/mouse):
 *   zoom.addPointer(e.pointerId, e.clientX, e.clientY);
 *   zoom.movePointer(e.pointerId, e.clientX, e.clientY);
 *   zoom.removePointer(e.pointerId);
 *   // on wheel events:
 *   zoom.wheel(e.deltaY);
 *   // once per frame, in the update loop:
 *   const dz = zoom.consume(); // accumulated delta, then zeroed
 */
export class PinchZoomController {
  constructor() {
    /**
     * Active pointers, id -> { x, y }. Only when this holds EXACTLY two entries
     * do moves produce pinch deltas.
     * @type {Map<number, { x: number, y: number }>}
     * @private
     */
    this._pointers = new Map();

    /**
     * Last measured separation between the two active pointers (pixels), or null
     * when not in a two-pointer pinch. Reset whenever we enter/leave the
     * two-pointer state so the first move after a finger lands/lifts produces no
     * spurious jump.
     * @type {number|null}
     * @private
     */
    this._prevDist = null;

    /**
     * Accumulated zoom delta since the last consume(). Positive = zoom in.
     * @type {number}
     * @private
     */
    this._zoomDelta = 0;
  }

  /**
   * Register a new pointer (finger / mouse) as down. If this brings the active
   * count to exactly two, the pinch baseline is (re)seeded so the next move
   * measures change from here rather than emitting a jump.
   * @param {number} id Pointer id (e.g. PointerEvent.pointerId).
   * @param {number} x  Client X in CSS pixels.
   * @param {number} y  Client Y in CSS pixels.
   * @returns {void}
   */
  addPointer(id, x, y) {
    this._pointers.set(id, { x, y });
    // Entering (or re-seeding) the two-pointer state: capture the baseline gap.
    this._prevDist = this._pointers.size === 2 ? this._currentDist() : null;
  }

  /**
   * Update a tracked pointer's position. While exactly two pointers are active,
   * the change in their separation since the previous move accumulates into the
   * zoom delta (pinch in -> positive). Moves with any other pointer count are
   * tracked but emit nothing.
   * @param {number} id Pointer id.
   * @param {number} x  Client X in CSS pixels.
   * @param {number} y  Client Y in CSS pixels.
   * @returns {void}
   */
  movePointer(id, x, y) {
    const p = this._pointers.get(id);
    if (!p) return; // move for an untracked pointer — ignore.
    p.x = x;
    p.y = y;

    if (this._pointers.size !== 2) return;

    const dist = this._currentDist();
    if (this._prevDist !== null) {
      // prevDist - dist: pinching IN shrinks dist -> positive delta -> zoom in.
      this._zoomDelta += (this._prevDist - dist) * PINCH_SCALE;
    }
    this._prevDist = dist;
  }

  /**
   * Remove a pointer that went up / was cancelled. Dropping out of the
   * two-pointer state clears the pinch baseline so a later pinch starts fresh;
   * if exactly two remain, the baseline is re-seeded from the survivors.
   * @param {number} id Pointer id.
   * @returns {void}
   */
  removePointer(id) {
    this._pointers.delete(id);
    this._prevDist = this._pointers.size === 2 ? this._currentDist() : null;
  }

  /**
   * Desktop mouse-wheel -> zoom delta. Wheel-up (deltaY < 0) zooms IN (positive
   * delta). The camera clamps the resulting distance to ZOOM_LIMITS.
   * @param {number} deltaY WheelEvent.deltaY (positive = scroll down/away).
   * @returns {void}
   */
  wheel(deltaY) {
    this._zoomDelta += -deltaY * WHEEL_SCALE;
  }

  /**
   * Return the accumulated zoom delta and reset it to zero. Call once per frame
   * from the update loop. Positive = zoom in. The caller applies it to the boom
   * length and clamps to ZOOM_LIMITS (re-exported here for callers' convenience).
   * @returns {number} Accumulated zoom delta since the last consume().
   */
  consume() {
    const dz = this._zoomDelta;
    this._zoomDelta = 0;
    return dz;
  }

  /**
   * Euclidean distance (CSS pixels) between the two currently tracked pointers.
   * Only meaningful when exactly two are active; iterates the (size-2) map.
   * @returns {number}
   * @private
   */
  _currentDist() {
    const it = this._pointers.values();
    const a = it.next().value;
    const b = it.next().value;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }
}

// Re-exported so a consumer can clamp the post-application distance without a
// second import. The controller itself never references it for emission.
export { ZOOM_LIMITS };
