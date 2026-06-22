# Docs guide

Use this as the starting point when deciding which project doc to read. The Unity/WebGL Da Hilg
game now has several overlapping docs because the level pipeline spans generated GLBs, Unity
runtime code, older three.js engine work, and one-off content notes.

## Start here

- `docs/dahilg-unity-level-review-2026-06-22.md` - Current Unity checkpoint. Read this first for
  what went wrong, what was fixed in the June 22 pass, generated surface/minimap overlays,
  remaining content problems, deployment notes, and the practical Unity level-editing workflow.
- `docs/HANDOFF.md` - Older broad handoff for engine gotchas, asset loading, coordinate frames,
  collision, Draco/WebGL pitfalls, and verification discipline. Some sections describe the earlier
  three.js build, so treat the Unity review as newer when the two conflict.

## Generated neighborhood and GLB pipeline

- `docs/dahilg-neighborhood-export.md` - Practical workflow for regenerating the 1840 Dahill
  neighborhood GLBs. Read this before changing facades, creek geometry, road/sidewalk surfaces,
  collision layers, or raw-GLB visual QA.
- `docs/neighborhood-glb-export-spec.md` - Long source-of-truth history and spec for the Dahill
  export: goals, data sources, layer naming, fences, facade strategy, trees, roads, and lessons
  learned.
- `docs/geo-export-layers.md` - Layer contract for generated meshes. Read this when Unity or the
  minimap consumes a layer incorrectly, or when you need to know what each generated mesh is
  supposed to mean in a ground-level game.
- `docs/dahilg-vegetation-annotation.md` - Vegetation placement plan. Covers the lightweight
  Terrain/ground-mesh strategy, grass cards/clumps, tree/bush placement, GPU instancing, draw
  distance, and fence-path annotations.

## Unity gameplay and content editing

- `docs/dahilg-adding-a-character.md` - Character pipeline. Read this before adding or changing a
  character GLB, rig, animator, spawn slot, metadata entry, or runtime character prefab.
- `docs/adding-cars.md` - Vehicle/content notes for adding cars.
- `docs/drive-mode.md` - Driving mode behavior and implementation notes.
- `docs/scoop-mode.md` - Scoop mode behavior and implementation notes.
- `docs/hud-design-brief.md` - HUD design intent and usability direction. Read this before
  changing the on-screen UI, minimap presentation, touch controls, or compact mobile layout.

## House and older interior work

- `docs/house-interior.md` - House scan and interior GLB pipeline, including the older couch swap
  context. Read this before restoring or replacing interior props such as the couch or bearded
  dragon cabinet.

## Reviews and refactors

- `docs/expert-review-2026-06-14.md` - Earlier expert review. Useful for historical issues and
  regressions, but validate against the current Unity review before acting.
- `docs/engine-refactor-recipe.md` - Refactor plan/recipe for the engine architecture. Read this
  before making broad runtime architecture changes.

## Quick choices

- Need to fix water, minimap masks, generated road/sidewalk overlays, camera deocclusion, mobile
  performance, spawn, melee, or current Unity playability? Start with
  `docs/dahilg-unity-level-review-2026-06-22.md`.
- Need to fix ugly/missing streets, sidewalks, fences, creek bed, building facades, or raw level
  fidelity? Read `docs/dahilg-neighborhood-export.md`, then `docs/neighborhood-glb-export-spec.md`,
  then `docs/geo-export-layers.md`.
- Need grass, bushes, trees, or short-range vegetation density? Read
  `docs/dahilg-vegetation-annotation.md`.
- Need old indoor props or house scan behavior? Read `docs/house-interior.md`.
- Need UI controls or HUD layout work? Read `docs/hud-design-brief.md` and the current Unity
  checkpoint.
