# 1840 Dahill Lane — Neighborhood GLB Export: Full Spec & Lessons Learned

A single-file record of **what we are trying to build, everything that was asked
for and why, and the specific lessons learned the hard way.** This covers the
GLB/USDZ export effort for the real neighborhood around 1840 Dahill Lane, Hayward
CA — the source-of-truth meshes that feed a ground-level game experience. (The
separate "driving mode" work — car physics, occlusion cutaway, OSM road hugging,
pedestrians — is a different track and is not covered here.)

For the deep geo/alignment reference, see also `docs/geo-export-layers.md`. This
document is the higher-level spec + the story of how we got here.

---

## 1. The goal (the "why" behind everything)

> "The most realistic best starting point for a **ground-level game type
> experience** in the neighborhood, where the **sides of buildings, the yards,
> trees — all matter. We can't just use aerial stuff.**"

That one sentence drives every decision below. The hard truth that shaped the
whole pipeline: **aerial-on-roofs is not enough at eye height.** When you stand in
the street you see building *facades*, *fences*, *yard surfaces*, *tree trunks* —
none of which a top-down satellite texture on a box can give you. So instead of
one cheap aerial model we build **separate, real, georeferenced data layers** that
can be cleaned up, swapped, toggled, and hand-edited in Blender.

The export is a **starting point for hand-authoring**, not a finished asset. Hence
the recurring requirements: every layer is its **own named, individually-deletable
object**; the owner's lots are left **empty where the user will place things by
hand**; toggles exist for photo layers; positions of real-world features (trees,
fences, the creek, driveways) are reproduced **as accurately as the data allows**
so the user has correct reference geometry to build on.

---

## 2. Deliverables

All outputs are gitignored under `exports/`. They **all share one coordinate
frame** (house centroid at the origin) so they drop on top of each other in
Blender with zero offset.

| File | Contents | Role |
|---|---|---|
| `1840-dahill-property.glb` | **Photo variant** — LiDAR terrain w/ Google-satellite texture, House + Buildings, Creek, Roads/Sidewalks/Curbs/Driveways, LotLines, YourLots | Realistic structural base |
| `1840-dahill-property-trees.glb` | Photo variant **+ trees + fences** baked in (post-step) | Photo deliverable |
| `1840-dahill-stylized.glb` | **Stylized variant** — flat-shaded green terrain (no photo), animated grass, asphalt roads, flat-colored buildings, trees + fences | Clean game-art base |
| `1840-dahill-region.glb` | ±5-mile USGS terrain + satellite drape (terrain only) | Distant backdrop |
| `1840-dahill-photoreal.glb` | Google Photorealistic 3D Tiles of the block, baked into the same frame | Visual "hero" reference (later de-emphasized — see lessons) |
| `*.usdz` | USDZ conversions (via `to_usdz.py`) for Quick Look / AR preview | Preview / iOS AR |

Two variants exist on purpose:

- **Photo** = maximum realism; uses real satellite/Street-View imagery as texture.
- **Stylized** = no photographic textures at all (only the bark/leaf bitmaps that
  ship inside the tree GLBs); everything else flat-shaded solid color. This is the
  clean, game-ready art base that sidesteps the "melty" photogrammetry look.

---

## 3. The complete request log (what was asked, and why)

In rough chronological order. Each item is a real user request; the *why* is
either stated or inferred from context.

### 3.1 Foundational scope
- **Export my property to a GLB I can clean up in Blender — house too.** Two lots:
  the **house lot** and the **back lot the creek runs through**. *Why:* basis for a
  ground-level neighborhood game.
- Use **real GIS / LiDAR data** with what's available now (can't field-scan for a
  while). Address: **1840 Dahill Ln, Hayward CA.** "Look at the repo — there's lots
  of map stuff already."
- **Separate the trees and buildings into their own layers.** *Why:* edit/replace
  independently in Blender.
- The **ground must be amazingly crisp** — **no weird artifacts from Google
  photoreal inferring stuff**. *Why:* the terrain is the collision/ground plane;
  melted photogrammetry is unacceptable as a base.
- **Bump the patch to 400 m** and get **real tree and even fence positions**.
- Add a separate **±5-mile terrain region** model (LiDAR terrain + satellite) as a
  backdrop.

### 3.2 Buildings looking real
- **"Why are the houses so ugly — barren boxes?"** → give buildings real massing
  and color, not blank extrusions.
