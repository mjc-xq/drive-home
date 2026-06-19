// drei KeyboardControls map for the *held* movement keys only. Edge actions
// (Tab/V/E/1/2/3/Esc) are NOT here — KeyboardControls is tuned for sustained
// state; one-shot actions are handled by input/useEdgeKeys.js with preventDefault.
//
// <KeyboardControls map={keyMap}> wraps the <Canvas> in DaHilgApp; the sim reads
// these transiently each frame via useKeyboardControls()[1] (getKeys()) inside
// input/useInput.js — never the subscribe form (that would re-render).

/**
 * Stable control names. Imported by useInput so the string keys never drift.
 * @readonly
 */
export const Controls = Object.freeze({
  forward: 'forward',
  back: 'back',
  left: 'left',
  right: 'right',
  jump: 'jump',
  run: 'run',
});

/** drei KeyboardControls `map` prop: held keys for locomotion. */
export const keyMap = [
  { name: Controls.forward, keys: ['KeyW', 'ArrowUp'] },
  { name: Controls.back, keys: ['KeyS', 'ArrowDown'] },
  { name: Controls.left, keys: ['KeyA', 'ArrowLeft'] },
  { name: Controls.right, keys: ['KeyD', 'ArrowRight'] },
  { name: Controls.jump, keys: ['Space'] },
  { name: Controls.run, keys: ['ShiftLeft', 'ShiftRight'] },
];

export default keyMap;
