// Shared CONTRACT for the staged mobile-controls modules (joystick, camera/look,
// pinch-zoom, on-screen buttons). This is the SINGLE SOURCE OF TRUTH for the
// central InputState shape, the pointer-ownership enum, and every tuning
// constant the user specified. Every other module under src/controls/ (and the
// player/ui consumers) imports from HERE so there is zero duplication — change a
// number once and it propagates everywhere.
//
// Dependency-free on purpose (no three import): pure data + tiny math helpers so
// it can be imported from anywhere — input handlers, the player update loop, or
// React UI — without pulling in the renderer.

/**
 * @typedef {'portrait'|'landscape'} Orientation
 */

/**
 * The central, mutable input buffer. ONE instance is created per session and
 * shared by reference: input modules WRITE to it, the player/camera update loop
 * READS from it once per frame.
 *
 * Field conventions:
 *  - moveX / moveY: camera-relative move intent, each clamped to -1..1. moveY is
 *    forward(+)/back(-), moveX is right(+)/left(-). These PERSIST across frames
 *    (they reflect the joystick's current position) — the loop reads them every
 *    frame and they only change when the stick moves.
 *  - lookX / lookY: ACCUMULATED look delta (radians-ish, scaled by LOOK_SENS).
 *    These are additive: multiple pointer-move events in one frame sum into them.
 *    The update loop CONSUMES them and zeroes them each frame (see consumeLook).
 *  - zoomDelta: ACCUMULATED pinch/wheel zoom delta, likewise consumed + zeroed
 *    each frame (see consumeZoom).
 *  - jump: edge/level flag set by the jump button, read (and optionally cleared)
 *    by the player loop.
 *  - orientation: current device orientation, used to pick LOOK_SENS /
 *    CAMERA_PRESET rows.
 *
 * @typedef {Object} InputState
 * @property {number} moveX        Camera-relative strafe, -1..1 (persists).
 * @property {number} moveY        Camera-relative forward/back, -1..1 (persists).
 * @property {number} lookX        Accumulated yaw look delta — consumed+zeroed each frame.
 * @property {number} lookY        Accumulated pitch look delta — consumed+zeroed each frame.
 * @property {number} zoomDelta    Accumulated zoom delta — consumed+zeroed each frame.
 * @property {boolean} jump        Jump intent flag.
 * @property {Orientation} orientation Current device orientation.
 */

/**
 * Create a fresh, zeroed InputState. Call once per session and share the
 * returned object by reference with every input module and the update loop.
 * @returns {InputState}
 */
export function createInputState() {
  return {
    moveX: 0,
    moveY: 0,
    lookX: 0,
    lookY: 0,
    zoomDelta: 0,
    jump: false,
    orientation: 'portrait',
  };
}

/**
 * Pointer-ownership enum. Multitouch means several pointers can be down at once;
 * each is claimed by exactly one consumer so (e.g.) a finger that started on the
 * joystick never also drives the look-camera. Frozen so it can't be mutated.
 * @readonly
 * @enum {string}
 */
export const PointerOwner = Object.freeze({
  NONE: 'none',         // unclaimed / released
  JOYSTICK: 'joystick', // owns the move stick
  CAMERA: 'camera',     // owns free-look drag
  PINCH: 'pinch',       // part of a two-finger pinch-zoom
  UI: 'ui',             // landed on an on-screen button / HUD element
});

/**
 * Joystick / look dead-zone (fraction of full deflection). Input below this
 * magnitude reads as zero so a resting thumb doesn't cause drift.
 * @type {number}
 */
export const DEADZONE = 0.15;

/**
 * Per-orientation look sensitivity. Multiplies raw pointer-move pixels into the
 * accumulated lookX/lookY delta. Landscape is a touch slower on yaw since the
 * wider screen gives more horizontal travel per gesture.
 * @type {{ portrait: { x: number, y: number }, landscape: { x: number, y: number } }}
 */
export const LOOK_SENS = {
  portrait: { x: 0.006, y: 0.0045 },
  landscape: { x: 0.005, y: 0.005 },
};

/**
 * Per-orientation chase-camera preset. distance = boom length (metres),
 * targetHeight = look-at height above the player's feet (metres), pitch =
 * resting downward tilt (radians). Portrait frames more of the world above the
 * player; landscape sits lower and closer.
 * @type {{ portrait: { distance: number, targetHeight: number, pitch: number }, landscape: { distance: number, targetHeight: number, pitch: number } }}
 */
export const CAMERA_PRESET = {
  portrait: { distance: 7, targetHeight: 1.8, pitch: 0.35 },
  landscape: { distance: 6, targetHeight: 1.5, pitch: 0.25 },
};

/**
 * Clamp range for camera pitch (radians). min looks up, max looks down; the
 * asymmetric range keeps the camera from flipping under the ground or staring
 * straight up.
 * @type {{ min: number, max: number }}
 */
export const PITCH_LIMITS = { min: -0.8, max: 0.9 };

/**
 * Clamp range for the chase-camera boom distance (metres) under pinch-zoom.
 * @type {{ min: number, max: number }}
 */
export const ZOOM_LIMITS = { min: 3, max: 12 };

/**
 * Clamp v into the inclusive range [lo, hi].
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Apply a radial dead-zone to a single -1..1 axis and re-normalize the
 * remaining range back to 0..1 magnitude, so output ramps smoothly from 0 at
 * the dead-zone edge to ±1 at full deflection (no jump at the threshold).
 * Values inside the dead-zone return exactly 0.
 * @param {number} v   Raw axis value, expected -1..1.
 * @param {number} [dz=DEADZONE] Dead-zone fraction (0..1).
 * @returns {number} Dead-zoned, re-normalized axis value, -1..1.
 */
export function applyDeadzone(v, dz = DEADZONE) {
  const m = Math.abs(v);
  if (m <= dz) return 0;
  // Re-map (dz..1) -> (0..1) so motion starts at zero right past the threshold.
  const scaled = (m - dz) / (1 - dz);
  return Math.sign(v) * scaled;
}
