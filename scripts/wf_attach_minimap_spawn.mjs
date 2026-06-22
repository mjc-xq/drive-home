export const meta = {
  name: 'dahilg-attach-minimap-spawn',
  description: 'Multi-angle redesign specs for hard Da Hilg problems: nibblers cling to the animated body (player-is-surface), solid Google-Maps minimap streets, real flowing creek, visible grass, address-front spawn',
  phases: [
    { title: 'Angles', detail: 'parallel design lenses' },
    { title: 'Synthesize', detail: 'one implementation plan' },
  ],
}

const RT = '/Users/mcohen/dev/home/unity/DaHilgUnity/Assets/DaHilg/Scripts/Runtime'
const ED = '/Users/mcohen/dev/home/unity/DaHilgUnity/Assets/DaHilg/Scripts/Editor'
const SC = '/Users/mcohen/dev/home/scripts'

const CTX = [
  'Da Hilg = Unity 6000.5 WebGL (Built-in RP), glTFast-streamed levels. Read the ACTUAL code; give exact, implementable specs (file:line, code).',
  '',
  'PROBLEM A — NIBBLER ATTACH (the core mechanic, currently wrong): nibblers SWARM IN FRONT of the player instead of clinging ON them. REQUIRED behavior: nibblers move INDEPENDENTLY, JUMP ONTO the player, and FROM THAT POINT THE PLAYER IS THEIR SURFACE — each attached nibbler sticks to the player\'s ACTUAL ANIMATED BODY: if the player moves they move, if the player FALLS they fall with them, if the player EMOTES/bends down the nibbler stays glued to the real body part (not where the body used to be), and gravity keeps dragging them onto the body (they cling, don\'t drift off). They must distribute over the WHOLE body (back, shoulders, head, legs, arms) — not pile at the front face.',
  'A-CODE: ' + RT + '/DaHilgNibblerAgent.cs — FSM Chase->Windup->Lunge->Climb->Attached; PositionOnBody() does `Root.transform.position = m_Player.TransformPoint(local)` (relative to the player ROOT transform, NOT the animated skinned-mesh bones — so it does NOT follow bend/emote/animation); the nibbler Root is parented to m_NibblerRoot (a sibling), never to the player; ChooseAttachAnchor sets m_AttachBaseLocal (the body offset); k_ClingBottom/m_AttachY/m_AttachTargetY climb. ' + RT + '/DaHilgActor.cs — the visual is a scaled CHILD (m_VisualT); the rig has SkinnedMeshRenderer bones (FindDeepChild "Hips","Spine","LeftArm","RightArm","LeftLeg","RightLeg","LeftFoot","RightFoot","Head" etc.); animation drives those bones; FeetPosition, BodyHeight, Role. ' + RT + '/DaHilgGameManager.cs — AttachedNibblerCount, ShedAttached (must UN-parent cleanly), overwhelm, jump/roll peel.',
  'A-KEY INSIGHT to evaluate: make an attached nibbler a CHILD of a chosen player BONE (skinned-mesh bone Transform) with a per-nibbler localPosition/localRotation, so it rides the animated surface for free (Unity parents to the bone that the SkinnedMeshRenderer animates). On shed/roll/jump it must reparent back to m_NibblerRoot at the bone\'s world pose and resume ground AI. Address: bone selection + spread over the body, the jump-on transition that ends in the parent, gravity-cling feel, and clean un-parent. Watch for: bones live under the visual child which is SCALED (the nibbler must not inherit the player\'s scale wrongly — set worldPositionStays + counter-scale, or attach at the bone with a corrected localScale).',
  '',
  'PROBLEM B — MINIMAP still reads as DOT STIPPLE, not streets (user has asked for a "Google Maps view" many times). The road layer renders as thousands of tiny disconnected WHITE specks. ROOT: ' + SC + '/build_minimap.mjs emits BOUNDARY EDGES (edges used by exactly one triangle) for road/drive/walk — for a wide road area the boundary edges are countless tiny fragments = stipple, NOT connected streets. The CREEK already looks good (it is long+thin so its edges form a line) + is blue. ' + RT + '/DaHilgMinimapElement.cs draws each layer as line segments (k_MaxSegmentsPerLayer already 6000, no decimation). REQUIRED: roads must read as SOLID CONNECTED ribbons like Google Maps. Evaluate: emit FILLED road TRIANGLES (readWorldTris already exists) and have the element FILL them as 2D polygons (solid road surface) — likely the cleanest "Google Maps" look — vs swept road centerlines. Give the exact build_minimap.mjs + DaHilgMinimapElement.cs changes (data shape, fill draw, road color/contrast on the dark field, keep creek blue + roads the hero). Keep it performant (a few thousand filled tris once-per-dirty is fine).',
  '',
  'PROBLEM D — CREEK is a tiny blue PUDDLE with GREEN winding banks ("green curbs"), NOT a real flowing-water creek with water animation + an adjustable water level. From the rich master: Creek_SanLorenzo (the water surface, ~2874 tris) renders small/puddle; Creek_Banks (~40668 tris) + Creek_Reeds are the green banks that dominate. ' + RT + '/DaHilgLevelRuntime.cs auto-adds DaHilgWaterAnimator to meshes named water/creek/river + TuneLevelSurface tints water. REQUIRED: a believable CREEK — a flowing animated water SURFACE running the length of the creek bed at a configurable WATER LEVEL (height), reading as blue water (not a puddle), with the banks reading as dirt/rock banks (not green curbs). Evaluate: generate/extend a water plane along the Creek path at an adjustable Y in the overlay or runtime; ensure DaHilgWaterAnimator (flow scroll) applies; expose an adjustable water level. Read DaHilgWaterAnimator + the overlay extraction + TuneLevelSurface. Give exact code.',
  'PROBLEM E — GRASS not visible. Trees now render (after the load-time ground-snap), but the grass (GrassClump_*/Grass_Wind/Shrubs) does not show near the player. Investigate every cause: is grass scaled too small, snapped wrong/under the ground by GroundVegetationOverlay, culled, wrong material, or simply too sparse/short to read? ' + RT + '/DaHilgLevelRuntime.cs GroundVegetationOverlay + TuneVegetationSurface; ' + SC + '/build_dahilg_overlay.mjs (grass kept by the KEEP regex). REQUIRED: visible grass cover near the player. Give the exact fix (and consider GPU-instanced grass cards near the player per the vegetation strategy if the master grass is inadequate).',
  '',
  'PROBLEM C — SPAWN still not on the street IN FRONT OF THE ADDRESS. Current: ' + SC + '/build_dahilg_overlay.mjs computes streetSpawn = nearest `Roads` vertex to meta.houseCenter pushed ~5m away from the house; written to public/da-hilg/<out>.meta.json; ' + ED + '/DaHilgProjectBuilder.cs reads streetSpawn into PlayerSpawns[0]; ' + RT + '/DaHilgGameManager.cs SpawnActors faces the house. PROBLEM: "nearest road to house center" can pick a SIDE/BACK road, not the FRONT (the address-facing street), and the push direction/heuristic is crude. REQUIRED: spawn on the road the address FRONT faces, on the street, looking at the house, for every level. Evaluate how to derive the FRONT: e.g. the house front normal (from House_walls orientation / the longest street-facing facade), or the largest/nearest MAIN road segment vs a driveway, or the geocoded street direction; pick the road point along the house\'s front direction. Give the exact build_dahilg_overlay.mjs computation + any builder/GM change. Note canyon\'s road is ~100m (keep a fallback).',
].join('\n')

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'design', 'files', 'risks'],
  properties: {
    lens: { type: 'string' },
    design: { type: 'string', description: 'the concrete, implementable design: exact code/approach, file:line' },
    files: { type: 'array', items: { type: 'string' } },
    risks: { type: 'string', description: 'failure modes + how to avoid them' },
  },
}
const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['plan', 'buildPlan', 'verifyPlan'],
  properties: {
    plan: { type: 'array', minItems: 5, items: { type: 'object', additionalProperties: false,
      required: ['rank', 'area', 'files', 'change'],
      properties: { rank: { type: 'integer' }, area: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, change: { type: 'string' } } } },
    buildPlan: { type: 'string' },
    verifyPlan: { type: 'array', items: { type: 'string' } },
  },
}

