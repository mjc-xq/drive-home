// In-game graphics settings (toggles surfaced in the pause menu). Discrete UI state,
// read by the renderers to gate optional layers. Defaults: everything ON.
import { atom } from 'jotai';

// Photo facades default ON: the SVFacade overlay quads ride in front of the always-present
// windowed-stucco walls (turning them OFF reveals the windows underneath — no missing geometry).
// Grass defaults ON now that it is paved-mask gated and capped to a smaller local field.
/** Show the Street View photo facade overlays (SVFacade_page* nodes) on the buildings. */
export const showFacadesAtom = atom(true);
/** Show the flowing creek water (the "fancy water"). */
export const showWaterAtom = atom(true);
export const showGrassAtom = atom(true);

// Performance mode — ON by default for a fast boot. When on, the game skips the
// ~8 ms/frame of sun shadows + the post-processing composer (bloom/AO/SMAA), keeping
// frames cheap for gameplay. Turn it OFF from the menu for the prettier (heavier) look.
export const perfModeAtom = atom(true);
