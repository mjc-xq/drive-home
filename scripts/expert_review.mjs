export const meta = {
  name: 'expert-review-dahill',
  description: 'Deep multi-agent expert review of the Dahill 3D web app (game design, controls, iOS Safari, performance, Google Photorealistic 3D Tiles, correctness) with per-domain best-practice grounding and adversarial verification, synthesized into a prioritized report',
  phases: [
    { title: 'Research', detail: 'ground each expert in current domain best practices via web + library docs' },
    { title: 'Review', detail: 'one domain expert statically reviews the real code per dimension' },
    { title: 'Verify', detail: 'two independent skeptics try to refute each finding against the actual code' },
    { title: 'Synthesize', detail: 'a staff-level judge dedupes, scores by consensus, and writes the report' },
  ],
}

const REPO = '/Users/mcohen/dev/home'

const APP_CONTEXT = `
APP UNDER REVIEW — "1840 Dahill Lane" (repo at ${REPO}; package name dahill-3d).
A mobile-first Three.js (r0.184) + React 18 + Vite single-page 3D web app of a real
neighborhood (Hayward, CA). Streams Google Photorealistic 3D Tiles via
3d-tiles-renderer ^0.4.28. Three modes, chosen from a start menu:
  - Explore: aerial orbit over the photoreal tiles.
  - Drive: drivable car (Sienna/RAV4/Ferrari) with a high "drone-follow" cam and a
    clean aerial "patch" disc under the car (photogrammetry is melty at ground level).
  - Scoop: walk a rigged keeper "Drew" (GLTF skinned mesh + AnimationMixer) around a
    PROCEDURAL backyard (real terrain topology + aerial photo texture) cleaning animal
    poop; photoreal tiles stream OUTSIDE the yard.
Primary target is iOS Safari on phones (memory/OOM sensitive). Google tiles are unlit
MeshBasic backdrop; the procedural world (staticGroup) hides once tiles arrive.

KEY FILES (line counts): src/engine/engine.js (1175 core loop, modes, camera, input,
photoreal align/flatten), src/engine/world.js (772 procedural geometry), src/engine/
animals.js (270), src/engine/car.js (253), src/App.jsx (137 HUD/React), src/styles.css
(124), src/engine/models.js (102), src/engine/audio.js (97), src/engine/tiles3d.js (91
Google tiles setup), src/engine/geom.js (90), src/engine/drew.js (79 rigged character),
src/engine/data.js, coords.js, terrain.js, roadmask.js. index.html at repo root.

RECENT CHANGE (commit 9af0334, just landed; review it critically): the Scoop "clearing"
(a TileFlatteningPlugin shape that pancakes the photoreal trees over the yard) and the
photoreal vertical alignment (alignP3DT) were previously gated to mode==='explore', which
broke when the start menu jumps straight to Scoop. Now flattenScoopArea()/alignP3DT() run
on tile load-model in ANY mode; the flatten shape is rebuilt if alignment shifts the holder
offset; the flatten disc is concentric with the grass disc (sancCx=-16,sancCz=-10), follows
terrain topology 0.3m under the lawn, and is widened to R=SCOOP_CLEAR_R+14 to pancake the
melty property-line trees; Scoop sets close fog (near 38/far 92); Angled/Close scoop cams
were tilted down. The Google Maps key is VITE_GOOGLE_MAPS_KEY (baked into the client bundle).
NOTE: the user just reported the widened flatten ALSO pancaked their real house (the house is
near world origin ~19m from the yard centre), and that Scoop look-controls also rotate the
movement direction (should be Roblox-style: left stick moves, right side orbits the camera
independently), and that Drive should let them roam much further. Weigh these in your review.

Build is clean; 24 vitest tests pass. This is a static code review (no browser profiling).
`.trim()

const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    domain: { type: 'string' },
    bestPractices: { type: 'array', items: { type: 'string' } },
    checklist: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['domain', 'bestPractices', 'checklist'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          file: { type: 'string' },
          line: { type: 'string' },
          evidence: { type: 'string' },
          impact: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['title', 'severity', 'file', 'evidence', 'impact', 'recommendation'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    real: { type: 'boolean' },
    confidence: { type: 'number' },
    severityAdjusted: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
    reason: { type: 'string' },
    codeChecked: { type: 'string' },
  },
  required: ['real', 'confidence', 'reason'],
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    topRisks: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          dimension: { type: 'string' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          file: { type: 'string' },
          line: { type: 'string' },
          consensus: { type: 'string' },
          impact: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'dimension', 'severity', 'file', 'fix'],
      },
    },
    quickWins: { type: 'array', items: { type: 'string' } },
    reportPath: { type: 'string' },
  },
  required: ['summary', 'findings'],
}

