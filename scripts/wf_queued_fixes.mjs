export const meta = {
  name: 'dahilg-queued-fixes',
  description: 'Root-cause + concrete fix specs for the 4 remaining Da Hilg items: street-spawn all levels, interior occlusion, vegetation render, swarm tuning/flop-escape',
  phases: [
    { title: 'Diagnose', detail: '4 parallel fix-spec lenses' },
    { title: 'Synthesize', detail: 'one implementable plan' },
  ],
}

const RT = '/Users/mcohen/dev/home/unity/DaHilgUnity/Assets/DaHilg/Scripts/Runtime'
const ED = '/Users/mcohen/dev/home/unity/DaHilgUnity/Assets/DaHilg/Scripts/Editor'
const SC = '/Users/mcohen/dev/home/scripts'

const CTX = [
  'Da Hilg = Unity 6000.5 WebGL (Built-in RP). CURRENT STATE (all verified in-engine just now): characters animate (T-pose fixed), nibblers chase + pile on the player (swarm works), giant-nibbler fixed, minimap is clean Google-Maps style upper-right, and a vegetation/water OVERLAY GLB (creek + instanced trees + grass extracted from the rich master) now loads on top of the single-surface ground WITHOUT breaking the scene (fall-through fixed).',
  'CONSTRAINTS: Built-in RP (not URP). DO NOT edit DaHilgGameSettings.asset — the user reverts it; tune ALL gameplay in CODE (constants/fields in the scripts). The level env is a single-surface GLB streamed from StreamingAssets; vegetation/water is the separate <slug>_overlay.glb loaded by DaHilgLevelRuntime.LoadStreamedLevel (parented under the level root, PrepareLevelColliders(overlayRoot, addColliders:false)).',
  '',
  'KEY FILES:',
  RT + '/DaHilgGameManager.cs  (SpawnActors spawn+facing; nibbler overwhelm: m_BuriedLoad/UpdateBuriedLoad, struggle-out, ShedAttached, jump radial-peel; HP drain via Settings.NibblerHealthDrainPerAttached/Cap; AwardCrush/score)',
  RT + '/DaHilgActor.cs  (Teleport(pos,facingYaw); Roll/flop; Health; PlayEmote role guard; locomotion)',
  RT + '/DaHilgLevelRuntime.cs  (LoadStreamedLevel + overlay load; ApplyLevelOffset; PrepareLevelColliders(level, addColliders); TuneLevelSurface; TuneVegetationSurface; DaHilgWaterAnimator add; StreamGlbUrl)',
  RT + '/DaHilgCameraRig.cs  (3rd-person follow, deoccluder MinimumDistanceFromTarget, camera modes Follow/Shoulder/FirstPerson, Punch)',
  ED + '/DaHilgProjectBuilder.cs  (BuildLevel: spawns from meta "spawns" + ExtractHouseBounds -> GreetSafeZones[0].Center; StageStreamingLevelGlb/StageStreamingOverlayGlb; BuildInteriorLevel for the house interior; CustomizeWebGLExport)',
  SC + '/build_dahilg_overlay.mjs  (extracts Creek_*/Trees/Tree_*/Grass from exports/<level>-property.glb master -> public/da-hilg/<out>_overlay.glb via strip-non-veg + prune + dedup + instance)',
  SC + '/build_dahilg_assets.mjs  (single-surface env assets; LEVELS src=<slug>-single.glb)',
  'exports/ has the rich masters (1840-dahill-property.glb etc.) with named meshes: Creek_SanLorenzo/Banks/Rocks/Reeds, Trees + Tree_0..1049 (48 distinct meshes), Shrubs/Grass_Wind/GrassClump_*. The overlay world-bounds were center y~60 size y~53 (env ground is ~y=33; LevelOffset for dahill is ~0).',
  '',
  'USER FEEDBACK (just tested in-engine, must drive these fixes): (1) NO trees and NO grass are visible — the overlay loads but its meshes do not render (veg-render lens MUST find why: y-offset/material/cull/visibility). (2) The MINIMAP is hard to read: it shows DOTS instead of a STREET network and has NO CREEK — almost certainly the single-surface minimap.json lost the road line-art (the flattening dropped roads), so there are no street segments to draw. The minimap element reads Data/<minimap>.json arrays (road/drive/walk/curb/line).',
  RT + '/DaHilgMinimapElement.cs  (draws minimap.json segment arrays as roads + zones + agent dots; MinimapData.FromProfile parses road/drive/walk/curb/line)',
  SC + '/build_dahilg_assets.mjs / the minimap generation (where <slug>.minimap.json road segments come from)',
].join('\n')

const FIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'rootCause', 'fix', 'files', 'risk'],
  properties: {
    area: { type: 'string' },
    rootCause: { type: 'string' },
    fix: { type: 'string', description: 'exact implementable fix: file:line, code/values, step by step' },
    files: { type: 'array', items: { type: 'string' } },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
}

const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['fixes', 'buildPlan', 'verifyPlan'],
  properties: {
    fixes: { type: 'array', minItems: 5, items: { type: 'object', additionalProperties: false,
      required: ['rank', 'area', 'files', 'change'],
      properties: { rank: { type: 'integer' }, area: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, change: { type: 'string' } } } },
    buildPlan: { type: 'string', description: 'which build stages to run (export/assets/unitysrc/unitybuild) and why' },
    verifyPlan: { type: 'array', items: { type: 'string' } },
  },
}

