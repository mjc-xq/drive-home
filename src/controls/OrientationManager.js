// Detect + broadcast device orientation (portrait vs landscape) for the staged
// mobile-controls modules. This is a pure REPORTER: it watches the viewport and
// fires a single onChange callback whenever the orientation flips, so layouts,
// look sensitivities (LOOK_SENS) and the chase-camera preset (CAMERA_PRESET) can
// recalc against the right row. It deliberately does NOT touch the camera,
// player, or any movement/input state — rotating the device should never teleport
// the player or reset where they're looking; only the *presentation* recalcs.
//
// Self-contained: depends only on the DOM (window). No three, no types.js
// import — orientation is just two strings and a boolean.

/**
 * @typedef {'portrait'|'landscape'} Orientation
 */

/**
 * @typedef {Object} OrientationManagerOptions
 * @property {(orientation: Orientation) => void} [onChange]
 *   Called with the NEW orientation each time it flips. Never called on
 *   construction (read `current` for the initial value). Not called when a
 *   resize keeps the same orientation.
 */

/**
 * Watches the viewport and reports portrait/landscape transitions.
 *
 * Orientation is derived from viewport shape — `innerHeight > innerWidth` is
 * portrait — rather than the `screen.orientation` API, because that matches what
 * the WebGL canvas + CSS layout actually see (split-screen, soft-keyboard, and
 * desktop window resizes all change the usable box without a true device
 * rotation, and we want to respond to all of them).
 *
 * Listeners are coalesced through a single rAF so a burst of `resize` events
 * (e.g. an animated rotation, or a dragged desktop window) results in at most one
 * orientation check per frame, and `onChange` only fires on an actual flip.
 *
 * @example
 * const om = new OrientationManager({
 *   onChange: (o) => applyPreset(CAMERA_PRESET[o], LOOK_SENS[o]),
 * });
 * applyPreset(CAMERA_PRESET[om.current]); // seed the initial layout yourself
 * // ...later, on teardown:
 * om.dispose();
 */
export class OrientationManager {
  /**
   * @param {OrientationManagerOptions} [options]
   */
  constructor({ onChange } = {}) {
    /** @type {((orientation: Orientation) => void) | null} */
    this._onChange = typeof onChange === 'function' ? onChange : null;

    /** @type {Orientation} Last-reported orientation. */
    this._current = OrientationManager.read();

    /** @type {number} Pending rAF handle (0 = none scheduled). */
    this._raf = 0;

    /** @type {boolean} Guards against double-dispose / post-dispose callbacks. */
    this._disposed = false;

    // Bind once so add/removeEventListener see the same function reference.
    this._onViewportEvent = this._onViewportEvent.bind(this);
    this._check = this._check.bind(this);

    // `resize` covers desktop window changes, split-screen and the soft keyboard;
    // `orientationchange` covers the dedicated mobile rotation event. We coalesce
    // both into one rAF, so subscribing to both is cheap and just makes us robust
    // across browsers that fire one but not the other.
    window.addEventListener('resize', this._onViewportEvent, { passive: true });
    window.addEventListener('orientationchange', this._onViewportEvent, { passive: true });
  }

  /**
   * Read the current orientation straight from the viewport (no caching). A
   * perfectly square viewport counts as landscape (height is not strictly
   * greater than width).
   * @returns {Orientation}
   */
  static read() {
    return window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';
  }

  /**
   * The most recently reported orientation. Read this for the initial value
   * right after construction (onChange does not fire on construction).
   * @returns {Orientation}
   */
  get current() {
    return this._current;
  }

  /**
   * Convenience boolean mirror of `current`.
   * @returns {boolean}
   */
  get isPortrait() {
    return this._current === 'portrait';
  }

  /**
   * Viewport-event handler: schedule a single coalesced check on the next frame.
   * Multiple events before that frame collapse into one check.
   * @private
   */
  _onViewportEvent() {
    if (this._disposed || this._raf !== 0) return;
    this._raf = window.requestAnimationFrame(this._check);
  }

  /**
   * Coalesced check (runs once per animation frame at most). Re-reads the
   * orientation and, only on an actual flip, updates `current` and fires
   * onChange.
   * @private
   */
  _check() {
    this._raf = 0;
    if (this._disposed) return;

    const next = OrientationManager.read();
    if (next === this._current) return; // resize that kept the same orientation

    this._current = next;
    if (this._onChange) this._onChange(next);
  }

  /**
   * Detach listeners, cancel any pending frame, and release the callback. Safe
   * to call more than once. After disposal no further onChange fires.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    if (this._raf !== 0) {
      window.cancelAnimationFrame(this._raf);
      this._raf = 0;
    }

    window.removeEventListener('resize', this._onViewportEvent);
    window.removeEventListener('orientationchange', this._onViewportEvent);

    this._onChange = null;
  }
}
