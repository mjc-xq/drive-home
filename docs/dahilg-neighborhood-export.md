# Improving the 1840 Dahill neighborhood GLB export

This is the practical "how do I fix / improve the neighborhood model" guide. The full
authored spec is `docs/neighborhood-glb-export-spec.md`; the layer/data reference is
`docs/geo-export-layers.md`. This doc is the **knobs + workflow** companion.

## The pipeline at a glance

```
exports/*.json (parcels, DEM, OSM surfaces, driveways, sv_facades, …)   ← source data
        │   node scripts/export_property_glb.mjs
        ▼
exports/1840-dahill-property.glb        ← the master neighborhood mesh (visual + Collision_*)
        │   npm run build:dahilg-assets   (meshopt + KTX2 + per-class caps)
        ▼
public/da-hilg/level.glb + level.meta.json   ← what the game actually loads
```

**The game asset is node-only.** To change the neighborhood you edit
`scripts/export_property_glb.mjs`, run it, then run `npm run build:dahilg-assets`. The
Blender steps (`place_trees.py`, `place_fences.py`, `organize_layers.py`) only build the
unused `-trees` / `-stylized` variants — you do **not** need Blender for the game.

```bash
node scripts/export_property_glb.mjs        # → exports/1840-dahill-property.glb
npm run build:dahilg-assets                 # → public/da-hilg/level.glb (+ meta)
```

> **Input data must be present.** `exports/` is gitignored. The Street View facade JPEGs
> (`exports/sv_facades/*.jpg`) in particular are not committed — regenerate them with
> `python scripts/fetch_sv_facades.py` (it serves from `scripts/_cache`, no API billing if
> cached). If they're missing, the exporter silently skips **all** facade overlays.

## The knobs you'll reach for (`scripts/export_property_glb.mjs`)

### Paved-surface heights (sidewalks/roads sitting at ground level)
All paved ribbons are draped per-vertex on the DEM (`terrainAt(x,z) + lift`). The `lift`
stack only exists to stop coincident-face z-fighting between the layers — keep it a few
cm, never more, or the surfaces **float above the terrain the player walks on** (you'll
walk through a sidewalk at knee/waist height). Current values (relative order matters,
curb > sidewalk > dash > driveway > asphalt):

```
LIFT_ASPHALT 0.06,  LIFT_DRIVEWAY 0.08,  LIFT_DASH 0.085,  LIFT_SIDEWALK 0.10,  LIFT_CURB 0.14
```

If you re-fetch the DEM or change its resolution and z-fighting reappears, nudge these by
1–2 cm — do **not** go back to the old ~0.6 m values.

### Street-View photo facades (the `SVFacade_*` panels)
`addStreetViewFacadeOverlays()` projects each cropped Street View JPEG onto a quad on the
building's footprint edge. Two things must line up or you get "the roof shows on the wall":
- **Horizontal:** the quad spans the exact footprint edge `A0→B0` (already correct).
- **Vertical:** the photo was cropped (`fetch_sv_facades.py:crop_to_wall`, pinhole model
  `CAM_EYE=2.5, PITCH=6, IMG 640×512`) to the band ground→eave+`WALL_PAD`. The exporter
  recovers that band from the manifest's `crop_v` + `fov` + `dist`, builds the quad bottom
  at the photo's true ground line, and **clips the top to the wall eave** (`base + wallH`),
  cropping the roof pad off via the UV-V range. If you re-fetch facades, keep the capture
  params in `fetch_sv_facades.py` and the recovery math in sync.

### Creek water (flat, not climbing the hill)
`flatWaterRibbon()` must produce a **flat surface per connected run**, not a per-vertex
terrain drape. It (1) trims centerline points whose terrain is > ~2 m above the valley
floor (p10), (2) splits survivors into connected runs, (3) gives each run one elevation =
run-p15 floor − `CREEK_DEPTH` (0.22, a recess **below** the floor). Banks/reeds still
follow terrain via the untouched `creekW` polyline. Tune width/depth via
`CREEK_WIDTH_M` / `CREEK_DEPTH_M` env vars.

> The **runtime** also draws a flowing-water plane (`src/da-hilg/level/CreekWater.jsx`) and
> hides road-line clutter inside the creek footprint — that's a visual layer on top of the
> flat creek geometry, independent of the export.

### Collision vs visual
`Collision_Terrain/Roads/Buildings/Trees` are physics-only proxies. The game bakes a
trimesh collider from them and hides them; the asset build strips their materials.
`Collision_Trees` is **excluded** from the collider so you can walk past street trees (no
invisible sidewalk wall). If you add a collision layer, name it `Collision_*` and decide
whether it should be walkable (exclude it in `Level.jsx:bakeCollider`).

## Verify

```bash
node scripts/verify_neighborhood_export.mjs exports/1840-dahill-property.glb   # node/QA check
npm run build:minimap                                                          # refresh minimap roads
```

Then load `/da-hilg` and walk the street: sidewalks should be underfoot (not at your
waist), photo facades should sit on their walls (no roof band on the siding), and the
creek should be flat water at the low point, never climbing the bank.
