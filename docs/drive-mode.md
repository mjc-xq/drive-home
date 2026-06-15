# Drive mode

Drive a real car around the real 1840 Dahill Lane neighbourhood (Hayward, CA),
rendered with Google Photorealistic 3D Tiles, and road-trip to real places.
Mobile-first, one-or-two thumbs, arcade feel.

This doc is the feature map for Drive mode after the multi-round game-feel pass
(the `scripts/drive_eval.mjs` arcade-driving eval loop). All of it lives in
`src/engine/engine.js` (`updateDrive`), `src/engine/audio.js`, `src/App.jsx`
(the HUD) and `src/styles.css`.

## Controls

- **Steer** — left thumbstick (spawns under your thumb, Roblox-style), or arrow
  keys / A-D (ramped so keyboard isn't binary).
- **Gas** — the green **GO** pedal. It's analog: press for ~65 %, **slide your
  thumb down to floor it** (a fill rises in the pedal). `W` / `↑` = full.
- **Brake / reverse** — the red **STOP** pedal (progressive: a tap trail-brakes,
  a hold hauls down hard). Holding past a stop reverses; the pedal label flips to
  **REV** and an `R` lights in the speedo. `S` / `↓`.
- **Handbrake / drift** — the ✋ button (hold) or `Space`. Glows while you're
  drifting.
- **Nitro** — auto-fires when you floor the throttle with charge in the meter (no
  free thumb for a button). The meter under the speedo fills from skill.
- **Horn** — 📣 / `H`.
- **Camera** — 🎥 cycles Cruise → Close → Top-down → Aerial (the button shows the
  current name). 🪄 **Trace** jumps straight to one-finger draw-to-drive.
- **Navigate** — 🧭 address presets (Meemaw's, the schools, Dad's work) + free
  text; or **tap anywhere on the minimap** to drive there.
- 🤖 auto-drive follows the route, 🛣️ snaps you back to the road, 🔊 toggles music.
  Touching the controls cancels auto-drive ("you took the wheel").

## Feel

- **Per-car handling** — Sienna (heavy, grippy), RAV4 (balanced), Ferrari (fast,
  slidey — unlocked by finding all 5 places), Toy Racer (twitchy). Each has
  `{accel, top, grip, slip}`.
- **High top speed, gentle launch** — real top ~180–220 mph on the open road;
  accel eased off the line so a standstill stab isn't jumpy; engine-braking on
  lift; high-speed steering tapers so the blast stays pointable.
- **Sense of speed decoupled from the real top** — a `feelRef` (~60 mph)
  saturates the FOV kick / speed-lines / gauge / engine rev so normal driving
  *feels* fast, while an uncapped `spHi` term keeps the cues building all the way
  to the real top. Motion-blur smear on the streaks flat-out.
- **Drift** — arcade lateral slip, held out on the throttle (power-slide) and
  kicked further on the handbrake; spin-recovery assist makes over-rotation
  catchable. Skid marks + tyre smoke (surface-tinted) + a screech voice.
- **Camera** — chase cam whips the car toward frame-edge in corners, asymmetric
  FOV, Dutch-tilt roll, speed rumble; auto-recenters so two-thumb driving needs no
  look thumb. Cameras stay above the melty ground-level photogrammetry.

## The loop

- **Coin rally** — 18 gold coins; a run timer + quick-chain combo + best time
  saved to `localStorage`.
- **Road trip** — the 5 real places (your house, Meemaw's, Canyon Middle, Stanton
  Elementary, Dad's work / XQ) show as light-pillar **beacons** you can see across
  town + floating **name-plates**. Reaching one awards trip points and **auto-
  routes you to the next** ("floor it to Stanton Elem — follow the pink beam!").
  Finding all 5 unlocks the Ferrari (persisted). Progress shows on the start card.
- **Juice** — ambient **traffic** to weave through (near-miss → combo; clip →
  bounce + CRUNCH), near-miss / drift / arrival feed the **nitro** meter, combos
  crescendo (×3 → ×5 "ON FIRE" → ×8), a big crash breaks the combo, and arrival is
  a finish-line moment (gold burst + slow-mo + fanfare + an ARRIVED card).
- **Audio** — a looping procedural synthwave soundtrack whose filter opens with
  speed, plus the perceptual throttle-aware engine, screech, whooshes and chimes.

## Routing

Google Directions runs in-browser via the Maps JS SDK (`VITE_GOOGLE_MAPS_KEY`),
producing a road-following route drawn on the minimap + a 3D guide ribbon, with a
live remaining-distance + ETA in the destination bar. Auto-drive's speed cap
scales with distance-to-next-turn so long straights run fast.

## Notes

- Collision is on the **invisible** procedural footprints under the photoreal
  tiles (the procedural neighbourhood spans ~±340 m; past that the car rides the
  real photoreal road and only a generous metro-scale sanity ring bounds it).
- `window.__dahill` exposes a debug handle (`api`, `beacons()`, tile nudges, …)
  for headless verification and on-phone debugging.