const DIMENSIONS = [
  {
    key: 'game', title: 'Game design & game feel',
    research: 'mobile web 3D casual mini-game design: game feel, juice, feedback loops, progression, onboarding, difficulty pacing best practices',
    focus: 'Are Drive and Scoop actually FUN and clear? Evaluate goal clarity & onboarding (start menu, toasts), the Scoop core loop (find poop -> scoop -> compost -> tool upgrades -> spotless), reward/feedback (audio sfx, carCard, Drew dance/cheer reactions), difficulty & pacing (poop spawn rates, tool capacities, yard % cleanliness), the walk-to-a-parked-car-and-drive handoff, Drive feel (speed, gears/shift, car swap, how far you can roam), replayability, and confusing/dead-end states. Flag missing juice, unclear objectives, frustration points, progression dead-ends.',
    files: 'src/engine/engine.js (updateScoop, updateDrive, enterScoop, enterDrive, setTool/TOOLS, scoring, toasts, driveFromScoop, drive bounds/clamp), src/engine/animals.js (spawnPoop cadence), src/engine/car.js, src/engine/audio.js, src/App.jsx (HUD)',
  },
  {
    key: 'controls', title: 'Controls, input & camera UX',
    research: 'Roblox-style mobile controls, virtual thumbstick, third-person camera follow vs shift-lock, default control scheme where left stick moves and right side orbits camera independently, dead zone, sensitivity best practices',
    focus: 'CRITICAL: the user reports that in Scoop the right-side look/drag ALSO rotates the movement direction, instead of Roblox-style (left stick moves the avatar in camera-relative world directions; right side orbits the camera WITHOUT changing where you are going unless the stick is held). Trace exactly how camYawS, CHAR.yaw, the joystick vector and the look-drag interact in updateScoop. Also evaluate the touch thumbstick, keyboard WASD, shift-lock, scroll/pinch zoom, the Scoop camera presets (SCOOP_CAMS), Drive drone cam, follow smoothing/lerp, dead zones, strafe/forward mapping correctness, one-handed phone use, and touch-target sizes (styles.css). Flag inverted axes, the look-drives-direction coupling, jitter, missing dead zones, tiny tap targets, camera fighting the player.',
    files: 'src/engine/engine.js (pointer/touch/key handlers, joystick math, camera math, SCOOP_CAMS, cycleScoopCamera, shiftLock, updateScoop/updateDrive camera blocks, pan/orbit, camYawS/look handling), src/App.jsx, src/styles.css',
  },
  {
    key: 'ios', title: 'iOS Safari compatibility & robustness',
    research: 'iOS Safari WebGL memory limits crashes three.js mobile devicePixelRatio context loss audio autoplay unlock safe-area 100dvh visibilitychange 2025 best practices',
    focus: 'This app primarily targets iPhone Safari and has OOM history. Evaluate WebGL/GPU memory (tile lruCache caps, texture/geometry disposal, KTX2/DRACO worker pools), devicePixelRatio capping, renderer settings, WebGL context-loss handling (webglcontextlost/restored), visualViewport + safe-area-inset + 100dvh usage, touch-action/passive listeners/-webkit callouts, audio unlock under the autoplay policy (audio.ensure on first gesture), page backgrounding/visibilitychange (does the RAF loop keep streaming tiles & burning memory when hidden?), and full teardown on dispose. Flag anything that risks a Safari crash, a black canvas, or a stuck audio context.',
    files: 'src/engine/engine.js (renderer init, pixelRatio, visualViewport, event listeners, RAF loop, dispose), src/engine/tiles3d.js (lruCache, disposeAll, decoders), src/engine/audio.js, src/styles.css, index.html',
  },
  {
    key: 'perf', title: 'Rendering & runtime performance',
    research: 'three.js r184 performance draw calls shadow map cost frustumCulled instancing per-frame allocations mobile; streaming 3D tiles memory errorTarget',
    focus: 'Evaluate frame-rate and memory cost: shadow map usage/resolution, number of lights, draw calls (merged vs separate geometry in world.js, instancing of poop), frustumCulled=false objects, per-frame heap allocations in the hot update loops (new THREE.Vector3/Matrix4/Color inside update*/raycasts), the new Scoop flatten shape cost & rebuild frequency, fog, tile errorTarget/displayActiveTiles/lruCache tradeoffs, raycast cost (rawTileY down-rays), and bundle size / code-splitting (three ~613KB, index ~963KB gz 289KB). Flag per-frame GC churn, oversized shadow maps, unnecessary always-on work, heavy main-bundle imports.',
    files: 'src/engine/engine.js (RAF loop, update*, shadows, raycasts, allocations), src/engine/tiles3d.js, src/engine/world.js, src/engine/models.js, src/engine/geom.js, src/engine/animals.js (instancing), package.json',
  },
  {
    key: 'gmaps', title: 'Google Photorealistic 3D Tiles API correctness & ToS compliance',
    research: 'Google Photorealistic 3D Tiles API attribution copyright requirement terms of service session errorTarget caching quota 3d-tiles-renderer GoogleCloudAuthPlugin best practices',
    focus: 'Evaluate correct & COMPLIANT use of Google Photorealistic 3D Tiles: (1) ATTRIBUTION: Google ToS REQUIRES displaying the data attributions/copyright the tileset provides (and Google logo); check whether the app surfaces tiles.getAttributions()/copyright anywhere (likely MISSING = compliance P0). (2) API key exposure: VITE_GOOGLE_MAPS_KEY is baked into the client bundle; is it referrer-restricted? note the risk. (3) Auth/token: GoogleCloudAuthPlugin autoRefreshToken. (4) errorTarget (=10) and lruCache caps vs Google guidance and billing/quota (each tile request is billable; driving further multiplies requests). (5) Correctness of reorientation + custom yOffset alignment + the TileFlatteningPlugin hacks (alignP3DT single-shot, flattenScoopArea rebuild-on-align, rawTileY raycasts) and whether flattening near world origin pancakes the real house. Flag compliance violations first.',
    files: 'src/engine/tiles3d.js (GoogleCloudAuthPlugin, plugins, lruCache, errorTarget, attribution?), src/engine/engine.js (P3DT, applyP3DT, alignP3DT, flattenScoopArea, rawTileY, drive tile follow/bounds), index.html',
  },
  {
    key: 'correctness', title: 'Code correctness, robustness & the recent Scoop changes',
    research: 'three.js dispose memory leak patterns, silent failure error handling, defensive coding for streaming async webgl apps',
    focus: 'Hunt for real bugs and fragile logic, extra scrutiny on commit 9af0334. Evaluate mode-transition state (setMode fog restore, applyModeVisuals visibility), the flatten/align logic (single-shot align + clamps + deleteShape rebuild ordering vs streaming order; can the clearing drift or never build?), the flatten radius pancaking the house near origin, terrainAt vs photoreal height layering (grass +0.05 vs flatten -0.3), silent failures (model load failures, missing API key, tiles never streaming), event-listener and resource cleanup in dispose, NaN/divide-by-zero/clamp safety in camera & movement math, drive-bounds clamp, and TDZ/closure hazards (flatShape referenced by alignP3DT defined earlier). Flag concrete defects with file:line and the exact failing scenario.',
    files: 'src/engine/engine.js (setMode, enter/exit*, applyModeVisuals, flattenScoopArea, alignP3DT, dispose, update*, drive clamp), src/engine/drew.js, src/engine/models.js, src/engine/car.js',
  },
]

