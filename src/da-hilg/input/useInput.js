// Per-frame input merge. Called once at the very top of the GameSystems useFrame
// with drei's transient getKeys(). It folds every input source — keyboard, the
// mobile joystick, and the run flag — into the single plain `refs.input` object
// the active player's controller consumes. NO React/Jotai writes happen here;
// this runs every frame.
//
// Look deltas are NOT handled here: usePointerLock (desktop) and the mobile
// touch-look surface write straight to cameraRig.yaw/pitch.

import { input } from '../state/refs.js';
import { Controls } from './keyMap.js';

// ── Shared mobile/touch joystick channel ────────────────────────────────────
// The mobile TouchJoystick writes a normalized vector here (right +x, up +y in
// screen space) and a push-to-run flag. We keep it as a module-level singleton
// (not a hook) so the DOM joystick — which lives outside the Canvas — can mutate
// it without any React plumbing, exactly like the keyboard path. Mutate fields
// in place; do not reassign the bindings.
export const touchMove = { x: 0, y: 0 }; // [-1..1] each axis; y+ = forward
export const touchActive = { on: false }; // true while a joystick touch is down
export const touchRun = { on: false };    // mobile push-to-run

// Edge-detect jump across frames: drei reports `jump` as held state, so we only
// queue a jump on the rising edge. The mobile JUMP button calls queueTouchJump().
let prevJumpHeld = false;

/** Mobile JUMP button helper — queue a jump exactly like a Space keydown edge. */
export function queueTouchJump() {
  input.jumpQueued = true;
  input.jumpQueuedT = performance.now();
}

/**
 * Merge held keyboard state + mobile joystick into refs.input for this frame.
 * @param {() => Record<string, boolean>} getKeys drei useKeyboardControls()[1]
 */
export function updateInput(getKeys) {
  const k = getKeys ? getKeys() : null;

  // Keyboard axes (digital): forward + back / right + left.
  let moveX = 0;
  let moveY = 0;
  let run = false;
  let jumpHeld = false;
  if (k) {
    moveX = (k[Controls.right] ? 1 : 0) - (k[Controls.left] ? 1 : 0);
    moveY = (k[Controls.forward] ? 1 : 0) - (k[Controls.back] ? 1 : 0);
    run = !!k[Controls.run];
    jumpHeld = !!k[Controls.jump];
  }

  // Mobile joystick overrides/augments the keyboard when it's the active source.
  // We take whichever has the larger magnitude per axis so a plugged-in keyboard
  // and a touch stick never cancel each other out awkwardly.
  if (touchActive.on) {
    if (Math.abs(touchMove.x) > Math.abs(moveX)) moveX = touchMove.x;
    if (Math.abs(touchMove.y) > Math.abs(moveY)) moveY = touchMove.y;
    if (touchRun.on) run = true;
  }

  input.moveX = moveX;
  input.moveY = moveY;
  input.run = run;

  // Edge-detect the held Space jump into a buffered queue (mobile uses the
  // queueTouchJump() helper above, which sets the same flag).
  if (jumpHeld && !prevJumpHeld) {
    input.jumpQueued = true;
    input.jumpQueuedT = performance.now();
  }
  prevJumpHeld = jumpHeld;
}

export default updateInput;
