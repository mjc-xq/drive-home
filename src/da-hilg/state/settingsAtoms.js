// In-game graphics settings (toggles surfaced in the pause menu). Discrete UI state,
// read by the renderers to gate optional layers. Defaults: everything ON.
import { atom } from 'jotai';

// Defaults favor GAMEPLAY/performance over graphics: facades + grass start OFF (they
// are the heaviest optional layers — facade textures + the instanced grass field's
// fragment overdraw). Re-enable either from the pause menu's GRAPHICS section.
/** Show the Street View photo facades on the buildings. */
export const showFacadesAtom = atom(false);
/** Show the flowing creek water (the "fancy water"). */
export const showWaterAtom = atom(true);
// Grass OFF by default — the instanced curved-blade field is the biggest GPU
// (fragment-overdraw) cost; opt in from the menu if you want it.
export const showGrassAtom = atom(false);

// Performance mode — ON by default for a fast boot. When on, the game skips the
// ~8 ms/frame of sun shadows + the post-processing composer (bloom/AO/SMAA), keeping
// frames cheap for gameplay. Turn it OFF from the menu for the prettier (heavier) look.
export const perfModeAtom = atom(true);
