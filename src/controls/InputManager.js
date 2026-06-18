// Central input manager: the ONE object the engine constructs to get unified,
// multitouch-safe player input on phones, tablets, and desktop. It owns the
// shared InputState, all sub-controllers (joystick, free-look, pinch-zoom,
// keyboard, orientation), and the TOUCH-OWNERSHIP arbiter that guarantees a
// given pointer drives exactly ONE single-finger system at a time.
//
// Wiring at a glance:
//   pointerdown  -> pinch.addPointer (always); if it's the FIRST finger, zone-
//                   classify it to JOYSTICK or CAMERA; a SECOND finger ends the
//                   single-finger gesture and we're in PINCH until back to <2.
//   pointermove  -> pinch.movePointer (always) + route to the owning single-ctrl
//   pointerup    -> pinch.removePointer (always) + end the owning single-ctrl
//   wheel        -> desktop zoom straight into PinchZoomController
//   update(dt)   -> fold every sub-ctrl's contribution into this.state
//
// Ownership rules (spec):
//   first finger, left side  -> JOYSTICK     first finger, right side -> CAMERA
//   any second finger        -> PINCH (zoom; the single gesture is ended)
//   UI elements stopPropagation, so their pointers never reach this canvas.
//   A pointer NEVER drives two single-finger systems at once.
//
// Public API (exactly):
//   new InputManager(canvas, opts?)
//   .state            -> shared InputState (read every frame by the loop)
//   .update(dt)       -> fold sub-ctrl outputs into .state
//   .setOrientation(o)-> 'portrait' | 'landscape'; live, no state reset
//   .joystick         -> render-state object for the on-screen UI
//   .requestJump()    -> queue a one-frame jump (the mobile Jump button)
//   .dispose()        -> detach all listeners, free sub-controllers

import { createInputState, PointerOwner, clamp, LOOK_SENS } from './types.js';
import { TouchJoystick } from './TouchJoystick.js';
import { CameraLookController } from './CameraLookController.js';
import { PinchZoomController } from './PinchZoomController.js';
import { KeyboardControls } from './KeyboardControls.js';
import { OrientationManager } from './OrientationManager.js';

/** @typedef {import('./types.js').InputState} InputState */
/** @typedef {'portrait'|'landscape'} Orientation */

export class InputManager {
  /**
   * @param {HTMLCanvasElement} canvas Render canvas. MUST have CSS touch-action:none.
   * @param {{orientation?:Orientation, keyboard?:boolean, wheel?:boolean}} [opts]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    /** The single shared input buffer — mutated in place, never replaced. @type {InputState} */
    this.state = createInputState();

    // sub-controllers (each integrates whatever pointer the manager routes to it)
    this.joystickCtrl = new TouchJoystick();
    this.lookCtrl = new CameraLookController({ sens: () => LOOK_SENS[this.orientation] });   // sens follows the live orientation
    this.pinchCtrl = new PinchZoomController();
    this.keyboardCtrl = opts.keyboard === false ? null : new KeyboardControls();
    this.orientationCtrl = new OrientationManager({ onChange: (o) => this._onOrientation(o) });

    this.orientation = opts.orientation || this.orientationCtrl.current || 'portrait';
    this.state.orientation = this.orientation;

    // single-finger ownership: which pointerId currently drives the stick / look.
    this._joyId = null;
    this._lookId = null;
    this._down = new Set();          // every pointerId currently down on the canvas
    this._pinching = false;          // true while ≥2 fingers are down (zoom mode)
    this._jumpQueued = false;        // one-frame jump from the mobile button
    this._allowWheel = opts.wheel !== false;

