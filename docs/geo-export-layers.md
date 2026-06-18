# Geo export: layer alignment & provider tile notes

How `scripts/fetch_dem.py`, `fetch_trees.py`, `fetch_parcels.py`,
`fetch_photoreal.mjs`, `gen_facade.py`, and `export_property_glb.mjs` build the
1840 Dahill Lane GLBs — and everything learned the hard way about making layers
from different providers line up.

The deliverables (all gitignored under `exports/`):
- `1840-dahill-property.glb` — crisp LiDAR terrain, gabled buildings, real trees,
  creek, roads, parcel lot-lines, all textured.
- `1840-dahill-photoreal.glb` — Google Photorealistic 3D Tiles of the block,
  baked into the **same frame** as the property model.

---

## 1. The world frame (use this everywhere)

glTF **Y-up, metres**, `x = East, y = Up, z = -North`, **origin at the house**.
Blender's glTF importer converts Y-up → Z-up on import (so North = +Y in Blender).

The canonical lat/lon → world transform is the **curvature-correct ECEF→ENU** in
`src/engine/coords.js` (`makeGeoENU`), ported to Python in `scripts/geo.py`. Both
are anchored at the **house lat/lon**, computed the same way the app derives the
Google-photoreal anchor (`src/engine/engine.js`):

```
houseLat = LAT0 + C[1] / 110540
houseLon = LON0 + C[0] / (COSLAT * 111320)   # C = scene.json "center" (house centroid)
```

Anchoring there means the property model and the photoreal layer **share origin
and axes** — they overlay.

### The flat-approximation trap (the "alignment grows with distance" bug)

The original pipeline (and `build_scene.py`) used a *flat* local approximation:

```
e = (lon - LON0) * cos(LAT0) * 111320      # East
n = (lat - LAT0) * 110540                  # North   <-- 110540 is the bug
```

`110540` is ≈ the **equatorial** metres-per-degree of latitude. At 37.68° the true
value is **~110990** — a **0.4 % north–south scale error**:

| distance from house | drift vs a true-scale reference (Google/GPS) |
|---|---|
| 200 m | ~0.85 m |
| 5 miles (8 km) | **~32 m** |

It's **zero at the house and grows with distance** — exactly the "is this the
curvature thing?" symptom. It hides at first because *every* layer used the same
wrong constant, so they agree with **each other**; it only shows against an
external true-scale reference (Google photoreal, GPS, Blender-GIS).

**Fix:** use `makeGeoENU` (ECEF-based) everywhere. The longitude term
(`cos(LAT0)` held constant) is also only valid for small areas — over miles
`cos(lat)` varies, so for the wide-area model proper ECEF is mandatory.

### Geoid vs ellipsoid (the vertical 32 m)

- USGS 3DEP DEM heights are **NAVD88 orthometric** (height above the geoid).
- Google 3D Tiles are **ellipsoidal** (ECEF).
- Difference = the **geoid undulation** N ≈ **-32.3 m** here (GEOID18).

`fetch_photoreal.mjs` anchors its ENU origin at the **geoid**
(`E0 = ecef(houseLat, houseLon, GEOID_N)`, `GEOID_N = -32.3`) so world-Y ≈ NAVD88
orthometric and the photoreal sits at the same height as the DEM terrain. Without
this the photoreal floats ~32 m off vertically.

---

## 2. How each layer is georeferenced

| Layer | Native CRS | Path to world |
|---|---|---|
| **Terrain** | USGS 3DEP, 4326 lat/lon grid, NAVD88 | per-cell lat/lon → `makeGeoENU` |
| **Buildings / House** | `scene.json` flat-ENU (Overture/OSM) | invert flat → lat/lon → `makeGeoENU` |
| **Trees** | LiDAR EPSG:2227 (CA zone 3, ftUS), NAVD88 | pyproj → lat/lon → `makeGeoENU` |
| **Parcels** | County assessor, 4326 | lat/lon → `makeGeoENU` |
| **Aerial texture** | Mapbox satellite, Web-Mercator | world → lat/lon → mercator fraction in photo's lat/lon corners |
| **Photoreal** | Google 3D Tiles, ECEF (y-up node matrices) | y-up→ECEF→ENU (see §3) |

Key point: the aerial photo is Web-Mercator, but it is georeferenced into the
scene via flat-ENU corner bounds. Map UVs through **mercator** (not linear-ENU)
to be exact — though over this ~850 m photo the mercator-vs-linear error is only
~1 cm, so it's not what caused the visible drift (that was §1).

---

## 3. Provider tile gotchas

