// Desktop keyboard driver for the staged mobile-controls system. Maps WASD /
// arrow keys onto the shared InputState's camera-relative move axes and Space
// onto the jump flag — the desktop counterpart to the on-screen joystick.
//
// SCOPE: keys only. Mouse drag (free-look) and the scroll wheel (zoom) are owned
// by the look / pinch controllers, NOT here — this module never touches lookX,
// lookY, or zoomDelta.
//
// Self-contained: depends only on the shared contract in ./types.js. Construct
// once per session (it attaches its own window listeners) and call update(state)
// each frame BEFORE the loop reads moveX/moveY/jump; call dispose() to detach.

import { clamp } from './types.js';

/**
 * Translates held keyboard keys into the shared InputState's move axes + jump.
 *
 * Usage:
 *   const kb = new KeyboardControls();      // attaches window key listeners
 *   // ...each frame, before reading the state:
 *   kb.update(inputState);                  // writes moveX / moveY / jump
 *   // ...on teardown:
 *   kb.dispose();                           // removes the listeners
 */
export class KeyboardControls {
  constructor() {
    /**
     * Set of currently-held key identifiers (lowercased KeyboardEvent.key, e.g.
     * 'w', 'arrowup', ' '). We track held state rather than firing on the
     * keydown edge so update() can be polled once per frame.
     * @type {Set<string>}
     * @private
     */
    this._held = new Set();

    // No-op guard for SSR / non-browser (no window): nothing to attach to.
    if (typeof window === 'undefined') {
      this._onKeyDown = null;
      this._onKeyUp = null;
      return;
    }

    // Bound handlers stored so dispose() can remove the exact same references.
    this._onKeyDown = (e) => {
      const k = this._normalize(e);
      if (k === null) return;
      this._held.add(k);
    };
    this._onKeyUp = (e) => {
      const k = this._normalize(e);
      if (k === null) return;
      this._held.delete(k);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  /**
   * Map a KeyboardEvent to the lowercased key id we track, or null if it's a key
   * we don't care about. Repeat keydown events (autorepeat) are harmless since we
   * store in a Set.
   * @param {KeyboardEvent} e
   * @returns {string|null}
   * @private
   */
  _normalize(e) {
    const k = e.key.toLowerCase();
    switch (k) {
      case 'w':
      case 'a':
      case 's':
      case 'd':
      case 'arrowup':
      case 'arrowdown':
      case 'arrowleft':
      case 'arrowright':
      case ' ':       // Space — jump
      case 'spacebar': // legacy key name on some older browsers
        return k;
      default:
        return null;
    }
  }

  /**
   * Write the current key state into the shared InputState. Computes raw -1..1
   * move intent from the held keys, then normalizes the (x, y) vector so a
   * diagonal isn't faster than a cardinal move. Sets jump from Space.
   *
   * moveX: right(+) / left(-)  (D / ArrowRight = +1, A / ArrowLeft = -1)
   * moveY: forward(+) / back(-) (W / ArrowUp = +1, S / ArrowDown = -1)
   *
   * @param {import('./types.js').InputState} state Shared input buffer to write.
   */
  update(state) {
    const held = this._held;

    let x = 0;
    let y = 0;
    if (held.has('d') || held.has('arrowright')) x += 1;
    if (held.has('a') || held.has('arrowleft')) x -= 1;
    if (held.has('w') || held.has('arrowup')) y += 1;
    if (held.has('s') || held.has('arrowdown')) y -= 1;

    // Normalize so diagonals (|v| = √2) aren't faster than cardinals (|v| = 1).
    const mag = Math.hypot(x, y);
    if (mag > 1) {
      x /= mag;
      y /= mag;
    }

    // clamp defends against any future multi-key sums creeping past the range.
    state.moveX = clamp(x, -1, 1);
    state.moveY = clamp(y, -1, 1);
    state.jump = held.has(' ') || held.has('spacebar');
  }

  /**
   * Detach the window listeners and forget held keys. Safe to call when no
   * listeners were attached (SSR construction) and idempotent.
   */
  dispose() {
    if (typeof window !== 'undefined') {
      if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
      if (this._onKeyUp) window.removeEventListener('keyup', this._onKeyUp);
    }
    this._onKeyDown = null;
    this._onKeyUp = null;
    this._held.clear();
  }
}
