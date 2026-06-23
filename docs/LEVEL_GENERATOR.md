# Geographic Level Generator

A standalone pipeline that turns a **real-world location** (OSM footprints + parcels + aerial +
Street View + LiDAR canopy) into a **game-ready 3D level**: a textured, welded terrain with
individually-labeled buildings, a draped road/curb layer, real-vegetation trees, a creek, and
collision proxies.

The output is engine-agnostic. It is built **uncompressed first** (so you can open and edit it in
Blender / QuickLook / any glTF tool), and a **separate compress+integrate step** produces the
optimized assets a specific game (Unity, three.js/WebGL) consumes. You can hand-edit the level in
Blender between generation and use.

> Design goal: make great levels for *any* game and *any* location. Unity integration is one
> consumer, wired up after the fact (and documented) — not baked into the generator.

---

## The two-stage architecture (why exports look "uncompressed")

```
  location data ─▶  GENERATE  ─▶  <slug>.glb  ─▶ [edit in Blender] ─▶  COMPRESS+INTEGRATE ─▶ game assets
   (sidecars)       (one node       PLAIN glb        (optional)         (meshopt/webp/KTX2)   web / Unity
                     script)     Blender-readable
```

1. **GENERATE — `scripts/export_property_single_surface.mjs <level>`**
   Builds the whole level into a THREE scene and writes a **PLAIN binary glTF** — *no* meshopt, *no*
   KTX2, JPEG/PNG textures. This is the **editable master**. Blender, QuickLook, and every glTF
   viewer open it directly. (It is large — ~130 MB for dahill — because it is uncompressed. That is
   intentional: it is the source, not the shipped asset.)

2. **COMPRESS + INTEGRATE** — run only when you need shippable assets:
   - `scripts/build_dahilg_assets.mjs` → `public/da-hilg/<out>.glb` — meshopt geometry + webp/KTX2
     textures for three.js/WebGL. Small, fast, **not** Blender-readable.
   - `scripts/build_dahilg_unity_assets.mjs` → `unity/.../StreamingAssets/<slug>.glb` — meshopt
     geometry + JPEG/PNG textures for Unity glTFast streaming.
   - `scripts/build_dahilg_overlay.mjs` → `<slug>_overlay.glb` — the vegetation + water OVERLAY
     (trees/creek), layered on top at runtime so the base env can stay grass-free.

   **Meshopt/KTX2 compression is the reason Blender/QuickLook can't read the shipped GLBs.** Always
   open the **uncompressed master** for editing, never `public/da-hilg/*.glb` or the StreamingAssets.

---

## Layers in a generated level (all in the master GLB)

| Node(s) | What | Removable? |
|---|---|---|
| `TerrainCore` / `TerrainFar` | one welded ground surface, road/sidewalk/curb **paint** baked into its texture | no (the bed) |
| `RoadLayer` → `Roads_asphalt`, `Roads_sidewalk`, `Roads_crosswalk`, `Roads_curb`, `Roads_markings_*`, `Roads_driveway` | streets + **raised curbs** as real geometry, draped **exactly** on the terrain (samples `terrainAt`, never approximates) | **yes** — delete `RoadLayer` to fall back to the painted roads beneath |
| `Building_<i>` groups (`_walls` + `_roof`) | every non-owner building as its **own named object** | per-building |
| `House_walls` / `House_roof` / `House_*` | the owner house | yes |
| `Buildings_windows` / `_window_trim` / `_siding_lines`, `Doors*`, `GarageDoor*` | shared facade detail | yes |
| `Trees` (group) | instanced trees, placed from **real aerial canopy** (not a grid) | yes |
| `Creek_*` | creek channel/water/rocks/reeds | yes |
| `Collision_Terrain` / `Collision_Buildings` / `Collision_Trees` | invisible collision proxies (runtime bakes/uses them) | no |

Everything is named so you can select it in Blender and we can talk about it precisely
("delete `Building_1511`", "hide `RoadLayer`").

---

## Adding a location / level

Levels are declared in a `LEVEL_SETS`-style table at the top of `export_property_single_surface.mjs`
(and mirrored in the build scripts). Each entry points at a `scene.json` + a sidecar directory:

```js
dahill:  { scene: 'src/assets/scene.json', dir: 'exports',                 slug: 'dahill' },
canyon:  { scene: 'exports/canyon-middle-school/scene.json', dir: 'exports/canyon-middle-school', slug: 'canyon' },
...
```

To add a new place:
1. Fetch its inputs into a sidecar dir (`scene.json` footprints/roads, `parcels.json`,
   `google_aerial.jpg` + bounds, `dem_1m.json`, `buildings_color*.json`, `trees_placed.json`,
   `sv_facades.json`, `map_surfaces_osm.json`). See the `fetch_*` / `build_*` helpers.
2. Add a `LEVEL_SETS` entry (scene, dir, slug).
3. `node scripts/export_property_single_surface.mjs <slug>` → the uncompressed master.
4. Review/edit in Blender; re-bake or compress to ship.

The frame is flat-ENU world XZ centered on the scene; +X east, +Z south. Heights come from the DEM
(`terrainAt`). Roads under the carriageway are graded flat (it's fine to flatten under the roadway).

---

## The Blender edit-in-the-middle workflow

Because the master is a plain GLB:
1. Open `exports/<slug>-single.glb` in Blender.
2. Select objects by name (each building is its own object; `RoadLayer` is one removable group).
3. Edit — delete a phantom building, nudge a fence, retexture a roof, toggle the road layer.
4. Either **re-export over the master** (then run the compress step), or feed your change back into
   the pipeline (preferred for anything procedural, so a re-bake keeps it).

If a building shouldn't exist, the fastest fix is to tell the pipeline: oversized inferred footprints
(>300 m²) are already auto-rejected (church/parking/shadow phantoms); specific ones can be excluded
by index.

---

## Output organization (target)

> Current state: dahill writes into the `exports/` root (shared with inputs + legacy artifacts);
> the other levels nest under their own dirs. Target structure (in progress):

```
exports/
  <slug>/
    <slug>-single.glb         # uncompressed editable MASTER  (rename target: <slug>.level.glb)
    scene.json, parcels.json, …   # inputs / sidecars for this location
    _ground/                  # baked ground atlas pages + paved_mask
    <slug>.vegetation.json, <slug>.surface_class.png
    logs/                     # per-level build logs
  _archive/                   # legacy/superseded artifacts (old -property/-stylized/.blend/.usdz)
```

Shipped, compressed assets live OUTSIDE `exports/`:
- `public/da-hilg/<out>.glb` (+ `.meta.json`, `.minimap.json`) — web.
- `unity/DaHilgUnity/Assets/StreamingAssets/<slug>.glb` (+ overlay) — Unity.

---

## Unity prep (one consumer, documented)

The Unity StreamingAssets GLB is meshopt geometry + JPEG/PNG textures, streamed at runtime by
`DaHilgLevelRuntime` (glTFast). Collision is added to `Collision_*` proxy nodes only (trees
excluded). The vegetation/water `*_overlay.glb` loads parented under the level root with colliders
off. See `docs/DEPLOY.md` for the asset-size + git/LFS/Vercel constraints when publishing.
