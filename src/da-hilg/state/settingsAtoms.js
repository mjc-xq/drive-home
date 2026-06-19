// In-game graphics settings (toggles surfaced in the pause menu). Discrete UI state,
// read by the renderers to gate optional layers. Defaults: everything ON.
import { atom } from 'jotai';

/** Show the Street View photo facades on the buildings. */
export const showFacadesAtom = atom(true);
/** Show the flowing creek water (the "fancy water"). */
export const showWaterAtom = atom(true);
// Grass defaults ON — a proper instanced curved-blade field (tapered multi-segment
// blades, traveling wind gust, root→tip gradient + base AO) that follows the player.
export const showGrassAtom = atom(true);