- **Texture my property's buildings from the Google photorealistic** layer for an
  added layer of realism. (Answer to follow-up: do **both** layers.)
- **Best-of-all-worlds:** only *infer/gap-fill* buildings **where there is no
  existing 3D building model** — don't replace good footprints with guesses.
- **"Sample Street View pics, get the color and use that in the mesh. Color the
  roofs based on a satellite pic."** *Why:* the first color pass made every
  building black — unacceptable.
- Add a **toggleable roof-photo layer** for the few big flat roofs. *Why:* user
  wants to turn real roof imagery on/off.
- **Street View facades** on the playable-core buildings (owner's house + nearest
  neighbors) — real building fronts instead of a tiled stucco pattern.
- **Improvise the house next door from the aerial photo**, and add the **missing
  house directly across the street** (the only lot with no house) by tracing the
  aerial. *Why:* completeness of the immediate surroundings.

### 3.3 Owner's lots / placement reference
- **Keep the back yard / back lot empty — a shed will be placed there manually
  later.** Repeatedly enforced; false buildings in the back yard are a hard fail.
- Highlight the **owner's two lots** distinctly (`YourLots`).

### 3.4 Roads, sidewalks, driveways
- **Trees in the street → remove them.** Roads must read clean.
- **Add driveways, and pave them.** *Why:* realism; "I thought you were paving
  driveways" + "you put a brown blob on my driveway" = the driveway must be a
  proper paved surface, not a dirt smear.
