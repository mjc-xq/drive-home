# Design brief: Drive HUD + Navigate/Jump-to-Location

## Context
This is a touch-first, real-time 3D driving experience layered over Google's photorealistic 3D map tiles ("1840 Dahill Lane" — a drivable neighborhood). A player drives a car around real streets with arcade controls. The app has three modes — **Explore**, **Drive**, and **Scoop** — but this brief covers the **Drive HUD**, which is the densest and contains the Navigate / Jump-to-location feature.

**Your job:** design the visual language, layout, hierarchy, and interaction feel of the Drive HUD from scratch. The functional requirements below are fixed — every element listed must be present and behave as described — but the look, placement, grouping, and styling are entirely yours. Do **not** anchor to any existing design. Assume a phone in landscape as the primary target (thumbs occupy the bottom-left and bottom-right corners), but it must also work on desktop with mouse/keyboard.

## Hard constraints (functional, non-negotiable)
- **The car is always the focal point.** The center of the screen and both lower-corner "thumb zones" must stay visually clear so the HUD never covers the vehicle or the road ahead. HUD chrome lives at the edges.
- **Two update tempos.** Some values change every animation frame (speed, compass heading, the steering joystick knob, ETA, the speed bar, nitro fill, the gas-pedal fill, the brake label). Others change occasionally and are event-driven (destination set/cleared, auto-drive on/off, score changes, camera name, arrival). Design so the per-frame values can animate smoothly without the whole panel re-rendering.
- **Touch ergonomics.** Driving controls (steer, gas, brake, handbrake, horn) sit under the thumbs at the bottom corners. Informational/menu controls sit elsewhere so they're never hit accidentally mid-corner.

## Functional inventory — everything the Drive HUD must expose

### 1. Telemetry cluster (read-outs)
- **Speed** — large numeric MPH plus a "MPH" label, updated every frame.
- **Reverse indicator** — an "R" state that activates when the car is going backwards.
- **A speedometer bar** — a continuous fill that tracks current speed (this is a per-frame analog readout, distinct from the numeric value).
- **Compass** — a rotating needle showing the car's heading, with North marked.
- **Run timer** — elapsed drive time as `M:SS`, ticking every frame.
- **Nitro/boost gauge** — a fill bar labeled "NITRO" showing available boost charge.
- **Score group (only appears once a scored run is active):**
  - Coins collected: `got / total`.
  - Neighborhood places found: `found / total` (out of 5 — a collection/achievement counter).
  - Combo multiplier: `×N`, shown only when N > 1, with a heightened "on fire" state at N ≥ 5.
  - Trip score: a running points number for the current trip.

### 2. Destination headline (top of the telemetry area)
This has two states:
- **No destination → "Free roam":** a label telling the player they can tap the map to drive somewhere.
- **Destination set → "Next stop":** shows the destination's name/label, a **live ETA** (updates per frame as the car approaches), an **auto-drive toggle** (a robot/chauffeur button — when on, the car drives itself to the destination; only available when a destination exists), and a **clear-destination** control.

### 3. Minimap
- A small top-down map tile showing the car and surroundings.
- **Tap-to-drive:** tapping anywhere on the minimap sets that point as a drive target. The car then auto-routes there **along real roads** (never a straight line across terrain); if no road route is ready yet it idles until one is found. The guide ribbon, destination pin, ETA, and arrival flow all engage automatically.

