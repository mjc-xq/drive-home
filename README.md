# 1840 Dahill Lane — Interactive 3D Neighborhood

A real-data 3D model of 1840 Dahill Lane, Hayward CA 94541, with two
mini-games for the kids: **Drive** (collect 6 rings in a Ferrari 458) and
**Scoop 💩** (clean up after the animal sanctuary: 5 potbelly pigs, 2 ducks,
1 iguana). Real building footprints, streets, San Lorenzo Creek, terrain and
aerial imagery. Mobile-first — it ships as **one self-contained HTML file**
that runs inside the Claude app's artifact viewer.

## Commands

```sh
npm install
npm run dev          # vite dev server (check for a running one first!)
npm test             # 24 vitest tests (coords, terrain, roadmask, tools, schema)
npm run build        # emits dist/index.html — the single shipping file
node scripts/verify_car_node.mjs   # proves the Ferrari GLB + Draco decode in Node
```

URL flags: `?lite` (no shadows/AA, 1x pixel ratio — old phones, headless
verification) · `?nocar` (skip the GLB swap; procedural car stays).

## Architecture

three.js **r128** (the only runtime network dependency, from cdnjs). React owns
the HUD shell (`src/App.jsx`); the engine is plain three.js:

```
src/engine/
  data.js      scene.json + coordinate frames + sanctuary placement (SREC)
  coords.js    orig (m east/north of geocode) <-> world (x=east, z=-north)
  terrain.js   bilinear heightfield sampler
  roadmask.js  drivable-surface occupancy grid (onRoad)
  world.js     terrain/creek/roads/buildings/yard/sanctuary/trees/labels
  animals.js   pigs, ducks, iguana, poop pools, the keeper
  car.js       procedural Ferrari + GLB swap-in
  draco-install.js / draco-shim.js / vendor: main-thread Draco (see below)
  audio.js     engine + sfx (WebAudio)
  engine.js    modes (explore/drive/scoop), controls, cameras, rings, render loop
```

## The Draco constraint (important)

The Claude artifact webview blocks **Workers, WASM and eval**, so the stock
DRACOLoader can't run there. The r128 *asm.js* decoder is vendored pristine
(`src/vendor/draco_decoder.js`), injected as a classic sloppy-mode script
(`?raw` import — never let the bundler transform/minify it), and decoded on
the main thread by `draco-shim.js`.

**Gotcha that once crashed the tab:** the Emscripten module object is
*thenable* — resolving a Promise with it directly spins the microtask queue
forever (100% CPU, memory blowup). The shim resolves `{ draco }` instead,
like the official DRACOLoader. `scripts/verify_car_node.mjs` re-proves the
whole pipeline in ~300 ms.

## Data regeneration

- `scripts/build_scene.py` (run with `scripts/.venv/bin/python`) rebuilds
  `src/assets/scene.json` + `aerial_opt.jpg` from open sources; caches in
  `scripts/_cache/`.
- `scripts/extract_assets.py` recovers the original artifact's assets from a
  shipped HTML file for exact-parity swaps.
- `scripts/fetch_streetview.py` bakes Google Street View photos for the drive
  level's 6 ring streets into `src/assets/streetview/` (billboards appear
  automatically). Needs `GOOGLE_MAPS_API_KEY` in the env **with the
  "Street View Static API" enabled** on the key's Cloud project.

## Credits & data sources

Ferrari 458 model by **vicent091036** (via three.js examples) — keep the
in-game credit card. Aerial imagery © Esri World Imagery. Buildings from
Overture Maps (incl. Microsoft ML footprints). Roads/creek © OpenStreetMap
contributors. Terrain from AWS Terrain Tiles. Street View photos © Google
(attribution baked into each billboard).