- **Sidewalks** must:
  - end in **curved corners** at intersections (not jut straight into the street),
  - **meet** at intersections (ends shouldn't leave gaps),
  - **border the property line and follow its curve** (Google/others publish road
    boundaries — use them),
  - be the **right width** (they were too thin almost everywhere).
- **Crosswalks** in the right places.
- **Roads** must be the **real width** (they were thinner than reality almost
  everywhere), have proper **lanes**, **messy/realistic intersections**, **curved
  roads**, and **rounded/right-sized cul-de-sac and road ends** (the ends were the
  wrong size).
- **No z-fighting / no under-layer showing through** the road or grass surface.
- **Extend the roads further** out from the immediate block.

### 3.5 Grass
- **Everywhere that is grass should have a wind-blown grass texture layer that is
  moving.** *Why:* liveliness; must animate **in-file** so it plays in any viewer
  (Blender, three.js, Quick Look) with no engine shader.
- **Too many trees in my yard — try again** / **too many trees in the street.**

### 3.6 Creek
- **Add a quick regenerator / way to set the creek depth on the fly.** *Why:* the
  user wants to tune it without a full rebuild.
- The creek's **water surface must be flat on top** — it should **not** follow the
  shape of the carved bottom. *Why:* that's how water actually sits.
- The creek must sit in the **real channel**, not run through a parking lot/yard.

### 3.7 Fences (the hand-drawn colored-line spec)
The user **hand-drew fence lines on an image** and gave an explicit color → asset
mapping. Fences must appear in **all exports** (both variants), each tiled section
a **separate deletable object**:

| Color | Asset | Where |
|---|---|---|
| **GREEN** | `Fence Section.glb` | the two long side boundaries (road → creek) |
| **PINK** | `Picket fence.glb` | the shared edge between the two owner lots (human-yard ↔ pig-yard) |
| **RED** | `Fence.glb` | the back lot boundary nearest the creek (pig/creek) |
| **BLACK** | `Picket fence.glb` | short front-yard run off the house's road corners |

Critical corrections the user issued about fence placement:
- The front (black) picket is **not** the full width of the house — it's **~half
  the house width**, does **not** cover the garage, and has a **gate mostly under
  the tree** on the path from the front door to the driveway. Follow the black line
  **precisely**.
- **"That white line is the fence between the human yard and the pig yard"** — it is
  **not** on the property divider; it sits **further from the house**. *Leave the
  very back property line alone.*
- The human/pig fence **should line up with a change in terrain.**
- If hand-drawn lines fall **outside the property, move them just inside** — use
  judgment.
- "It's very obvious you didn't look at my lines or fences" — i.e. **actually load
  and trace the drawn lines**, don't approximate.

### 3.8 The house's front door / garage
- **The front door is in the middle of the garage** — wrong; the door and garage
  must be in their correct, distinct positions.
- The garage side faces **toward the road / NE**.
- There must not be a **tree right in front of the front door.**

### 3.9 Process / working-style demands (stated repeatedly)
- **"Render and see yourself."** Don't claim something is fixed without *visually
  rendering it and looking.* Your own verification image is the bar — if it shows
  garbage, it isn't done.
- **Use a dynamic workflow / a shit-ton of sub-agents** to take problems on from
  scratch, and have **adversarial agents verify** the result ("say this crap is
  crap"). Don't trust a single "good enough."
- **Use version control instead of a million different files** — clean up old
  scripts, commit the ones worth keeping, delete stale exports.
- **"Do it all, never stop."** Don't ask "should I continue?" — execute the full
  scope and verify.

---

## 4. Subsystem specifications

### 4.1 World frame (use everywhere)
- **glTF Y-up, metres**, `x = East, y = Up, z = -North`, **origin at the house
  centroid** (`scene.json.center`). Blender converts Y-up → Z-up on import (North
  becomes +Y in Blender).
- **Two frames exist; do not mix them within one model:**
  - **Curvature-correct ECEF→ENU** (`makeGeoENU` in `src/engine/coords.js`,
    mirrored in `scripts/geo.py`) — needed to match the **Google photoreal** tiles.
  - **Flat ENU** (`e=(lon-LON0)·cos(LAT0)·111320`, `n=(lat-LAT0)·110540`;
    `world=[e-C[0], -(n-C[1])]`) — used **end-to-end** for the property/stylized
    models so geometry and aerial UVs share one frame (see Lesson 6.2).
- All deliverables are anchored at the same house lat/lon so they overlay.

### 4.2 Terrain
- Source: **USGS 3DEP 1 m bare-earth LiDAR DTM** (`fetch_dem.py` → `dem_1m.json`),
  falling back to scene.json's coarse Terrarium DEM if the 1 m patch is absent.
- **Bare-earth only** (no buildings/trees baked in) → crisp, clean ground.
- Photo variant: textured with the **Google satellite mosaic** mapped through the
  aerial bounds. Stylized variant: **flat green**, no photo.
- Heights are **NAVD88 orthometric** (Y axis).

### 4.3 Buildings & House
- Footprints from `scene.json` (Overture/OSM). House = the footprint flagged
  `house:true`. Other footprints within the patch are extruded.
- **Heights: use OSM `building:height`/levels (`b.h || 4.5`).** **LiDAR roof
  heights were dropped** — they were "shit" (see Lesson 6.4).
- **Roofs:** solid shingle color (photo) or per-building flat color from
  `buildings_roof_color.json` keyed to a satellite sample (stylized). Draping the
  nadir aerial on *pitched* roofs stretches/darkens and never aligns — dropped.
- **Walls:** tiled window facade tinted per-building by a **Street View dominant
  color** (`fetch_building_colors.py` → `buildings_color.json`).
- **Facade detail geometry:** every exported house/building wall also receives
  actual mesh windows, light trim, mullions, and sill strips on all usable sides
  (`House_windows`, `House_window_trim`, `Buildings_windows`,
  `Buildings_window_trim`). The owner's house also gets a separate garage-door
  mesh/trim facing the road so it reads correctly at game-camera distance.
- **Street View facades:** `fetch_sv_facades.py` selects the house + ~18 nearest
  buildings, and for each street-facing edge places a Static Street View camera at
  the nearest road point, crops the ground→eave band with a pinhole model, and maps
  it to that wall quad as its own material/primitive.
- **Gap-fills are OFF by default** — LiDAR-detected "buildings" put false
  structures in the back yard and crossed boundaries. Missing structures (e.g. the
  across-the-street house) are traced from the aerial into `scene.json` by hand
  instead.
- **Owner lots stay clear** of auto-placed structures (`inMine`/point-in-polygon
  against the `mine` parcel rings).

### 4.4 Trees
- Templates: `Downloads/Trees.glb` (NormalTree_1..5) + `Acacia.glb`.
- Placed by `place_trees.py` as **individual `Tree_NNNN` nodes** (one per position)
  — **never merged into one mesh**, so each is deletable in Blender. Grouped under a
  `Trees` parent.
- Positions: real LiDAR-canopy peaks where available, else a **riparian band along
  the creek + scattered yards**, **avoiding buildings and roads**, with per-tree
  scale/rotation variation.
- **Every trunk is seated exactly on the DEM** (`Y = terrainAt − baseY·scale`) and
  filtered to the real terrain bounds. Canopy size clamped (≤11 m normal, ≤16 m
  acacia) so no yaw produces a giant tree. (See Lesson 6.7 — the floating-trees bug.)
- Owner-lot trees are no longer blanket-suppressed: keep the strongest 12 LiDAR
  canopy detections on the owner's lots, still clearing buildings and the front
  door. Context trees remain LiDAR-driven within the 150 m playable radius.

### 4.5 Roads / Sidewalks / Curbs / Driveways
- Shared geometry helpers in `road_prep.mjs` so **both exporters draw identical
  roads.** Key pieces:
  - `clipPolylineToBox` (Liang-Barsky clip to the patch),
  - `smoothLine` (centripetal Catmull-Rom, only on genuinely-curved vertices 8°–100°
    so straights and square junctions stay crisp),
  - `roadSpec` (real **width / lanes** per road class),
  - `fanDisc`/`ringAnnulus` (cul-de-sac discs + curb annuli),
  - `buildSidewalkConnectors` (rounded sidewalk returns around intersections),
  - `buildSidewalkEndCaps` (U-shaped sidewalk returns at ordinary residential
    dead ends),
  - `trimEndInward` (junction gapping).
- Sidewalks are generated from the **road edges** rather than parcel outlines: each
  non-service road gets a concrete ribbon on both sides, with gapped junctions sewn
  by rounded connector arcs and terminal streets wrapped by a U-shaped return.
- Shared/split road vertices also get **straight-through sidewalk bridges** when
  the two arms are near-collinear, so sidewalk ribbons do not stop at ordinary
  through-junctions just because OSM split the road into separate ways.
- Asphalt is **raised ~0.55 m** so DEM crowns/cul-de-sacs don't poke through (no
  z-fight / under-layer bleed). Sidewalks and curbs sit in a fixed layer stack above
  it; raised light curbs run both sides, with dashed centerline.
- Current width rules: **residential 9.0 m**, **tertiary 11.0 m**; sidewalks are
  **1.8 m** wide with their center **2.2 m from the road edge** (about 1.3 m of
  planting strip between curb and inner sidewalk edge). Service pavement is not a
  street: **driveways 3.6 m**, **parking aisles 5.0 m**, no curbs, no centerline,
  no generated sidewalks.
- **Driveways are paved** surfaces (not dirt blobs), but only from mapping sources:
  service ways retained in `scene.json` plus `exports/driveways_osm.json`
  (`highway=service` with `service=driveway|parking_aisle|drive-through|alley`).
  The old synthetic garage-to-road strip was removed; if OSM has no driveway at the
  owner's house, that is a data gap to trace by hand, not something the exporter
  should invent.
- Ribbons sample terrain **per vertex** and long segments are densified (≤2.5 m) so
  they don't chord across the terrain and float.

### 4.6 Creek (`Creek_SanLorenzo`)
- OSM centerline is crude (10–20 m off); each vertex is snapped **90% toward the
  lowest bare-earth DEM within ±18 m perpendicular to flow** so the ribbon sits in
  the real channel.
- Ongoing exporter pass: each vertex is now snapped more strongly toward the
  DEM channel bottom, then lightly smoothed, in **both** photo and stylized exports
  so tree placement and water match.
- **Flat water surface** on top: both banks of each ribbon cross-section use the
  same water elevation, so the water no longer twists across the carved bed.
- **Adjustable width/depth** at rebuild time via `CREEK_WIDTH_M` and
  `CREEK_DEPTH_M`, e.g. `CREEK_DEPTH_M=0.35 node scripts/export_property_glb.mjs`.

### 4.7 Fences
See the color → asset table in §3.7. Implemented as a **post-step**
(`place_fences.py`) over the *same* output file so fences land in **both** models,
tiling the three fence GLBs along straight, hand-traced world-coordinate endpoints
near the owner's parcel lines (`parcels.json` lots, world `p.ring` coords), each section a separate deletable object
(`FenceGreen_/FencePink_/FenceRed_/FenceBlack_NNNN`) under a `Fences` empty. Picket
runs divide each segment into a whole number of equal panels so they terminate
exactly at corners. `Fence.glb` runs along native Y, so it's rotated −90° about Z
(baked into mesh data) to share the common +X length convention.

### 4.8 Grass (stylized variant)
- Flat-shaded green DTM, plus a `Grass_Wind` parent of hundreds of **instanced
  grass-blade clumps**, each its own node.
- A looping **glTF node animation `GrassWind`** sways every clump, phase-offset by
  world position (travelling-gust effect). It plays **natively in any viewer that
  auto-plays animations** — no engine shader required.

---

## 5. Build pipeline (rebuild commands)

```
# data layers
scripts/.venv/bin/python scripts/fetch_dem.py 400        # crisp 1 m DEM patch
scripts/.venv/bin/python scripts/fetch_trees.py          # LiDAR canopy trees
scripts/.venv/bin/python scripts/fetch_parcels.py        # county lot lines
scripts/.venv/bin/python scripts/fetch_aerial_google.py  # Google satellite mosaic + bounds
scripts/.venv/bin/python scripts/fetch_building_colors.py# Street View wall colors
scripts/.venv/bin/python scripts/fetch_sv_facades.py     # Street View facade crops
python3 scripts/fetch_driveways.py                       # mapped OSM service driveways/aisles

# PHOTO variant (fences must land in the FINAL file)
node scripts/export_property_glb.mjs                            # -> 1840-dahill-property.glb
blender --background --python scripts/place_trees.py            # -> 1840-dahill-property-trees.glb
blender --background --python scripts/place_fences.py           # rewrites that file

# STYLIZED variant
node scripts/export_stylized_glb.mjs                                          # -> 1840-dahill-stylized.glb
blender --background --python scripts/place_fences.py -- exports/1840-dahill-stylized.glb

# REGION backdrop
scripts/.venv/bin/python scripts/fetch_region.py         # wide DEM + satellite (±5 mi)
node scripts/export_region_glb.mjs                        # -> 1840-dahill-region.glb

# USDZ + verification render
blender --background --python scripts/to_usdz.py -- exports/<file>.glb exports/<file>.usdz
/usr/bin/usdrecord <wrapper>.usda <out>.png              # Quick Look's engine
blender --background --python scripts/render_roads_review.py -- exports/<file>.glb exports/_verify/<prefix>
```

---

## 6. Lessons learned (the hard ones)

### 6.1 The flat-approximation drift bug ("alignment grows with distance")
The old pipeline used `n=(lat-LAT0)*110540`. `110540` is the *equatorial*
metres-per-degree of latitude; at 37.68° the true value is **~110990** — a **0.4%
N–S scale error**. It's **zero at the house and grows with distance** (~0.85 m at
200 m, **~32 m at 5 mi**). It hides because *every* layer used the same wrong
constant, so they agree with *each other* — it only shows against an external
true-scale reference (Google, GPS). **Fix:** `makeGeoENU` (ECEF-based) when matching
Google; flat ENU end-to-end otherwise.