function researchPrompt(d) {
  return `You are a world-class expert in: ${d.title}.
${APP_CONTEXT}

TASK: Produce a tight, CURRENT best-practices brief that a code reviewer will use to audit THIS app's "${d.title}" dimension. Research online to stay current: load web tools if needed via ToolSearch("select:WebSearch,WebFetch") and use them; use context7 (resolve-library-id then query-docs) for three.js / 3d-tiles-renderer / Google 3D Tiles specifics. Do NOT review the code yet.

Topic: ${d.research}

Return via the structured tool: bestPractices (specific, authoritative criteria for a mobile-first WebGL app like this), checklist (concrete greppable things to verify in this codebase), sources (URLs you actually consulted). Be specific and current, not generic.`
}

function reviewPrompt(d, brief) {
  const b = brief && brief.bestPractices ? JSON.stringify({ bestPractices: brief.bestPractices, checklist: brief.checklist }) : '(no brief)'
  return `You are a world-class expert reviewer for: ${d.title}.
${APP_CONTEXT}

Apply this freshly-researched best-practices brief:
${b}

TASK: Statically review the REAL code for the "${d.title}" dimension. OPEN AND READ the actual files (Read / Grep at ${REPO}). Primary files: ${d.files}. Read others as needed.

FOCUS: ${d.focus}

RULES (false positives are penalized):
- Only report issues you CONFIRMED by reading the actual code. Cite exact file and line number and quote/describe the real code in "evidence".
- No generic advice; every finding must be specific to THIS codebase and actionable.
- Prefer fewer, higher-signal findings. Return at most your 8 most important, ordered by severity.
- Severity: P0=crash/broken/compliance-violation, P1=major UX/perf/correctness, P2=notable, P3=polish.
- Returning 0 findings is fine if the code is genuinely solid here (empty findings array).`
}