### Google Photorealistic 3D Tiles
- **Endpoint:** `https://tile.googleapis.com/v1/3dtiles/root.json?key=KEY`.
- **Session token:** the response embeds `?session=…` in child URIs. Append
  **both `session` and `key`** to every subsequent request, or you get HTTP 400.
- **Bounding volumes are OBB `box`** (12 floats: center + 3 half-axis vectors), in
  **ECEF**. You must do real box-containment for region pruning. Treating a missing
  `region` as "always inside" makes the traversal wander to the wrong continent.
- **Tile `transform`s are identity** — placement lives in the glb **node matrix**.
- **Node matrices are Y-UP**: their output is `(ecefX, ecefZ, -ecefY)`, *not* true
  ECEF. Rotate y-up→ECEF (`M = [[1,0,0],[0,0,-1],[0,1,0]]`) before ECEF→ENU.
  Skipping this puts tiles ~8000 km away.
- **Content:** glb with `KHR_materials_unlit`, **JPEG** textures (so they survive a
  file export — no KTX2), usually already Draco-decoded (`asset.generator` says
  `draco_decoder` but no draco extension); register a Draco decoder anyway for the
  tiles that are compressed.
- **LOD:** `geometricError` (smaller = finer; root is `1e100`). Descend until
  `geomError ≤ target` or no children. Lower target → many more tiles.
- **Heights are ellipsoidal** (see geoid note above).
- **ToS:** streaming via an approved renderer is sanctioned; **caching/storing
  tiles into a static asset is not** — fine to know for a personal model.

### Cesium Ion
- **Cesium OSM Buildings** = Ion asset **96188**. Endpoint:
  `GET https://api.cesium.com/v1/assets/96188/endpoint?access_token=$CESIUM_ION_TOKEN`
  → `{url, accessToken}`; fetch the tileset with `Authorization: Bearer <accessToken>`
  (it's **gzipped** — use `curl --compressed`). Token: `CESIUM_ION_TOKEN` in `.env.local`.
- **Reality check:** the asset URL is `.../OpenStreetMap/CWT/2025` — it's an **OSM
  extract**, i.e. the *same source* as our OSM footprints, just extruded. Here it's
  **less dense than the baked Overture set** (≈169 vs 516 buildings in-patch) and
  won't contain a structure OSM is missing. Not an upgrade for completeness; skipped.
- Its tiles are **`b3dm`** (binary header + feature/batch tables + an embedded glb,
  often with an `RTC_CENTER`) — strip the b3dm wrapper before gltf-transform.
- Ion also re-hosts Google Photoreal and Cesium World Terrain.
- **To actually fill footprint gaps** (the missing house), the only complete vector
  source is **LiDAR building detection** (planar tall clusters in the point cloud) —
  or just trace it off the photoreal layer in Blender.

### OSM / Overture
- **OSM Overpass:** `way[building];out geom;` (footprints + `height`/`building:levels`),
  `way[highway]`, `way[waterway]`, `node[natural=tree]` (sparse — none in this
  residential block), `way[barrier=fence]` (essentially never mapped).
- **Overture** (what `scene.json` baked) is **denser** (sheds/garages) but not
  guaranteed complete and its registration can differ a few m from a given
  orthophoto. Here Overture and fresh OSM agreed to **0.1 m** — both fine after §1.
- Parcels (lot lines) are the real-world stand-in for fences, since fence geometry
  isn't in any public dataset.

### Mapbox
- **Satellite** tiles (Web-Mercator, orthorectified) → the aerial texture
  (`scripts/fetch_aerial.py`, z19). Token `NEXT_PUBLIC_MAPBOX_TOKEN`.
- Mapbox also has vector building extrusions (~OSM-derived) and terrain-RGB DEM,
  but the LiDAR DEM here is far crisper.

### USGS 3DEP
- **DEM:** `3DEPElevation/ImageServer/exportImage`, bbox in 4326, `format=tiff`
  `pixelType=F32` → read with Pillow (mode `'F'`). 1 m where available
  (`CA_AlamedaCounty_2021`). Bare-earth (DTM) = no buildings/trees = clean ground.
- **LiDAR point cloud (LPC):** TNM staged `.laz` on `rockyweb.usgs.gov`
  (~300–400 MB/tile), **EPSG:2227 ftUS, NAVD88**. Classified ground/noise only here
  (no vegetation class) → derive trees from a **canopy-height model**: max-Z per
  1 m cell (noise classes 7/18 removed) minus the bare-earth DTM, mask building +
  road footprints, peak-pick the rest.

---

## 4. Texturing & export in Node (no browser)
- three.js `GLTFExporter` runs headless if you shim `FileReader`
  (`globalThis.FileReader` over Node's `Blob.arrayBuffer()`), but it **cannot encode
  images in Node**. So export geometry + UVs + named materials, then attach textures
  with **gltf-transform** (`NodeIO`), which moves the JPEG/PNG bytes without
  decoding. Match materials by name (`Terrain_mat`, `*_roof*`, `*_walls`).
- Roof faces need **upward winding** or they render dark (sun lights the back).
- Ribbons (lot lines / roads / creek) sample terrain **per vertex** — densify long
  segments (≤2.5 m) or they chord across the terrain and float (cul-de-sacs).

## 5. Blender notes
- Import → glTF 2.0. Y-up→Z-up is automatic; North = +Y.
- Object names repeat between exports — **delete the previous import first**.
- Terrain has UVs in the aerial's frame; drop `src/assets/aerial_opt.jpg` on it (or
  it's already embedded). The photoreal layer overlays the property model directly.

## 6. Rebuild commands
```
scripts/.venv/bin/python scripts/fetch_dem.py 400          # crisp 1 m DEM patch
scripts/.venv/bin/python scripts/fetch_trees.py            # LiDAR canopy trees (needs LAZ in _cache)
scripts/.venv/bin/python scripts/fetch_parcels.py          # county lot lines (needs parcels_raw.json)
scripts/.venv/bin/python scripts/gen_facade.py             # wall texture
node scripts/export_property_glb.mjs                       # -> 1840-dahill-property.glb
node scripts/fetch_photoreal.mjs 150 3                     # -> 1840-dahill-photoreal.glb (Google tiles)
scripts/.venv/bin/python scripts/fetch_region.py          # wide DEM + satellite (±5 mi)
node scripts/export_region_glb.mjs                         # -> 1840-dahill-region.glb (terrain only)
/Applications/Blender.app/Contents/MacOS/Blender --background \
  --python scripts/render_property.py -- exports/<file>.glb exports/preview
```

## 6b. Deliverables (all share the curvature-correct frame; house at origin)

| File | Contents | Role in a ground-level game |
|---|---|---|
| `1840-dahill-property.glb` | Terrain, House, Buildings (+LiDAR heights +gap-fills), Trees, Creek, Roads, LotLines, YourLots | **Structure & gameplay**: collision ground, building massing/zones, prop positions, property lines |
| `1840-dahill-photoreal.glb` | Google Photorealistic mesh of the block (textured, unlit) | **Visual hero** — real building *sides*, yards, surfaces you walk past |
| `1840-dahill-region.glb` | ±5-mile terrain + satellite | **Distant backdrop** under/around the playable area |

## 7. Assembling a ground-level neighborhood base

The hard truth that drove this design: **aerial-on-roofs is not enough for ground
level** — at eye height you see building *sides*, fences, yards. So:

- **Visuals = the photoreal layer.** It's the only source with real, textured
  building facades and yard surfaces. It's "melty" up close (single-residence
  photogrammetry) but it's the realistic walkable environment.
- **Collision / clean ground = the property model's `Terrain`** (1 m bare-earth
  LiDAR — crisp, no melted buildings/trees baked in).