### 6.2 Geometry and texture must be in the SAME frame
A devastating, days-long regression: geometry was placed with `makeGeoENU`
(curvature ENU, only needed for the now-dropped photoreal tiles) while the aerial
UVs were flat → the two drifted metres apart, growing with distance ("the street
has pictures of houses in the middle of it", "the creek goes through a parking
lot"). **Fix: use flat ENU end-to-end** — terrain, buildings, creek, roads **and**
aerial UVs in the same flat ENU as the verified 2-D overlay. Then the 3-D top-down
render equals the 2-D footprint-on-mosaic overlay *by construction.*

### 6.3 The texture N–S flip
glTF's texture origin is `v=0` at the **top** of the image. The Google mosaic is
stored north-up (row 0 = north), so north must map to `v=0`: `v=(Nt−n)/(Nt−Nb)`.
The old `mercY`-based V put north at `v=1` → the ground rendered upside-down. (The
retired Mapbox photo was stored *south-up*, so the wrong formula looked fine until
the Google swap exposed it.) A flip swaps landmarks N↔S — check apartment rows / a
known large roof against fresh Google Static Maps.

### 6.4 LiDAR roof heights are unreliable here
LiDAR-derived building heights were wrong enough that the user called them "shit."
LiDAR gap-fill *buildings* were worse — they put a **false building in the back
yard** and crossed property boundaries. **Both were dropped:** heights come from
OSM, and footprint gaps are traced by hand from the aerial. Use clean OSM/Overture
footprints, not point-cloud-detected massing.

### 6.5 Provider gotchas
- **Google Photorealistic 3D Tiles:** session token must be appended (`session` +
  `key`) to *every* request or HTTP 400; bounding volumes are **OBB `box`** in ECEF
  (do real box-containment or the traversal wanders continents); tile transforms are
  identity (placement is in the node matrix); **node matrices are Y-up** — rotate
  y-up→ECEF (`[[1,0,0],[0,0,-1],[0,1,0]]`) before ECEF→ENU or tiles land ~8000 km
  away; content is unlit + JPEG; heights are **ellipsoidal**.
- **Geoid vs ellipsoid:** USGS DEM is NAVD88 orthometric; Google is ellipsoidal;
  difference here is the geoid undulation **N ≈ −32.3 m** (GEOID18). Anchor the
  photoreal ENU origin at the geoid or it floats ~32 m vertically.
- **Cesium OSM Buildings (Ion asset 96188):** it's an **OSM extract** — the same
  source as our footprints, just extruded, and *less dense* than the baked Overture
  set here. Not an upgrade; it won't contain a structure OSM is missing.
- **OSM/Overpass:** trees are sparse-to-absent in this residential block; fences are
  essentially never mapped — parcels are the real-world stand-in for fence lines.
- **Mapbox vs Google satellite:** the user verifies against Google Maps, so the
  aerial texture was switched to **Google satellite** (what they trust).

### 6.6 Texturing in Node without a browser
three.js `GLTFExporter` runs headless if you shim `FileReader`, but **cannot encode
images in Node.** So export geometry + UVs + **named** materials, then attach the
JPEG/PNG bytes with **gltf-transform `NodeIO`** (no decode), matching materials by
name. Roof faces need **upward winding** or they render dark.

### 6.7 Trees: seat them on the terrain, keep them individual
The first stylized trees floated/sank because the placement code **mis-measured
tree height** (used a raw mesh axis, ignoring each template's own −90° X rotation)
and never seated the trunk or filtered to real terrain bounds. **Fix:** compute each
template's true upright AABB (keep rotation/scale, drop translation), seat every
trunk exactly on the DEM, restrict to real terrain bounds, clamp canopy size. And
**never merge trees** — one node per tree so they're deletable.

### 6.8 Verification discipline (the biggest meta-lesson)
This effort's worst failures were **false "good enough" claims.** What the user
demanded — and what actually works:
- **Render it and look at it yourself** (GLB → USDZ via `to_usdz.py` → **`usdrecord`**,
  which is Quick Look's Hydra/Storm engine). `qlmanage` hangs on large files.
- **Overlay building footprints on fresh Google satellite** every time — that
  overlay *proved* the geometry was actually correct (~1 m) when the user believed
  "houses are in the wrong place"; the real culprit was the **texture** (flip +
  frame mismatch), and the apparent "parking lot across the street" was the render
  being rotated vs north-up Google Maps.
- **Render terrain-only and full at the SAME ortho camera and blend 50%** — every
  building must cover its roof; the blue creek must lie in the vegetated channel.
- Use **adversarial sub-agents** to try to *refute* "it's fixed," not confirm it.
- Note the harness caveat: `usdrecord`'s headless camera handling framed controlled
  USD cameras edge-on/inverted in this toolchain version, so **Blender Cycles renders
  were the authoritative visual check** when that happened.

### 6.9 Process & hygiene
- **One source of truth, version-controlled.** The "million different scripts" sprawl
  was a real problem — consolidate, commit the keepers, delete stale exports.
- **`git add -A` is dangerous with concurrent sessions** — it once folded in a
  leaked harness HTML and unrelated WIP. Stage deliberately.
- **A background dynamic workflow died with "Not logged in / Please run /login"** —
  long-running multi-agent workflows can silently fail on auth; check their
  `<failures>` output, don't assume completion.

---

## 7. Open / pending items (as of this writing)

- **Owner-house driveway is not mapped in OSM** in the current fetch. The exporter
  now avoids inventing it; for a final game level, trace it from aerial/field
  reference into a curated driveway layer.
- **Verify the Google-textured result** end to end (footprints land on
  Google-satellite roofs) and keep the overlay proof with each serious rebuild.
- **Confirm** the human/pig fence, front gate, and crosswalk placement at
  ground-level camera height, not only top-down.
- **Game-level pass:** add collision proxies, navmesh/walkmesh/drivable masks,
  LODs, material consolidation, and per-layer metadata for engine import.
- **`src/engine/coords.js` has uncommitted user modifications — do not touch.**

---

## 8. Source sessions

- Primary GLB export session: `916f3a6c-1644-4f72-9b8a-bfd9b458bf34` (Jun 18).
- Companion deep reference: `docs/geo-export-layers.md`.
- (The Jun 18 driving-mode session `e6662b5d` is a separate track — car control,
  occlusion cutaway, OSM road hugging, pedestrians — not part of this export spec.)