function refutePrompt(f, d, lens) {
  const lensText = lens === 'code-truth'
    ? `LENS = CODE TRUTH. Open the cited file at ${REPO} and surrounding code. Does the code ACTUALLY behave as the finding claims? Check for guards, clamps, conditions, or context the reviewer may have missed. If the claim misreads the code, mark real=false.`
    : `LENS = IMPACT SKEPTIC. Assume the code is as described. Is this a REAL problem for THIS app (a mobile-web toy of a neighborhood, static review, iOS-first), or overstated/theoretical/non-issue/already-acceptable? Down-rank or reject if the impact is not real; adjust severity if warranted.`
  return `You are an adversarial verifier. REFUTE the finding below unless the evidence is solid. Default to real=false when uncertain.

DIMENSION: ${d.title}
FINDING: ${JSON.stringify(f)}

${APP_CONTEXT}

${lensText}

Read whatever code you need at ${REPO}. Return your verdict: real (true only if it survives scrutiny), confidence 0..1, severityAdjusted, reason, codeChecked (file+lines you actually opened).`
}

function synthPrompt(confirmed) {
  return `You are a senior staff engineer writing the final report for a multi-agent expert review of the "1840 Dahill Lane" 3D web app.
${APP_CONTEXT}

These findings SURVIVED adversarial verification (each cross-checked by two independent skeptics against the real code; consensus = reals/total verifiers that confirmed, avgConf = mean confidence):
${JSON.stringify(confirmed, null, 1)}

TASK:
1. Dedupe/merge overlapping findings across dimensions.
2. Prioritize by true severity and consensus (P0 first); down-weight low-consensus items.
3. For each kept finding give: title, dimension, severity, file, line, consensus (e.g. "2/2"), impact, specific fix.
4. Write "summary" (3-5 sentences on overall health), "topRisks" (fix first), "quickWins" (cheap high-value).
5. WRITE the full human-readable report as Markdown to ${REPO}/docs/expert-review-2026-06-14.md (create docs/ if needed, use Write). Include a short "Methodology" section noting this was a multi-agent review with per-domain best-practice grounding and adversarial verification. Set reportPath to that path.
Return the structured object. Be rigorous and concrete; this goes to the app's developer.`
}

function verifyOne(f, d) {
  return parallel([
    () => agent(refutePrompt(f, d, 'code-truth'), { phase: 'Verify', schema: VERDICT_SCHEMA, label: `verify:${d.key}:truth` }),
    () => agent(refutePrompt(f, d, 'impact'), { phase: 'Verify', schema: VERDICT_SCHEMA, label: `verify:${d.key}:impact` }),
  ]).then(vs => {
    const v = vs.filter(Boolean)
    const reals = v.filter(x => x && x.real).length
    const avgConf = v.length ? Math.round(v.reduce((s, x) => s + (x.confidence || 0), 0) / v.length * 100) / 100 : 0
    const adj = v.map(x => x && x.severityAdjusted).filter(Boolean)
    return Object.assign({}, f, {
      dimension: d.key,
      dimensionTitle: d.title,
      reals,
      total: v.length,
      consensus: reals + '/' + v.length,
      confirmed: v.length > 0 && reals >= Math.ceil(v.length / 2),
      avgConf,
      severityVerified: adj[0] || f.severity,
    })
  })
}

function verifyDimension(review, d) {
  const fs = review && review.findings ? review.findings.slice(0, 8) : []
  if (!fs.length) return []
  return parallel(fs.map(f => () => verifyOne(f, d)))
}

log('Expert review: grounding 6 domain experts, reviewing the real code, then adversarially verifying every finding (2 independent skeptics each).')

const reviewed = await pipeline(
  DIMENSIONS,
  d => agent(researchPrompt(d), { phase: 'Research', schema: BRIEF_SCHEMA, label: `research:${d.key}` }),
  (brief, d) => agent(reviewPrompt(d, brief), { phase: 'Review', schema: FINDINGS_SCHEMA, label: `review:${d.key}` }),
  (review, d) => verifyDimension(review, d)
)

const all = reviewed.flat().filter(Boolean)
const confirmed = all.filter(f => f.confirmed)
const rank = { P0: 0, P1: 1, P2: 2, P3: 3 }
confirmed.sort((a, b) => (rank[a.severityVerified] - rank[b.severityVerified]) || (b.avgConf - a.avgConf))
const byDimension = {}
for (const f of confirmed) byDimension[f.dimension] = (byDimension[f.dimension] || 0) + 1
log(`Findings: ${all.length} raised across 6 experts; ${confirmed.length} survived adversarial verification.`)

const report = await agent(synthPrompt(confirmed), { phase: 'Synthesize', schema: REPORT_SCHEMA, label: 'synthesize:judge' })

return {
  stats: { raised: all.length, confirmed: confirmed.length, byDimension },
  confirmed: confirmed.map(f => ({
    title: f.title,
    dimension: f.dimension,
    severity: f.severityVerified,
    file: f.file,
    line: f.line,
    consensus: f.consensus,
    avgConf: f.avgConf,
    impact: f.impact,
    recommendation: f.recommendation,
  })),
  report,
}
