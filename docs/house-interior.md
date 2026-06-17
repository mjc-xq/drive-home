# House interior

The inside of 1840 Dahill Lane is a furniture-segmented **room scan** dropped into Scoop
mode. Loaded + normalised by `src/engine/interior.js` (`createInterior`). Built from a
scan; **more rooms come later**, so the loader stays generic (categorise by node name,
derive everything from geometry — nothing hard-codes a room).

## The GLB (`src/assets/house-interior.glb`)

- **Plain GLB** (the 6/16 scan, ~1.9 MB): ~304 meshes, ~61k tris, 10 small textures (~1 MB),
  **no Draco, no animations, no extensions** → the **stock `GLTFLoader`** loads it (NOT the
  DracoShim path the cars/CeCe use — don't mix them up). The scan is re-generated periodically,
  so nothing hard-codes counts — the loader is name-driven and `floorTop`/bounds are computed.
- Bounds ≈ 8.5 × 3.42 (tall) × 17.9; floor **top** ≈ −1.30 (recenter is computed, not constant).
- **Names live on NODES** — traverse the loaded scene by `object.name`. Categories on the 6/16
  scan: ~187 `wall_*`/`joint_*` (structure), 14 `door_*`, 20 `window_*`, 20 `floor_*` (rooms:
  Living Room, Kitchen, Dining Room, Laundry, Bathroom, Bedrooms 1-6, "Other"), 4 `sofa_*`, plus
  named furniture (cabinets, appliances, chairs, tables).
- Re-run the structure check after a re-scan: `node scripts/verify_interior_node.mjs` (three.js-free;
  generic asserts so more/fewer rooms still pass, and it fails loudly if a scan ships with Draco).

## Normalisation

- **Recenter floor TOP to `y = 0`** (`group.position.y = floorY − floorTop`, using the
  `floor_*` meshes' `box.max.y`). Recentering on overall `min.y` instead would sink the
  character ~10 cm into the floor. Footprint centre is moved to the chosen origin; **no
  scale** (already metric).
- **Light rig** parented to the group (same `× Math.PI` physical-intensity convention as
  the scene sun/hemi, or rooms render ~3× too dark): a gentle Ambient + Hemisphere + one
  soft Directional fill. The scan has **no ceiling**, so the scene sun reaches in too —
  the room is a roofless dollhouse under the sky.
- Walls are `side: DoubleSide` (inward faces would otherwise be black); shadows off on all
  interior meshes.

## Collision (per-wall — NOT the union)

The union of all `wall_*` is just the outer 8.36 × 13.07 shell, so clamping to it would
let you walk through every interior partition. Instead `interior.collide()` pushes out of
**each wall's own AABB** (+ `joint_*`) and the **large floor-standing furniture**
(sofa/table/fridge/oven/stove/dishwasher/sink/washer-dryer/shelf/tall-cabinet — chairs and
wall-hugging mid/low cabinets are skipped, already covered by walls), with axis-slide, then
a hard clamp to the outer shell. The 12 `door_*` nodes are treated as **passable portals**:
inside a door AABB, wall collision is bypassed, so per-wall collision doesn't seal rooms.

## Mounting (far away + fog)

The interior is added to the scene **~2 km from the yard** (`INT_CX/INT_CZ` in
`engine.js`). Scoop's tight fog (near 38 / far 92) fogs the distant yard to the background
when the indoor camera is at the interior, and fogs the interior away when the camera is in
the yard — so showing/hiding the house is just `interior.group.visible` + teleporting the
character, with no per-object yard hide. `interior.clampCam` keeps the small indoor follow
cam inside the walls and under the ceiling; `updateScoopInterior` also pulls the camera in
before it would poke through a wall.

## The couch swap (couchy.usdz)

The couch nearest a window (`sofa_*` closest to a `window_*` centre — currently
`sofa_rect0`, 0.57 m from `window_1`) is replaced by **`src/assets/couchy.usdz`**, loaded
with three's **`USDLoader`** (`USDZLoader` is deprecated). That loader reads the binary
**USDC** crate + **AVIF** textures in pure JS (fflate unzip — no wasm/workers, fine for the
artifact-webview constraints) and auto-converts Z-up→Y-up. `**/*.usdz**` is added to Vite's
`assetsInclude`. It loads **non-blocking** (the original sofa shows until it lands and stays
on failure), is scaled to the original couch's length with its long axis aligned, and dropped
on the couch's spot — the original sofa's furniture collider stays, so the new couch blocks.
~14.5 MB (binary USDC parses on the main thread, so a brief hitch on first load is expected).
Its facing isn't guaranteed (USD orientation varies) — flip the `Math.PI/2` long-axis rotation
in `interior.js` if it sits the wrong way.

## Build size

The build is **multi-file** (`vite-plugin-singlefile` is an unused dependency) —
`dist/index.html` stays ~1.5 KB and each GLB is a separate `dist/assets/*.glb` lazy fetch.
The interior (~946 KB) and dog couch (~40 MB) are external fetches, not base64 inline.
`?nointerior` skips the interior load entirely.
