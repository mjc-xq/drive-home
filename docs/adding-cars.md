# Adding a car to the roster

The 🚗 picker in Drive lists every entry in `VEHICLES` (src/engine/car.js). Adding
a car is four small steps.

## 1. Get a GLB

Use any car GLB you're licensed to use. Good CC0 sources:

- **Khronos glTF Sample Assets** — e.g. the ToyCar used here:
  `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/ToyCar/glTF-Binary/ToyCar.glb`
- **Poly Pizza** (poly.pizza) — CC0 low-poly cars, direct .glb downloads.
- **Quaternius** (quaternius.com) — CC0 vehicle packs.

```sh
curl -sL -o /tmp/mycar.glb "<url>"
```

## 2. Optimize it into src/assets

Shrinks it and webp-compresses textures. `quantize` needs no runtime decoder
(GLTFLoader reads `KHR_mesh_quantization` natively):

```sh
npx gltf-transform optimize /tmp/mycar.glb src/assets/mycar.glb \
  --compress quantize --texture-compress webp
```

## 3. Add a roster entry

In `src/engine/car.js`, append to `VEHICLES` with the next free `slot`:

```js
{ slot: 4, name: 'My Car', spec: 'V8 · 400 HP', credit: 'author · CC0' }
```

## 4. Load it

In `src/engine/engine.js`, import the asset and add one `loadDrivableCar` call
next to the others (~line 427):

```js
import mycarUrl from '../assets/mycar.glb';
// ...
loadDrivableCar(car, mycarUrl, 4, { length: 4.6, flip: false, black: false, meta: VEHICLES[4] });
```

- `length` — normalizes the model to that many metres (it's auto-centred + sat on
  the ground).
- `flip: true` — add if the model drives backwards (its nose runs −Z).
- `black: true` — repaints the body near-black (used for the parked driveway cars).

That's it — the picker, cycle and car card pick it up automatically from `VEHICLES`.
