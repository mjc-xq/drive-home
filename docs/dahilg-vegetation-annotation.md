# Da Hilg — Vegetation / Surface Annotation

A **side-channel** for the Da Hilg single-textured-terrain export. The beautiful textured
environment GLB is built elsewhere and does all the up-close visual work through its ground
texture. This annotation does **not** modify that GLB. It tells a **later Unity step** where to
scatter GPU-instanced foliage (grass clumps/cards, bushes, trees) on a lightweight Unity Terrain
laid under the GLB, so vegetation appears near the player for density and realism without bloating
the GLB or the draw call budget.

Produced by `scripts/lib/surface_annotation.mjs` (`buildSurfaceAnnotation`). Two artifacts per
level:

- `exports/_ground/<level>.surface_class.png` — world-aligned **surface-class raster**.
- `exports/<level>.vegetation.json` — the **contract** Unity reads.

A colorized `exports/_ground/<level>.surface_class_key.png` is also written for human inspection
only (Unity ignores it).

---

### Vegetation Strategy

- Import the environment as a GLB and use it for buildings, terrain shapes, rocks, and collisions.
- Create a lightweight Unity Terrain (or dedicated ground mesh) for vegetation placement rather than painting directly onto the GLB.
- Use Unity Terrain details or GPU-instanced foliage for grass, bushes, and trees.
- Use low-poly grass clumps/cards instead of individual blades.
- Enable GPU instancing, LODs, and billboards for distant vegetation.
- Keep grass draw distance relatively short and disable realtime shadows on grass.
- Use baked lighting and static batching where possible.
- Make the ground texture do most of the visual work, with vegetation used primarily near the player to create density and realism.

---

## Class raster format

`<level>.surface_class.png` is a **1-channel (grayscale, `b-w`) PNG**, `rasterSize × rasterSize`
(default 1024²). The stored byte of each texel **is** its class id — no palette indirection. Reading
the PNG raw (e.g. sharp `.raw()`, or `Texture2D.GetPixels32().r` in Unity) gives the id back
directly; PNG decoders that expand grayscale to RGB return three identical bytes, so use any channel.

### Palette / legend

