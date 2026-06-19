# Da Hilg — start here

**Da Hilg** is a greenfield, first-person React-Three-Fiber game living entirely
under `src/da-hilg/`. You explore the recentered 1840 Dahill neighborhood as one of
four family members (Mike, Kelli, Cece, Drew), switch control between them at will,
and **greet** the other three (who wander as NPCs) to reunite the family. The whole
engine is built around one idea: an **Actor is data + refs**, a **Controller is a
pure `(actor, ctx, dt) => Intent`**, and motion is applied in exactly one place. It
is also the deliberate foundation for the next game, Nibblers.

**See `AGENTS.md` in this directory for the full guide** (game, controls,
architecture, file layout, asset pipeline, framework-vs-content, isolation,
Nibblers-readiness, gotchas). The pinned interfaces are in `CONTRACTS.md`; every
tunable is in `constants.js`.

## Most important rules

1. **Total isolation from the old app.** Import ONLY from within `src/da-hilg/**`
   and `node_modules`. NEVER import from `src/engine|controls|player|lib|pages|ui`.
   (`rg -n "src/(engine|controls|player|lib|pages|ui)" src/da-hilg/` must be empty.)
2. **Refs vs atoms.** Per-frame truth (`registry, input, cameraRig, levelMeta,
   clock` in `state/refs.js`) is plain mutable — mutate in place, never put it in
   React/Jotai. Atoms (`state/atoms.js`) are discrete UI state only, written
   change-gated in `systems/commitReactive.js`, never per frame.
3. **One stepMotion, one sim loop.** `systems/stepMotion.js` is the ONLY Rapier KCC
   apply site; `scene/GameSystems.jsx` is the ONLY simulation `useFrame`. Cameras run
   read-only at priority 10 and the manual `RenderLoop` renders at priority 100 — keep
   that ordering (sim 0 → camera 10 → render 100) or the screen goes black.
4. **Rebuild assets with `npm run build:dahilg-assets`** (→ `public/da-hilg/`:
   meshopt+webp level, 4 character GLBs, 7 anim clips, computed `level.meta.json`).
