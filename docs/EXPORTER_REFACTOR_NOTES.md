# Exporter refactor — core + per-level config/hooks (next step)

`scripts/export_property_single_surface.mjs` has grown level-specific logic mixed into the core. This
note captures the agreed direction so the refactor can be done as a focused, verified pass.

## The smell — level-specific stuff currently in the core exporter

- `LEVEL_SETS` table (scene/dir/slug/dropOffPatch/photoreal/patchHalf) — already a per-level config (good; the model to extend).
- `SUPPRESS_PAVING_IDS = new Set([569765775, 558986022])` — hardcoded **stanton** OSM ids (the 4-portables footprint mis-read as parking).
- `if (LEVEL === 'dahill')` — the Blender fence post-step (`place_fences.py`), the owner front-yard-lot tree scatter (APN `416-120-67`).
- `if (LEVEL === 'stanton' || LEVEL === 'canyon')` — the campus canopy-tree fill.
- (removed/superseded) the old dahill back-yard centroid exclusion.

Already data-driven + the right pattern (keep): the per-level sidecars the core reads —
`data/manual_buildings.json`, `data/manual_structures.json`, `data/manual_props.json`.

## Target design — a CORE with a well-defined per-level handoff

Two layers of per-level customization, in increasing power:

1. **Per-level CONFIG (declarative)** — extend `LEVEL_SETS` (or a `exports/<slug>/data/level.config.json`)
   so every knob is data, not an `if`:
   ```
   dahill:  { …, patchHalf: 400, fences: true, frontYardLot: '416-120-67' }
   stanton: { …, suppressPaving: [569765775, 558986022], campusTrees: true }
   canyon:  { …, campusTrees: true }
   xq:      { …, dropOffPatch: true, photoreal: false }
   ```
   The core reads these flags instead of `if (LEVEL === …)`. Most current branches collapse to config.

2. **Per-level HOOK module (imperative, optional)** — `scripts/levels/<slug>.mjs` exporting well-defined
   hooks the core calls at fixed points, for genuinely custom logic that doesn't fit a flag:
   ```js
   export default {
     postFill(ctx)      {}   // mutate ctx.S.buildings after fill (manual adds/removes already cover most)
     prePaint(ctx)      {}   // tweak ctx.network / ctx.MS before the ground atlas bake
     extraLayers(ctx)   {}   // add bespoke geometry groups to ctx.scene (gazebos/props already cover most)
     postWrite(ctx)     {}   // run a post-step on the written GLB (e.g. the dahill Blender fence pass)
   }
   ```
   `ctx` is the well-defined handoff: `{ THREE, scene, S, MS, network, terrainAt, w2, demRect, dataDir, SET, ROOT }`.
   The core does `const hooks = await import('./levels/<slug>.mjs').catch(()=>null)` and calls each hook if present.

## Migration order (low-risk, verify each)

1. Move the data-driven knobs into config (`suppressPaving`, `fences`, `campusTrees`, `frontYardLot`,
   `patchHalf`), replace the `if (LEVEL===…)` reads with config reads. Re-bake all 5 levels; diff the
   outputs (should be byte-comparable modulo timestamps).
2. Extract the truly-custom bits (dahill fence post-step) into `scripts/levels/dahill.mjs::postWrite`,
   wire the core hook loader. Re-bake dahill.
3. The `manual_*.json` sidecars stay as-is — they're already the data half of the handoff.

## Acceptance

- No `if (LEVEL === '…')` in the core exporter (all via config or a hook module).
- Adding a new location = add a `LEVEL_SETS` entry (+ optional `scripts/levels/<slug>.mjs`); no core edits.
- All 5 existing levels re-bake to equivalent output (verified before/after).

Related: `docs/LEVEL_GENERATOR.md` (pipeline overview), the `manual_structures`/`manual_props`/`manual_buildings`
sidecar mechanisms (the existing data-driven hooks).