phase('Diagnose')
const LENSES = [
  { key: 'street-spawn', focus: 'Make the player spawn ON THE STREET directly in front of each level\'s MAIN ADDRESS, facing the house, inside a safe zone — for ALL 5 levels (dahill/canyon/stanton/meemaw/xq). Today the spawn is meta "spawns" (hardcoded dahill (0,0.05,23.315)) + a house->spawn facing. Design a per-level street-front computation: the rich master has a "Roads" mesh + the house center (ExtractHouseBounds). Best path: in build_dahilg_overlay.mjs (already reads each master), ALSO compute the nearest Road vertex/edge to the house center, push the spawn a little onto the road, and write {streetSpawn:[x,y,z], facing:deg} into each level meta JSON (Data/<meta>.json); then DaHilgProjectBuilder.BuildLevel reads streetSpawn into PlayerSpawns[0] and DaHilgGameManager.SpawnActors already applies facing. Give concrete code for the master-road nearest-point computation + the meta write + the builder read.' },
  { key: 'interior-occlusion', focus: 'The house INTERIOR level is "unusable" due to occlusion. Investigate how the interior loads (DaHilgProjectBuilder BuildInteriorLevel; Art/Levels/house-interior.glb; baked prefab not streamed) and the camera (DaHilgCameraRig 3rd-person). Likely causes: (a) interior walls are single-sided so from the 3rd-person camera outside/through a wall you see into/through the room; (b) the 3rd-person deoccluder camera cannot fit in a small room and clips through walls or jams; (c) the roof/near walls are not culled so the camera is blocked. Diagnose the REAL cause and give a concrete fix — e.g. force a closer/first-person camera for the interior level, OR fade/cull walls between camera and player, OR make interior meshes double-sided, OR lower the camera deoccluder MinimumDistance for interiors. Be specific to the code.' },
  { key: 'veg-render', focus: 'The vegetation overlay LOADS (no crash) but the trees/creek are not clearly visible/placed in-engine. Find why and fix: (1) Y-PLACEMENT: overlay world-bounds y-center ~60 vs ground y~33 — are trees rooted on the ground or floating/sunk? Check ApplyLevelOffset vs the overlay being parented under root (does it get the right offset?). (2) MATERIALS: does build_dahilg_overlay.mjs (strip non-veg meshes + prune + dedup + instance) PRESERVE the tree/grass/water materials+textures, or are they pruned/untextured/invisible? (3) TuneVegetationSurface/TuneLevelSurface on the overlay — does it correctly tune (not hide) the trees/grass and animate the creek water? Give the exact fix so trees + grass + creek render, textured, correctly grounded. Note: GLTFAST_KEEP_MESH_DATA is set; the overlay is plain (no meshopt).' },
  { key: 'minimap-streets', focus: 'The minimap is "hard to read — dots instead of streets, no creek." Find why the street network does not render: almost certainly the single-surface minimap.json (Data/<minimap>.json) has EMPTY or near-empty road/walk segment arrays because the single-surface bake dropped the road geometry (same reason the 3D roads/creek are gone). VERIFY by checking the actual road segment counts in Data/minimap.json. Fix: regenerate the minimap line-art from the RICH master (project its Roads + Sidewalks + Creek_* meshes to the XZ plane into segment arrays) so the minimap shows a real street network + the creek as a blue line. Find where minimap.json is generated (build_dahilg_assets.mjs or a minimap script) and give the concrete generation fix, plus a DaHilgMinimapElement tweak to draw the creek (a blue stroke) and keep roads the clear hero over the agent dots.' },
  { key: 'swarm-tuning', focus: 'The swarm overwhelms to 0% HP almost instantly (25 riders at -2.3 HP/s) — not fun. Make it FUN + survivable with a clear FLOP/ROLL escape. Read DaHilgGameManager (m_BuriedLoad/UpdateBuriedLoad tiers, struggle-out, ShedAttached, jump radial-peel 0.40, HP drain from Settings.NibblerHealthDrainPerAttached*count capped at Cap) + DaHilgActor (Roll). Tune IN CODE (never the .asset): (a) cap the effective HP drain lower / make it ramp so you have time; (b) make ROLL (flop) shed a strong batch of attached nibblers (a clear panic-button escape) + brief i-frames; (c) keep it visibly threatening but escapable. Give concrete code changes (constants, the roll-shed hook, drain math).' },
]
const findings = (await parallel(LENSES.map(L => () => agent(
  'You are a Unity gameplay engineer. Produce a CONCRETE, implementable fix spec for ONE area, grounded in the actual code (read the files). Exact file:line, code, and values.\n\nAREA: ' + L.focus + '\n\n' + CTX,
  { label: 'fix:' + L.key, phase: 'Diagnose', schema: FIX_SCHEMA }
)))).filter(Boolean)
log('Diagnosed ' + findings.length + ' areas. Synthesizing the build plan.')

phase('Synthesize')
const synth = await agent(
  'Synthesize these 5 fix specs into ONE ordered, directly-implementable plan (rank, area, files, exact change), the minimal build stages to run, and an in-engine verify step per fix. Order: veg-render + swarm-tuning (code-only, fast) first, then minimap-streets + street-spawn (need master-derived data into meta/minimap.json), then interior-occlusion.\n\n=== FIX SPECS ===\n' + JSON.stringify(findings, null, 1) + '\n\n=== CONTEXT ===\n' + CTX,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA }
)

return { findings, synth }