| id | class         | gets vegetation?                    |
|----|---------------|-------------------------------------|
| 0  | `unknown`     | none (shouldn't occur in practice)  |
| 1  | `paved`       | **none** (roads/sidewalks/driveways/crosswalks/hardscape) |
| 2  | `building`    | **none** (footprints)               |
| 3  | `grass`       | grass detail layer                  |
| 4  | `dry-grass`   | dry/yellow grass detail layer       |
| 5  | `dirt`        | sparse or none (optional pebbles)   |
| 6  | `bush`        | bush detail layer                   |
| 7  | `tree-canopy` | tree prototypes (also see `trees`)  |
| 8  | `water`       | **none** (pool/creek/pond)          |

The legend is also embedded in `vegetation.json` under `legend`, so consumers never hard-code it.

### How a texel is classified (pipeline-side)

1. Inside a **building** footprint → `building`. (overrides everything)
2. Else inside a **paved** polygon → `paved`.
3. Else inside a **tree canopy disc** from `trees_placed.json` → `tree-canopy`.
4. Else by **aerial color** (sRGB linearized): bright saturated blue → `water`; dark green →
   `tree-canopy`; mid/bright green → `grass`; saturated mid-dark green → `bush`; yellow straw
   (r≈g>b, mid luma) → `dry-grass`; brown ramp (r>g>b, low-mid luma) → `dirt`; anything
   ambiguous/gray defaults to `grass` (never silently to `paved`).
5. A 3×3 majority filter despeckles the result.

Color thresholds are deliberately conservative and live (commented) in `classifyColor`. A perfect
classifier is not the goal — a sensible seed for Terrain detail layers is.

---

## `<level>.vegetation.json` schema

```jsonc
{
  "frame": {
    "center": [20.91, 35.17],                 // scene.center [e, n]
    "demRect": { "x0": -600, "x1": 600, "z0": -600, "z1": 600 },  // world XZ extent
    "rasterSize": 1024,                        // class raster dimension
    "worldPerTexel": { "x": 1.171875, "z": 1.171875 }             // meters per texel
  },
  "classRaster": "level.surface_class.png",    // file in exports/_ground/
  "legend": { "0": "unknown", "1": "paved", ... "8": "water" },
  "fencePaths": [                              // real-world parcel/lot lines (WORLD XZ)
    { "ring": [[x, z], ...], "mine": false, "apn": "415-80-34" }
  ],
  "trees": { "source": "trees_placed.json", "count": 1049 },      // positions live in that file
  "notes": "..."
}
```

### World ↔ texel mapping

The class raster covers `demRect` exactly. Texel `(i, j)` (i across X, j down Z, with `j = 0` at
`z0` = **north**) maps to a world cell center:

```
X = x0 + (i + 0.5) * worldPerTexel.x
Z = z0 + (j + 0.5) * worldPerTexel.z
```

and inversely `i = (X - x0) / worldPerTexel.x`, `j = (Z - z0) / worldPerTexel.z`.

The world frame matches the export (`scene.json` / `export_property_glb.mjs`):
`world(e, n) = [e - C[0], -(n - C[1])]` — house centroid at origin, +X = east, +Z = **south**,
glTF Y-up. Trees in `trees_placed.json` and `fencePaths` rings are already in this WORLD XZ frame,
so no conversion is needed in Unity.

---

## Intended Unity consumption

Concrete, practical steps. None of this is implemented here — it's the target the annotation feeds.

### 1. Lay a Terrain under the GLB

Create a Unity Terrain (or a flat ground mesh) sized to `demRect` (1200×1200 m by default) and
positioned so its world origin lines up with the export origin. Conform its heights to the GLB
ground if desired, or keep it flat just for detail placement — vegetation roots will be raycast
down onto the GLB collision anyway. The GLB remains the source of truth for buildings, terrain
shape, rocks, and collision.

### 2. Map class ids → Terrain detail layers

Create Terrain **detail prototypes** (low-poly grass clumps/cards, dry-grass cards, a bush mesh)
and map:

| class id | Terrain detail layer        | density        |
|----------|-----------------------------|----------------|
| 3 grass  | grass clump/card detail     | high           |
| 4 dry-grass | dry-grass card detail    | medium         |
| 6 bush   | bush detail mesh            | low (clustered)|
| 5 dirt   | (optional) sparse pebbles   | very low       |
| 1, 2, 8  | **no detail**               | 0              |

### 3. Class raster → detail density map

Read `surface_class.png` raw. For each detail layer, build a density map at the Terrain's
`detailResolution` by sampling the class raster (nearest or area-average) and writing the layer's
target density where the class matches, 0 elsewhere. Push it with
`terrainData.SetDetailLayer(0, 0, layerIndex, map)`. Because `worldPerTexel` is known, the class
raster and the detail grid align 1:1 in world space; resample if the detail resolution differs.

### 4. Trees from `trees_placed.json`

The class raster's `tree-canopy` (id 7) is only a coarse mask. **Place actual trees** from
`trees_placed.json`, which has exact positions and sizes: each `{ x, z, base, canopyR, height }`
in WORLD XZ (`base` = ground Y). Instantiate tree prototypes (or Terrain `TreeInstance`s) at those
points, scaling by `canopyR` / `height`. Enable GPU instancing and tree LOD/billboards for distance.

### 5. Fences along `fencePaths`

Each `fencePaths[i].ring` is a closed parcel/lot polyline in WORLD XZ. Instance fence posts/rails
along the segments (skip segments that run through buildings/roads if undesired). `mine: true`
marks the player's own parcels (APNs `416-120-67` / `416-120-68`) — use it to fence only the home
lot, or to style it differently.

### 6. Performance (per the strategy above)

GPU instancing + LODs on all detail/foliage; billboards for distant grass and trees; short grass
draw distance; realtime shadows **off** on grass; baked lighting and static batching where possible.
The ground texture (on the GLB) carries the look — foliage just adds near-player density.
