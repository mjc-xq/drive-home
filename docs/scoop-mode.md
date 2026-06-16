# Scoop mode

Walk a kid (Drew or CeCe) around the 1840 Dahill Lane backyard sanctuary, scooping
animal poop into the green compost bin, and now **head inside the house** through a
door pad. Mobile-first, one thumb to move + swipe to look. Lives in
`src/engine/engine.js` (`updateScoop` / `updateScoopInterior`), `src/engine/animals.js`
(`createCharacter`), `src/engine/drew.js` + `src/engine/cece.js` (the avatars),
`src/engine/interior.js` (the house), `src/App.jsx` (the HUD) and `src/styles.css`.

## The two sub-scenes

Scoop is one mode with a `scoopScene` flag — **`'yard'`** or **`'interior'`** — that
`updateScoop` forks on. There is no separate top-level mode; `enterScoop`/`exitScoop`,
the joystick, the follow camera and the HUD are all shared.

- **Yard** — the procedural sanctuary: pigs/ducks/iguana, poop, the compost bin, the
  walk-to-drive car pin, terrain grounding, the `SCOOP_CAMS` follow cam.
- **Interior** — the scanned house GLB (`docs/house-interior.md`): fixed-floor grounding,
  per-wall + furniture collision with passable doorways, and a tight indoor follow cam
  that pulls in before it clips a wall and stays under the (virtual) ceiling.

## Doors (auto walk-through)

A blue **🚪 pad** floats in the front yard near the house (`entryPt`, derived from the
curb→house inward normal — note `frontDir` is the *road tangent*, not inward). Stand on
it and you walk inside; a matching blue **exit pad** sits where you arrive indoors —
stand on it to come back out. Both use a hysteresis (`entryArmed`/`exitArmed` + a
`doorT` cooldown) so arriving on a pad never instantly re-triggers it.

The interior is mounted **~2 km from the yard** (`INT_CX/INT_CZ`). Scoop's fog is pulled
in tight (near 38 / far 92), so when the indoor camera is at the interior the whole yard
is fogged out and never drawn — entering/leaving just teleports the character + flips
`interior.group.visible`, with **no per-object yard hide**.

## Avatars: Drew ↔ CeCe (switch is avatar-only)

You control **one** kid; the side-menu switch flips which. `CHAR.drew` is the generic
"active avatar" controller slot (kept that name to avoid a wide rename) — it holds either
the Drew or the CeCe controller, both exposing the same
`{ group, locomotion(speed), react(name), tick(dt), reset() }` interface
(`makeController` in `drew.js`, reused by `cece.js` via a logical→raw clip-name map). The
inactive avatar is cached so the second swap is instant; switching hard-resets to idle so
a controller never gets stripped mid-emote. Real heights: **Drew 5'4", CeCe 4'10"**
(`DREW_HEIGHT_M` / `CECE_HEIGHT_M`), so the models are scaled to size and CeCe is the
shorter one.

Separately, a **decorative Drew + CeCe pair dances inside** the house (the original
"a drew and cece inside" ask) via the crowd system, `zone: 'interior'`, gated visible only
when `scoopScene === 'interior'`. These are NOT the playable avatar.

## The side menu

A collapsible **☰ side menu** (mirrors Drive's `segMenu`/`segMenuPanel`), top-right,
available across all of Scoop. It holds:

- the **Drew / CeCe** character switch (a radiogroup),
- an **Actions** grid — every emote the active avatar can play (Drew: Dance, Cheer;
  CeCe: 11 dances/gestures — All-Night, Gangnam, Silly, Bass Drop, Cheer, Spin Jump,
  Big Heart, Bicycle, Stomp, Tantrum, …), wired to `api.playAction(key)`,
- Camera cycle, Shift-lock, and Exit.

Jump (🦘) stays a dedicated always-on button; "Get in & drive 🚗" still appears inline
when you reach a parked car.

## Engine API (called from the HUD)

`enterScoop` · `exitScoop` · `jump` · `dance` (random emote) · `playAction(key)` ·
`setAvatar('drew'|'cece')` · `getAvatar()` · `getScoopActions()` · `cycleScoopCamera` ·
`toggleShiftLock` · `driveFromScoop`. The engine pushes `emit('avatar', {name, actions})`
on entry and on every swap so the menu's switch + action grid stay in sync.

## URL flag

`?nointerior` skips loading the house GLB (fast verify loops; the door pad goes inert).
