// In-game graphics settings (toggles surfaced in the pause menu). Discrete UI state,
// read by the renderers to gate optional layers. Defaults: everything ON.
import { atom } from 'jotai';

/** Show the Street View photo facades on the buildings. */
export const showFacadesAtom = atom(true);
/** Show the flowing creek water (the "fancy water"). */
export const showWaterAtom = atom(true);
// Grass defaults OFF — the current blade field looks rough; a proper instanced-grass
// rework (shell/fin or alpha-card tutorial technique) is pending. Toggle on to preview.
export const showGrassAtom = atom(false);