- **Building massing / gameplay zones = `Buildings`/`House`** — clean footprints at
  **real LiDAR roof heights**, so they sit exactly inside the photoreal shells
  (use as collision proxies, triggers, or a stylized alternative skin). Gap-fills
  cover structures OSM/Overture missed (e.g. the across-the-street house).
- **Props = `Trees`** — real LiDAR-canopy positions/heights as clean instanced
  trees (sharper + cheaper than photoreal's melted canopy).
- **Zones = `YourLots`/`LotLines`** (parcel boundaries — also where fences run),
  `Creek_SanLorenzo`, `Roads`.
- **Backdrop = the region model**.

All layers are in one frame (house at origin, Y = NAVD88 metres), so they drop in
together with no offset — verified by rendering the property + photoreal in one
scene (`exports/both_view.png`): generated buildings coincide with the photoreal
shells, lot lines wrap the right parcels, trees land on the real canopy.

**Building look:** roofs are a **solid shingle** colour (draping the nadir aerial on
*pitched* roofs stretches/darkens and never lines up — so it's dropped). Walls use a
tiled window facade **tinted per-building by a Street View colour guess**
(`fetch_building_colors.py` → `buildings_color.json`: nearest pano, shot at the
building, robust median of the facade band with sky/veg/ground rejected). Heights are
from LiDAR. So the clean buildings read as real-coloured massing that coincides with
the photoreal — not aerial-on-boxes.

**Beyond this pipeline:** bespoke per-facade detail sharper than the photoreal needs
**Street View** projection or hand-modelling in the engine — that's authoring work,
not data extraction. The photoreal is the best automatic ground-level facade source.

## 7b. Regional terrain model (`1840-dahill-region.glb`)
±5-mile USGS 3DEP terrain (downsampled, e.g. 1024²) with the Mapbox satellite
draped — terrain only, same frame, so it sits under the property/photoreal models.
Uses the curvature-correct ENU horizontal + **orthometric elevation as Y** (matching
the property DEM); the ~5 m earth-curvature drop at 8 km is intentionally omitted so
the regional ground stays a clean datum. Camera far-clip must exceed the model size
(`render_property.py` sets `clip_end = max(2000, span*5)`).

## 8. Aerial-alignment bugs that cost days (read before touching `export_property_glb.mjs`)
Two stacked bugs made the satellite texture look "metres off" / "creek through a
parking lot," and each masked the other. Both are now fixed; do not reintroduce them.

1. **Texture N-S flip.** glTF's texture origin is `v=0` at the TOP of the image. The
   Google mosaic (`fetch_aerial_google.py`) is stored **north-up** (row 0 = north), so
   north must map to **`v=0`**: `v = (Nt - n)/(Nt - Nb)`. The old formula used a
   `mercY`-based V that put north at `v=1` → the ground rendered upside-down. (The
   retired Mapbox photo was stored *south-up*, so the wrong formula looked fine until
   the Google swap exposed it.)
2. **Geometry/texture in different frames.** Geometry was placed with `makeGeoENU`
   (curvature ENU, only needed to match the now-dropped Google **photoreal** tiles)
   while the aerial UVs were flat → the two drifted metres apart, growing with
   distance. **Fix: use flat ENU end-to-end** — terrain, buildings, creek, roads AND
   aerial UVs all in the same flat ENU as the verified 2-D overlay
   (`world = [e - C[0], -(n - C[1])]`, `u=(e-E0)/(E1-E0)`, `v=(Nt-n)/(Nt-Nb)`). The
   3-D top-down render then equals the 2-D footprint-on-mosaic overlay by construction.

**Verification that actually catches these:** render GLB→USDZ via `usdrecord` (Quick
Look's engine); render terrain-only and full at the SAME ortho camera and blend 50% →
every building must cover its roof and the blue creek must lie in the vegetated
channel; landmark sides (apartment rows, large gray roof) must match fresh Google
Static Maps (a flip swaps them N↔S). Residual building scatter (~1-3 m, both
directions) is cadastral-footprint-vs-roof-overhang, not a frame error.

The OSM creek centerline is crude (10-20 m off in places); `export_property_glb.mjs`
snaps each vertex 60% toward the lowest bare-earth DEM within ±12 m perpendicular to
flow so the ribbon sits in the real channel.

## 9. Stylized (no-photo) variant + trees
`export_stylized_glb.mjs` builds `1840-dahill-stylized.glb`: flat-green grass on the
DEM (no photo textures), asphalt roads + concrete sidewalks/curbs, buildings
flat-coloured from Street View, and **in-file animated grass** (per-clump glTF node
animation, phase-offset by position). Trees for BOTH variants come from
`Downloads/Trees.glb` (NormalTree_1..5) + `Acacia.glb`, instanced by `place_trees.py`
as **individual `Tree_NNNN` objects** (one node per LiDAR-canopy position) so each is
deletable in Blender — never merge them into one mesh.

## 10. Fences (post-step, both variants)
`place_fences.py` tiles three fence GLBs from `Downloads/` along the owner's parcel
lines (`parcels.json` lots 50/113, world `p.ring` coords), seated on the DEM terrain,
mirroring `place_trees.py` — each tiled section is a separate, deletable object
(`FenceGreen_/FencePink_/FenceRed_/FenceBlack_NNNN`) under a `Fences` empty:
* **GREEN** `Fence Section.glb` — the two long side boundaries (road→creek).
* **PINK** `Picket fence.glb` — the shared edge between the two owner lots.
* **RED** `Fence.glb` — the back lot boundary nearest the creek.
* **BLACK** `Picket fence.glb` — short front-yard run off the house's road corners.

It runs as a POST-step over the SAME output file so fences land in BOTH models:
* PHOTO: `…export_property_glb.mjs → place_trees.py → place_fences.py` (default arg
  `exports/1840-dahill-property-trees.glb`).
* STYLIZED: `…export_stylized_glb.mjs → place_fences.py -- exports/1840-dahill-stylized.glb`.

Picket runs (PINK/BLACK) divide each segment into a whole number of equal panels so
they terminate exactly at corners; GREEN/RED tile whole panels plus a fractional stub.
The `Fence.glb` template runs along native Y, so it is rotated −90° about Z (baked into
mesh data) to share the common +X length convention. Colours stay in each GLB's own
material base colour (Quick Look/usdrecord ignore `COLOR_0`).
