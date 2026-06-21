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

### Paved-surface heights — EXACT-SURFACE strategy (no more "crank the lift")
The z-fighting that plagued earlier passes came from a **surface-approximation mismatch**:
`terrainAt` used **bilinear** interpolation while the terrain MESH renders **triangles**, so a
draped road ribbon and the terrain were two different surfaces — a small lift couldn't reliably
win, and a big lift made curbs/sidewalks look like chunky slabs.

**The fix (current):** `terrainAt(x,z)` now returns the **EXACT terrain-mesh triangle height**
(it samples the same `(a,c,b)+(b,c,d)` triangle the mesh emits, split on the `u+v=1` diagonal).
Every paved ribbon is draped per-vertex on this exact surface (`emitGroundRibbon` densifies to
**1.0 m along × 0.6 m cross** + a centre sample), so each ribbon sits exactly `lift` above the
*real* full-resolution DEM surface everywhere. Z-fighting is gone WITHOUT a big lift, so the
lifts are now **real-world curb/slab thicknesses** (the skirt edge = the lift):

```
LIFT_ASPHALT 0.05,  LIFT_DRIVEWAY 0.06,  LIFT_DASH 0.07,  LIFT_SIDEWALK 0.08,  LIFT_CURB 0.11
```

Related constants: `LIFT_ASPHALT_PAD = LIFT_ASPHALT + 0.01` (bulbs/junction pads/dead-end caps
sit just above the through-road in the same `Roads` mesh); `LIFT_GAPFILL = LIFT_ASPHALT + 0.005`
(GapDirt below both concrete tops). Mapped vs generated concrete stay **mutually exclusive**
(generated skips where a mapped ribbon is drawn, by the mapped ribbon's real width).

**Rules:** keep the terrain MESH full-resolution (do NOT downsample the DEM — the user wants the
real LiDAR/DEM height field). If z-fighting ever reappears, the fix is **finer ribbon sampling**
(lower `alongStep`/`crossStep` in `road_prep.mjs`) or confirming `terrainAt` still matches the
mesh triangulation — NOT cranking the lift back up to floating slabs. The web `Level.jsx`
`polygonOffset` is now only a belt-and-suspenders bias; the geometry is correct standalone.

### Buildings sitting ON the ground (not buried)
`buildingBase(ringW)` anchors the flat eave wall-top to the **85th percentile** of densely
sampled footprint terrain (corners + edge midpoints + interior grid) minus a small 0.15 m
embed — spike-robust, high enough that wall tops clear grade on the high side of a sloped
footprint. Walls AND the building collider both drop per-corner to
`terrainAt(corner) − WALL_EMBED` so each wall reaches the ground and the collision envelope
matches the wall silhouette on slopes. **NO ground apron:** an earlier `Ground_Pads` apron was
removed — on dense blocks its quads merged into a sheet coplanar with the terrain and z-fought
catastrophically. The per-corner wall drop already grounds buildings; no apron is needed.

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

**Facades on EVERY building, EVERY level (current requirement).** `fetch_sv_facades.py` now:
(1) reads the **per-scene origin** from `scene.json` (`SVF_SCENE`/`SVF_OUT`/`SVF_MANIFEST` env
vars let levels fetch concurrently into their own dirs) so canyon/stanton/meemaw land at the
right real-world spot — it is no longer hardcoded to Dahill; (2) covers **all** street-facing
buildings in the patch (`N_NEAREST` default 400, not 60); (3) **retries** transient SSL/network
errors so one blip doesn't kill a level. The Street View Static API is enabled on
`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (the old `REQUEST_DENIED` note is stale). Wall base colour
(`wallColor`) rejects implausible (green/olive/too-dark) aerial samples and falls back to a
varied warm paint palette, so a wall never renders green even where SV has no crop.

### Rebuild ALL levels at once (`scripts/rebuild_all_levels.py`)
The one-shot driver for "fix the levels": for dahill (current working scene) + canyon/stanton/
meemaw (restored from `exports/<region>/` sidecars) it fetches SV facades, runs the exporter,
copies to `exports/<slug>-property.glb`, and restores the Dahill working files at the end.
Re-export-only (no fetch) from cached sidecars: `scripts/reexport_schools_from_sidecars.py`.
Meemaw (4311 Circle Ave) is built via `scripts/export_meemaw.py` (residential
`build_place_scene.py` + the same fetch pipeline).

### Visual QA — render the raw GLB (no engine masking)
`/Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/render_glb_angles.py
-- exports/<slug>-property.glb /tmp/<slug> 1300` renders 7 angles (orbit + top + eye-level
close-ups at the world origin) in EEVEE. Use this to verify z-fighting, facades, wall/roof
colours, and window/door placement **as a game engine sees it** — the web runtime's
`polygonOffset` hides z-fighting, so always QA the raw GLB, not just `/da-hilg`.

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