### 4. Action rail (labelled, always-visible menu controls — kept away from the pedals)
Each is an icon + text label; some are stateful toggles that must read clearly as on/off:
- **Road** — snap the car back onto the nearest road (recovery if you've gone off-route).
- **Camera** — cycles through camera views; the button shows the **current camera's name** (e.g. Cruise, Top-down, Aerial).
- **Trace** — toggles a "drag the road to drive" steering mode (used with top-down/aerial cameras); has a distinct on state.
- **Go to…** — opens the Navigate panel (see section 6).
- **Cars** — opens the car picker.
- **Assist** — lane-keep / auto-steer toggle, reads "Assist on/off".
- **Music** — soundtrack toggle, with a muted/unmuted state.

### 5. Driving controls (bottom thumb zones)
- **Steering joystick** — spawns under the left thumb; a knob that the design must accommodate (its position is driven per-frame). A faint "steer here" ghost hint appears for the first few seconds of a drive only.
- **Gas pedal (analog)** — pressing engages ~65% throttle; **sliding the thumb downward along the pedal increases throttle toward 100% ("floor it")**. The pedal must visually show its current fill level. Pointer capture keeps the press alive through a thumb-roll mid-corner.
- **Brake / STOP** — hold to slow, then reverse; the label reflects state.
- **Handbrake** — hold to drift; has an active "drifting" state, and a transient "DRIFT!" flourish appears while a sustained drift is happening.
- **Horn.**
- **Drive hint** — a one-line "how to drive" tip that shows briefly at the start (its wording changes depending on whether the player is in normal steering vs. trace/drag-to-drive mode).

### 6. Navigate panel — including Jump-to-location (PRIMARY FOCUS)
Opened from the **Go to…** action. It's a dismissible panel with a title and close control. It contains **two distinct address tools plus presets and a setting.** The key conceptual distinction the design must make obvious:

- **"Drive to"** = set a destination and route/drive there (the car stays where it is and navigates).
- **"Jump to"** = *teleport the car to a new starting location* and clear any destination (relocate, don't navigate).

These are different actions with different outcomes and must be visually differentiated so a player never confuses "go somewhere" with "start over somewhere new."

**Address search component (used by both Drive-to and Jump-to):**
- A text input with live **autocomplete suggestions** (Google Places). Behavior: suggestions appear after **3+ characters**, **debounced** (~220 ms), showing up to **5** predictions, each with a location pin and the place description.
- The player can either **pick a suggestion** or **type free text and submit** (Enter / a Go button).
- A **busy/loading state** while the address is being resolved (geocoded).
- **Error state:** if the place/address can't be found, show an inline, recoverable error ("Couldn't find that place/address") — don't close the panel.
- On success, the panel closes and the action takes effect.

**Drive-to specifics:**
- Submitting routes to the destination and **starts auto-drive** (chauffeur engages, car points itself down the route start so it sets off forward, not via a U-turn).
- **Preset destination chips** — a small row of one-tap favorite places (e.g. "Meemaw's," a school, "Dad's work"). Tapping one drives there immediately, with a graceful fallback if geocoding is unavailable.

**Jump-to specifics:**
- Submitting **teleports the car** to that address, **snaps it onto the nearest road** if one is close by, clears any active destination, and re-settles the camera. Communicate that this is a relocation/"start somewhere new" action, not navigation.

**Auto-drive speed setting:**
- A slider controlling the auto-drive **top speed cap**, from "slow" up to 700 mph, where **0 = unlimited**. The current value must be shown as a live readout (e.g. "unlimited" or "N mph"). This setting persists across sessions.

### 7. Transient overlays / feedback (design these as a coherent family)
- **Arrival card** — celebratory "You made it to {place}!" with points earned and trip score; auto-dismisses after a few seconds.
- **Car card** — when a car is selected, a brief card with the car's name, spec, and credit; auto-dismisses.
- **Toast** — a generic short-lived status message (routing, jumped, auto-drive on/off, etc.).
- **Map data attribution** — a small, persistent, legally-required Google credit line for the 3D map data. It must always be visible and legible but unobtrusive.
- **Car picker** — a selectable list of cars; each row shows name, spec, and credit, marks the current car, and shows **locked** cars (unlocked by finding all 5 neighborhood places) with their unlock condition.

### 8. Cross-mode chrome (present but lighter — design at least how it coexists)
- A **loading screen** ("Building the neighborhood…") that resolves to the experience.
- A **start menu** offering Explore / Drive / Scoop, plus a progress badge for neighborhood places found.

## Deliverable
Design the full Drive HUD as a fresh interface: visual system, component hierarchy, layout for landscape phone and desktop, the states and transitions for every interactive element above, and the complete Navigate panel flow with its Drive-to vs. Jump-to distinction front and center. Show empty/active/busy/error states for the address search, on/off states for every toggle, and the resting vs. engaged states of the pedals and joystick. Prioritize at-a-glance legibility while driving, thumb reachability, and keeping the car unobstructed.
