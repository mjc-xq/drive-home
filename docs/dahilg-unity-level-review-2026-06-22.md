# Da Hilg Unity level review - 2026-06-22

This is the checkpoint note for the Unity/WebGL Da Hilg pass. It covers what went wrong, what
was fixed, what still needs a content pass, and how to edit levels in Unity without fighting the
generated GLB pipeline.

## What to read

- Start here for the current Unity game checkpoint: `docs/dahilg-unity-level-review-2026-06-22.md`.
  It is the short operational guide for the bugs fixed in this pass, remaining content problems,
  and Unity editing workflow.
- Read `docs/dahilg-neighborhood-export.md` when changing the generated neighborhood GLBs. It
  explains the practical export workflow, knobs, Street View facades, creek export, collision
  layers, rebuild commands, and raw-GLB visual QA.
- Read `docs/neighborhood-glb-export-spec.md` for the longer historical/source-of-truth GLB spec:
  goals, data sources, layer naming, fences, facades, trees, roads, and lessons learned from the
  1840 Dahill export.
- Read `docs/geo-export-layers.md` when you need to understand the layer contract and what each
  generated mesh/layer is supposed to mean in a ground-level game.
- Read `docs/dahilg-vegetation-annotation.md` for the vegetation strategy: surface-class rasters,
  GPU-instanced grass/bush/tree placement, draw-distance guidance, and fence-path annotations.
- Read `docs/dahilg-adding-a-character.md` when adding or changing a character GLB, rig, animator,
  spawn slot, or character metadata.
- Read `docs/house-interior.md` for the older interior/house scan pipeline and interior GLB
  gotchas. This is also the place to look before restoring old indoor props like the couch or
  bearded dragon cabinet.
- Read `docs/HANDOFF.md` for older engine-wide gotchas, especially coordinate frames, collision
  lessons, Draco/WebGL pitfalls, and verification discipline. Some parts refer to the prior
  three.js game, not the Unity build, so treat Unity-specific notes in this file as newer.

## What went wrong

- The Unity build had drifted away from the good textured GLB exports. The runtime was consuming
  simplified/generated level data that made Dahill unrecognizable: missing readable roads,
  sidewalk structure, fences, facade detail, and visible creek water.
- The creek water mesh existed in source data, but it was being placed as a broad floating sheet
  after runtime grounding. It needed to conform to the creek bed and use a visible flowing water
  material instead of relying on transparent sorting.
- The minimap was effectively a coarse occupancy fallback. It did not carry enough separate
  surface information for roads, driveways, sidewalks, curbs, lane paint, and creek water, so the
  HUD looked like scattered dots instead of a readable local street map.
- The player could appear to emote constantly because ambient NPC/nibbler logic randomly called
  `PlayEmote`, and the fourth emote slot was wired to the `Attack` animation. Emotes should only
  happen from explicit emote input, explicit greet input, or combat/hit reactions.
- iOS/WebGL performance was hurt by too many skinned nibbler instances, excessive pixel ratio,
  collider mesh complexity, and Unity data loading paths that held large payloads longer than
  necessary.
- Deocclusion was only shortening camera distance. In tight spaces that could still leave the
  shoulder/arm offset on the wrong side of walls, so the camera looked like walls were between
  the player and camera.

## Current fixes in this checkpoint

- Unity now streams the textured GLBs from `exports/*-single.glb` into
  `public/unity/da-hilg/StreamingAssets/*.glb`, using smaller deploy-safe GLBs.
- The player spawn for Dahill is on the street in front of the house at `[37.32, 0.05, 61.25]`
  and uses an explicit facing yaw.
- The Dahill overlay now uses `exports/1840-dahill-property-trees.glb`, which restores 46
  fence-like named nodes into `dahill_overlay.glb`.
- The minimap generator now emits separate packed masks for roads, driveways, sidewalks, curbs,
  lane paint, and creek water. The Unity minimap renders those as layered smooth surfaces, so it
  reads like a compact street map instead of dots.
- Runtime-generated road, driveway, sidewalk, curb, lane-paint, and creek-water surface overlays
  are grounded to the streamed level mesh, which makes the location recognizable even when the
  source GLB bakes too much into one low-resolution ground texture.
- Creek water now comes from the generated `fillWater` mask, is grounded against the creek bed,
  uses a visible blue/emissive procedural flow material, animates via `DaHilgWaterAnimator`, and
  still honors the level profile `WaterHeightOffset`. The current generated default is `0.10`,
  clamped to `0.045..0.16`, so it fills the creek bed without returning to the old hovering sheet.
- Procedural grass clumps/cards are generated near the player with short draw distance, no
  realtime shadows, and mobile caps. Grass now rejects generated road/drive/walk/curb/lane/water
  masks so it does not grow through streets, sidewalks, or creek water.
- Touch controls use a floating left stick, right-side look zone, and explicit Punch/Roll/Run/Jump
  buttons. The HUD was tightened, and touch devices start with the status panel collapsed.
- Ambient/random emote calls were removed. The remaining emote paths are player emote input and
  greet reactions; attack now comes from punch/melee only.
