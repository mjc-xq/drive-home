# Adding a character to Da Hilg

A "character" in Da Hilg is one family member who is **both** a Tab-switchable playable
body **and** a wandering NPC, and (in Nibblers) a tint/identity for the swarm clones. The
roster is data-driven, so adding one is mostly registering it in a few lists + rebuilding
assets.

## Prerequisite: the rig

All characters share a **byte-compatible 24-bone Mixamo skeleton** with bare bone names.
The seven canonical animation clips (`idle/walk/run/jump/dance/wave/cheer`) bind to that
rig **by bone name with zero remapping**. So a new character GLB must use that same rig
(a Mixamo auto-rig of a Meshy/other body is what the existing four are). Different bind
proportions are fine — the build's **skin-safe retarget** (drop non-`Hips` translation
channels) handles that. A *different* skeleton means the shared clips won't bind; you'd
have to author per-character clips, which the pipeline doesn't currently do.

Put the source GLB at `src/assets/<name>.glb` (it can keep its own embedded clips — the
build strips them; it ships the 7 shared clips separately).

## Steps

1. **Register the hero GLB build** — `scripts/build_dahilg_assets.mjs`, the `CHARS` array:
   ```js
   { out: '<name>.glb', src: 'src/assets/<name>.glb' },
   ```
   (Textures auto-cap at 512 + KTX2; skinned-safe quantization is applied.)

2. **Register the roster** — `src/da-hilg/constants.js`:
   ```js
   export const CHARACTERS     = ['mike', 'kelli', 'cece', 'drew', '<name>'];
   export const CHARACTER_LABELS = { …, '<name>': '<Name>' };
   export const CHARACTER_BLURB  = { …, '<name>': '<one word>' };
   export const CHARACTER_URL    = { …, '<name>': '/da-hilg/<name>.glb' };
   ```
   That's all the framework needs: `actorRegistry` iterates `CHARACTERS` to spawn the
   player (index 0) + the rest as NPCs from `level.meta.json:npcSpawns`, the HUD renders a
   switch chip per entry, and Tab/number-key switching picks them up automatically.

3. **Add NPC spawn points (optional)** — if you add a 5th+ character and want it placed
   deliberately, the spawn points come from `level.meta.json:npcSpawns`, which is
   **computed** by `scripts/build_dahilg_assets.mjs` (step 4). Add a point to the
   `npcSpawns` array there; otherwise the registry falls back to a spread around spawn 0.

4. **Add it to the Nibblers swarm** — the swarm clones are per-character. In
   `scripts/build_nibbler_vat.mjs` add the character to the bake list (so it gets its own
   textured VAT proxy), and add a tint entry in `src/da-hilg/nibblers/constants.js`
   (`NIBBLER_TINTS`, indexed by the character's position in `CHARACTERS`). If you skip
   this, the swarm just won't spawn that character variant.

5. **Rebuild assets**:
   ```bash
   npm run build:dahilg-assets     # hero GLB + anims + meta
   npm run build:nibbler-vat       # swarm proxy/VAT (if you did step 4)
   ```

6. **Verify** — load `/da-hilg`: the new chip appears in the switch bar; Tab to them and
   walk (the shared clips should bind cleanly — if the torso tears at the waist, the rig
   isn't bone-name-compatible, see the skin-safe note in `AGENTS.md §5`); confirm they
   wander as an NPC; in Nibblers (`/da-hilg?fastmark`) confirm their swarm variant spawns.

## Gotchas

- **Bone-name compatibility is the whole game.** If the new GLB's skeleton differs, the 7
  clips bind partially or not at all and assertion (b) in the asset build fails loudly.
- **Don't hand-edit `level.meta.json`** — it's computed. Edit the generators in
  `build_dahilg_assets.mjs`.
- **Author-facing direction:** the meshes face +Z; the runtime applies
  `MODEL_FACING_OFFSET` so they face their travel/look direction, not the camera. A new
  character authored facing a different axis will look backwards — match the others.
