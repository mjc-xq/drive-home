# Adding a character to Da Hilg

A "character" is one family member: a Tab-switchable playable body, a wandering NPC,
and (for `drew`) the body the Nibbler swarm wears. The roster is **data-driven from one
manifest**, and bodies/animations come from **Mixamo FBX exports** run through a headless
Blender converter. Adding a character is ~1 manifest entry + a Blender run.

## Architecture (read this first)

- **One canonical skeleton, shared everywhere.** Every character — players, NPCs, and the
  nibbler swarm — uses the **standard Mixamo skeleton with the `mixamorig:` prefix
  stripped** to plain bone names (`Hips`, `Spine`, `Spine1`, `Spine2`, `Head`,
  `Left/RightShoulder/Arm/ForeArm/Hand`, `Left/RightUpLeg/Leg/Foot`). Because the skeleton
  is shared, **any clip plays on any character** by bone-name binding — motions are a
  shared library, not per-character silos.
- **Single source of truth:** `config/dahilg-roster.json`. Each entry:
  `{ id, body, animsGlb, role: "player"|"nibbler", isDefault?, label, blurb, accent:[r,g,b],
  yawOffset, clips?: { <state>: <ClipKey> } }`. The JS asset build, the Unity builder
  (reads it at build time), and the web constants all derive from this.
- **Player states (15):** Idle, Walk, Run, Jump, Dance, Wave, Cheer, **Attack, Attack2,
  Attack3** (3-hit melee combo), Hit, Stumble, Knockdown, Crawl, Climb. Player controller =
  `Assets/DaHilg/Settings/DaHilgCharacter.controller` (default char) or
  `CharacterControllers/<id>.controller`.
- **Nibbler states (7):** Idle, Run, Crawl, Climb, Bite, Jump, Knockdown. Dedicated
  `Assets/DaHilg/Settings/DaHilgNibbler.controller`, clips namespaced under
  `Art/NibblerAnimations` (separate from player `Art/Animations` because the state names
  collide). `role: "nibbler"` characters are the swarm body, not a selectable player.
- **Shared motion library + per-character overrides.** Each state has a shared-default clip
  (any character without an override uses it). A character's `clips` map overrides specific
  states with its own signature motion (e.g. cece boxes, mike punches, kelli jump-attacks).
  Both are emitted to `public/da-hilg/anims/`: shared as `<state>.glb`, overrides as
  `<id>_<state>.glb`. The Unity builder prefers `<id>_<state>` over `<state>` per character.

## The Blender converter

