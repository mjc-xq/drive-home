// A custom, dependency-free left-thumb virtual joystick (no nipplejs). PURE
// LOGIC only: it tracks one pointer, maps its offset-from-touch-down into a
// -1..1 vector, and exposes a small render-state object the React UI reads to
// draw the base + knob. It NEVER touches the DOM or three — the caller wires up
// pointer events and passes coordinates in.
//
// Floating-joystick model: the base re-centres wherever the thumb lands on
// touch-down (start), and the knob follows the thumb, clamped to the joystick
// radius. The output vector is offset / radius with the contract DEADZONE
// applied and magnitude clamped to 1.
//
// Convention: the input (x, y) are screen-space pixels (y grows DOWNWARD, as in
// pointer events). The output value uses moveX = right(+)/left(-) and
// moveY = forward(+)/back(-): pushing the thumb UP the screen (smaller y) is
// forward, so we negate the pixel-space dy. This matches InputState.moveX/moveY
// from src/controls/types.js so the caller can copy value.x/value.y straight in.

import { applyDeadzone, clamp } from './types.js';

/**
 * @typedef {Object} JoystickVector
 * @property {number} x  Strafe, right(+)/left(-), -1..1 (dead-zoned, clamped).
 * @property {number} y  Forward(+)/back(-), -1..1 (dead-zoned, clamped).
 */

/**
 * @typedef {Object} JoystickRenderState
 * @property {boolean} active  True while a pointer is captured (stick is down).
 * @property {number} baseX    Base centre x (screen px) — the touch-down point.
 * @property {number} baseY    Base centre y (screen px) — the touch-down point.
 * @property {number} knobX    Knob centre x (screen px), clamped to radius.
 * @property {number} knobY    Knob centre y (screen px), clamped to radius.
 */

/**
 * @typedef {Object} TouchJoystickOptions
 * @property {() => number} [getRadius]  Returns the joystick radius in px. The
 *   caller typically passes `() => Math.min(innerWidth * 0.16, 70)`. Defaults to
 *   a constant 70 if omitted.
 * @property {(vec: JoystickVector) => void} [onChange]  Called with the new
 *   value vector whenever it changes (on start, move, and end → {x:0,y:0}).
 */

/** Fallback radius (px) when no getRadius is supplied. */
const DEFAULT_RADIUS = 70;

/**
 * Custom floating virtual joystick. Create ONE per joystick zone; feed it
 * pointer-down / -move / -up coordinates and read `value` (or subscribe via
 * onChange) for the -1..1 move vector, and `renderState` for the UI.
 */
export class TouchJoystick {
  /**
   * @param {TouchJoystickOptions} [options]
   */
  constructor(options = {}) {
    /** @private */
    this._getRadius = typeof options.getRadius === 'function'
      ? options.getRadius
      : () => DEFAULT_RADIUS;
    /** @private */
    this._onChange = typeof options.onChange === 'function'
      ? options.onChange
      : null;

    /**
     * Pointer id we captured on start, or null when idle. Lets the caller route
     * only the matching pointer's move/up events to us in a multitouch scene.
     * @type {number|null}
     */
    this.pointerId = null;

    /**
     * Base centre = the screen point where the thumb first touched down. The
     * floating stick re-centres here every start.
     * @private
     */
    this._baseX = 0;
    /** @private */
    this._baseY = 0;

    /**
     * Current knob centre (screen px), already clamped to the radius.
     * @private
     */
    this._knobX = 0;
    /** @private */
    this._knobY = 0;

    /**
     * Public output vector, -1..1 on each axis (dead-zoned, magnitude-clamped).
     * Mutated in place — read `value.x` / `value.y` directly each frame.
     * @type {JoystickVector}
     */
    this.value = { x: 0, y: 0 };
  }

  /**
   * Whether a pointer is currently captured (the stick is being held).
   * @returns {boolean}
   */
  get active() {
    return this.pointerId !== null;
  }

  /**
   * Snapshot for the React UI to render the base ring + knob. Returns a fresh
   * object each call (cheap) so React sees a new reference and re-renders.
   * @returns {JoystickRenderState}
   */
  get renderState() {
    return {
      active: this.active,
      baseX: this._baseX,
      baseY: this._baseY,
      knobX: this._knobX,
      knobY: this._knobY,
    };
  }

  /**
   * Begin a drag. Re-centres the floating base at (x, y) and captures the
   * pointer. Knob starts exactly on the base, so the initial value is {0, 0}.
   * @param {number} pointerId  The PointerEvent.pointerId to capture.
   * @param {number} x  Touch-down x in screen px.
   * @param {number} y  Touch-down y in screen px.
   */
  start(pointerId, x, y) {
    this.pointerId = pointerId;
    this._baseX = x;
    this._baseY = y;
    this._knobX = x;
    this._knobY = y;
    this._setValue(0, 0);
  }

  /**
   * Update the drag. Computes the offset from the base, clamps the knob to the
   * joystick radius, and maps the (unclamped) offset to a -1..1 vector with the
   * contract dead-zone applied and magnitude clamped to 1. No-op if idle.
   * @param {number} x  Current pointer x in screen px.
   * @param {number} y  Current pointer y in screen px.
   */
  move(x, y) {
    if (!this.active) return;

    const radius = this._radius();
    const dx = x - this._baseX;
    const dy = y - this._baseY;
    const dist = Math.hypot(dx, dy);

    // Clamp the KNOB position to the rim so the UI ring never overflows, while
    // keeping its direction. (Pure render geometry.)
    if (dist > radius && dist > 0) {
      const k = radius / dist;
      this._knobX = this._baseX + dx * k;
      this._knobY = this._baseY + dy * k;
    } else {
      this._knobX = x;
      this._knobY = y;
    }

    // Normalise the raw offset to -1..1 per axis (offset / radius), clamp the
    // overall MAGNITUDE to 1 (round edge, not square), then dead-zone each axis.
    // Screen y grows downward, so negate dy to make "up the screen" = forward.
    const nx = clamp(dx / radius, -1, 1);
    const ny = clamp(-dy / radius, -1, 1);

    let mag = Math.hypot(nx, ny);
    let ux = nx;
    let uy = ny;
    if (mag > 1) {
      ux /= mag;
      uy /= mag;
      mag = 1;
    }

    // Radial dead-zone: kill output near centre, then re-scale the surviving
    // magnitude back to 0..1 so motion ramps smoothly from the dead-zone edge.
    const dzMag = applyDeadzone(mag);
    if (dzMag === 0 || mag === 0) {
      this._setValue(0, 0);
      return;
    }
    const scale = dzMag / mag;
    this._setValue(ux * scale, uy * scale);
  }

  /**
   * End the drag: release the pointer, reset the value to {0, 0}, and park the
   * knob back on the base. The caller hides the UI based on `active`.
   */
  end() {
    if (!this.active) return;
    this.pointerId = null;
    this._knobX = this._baseX;
    this._knobY = this._baseY;
    this._setValue(0, 0);
  }

  /**
   * Current joystick radius in px (always ≥ 1 to avoid divide-by-zero).
   * @private
   * @returns {number}
   */
  _radius() {
    const r = this._getRadius();
    return r > 1 ? r : 1;
  }

  /**
   * Write the value vector in place and fire onChange only when it actually
   * changed (avoids spamming React/state on no-op moves).
   * @private
   * @param {number} x
   * @param {number} y
   */
  _setValue(x, y) {
    if (this.value.x === x && this.value.y === y) return;
    this.value.x = x;
    this.value.y = y;
    if (this._onChange) this._onChange(this.value);
  }
}

export default TouchJoystick;
