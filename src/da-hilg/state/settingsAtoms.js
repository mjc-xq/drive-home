// In-game graphics settings (toggles surfaced in the pause menu). Discrete UI state,
// read by the renderers to gate optional layers. Defaults: everything ON.
import { atom } from 'jotai';

// Photo facades default ON: the SVFacade overlay quads ride in front of the always-present
// windowed-stucco walls (turning them OFF reveals the windows underneath — no missing geometry).
// Grass stays OFF (the instanced curved-blade field's fragment overdraw is the heaviest layer).
/** Show the Street View photo facade overlays (SVFacade_page* nodes) on the buildings. */
export const showFacadesAtom = atom(true);
/** Show the flowing creek water (the "fancy water"). */
export const showWaterAtom = atom(true);
// Grass OFF by default — the instanced curved-blade field is the biggest GPU
// (fragment-overdraw) cost; opt in from the menu if you want it.
export const showGrassAtom = atom(false);

// Performance mode — ON by default for a fast boot. When on, the game skips the
// ~8 ms/frame of sun shadows + the post-processing composer (bloom/AO/SMAA), keeping
// frames cheap for gameplay. Turn it OFF from the menu for the prettier (heavier) look.
export const perfModeAtom = atom(true);