`scripts/convert_mixamo_fbx.py` (headless Blender 5.x) turns a folder of Mixamo `@`-clip
FBX exports into the GLBs the pipeline expects. Per character it produces:
`src/assets/<id>-mx.glb` (skinned body) and `src/assets/anim/<id>-mx-anims.glb` (one glTF
animation per clip). It:
- strips the `mixamorig:` prefix from bones, vertex groups, **and** fcurve data-paths
  (Blender 5 stores FBX actions as **slotted** actions — `action.layers→strips→channelbags→
  fcurves`, NOT `action.fcurves`; missing this is the project's recurring T-pose bug);
- **bakes out the import's `[90,0,0]` Y-up→Z-up object rotation** (`transform_apply`) so the
  exported glTF Armature root is identity and the character stands upright instead of lying
  face-up. This preserves clip content, so fall/death animations still topple the body;
- drops unweighted stray meshes, asserts no residual `mixamorig:` and that the core bone set
  is present, and re-imports the GLB to assert the multi-action export didn't silently
  collapse to one clip.

Clip key = the part of the filename after `@`, with non-alphanumerics → `_`
(`Cece@Catwalk Walk.fbx` → `Catwalk_Walk`). `<...>@T-Pose.fbx` is the mesh, not a clip.
The source-folder filename prefix is ignored; the `<id>` is passed explicitly.

## Steps to add a character

1. **Export from Mixamo** into `~/Downloads/<Folder>/`: a `…@T-Pose.fbx` (with skin) plus
   one `…@<Clip>.fbx` per motion. Any/all of its clips join the shared library.
2. **Point the converter at it** — add to `MIXAMO_FBX_DIRS` in `scripts/build_dahilg.mjs`:
   ```js
   <id>: path.join(os.homedir(), 'Downloads', '<Folder>'),
   ```
3. **Add one manifest entry** — `config/dahilg-roster.json`:
   ```json
   { "id":"<id>", "body":"src/assets/<id>-mx.glb", "animsGlb":"src/assets/anim/<id>-mx-anims.glb",
     "role":"player", "isDefault":false, "label":"<Name>", "blurb":"<word>", "accent":[r,g,b], "yawOffset":0,
     "clips": { "attack":"<ClipKey>", "dance":"<ClipKey>" } }
   ```
   `clips` is optional — list only the states this character should play with its OWN clip;
   everything else falls back to the shared default. (`role:"nibbler"` for a swarm body.)
4. **Web constants (only if web-visible)** — `src/da-hilg/constants.js` (`CHARACTERS`,
   `CHARACTER_LABELS`, `CHARACTER_BLURB`, `CHARACTER_URL`) and, for the web swarm,
   `src/da-hilg/nibblers/constants.js` (`NIBBLER_CHARS`, `NIBBLER_NPC_CHARS`,
   `NIBBLER_NPC_CHAR_IX`, `NIBBLER_TINTS`). These are not yet manifest-derived; keep them in
   lockstep or the web pool 404s.
5. **Build**:
   ```bash
   node scripts/build_dahilg.mjs --convert        # FBX→GLB (all roster chars), then assets
   npm run dahilg:build                            # export → assets → unitysrc → unitybuild (WebGL)
   ```
   `--convert` (or a stale-body freshness check) runs the Blender converter into a temp dir
   and split-copies `<id>-mx.glb`→`src/assets/` and `<id>-mx-anims.glb`→`src/assets/anim/`.
   The JS build emits the 15 shared + per-character override clips; the Unity builder reads
   the manifest, builds per-character controllers + the nibbler controller, retargets every
   clip onto each rig, and prunes dropped characters.
6. **Verify** — `Da Hilg/Validate Character Animations` (or it runs inside the WebGL build):
   it asserts every player controller has all 15 states bound and a moving Run/Crawl. Load
   the game and confirm the character stands, the combo chains, and (for a nibbler) the swarm
   crawls/bites and clings feet-to-body.

## Gotchas

- **Bone-name compatibility is the whole game.** A non-Mixamo skeleton won't bind the shared
  clips. The converter normalizes Mixamo rigs; assertion (B) in the asset build fails loudly
  if a clip's channels don't match the target rig's joints.
- **Orientation:** the converter bakes the rig upright. If a future rig ships face-up, check
  that `transform_apply(rotation=True)` ran (the glTF Armature root must be identity).
- **Filename case:** the Unity builder loads each clip's source rig via
  `AssetDatabase.GetAssetPath(clip)` (the clip's own GLB), so animation filenames are
  case-agnostic across macOS/Linux.
- **Donor gap clips:** Jump/Wave/Cheer/Stumble still come from legacy non-Mixamo donor GLBs
  (`dad.glb`, `family-anims.glb`, `jack-hartmann.glb`). Their trunk bones (`Spine01/Spine02/
  neck`) are aliased to the canonical `Spine1/Spine2/Neck` in `TryFindRetargetBones` so the
  torso isn't frozen. Replacing them with Mixamo-native clips would let the donors retire.
- **Expressive emotes:** Dance and Attack are exempt from the grounded-emote foot check
  (`s_FootPinnedClips` = Idle/Wave/Cheer) — breakdances and jump-attacks legitimately leave
  the ground.
- **Don't hand-edit `level.meta.json` or `DaHilgGameSettings.asset`** — both are regenerated
  by the build.