- Camera deocclusion now collapses to a much tighter distance in obstructed spaces, with smaller
  collision radii and lower occlusion damping so walls are less likely to land between player and
  camera. It also has a lightweight visual deocclusion pass for nearby foliage/wall/fence renderers
  that cross the camera-to-player sightline but do not have useful colliders.
- Nibbler spawning is capped on mobile, grounded, clearance checked, and keeps full-size NPCs
  within smaller findable outdoor leash areas.
- The huge terrain collider path now creates a collider LOD so Unity does not use oversized
  collider meshes on WebGL/iOS.

## Content problems still needing a source-asset pass

- **Street View facades do not line up well enough.** Several facade panels need recropping,
  rescaling, and reprojecting against their exact wall edges. The current crop math can still put
  roof/sky/ground bands into wall quads.
- **Missing facade coverage and color fallback.** Buildings without facade panels still need wall
  colors derived from nearby Street View or a curated paint palette, not aerial/terrain colors.
  Missing facade meshes should be easy to spot in raw GLB QA.
- **Fences need a deliberate source pipeline, not another runtime patch.** This pass restored the
  Dahill fence meshes by switching the overlay source to `1840-dahill-property-trees.glb` and
  verifying 46 fence-like nodes. Future GLB regeneration must keep that source or regenerate the
  fence placement step, then verify `Fence_*`, `Gate_*`, or equivalent nodes survive into
  `dahill_overlay.glb`.
- **Previous-level props are missing.** The couch and bearded dragon cabinet from earlier levels
  need to be reintroduced as Unity-authored overlay props or as named GLB nodes in the level
  source. They are not reliably present in the currently streamed outdoor GLBs.
- **Minimap source data should eventually become polygon/ribbon metadata.** This pass fixed the
  immediate visual problem with packed 384x384 masks for each surface type. A future exporter
  should still emit editable road/drive/walk polygons or centerline ribbons so map styling and
  hit testing are not tied to raster resolution.

## How to edit levels in Unity

1. Open the Unity project:

   ```sh
   open -a "Unity Hub" unity/DaHilgUnity
   ```

   Use Unity `6000.5.0f1`, matching the build logs.

2. Open the main scene:

   ```text
   unity/DaHilgUnity/Assets/DaHilg/Scenes/DaHilg.unity
   ```

3. Edit gameplay/runtime behavior in source scripts under:

   ```text
   unity/DaHilgUnity/Assets/DaHilg/Scripts/Runtime/
   unity/DaHilgUnity/Assets/DaHilg/Scripts/Editor/
   ```

4. Edit level metadata and spawn settings in:

   ```text
   unity/DaHilgUnity/Assets/DaHilg/Settings/Level_dahill.asset
   unity/DaHilgUnity/Assets/DaHilg/Data/level.meta.json
   ```

   Do not hand-edit `public/unity/da-hilg/*`; those are build outputs.

5. The outdoor geometry is streamed at runtime from `Assets/StreamingAssets/*.glb` and the public
   copied files. That geometry is generated, not authored directly in the scene. For durable
   building/road/facade/fence fixes, edit the GLB generation scripts and rebuild:

   ```sh
   node scripts/build_dahilg_unity_assets.mjs
   node scripts/build_dahilg.mjs --stages=unitysrc,unitybuild
   ```

6. For Unity-authored props that are not generated from geodata, add a separate overlay/prefab
   path rather than editing streamed GLB internals. Good candidates: couch, bearded dragon
   cabinet, hand-placed yard props, signs, one-off fences. Keep them as named prefabs or scene
   objects so they can be inspected and moved in the Editor.

7. To test a specific spot without walking there, the WebGL debug URL supports temporary query
   params:

   ```text
   /unity/da-hilg/index.html?level=dahill&debugSpawn=x,z&debugYaw=120
   /unity/da-hilg/index.html?level=dahill&debugSpawn=x,y,z
   ```

   These are verification hooks only; do not rely on them for player-facing spawn behavior.

8. Build and smoke-test before committing:

   ```sh
   npm test
   npm run build
   node scripts/build_dahilg.mjs --stages=unitybuild
   ```

## Recommended next work

- When regenerating Dahill from the textured GLB pipeline, keep the fence-bearing overlay source or
  rerun fence placement, then inspect node names to ensure `Fence_*`, `Gate_*`, or equivalent
  meshes survive into the streamed GLB.
- Add a Unity overlay-prop system for non-geodata props like the couch and bearded dragon cabinet,
  with per-level transforms stored in a small JSON or ScriptableObject.
- Rework facade fetching/cropping as a measurable pipeline: render raw GLB eye-level QA, compare
  wall edge bounds, adjust crop/UV/scaling, and fail the build when facade quads miss their wall
  bounds.
- Replace the minimap raster masks with filled polygon/ribbon data generated from the same
  road/sidewalk meshes Unity consumes once the source pipeline is stable.
- Add a repeatable mobile smoke test that captures iPhone-sized screenshots and checks the HUD
  panel state, minimap texture, and touch buttons after Unity startup.