phase('Angles')
const LENSES = [
  { key: 'attach-bone-parent', focus: 'PROBLEM A, angle 1 — Make an attached nibbler a CHILD of a chosen player skinned-mesh BONE so it rides the animated body (move/fall/bend/emote) for free. Give the exact Unity reparent (SetParent(bone, worldPositionStays:false) with a per-nibbler localPosition on the bone + a localScale that cancels the player rig scale so the nibbler keeps its own size), the bone lookup (cache the player\'s bone Transforms), and the conversion of the current PositionOnBody/m_AttachBaseLocal into a bone+local-offset. Cover the scale gotcha (bones under the SCALED visual child).' },
  { key: 'attach-distribute-jumpon', focus: 'PROBLEM A, angle 2 — Why nibblers pile IN FRONT, and how to DISTRIBUTE them over the whole body + a believable independent JUMP-ON. Trace ChooseAttachAnchor/m_AttachBaseLocal/the lunge ring target; design bone-slot assignment (back/shoulders/head/arms/legs, multiple per bone with offsets, dedup so they spread), and the Lunge->land->parent transition (a real leap from the ground that ends attached to a bone). Give exact code.' },
  { key: 'attach-cling-shed', focus: 'PROBLEM A, angle 3 — Cling physics + clean un-attach. Gravity should keep them ON the body (cling, never drift), they follow falls/jumps with the player automatically once parented; and ShedAttached/roll-peel/jump-peel must UN-PARENT cleanly (reparent to m_NibblerRoot preserving world pose, restore scale/controller, fling outward, resume Chase). Cover edge cases: player death, level switch, pooling/Despawn must un-parent. Give exact code in DaHilgNibblerAgent + DaHilgGameManager.' },
  { key: 'minimap-streets', focus: 'PROBLEM B — Solid Google-Maps streets. Convert build_minimap.mjs road/drive/walk from boundary-EDGES to FILLED TRIANGLES (use readWorldTris, store flat [ax,az,bx,bz,cx,cz] arrays, clip/dedup as needed), and DaHilgMinimapElement.cs to FILL them as 2D triangles (Painter2D) with a clean road color over the dark field; keep the creek the blue hero + the player marker on top. Give exact data-shape + draw code + colors, and a note on perf/segment caps.' },
  { key: 'creek-water', focus: 'PROBLEM D — Make a real flowing CREEK (not a puddle + green curbs). Design a flowing animated water SURFACE along the full creek bed at an ADJUSTABLE water level: e.g. build a water-plane/strip mesh from the Creek path (or scale/raise Creek_SanLorenzo) at a configurable Y, blue water material, DaHilgWaterAnimator flow scroll; retune Creek_Banks/Reeds so banks read as dirt/rock not green. Give exact code in DaHilgLevelRuntime (TuneLevelSurface/DaHilgWaterAnimator) + build_dahilg_overlay.mjs, including how the water level is exposed/adjusted.' },
  { key: 'grass-visible', focus: 'PROBLEM E — Make grass visible near the player. Diagnose why GrassClump_*/Grass_Wind/Shrubs do not render (scale too small? snapped under ground by GroundVegetationOverlay? culled? material? too sparse/short?) and fix it. If the master grass is inadequate, design WebGL-safe GPU-instanced grass cards scattered on the unpaved ground near the player (paved-mask-aware, short draw, no shadows) per the vegetation strategy. Give exact code (DaHilgLevelRuntime + build_dahilg_overlay.mjs and/or a new grass component).' },
  { key: 'spawn-front', focus: 'PROBLEM C — Spawn on the address FRONT street. Replace "nearest road vertex to house center" with a FRONT-aware pick: derive the house front direction (e.g. from House_walls bounds aspect / the street-facing facade / the densest nearby road run) and choose the nearest road point ALONG that front direction, then stand on the street looking at the house. Give the exact build_dahilg_overlay.mjs computation (world-space, using getWorldMatrix on Roads + House_walls), the fallback (canyon ~100m), and any builder/GM tweak. Verified spawn coords expected per level if you can compute them.' },
]
const angles = (await parallel(LENSES.map(L => () => agent(
  'You are a senior Unity gameplay+tools engineer. Design ONE angle of a hard problem, grounded in the actual code (read the files). Be concrete and implementable: exact file:line, code, values.\n\nANGLE: ' + L.focus + '\n\n' + CTX,
  { label: 'angle:' + L.key, phase: 'Angles', schema: SCHEMA }
)))).filter(Boolean)
log('Explored ' + angles.length + ' angles. Synthesizing one plan.')

phase('Synthesize')
const synth = await agent(
  'Synthesize these design angles into ONE ordered, directly-implementable plan (rank, area, files, exact change), a minimal build plan, and an in-engine verify step per item. For the nibbler attach, MERGE the 3 attach angles into one coherent bone-parent design (parent on attach, ride the animated body, distribute over bones, clean un-parent on shed/roll/jump/despawn). Order: nibbler attach first (the core mechanic), then creek water, grass, minimap streets, front spawn.\n\n=== ANGLES ===\n' + JSON.stringify(angles, null, 1) + '\n\n=== CONTEXT ===\n' + CTX,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA }
)

return { angles, synth }
