# Mixamo Animation Library

A shared, **character-agnostic** library of Mixamo animations as small, animation-only **GLB**
clips. Each clip is a skeleton + one action with the `mixamorig:` prefix STRIPPED from every bone
name and fcurve path, so it binds to the project's canonical plain-named Mixamo skeleton — meaning
**any** Mixamo-rigged character (players, NPCs, the nibbler swarm) can play any clip here with no
per-character re-export. GLBs are ~40–80 KB (vs ~200–500 KB for the FBX); the game ships GLB.

## How it was built
1. `scripts/mixamo_bulk_download.py` — bulk-download from your Mixamo account as FBX (no skin).
2. `scripts/extract_mixamo_anim_glb.py` — each FBX → a tiny anim-only GLB (plain bones, upright
   identity root), reusing the game's exact retarget technique (`scripts/convert_mixamo_fbx.py`).
   The original FBX are kept as the source archive.
3. `scripts/organize_mixamo_library.py` — sort into the hierarchy below.
`manifest.json` maps every clip → its Mixamo description, frame range, category, and source FBX.

## Why this hierarchy (organized by USE, not Mixamo's flat list)
Designers think "I need a punch and its reaction", "all the sword moves", "idle variations" — so
the folders mirror that.

- **locomotion/** — the core movement set, split so a state machine maps cleanly: `idle/ walk/
  run/ turn/ crouch/`.
- **jump/** — jumps, falls, landings (distinct transition states).
- **movement/** — traversal that isn't plain locomotion: climb, swim, crawl, vault, roll,
  cartwheel, push/pull/carry.
- **combat/**
  - **unarmed/attacks/** + **unarmed/reactions/** — kept as SIBLINGS on purpose: a punch and the
    reaction to being punched live one folder apart, so attacks pair with their hit reactions.
  - **death/** — deaths/collapses. **stealth/** — takedowns/assassinations/chokes.
  - **weapons/** — every weapon in **its own folder** (`sword/ rifle/ pistol/ bow/ knife/ blunt/
    spear/ shield/ throw/`) so a weapon's whole moveset stays together (no sword swing mixed with
    a rifle aim).
- **emotes/** — expressive gestures: wave, cheer, point, taunt, laugh, roar, celebrate.
- **social/** — sit/lean/kneel/rest/conversation (ambient life).
- **interaction/** — clips acting on a prop/the world: doors, pickups, levers, reach/grab.
- **dance/ music/ sports/ fitness/** — themed sets, isolated so they don't pollute core gameplay.
- **poses/** — static reference / body-position clips ("on one foot, arm raised").
- **creature/** — zombie/monster/ape motion.
- **misc/** — genuine oddballs the rules couldn't place (e.g. "Milking A Cow"). Kept rather than
  force-fit; review + move by hand if any belong elsewhere.

Classification is ordered keyword rules in `scripts/organize_mixamo_library.py` (first match wins;
combat/specific rules run before broad locomotion). Re-run it to reorganize after tuning the rules.

## Using a clip
The plain-bone skeleton retargets onto any character on the canonical rig (bone contract in
`scripts/convert_mixamo_fbx.py`). Feed chosen clips into the character motion build
(`build_dahilg_unity_assets.mjs` stages `anims/<state>.glb`). Use `manifest.json` to pick by
description + frame range.

## Contents


**2344 clips** across 31 categories:

- `combat/death/` — 31
- `combat/stealth/` — 22
- `combat/unarmed/attacks/` — 168
- `combat/unarmed/reactions/` — 132
- `combat/weapons/blunt/` — 31
- `combat/weapons/bow/` — 51
- `combat/weapons/knife/` — 5
- `combat/weapons/pistol/` — 41
- `combat/weapons/rifle/` — 208
- `combat/weapons/shield/` — 3
- `combat/weapons/spear/` — 2
- `combat/weapons/sword/` — 112
- `combat/weapons/throw/` — 9
- `creature/` — 58
- `dance/` — 139
- `emotes/` — 164
- `fitness/` — 51
- `interaction/` — 124
- `jump/` — 81
- `locomotion/crouch/` — 64
- `locomotion/idle/` — 98
- `locomotion/run/` — 89
- `locomotion/turn/` — 87
- `locomotion/walk/` — 135
- `magic/` — 2
- `misc/` — 12
- `movement/` — 137
- `music/` — 9
- `poses/` — 66
- `social/` — 95
- `sports/` — 118