    for (const m of ['_onPointerDown', '_onPointerMove', '_onPointerUp', '_onWheel']) this[m] = this[m].bind(this);
    this._attach();
  }

  // ---- public ---------------------------------------------------------------

  /** Render-state for the on-screen joystick UI ({active, baseX, baseY, knobX, knobY}). */
  get joystick() { return this.joystickCtrl.renderState; }

  /** Queue a single-frame jump (wired to the mobile Jump button). */
  requestJump() { this._jumpQueued = true; }

  /**
   * Fold every sub-controller's contribution into the shared InputState. Call once
   * per frame BEFORE the player/camera read this.state. moveX/moveY are a live
   * vector (joystick takes priority, else keyboard); lookX/lookY/zoomDelta are
   * CONSUMED (read+zeroed) so each accumulated delta is applied exactly once.
   * @param {number} dt
   */
  update(dt) {
    const s = this.state;
    const stick = this.joystickCtrl.value;                 // already dead-zoned, -1..1
    const stickActive = stick.x !== 0 || stick.y !== 0;
    let kbJump = false;
    if (stickActive) { s.moveX = stick.x; s.moveY = stick.y; }
    else if (this.keyboardCtrl) { this.keyboardCtrl.update(s); kbJump = s.jump; s.moveX = clamp(s.moveX, -1, 1); s.moveY = clamp(s.moveY, -1, 1); }
    else { s.moveX = 0; s.moveY = 0; }

    s.jump = kbJump || this._jumpQueued; this._jumpQueued = false;

    const look = this.lookCtrl.consume();                  // { lookX, lookY }, then zeroed
    s.lookX = look.lookX; s.lookY = look.lookY;
    s.zoomDelta = this.pinchCtrl.consume();                // accumulated, then zeroed
    s.orientation = this.orientation;
  }

  /** Force orientation (portrait/landscape) live — no pointer/camera/move reset. */
  setOrientation(o) { if (o === 'portrait' || o === 'landscape') this._applyOrientation(o); }

  /** Detach everything and free sub-controllers. Idempotent. */
  dispose() {
    this._detach();
    this._down.clear(); this._joyId = this._lookId = null; this._pinching = false;
    this.keyboardCtrl?.dispose?.();
    this.orientationCtrl.dispose?.();
  }

  // ---- listeners ------------------------------------------------------------

  _attach() {
    const c = this.canvas;
    c.addEventListener('pointerdown', this._onPointerDown);
    c.addEventListener('pointermove', this._onPointerMove);
    c.addEventListener('pointerup', this._onPointerUp);
    c.addEventListener('pointercancel', this._onPointerUp);
    if (this._allowWheel) c.addEventListener('wheel', this._onWheel, { passive: false });
  }

  _detach() {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onPointerDown);
    c.removeEventListener('pointermove', this._onPointerMove);
    c.removeEventListener('pointerup', this._onPointerUp);
    c.removeEventListener('pointercancel', this._onPointerUp);
    c.removeEventListener('wheel', this._onWheel);
  }

  // ---- ownership ------------------------------------------------------------

  // first finger: left side drives the stick, right side free-looks (landscape
  // widens the look area a touch). UI buttons stopPropagation, so they never land here.
  _classifyZone(clientX) {
    const r = this.canvas.getBoundingClientRect();
    const lx = clientX - r.left, w = r.width || 1;
    const split = this.orientation === 'landscape' ? w * 0.45 : w * 0.5;
    return lx <= split ? PointerOwner.JOYSTICK : PointerOwner.CAMERA;
  }

  _onPointerDown(e) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    this._down.add(e.pointerId);
    this.pinchCtrl.addPointer(e.pointerId, e.clientX, e.clientY);   // pinch tracks its own set; only acts on 2

    if (this._down.size >= 2) {
      // a second finger → we're zooming: end any in-flight single-finger gesture so it can't fight
      if (this._joyId != null) { this.joystickCtrl.end(); this._joyId = null; }
      if (this._lookId != null) { this.lookCtrl.end(); this._lookId = null; }
      this._pinching = true;
      return;
    }
    // first finger → zone-claim it
    const owner = this._classifyZone(e.clientX);
    if (owner === PointerOwner.JOYSTICK) { this._joyId = e.pointerId; this.joystickCtrl.start(e.pointerId, e.clientX, e.clientY); }
    else { this._lookId = e.pointerId; this.lookCtrl.start(e.clientX, e.clientY); }
  }

  _onPointerMove(e) {
    if (!this._down.has(e.pointerId)) return;
    this.pinchCtrl.movePointer(e.pointerId, e.clientX, e.clientY);
    if (e.pointerId === this._joyId) this.joystickCtrl.move(e.clientX, e.clientY);
    else if (e.pointerId === this._lookId) this.lookCtrl.move(e.clientX, e.clientY);
  }

  _onPointerUp(e) {
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!this._down.delete(e.pointerId)) return;
    this.pinchCtrl.removePointer(e.pointerId);
    if (e.pointerId === this._joyId) { this.joystickCtrl.end(); this._joyId = null; }
    else if (e.pointerId === this._lookId) { this.lookCtrl.end(); this._lookId = null; }
    // lifting a finger out of a pinch leaves the remaining finger UNOWNED — a fresh
    // touch is needed to start a new single-finger gesture (no jumpy pinch→look hand-off).
    if (this._down.size < 2) this._pinching = false;
  }

  _onWheel(e) { e.preventDefault(); this.pinchCtrl.wheel(e.deltaY); }

  // ---- orientation ----------------------------------------------------------

  _onOrientation(o) { if (o && o !== this.orientation) this._applyOrientation(o); }

  // apply a new orientation WITHOUT touching live state: the look sensitivity follows
  // this.orientation lazily (via the sens callback); zones read it on the next
  // pointerdown; held pointers keep their owner; no deltas cleared.
  _applyOrientation(o) { this.orientation = o; this.state.orientation = o; }
}
