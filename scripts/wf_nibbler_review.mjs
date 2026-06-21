export const meta = {
  name: 'nibbler-fun-review',
  description: 'Multi-lens adversarial gameplay-design review of the Da Hilg nibbler swarm mechanic, then synthesis into one implementable "make it fun" redesign spec',
  phases: [
    { title: 'Map', detail: 'map current Unity mechanic, JS original intent, reference fun patterns' },
    { title: 'Reviews', detail: '6 diverse adversarial gameplay-design lenses' },
    { title: 'Verify', detail: 'adversarially challenge each top fix for fun + side effects' },
    { title: 'Synthesize', detail: 'one prioritized, implementable fun-redesign spec' },
  ],
}

const RT = '/Users/mcohen/dev/home/unity/DaHilgUnity/Assets/DaHilg/Scripts/Runtime'
const FILES = [
  'CURRENT UNITY IMPLEMENTATION:',
  RT + '/DaHilgNibblerAgent.cs  (boids: chase/lunge/attach/scatter/crush, separation, ring-surround, torso-aim)',
  RT + '/DaHilgGameManager.cs  (TickNibblers spawn director, mark/danger zones, overwhelm gates, jump-shed, win/lose, score)',
  RT + '/DaHilgActor.cs  (overwhelm thresholds -> stagger/crawl/pinned, roll-crush, melee, health drain/regen)',
  RT + '/DaHilgCameraRig.cs  (camera modes + feel)',
  '/Users/mcohen/dev/home/unity/DaHilgUnity/Assets/DaHilg/Settings/DaHilgGameSettings.asset  (all tunables)',
  'ORIGINAL JS/R3F DESIGN (the port intended fun reference): /Users/mcohen/dev/home/src/da-hilg/nibblers/  (systems + hud: HealthBar, NibblerFeedback, Minimap, MarkedIndicator)',
  'CURRENT TUNABLES (after a user revert to stock): NibblerPoolSize 36, NormalSpawnInterval 0.48s, DangerSpawnInterval 0.14s, DangerNibblerBonus 9, NibblerAttachDistance 0.65, NibblerRunSpeed 4.5, NibblerScale 0.32, NibblerHealthDrainPerAttached 0.09 (cap 3.2), HealthRegen 5, OverwhelmStagger 7, OverwhelmDown 15, OverwhelmStop 24, MarkedDuration 3.1, RollCrushRadius 1.38, RollCrushScore 35, RollCooldown 1.55, RollDuration 0.78.',
  'CONTEXT: 3rd-person Unity WebGL game. Nibblers are a swarm of small creatures that chase the player, attach, and overwhelm you (stagger at 7 attached, cannot sprint at 15, pinned at 24); you shed them by JUMPING (scatters a third), ROLLING (crushes in a radius, scores), or MELEE punch/kick. Health drains while attached, regens when clear. Safe zones and danger zones that mark you (more spawns). The player has repeatedly said the nibbler mechanic is off and not fun; incremental number-tuning has NOT fixed it, so bold mechanic-level redesign is on the table, not just tweaks. North star: FUN. The fantasy: being swarmed by adorable menaces and fighting back with satisfying, masterable counters.',
].join('\n')

const MAP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'summary', 'mechanics', 'tunablesInUse', 'gaps'],
  properties: {
    area: { type: 'string' },
    summary: { type: 'string', description: 'what the mechanic actually does, concretely' },
    mechanics: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'how', 'feelNote'], properties: {
      name: { type: 'string' }, how: { type: 'string' }, feelNote: { type: 'string', description: 'how this likely FEELS to play' } } } },
    tunablesInUse: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' }, description: 'missing fun ingredients vs intent/reference' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'oneLineVerdict', 'whyNotFun', 'findings', 'topFixes'],
  properties: {
    lens: { type: 'string' },
    oneLineVerdict: { type: 'string' },
    whyNotFun: { type: 'string', description: 'the core reason this lens says the mechanic is not fun' },
    findings: { type: 'array', minItems: 3, items: { type: 'object', additionalProperties: false,
      required: ['id', 'title', 'severity', 'whyNotFun', 'fix', 'tunableChanges', 'codeLocations', 'funImpact', 'effort'],
      properties: {
        id: { type: 'string' }, title: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        whyNotFun: { type: 'string' }, fix: { type: 'string', description: 'concrete, specific — values, behaviors, juice' },
        tunableChanges: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'to'], properties: { key: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } } } },
        codeLocations: { type: 'array', items: { type: 'string' } },
        funImpact: { type: 'string', enum: ['high', 'medium', 'low'] }, effort: { type: 'string', enum: ['small', 'medium', 'large'] },
      } } },
    topFixes: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', description: 'finding id' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['fixTitle', 'willIncreaseFun', 'confidence', 'risks', 'conflictsWith', 'verdict', 'refinedRecommendation'],
  properties: {
    fixTitle: { type: 'string' }, willIncreaseFun: { type: 'boolean' }, confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    risks: { type: 'string' }, conflictsWith: { type: 'string', description: 'other proposed changes it conflicts with, or none' },
    verdict: { type: 'string', enum: ['keep', 'modify', 'drop'] }, refinedRecommendation: { type: 'string' },
  },
}

const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['mechanicVision', 'theFunCore', 'prioritizedChanges', 'tunables', 'juiceAdditions', 'cutList', 'fullReviewAddendum', 'risks'],
  properties: {
    mechanicVision: { type: 'string', description: 'the redesigned nibbler mechanic in 1 paragraph — what makes it fun' },
    theFunCore: { type: 'string', description: 'the single core fun loop in one sentence' },
    prioritizedChanges: { type: 'array', minItems: 5, items: { type: 'object', additionalProperties: false,
      required: ['rank', 'title', 'type', 'file', 'location', 'change', 'expectedFunGain', 'effort'],
      properties: { rank: { type: 'integer' }, title: { type: 'string' }, type: { type: 'string', enum: ['tunable', 'code', 'juice', 'cut'] },
        file: { type: 'string' }, location: { type: 'string' }, change: { type: 'string', description: 'concrete enough to implement directly' },
        expectedFunGain: { type: 'string' }, effort: { type: 'string', enum: ['small', 'medium', 'large'] } } } },
    tunables: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'to', 'why'], properties: { key: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, why: { type: 'string' } } } },
    juiceAdditions: { type: 'array', items: { type: 'string', description: 'feedback/juice with where to add it' } },
    cutList: { type: 'array', items: { type: 'string' } },
    fullReviewAddendum: { type: 'object', additionalProperties: false, required: ['hud', 'controls', 'visual', 'correctness', 'other'],
      properties: { hud: { type: 'string' }, controls: { type: 'string' }, visual: { type: 'string' }, correctness: { type: 'string' }, other: { type: 'string' } } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

phase('Map')
const mapTasks = [
  { area: 'unity-current', p: 'Read the CURRENT Unity nibbler implementation and map exactly what it does and how it likely FEELS to play. Focus: spawn cadence, chase/lunge/attach, the overwhelm gates, the three counters (jump-shed, roll-crush, melee), health drain/regen, mark/danger zones, win/lose, scoring, feedback. Be concrete about the moment-to-moment experience.\n\nFILES:\n' + FILES },
  { area: 'js-original-intent', p: 'Read the ORIGINAL JS/R3F nibbler design under /Users/mcohen/dev/home/src/da-hilg/nibblers/ (systems + hud) and map the INTENDED fun: core loop, counters, feedback/juice, goal. What did the Unity port LOSE or change vs this intent?\n\nFILES:\n' + FILES },
  { area: 'reference-fun-patterns', p: 'You are a senior game designer. Without reading code, lay out what makes SWARM/HORDE be-chased-and-fight-back mechanics FUN, drawing concretely on Vampire Survivors, Katamari Damacy, Pikmin, Untitled Goose Game, Hades, and classic Snake/Nibbles. Cover the core toy, threat pacing/tension-release, satisfying counters & mastery, juice/feedback, clear goals & scoring, readability. Produce a checklist of fun ingredients a swarm mechanic needs — this is the rubric the reviews grade against.\n\nTARGET GAME:\n' + FILES },
]
const maps = (await parallel(mapTasks.map(t => () => agent(t.p, { label: 'map:' + t.area, phase: 'Map', schema: MAP_SCHEMA })))).filter(Boolean)
const brief = JSON.stringify(maps, null, 1)
log('Map done: ' + maps.length + ' maps. Launching 6 adversarial design lenses.')

phase('Reviews')
const LENSES = [
  { key: 'game-feel', title: 'Game feel & juice (Steve Swink lens)', focus: 'Input responsiveness, IMPACT, and feedback (visual/audio/haptic), hit-stop, screen shake, knockback, particle/flash on crush & attach & shed, animation snappiness. Why does crushing/shedding/being-swarmed feel FLAT or unsatisfying? What concrete juice would make each interaction feel crunchy and rewarding?' },
  { key: 'threat-pacing', title: 'Threat pacing & spawn director', focus: 'The difficulty curve and spawn cadence. Tension to release rhythm, the danger/mark system, the ramp. Is the pressure satisfying, or a trickle-then-sudden-wall, random, unfair, or boring? Design a proper AI-director / wave rhythm that builds dread and gives breathing room.' },
  { key: 'player-agency', title: 'Player agency, counterplay & mastery', focus: 'Risk/reward and the three counters (jump-shed, roll-crush, melee) plus running/safe zones. Are the counters satisfying, distinct, and strategically meaningful, or spammy/pointless/dominant? Is there a skill/mastery curve? Design counters with real decisions and a rising skill ceiling.' },
  { key: 'swarm-ai', title: 'Swarm AI readability & behavior', focus: 'Do the nibblers read as a coherent, FAIR, telegraphed threat? Targeting, surround/ring behavior, lunge telegraph, separation/clumping, numbers on screen, where they attach. Where does the AI read as cheap, confusing, or off (attacking the camera, orbiting, popcorn-spawning)? Design readable, fair, characterful swarm behavior.' },
  { key: 'core-loop-fun', title: 'Core loop, goal & fun fantasy', focus: 'The moment-to-moment TOY and the meta loop. Is there a compelling goal, score chase, or escalating fantasy? Compare directly to Vampire Survivors / Katamari / Pikmin / Untitled Goose / Hades. The fantasy is swarmed by adorable menaces, fight back & dominate. What loop/goal/progression would make a player say one more run? Bold redesign welcome.' },
  { key: 'onboarding-clarity', title: 'Onboarding, clarity & failure readability', focus: 'First-30-seconds learnability, what the game teaches, and READABILITY of state: am I marked? overwhelmed? why is my health dropping? why did I lose/win? Are the counters discoverable? Design clear teaching, legible danger states, and I-understand-why-that-happened failure feedback.' },
]
const reviews = (await parallel(LENSES.map(L => () => agent(
  'You are an elite game designer doing an ADVERSARIAL gameplay-design review of the Da Hilg NIBBLER swarm mechanic through ONE lens: "' + L.title + '". Be adversarial: ASSUME the mechanic is not fun and find precisely WHY, then propose the SMALLEST set of HIGHEST-fun-per-effort changes (bold mechanic-level changes are encouraged — incremental tuning has already failed). Ground every claim in the actual code/design.\n\nLENS FOCUS: ' + L.focus + '\n\nSHARED CONTEXT MAPS (current impl, JS intent, fun rubric):\n' + brief + '\n\nFILES you may read for specifics:\n' + FILES + '\n\nReturn structured findings. Each finding: what is wrong, WHY it is not fun, a concrete fix (exact values/behaviors/juice), tunable changes, code locations, fun impact, effort. Then pick your top 1-3 highest-fun-per-effort fixes.',
  { label: 'review:' + L.key, phase: 'Reviews', schema: REVIEW_SCHEMA }
)))).filter(Boolean)
log('Reviews done: ' + reviews.length + ' lenses. Adversarially verifying top fixes.')

phase('Verify')
const topFixes = []
for (const r of reviews) {
  const byId = new Map((r.findings || []).map(f => [f.id, f]))
  for (const id of (r.topFixes || [])) {
    const f = byId.get(id)
    if (f) topFixes.push({ lens: r.lens, finding: f })
  }
}
const verdicts = (await parallel(topFixes.map((tf, i) => () => agent(
  'You are a skeptical senior game designer. A reviewer (lens: "' + tf.lens + '") proposes this change to make the nibbler mechanic more fun:\nTITLE: ' + tf.finding.title + '\nFIX: ' + tf.finding.fix + '\nTUNABLES: ' + JSON.stringify(tf.finding.tunableChanges) + '\nWHY-FUN: ' + tf.finding.whyNotFun + '\n\nAdversarially challenge it: will it ACTUALLY increase fun, or does it just sound good? What are the side effects, the ways it backfires, and what OTHER proposed direction it might conflict with? Default to skeptical. Then give a verdict (keep / modify / drop) and a refined recommendation. Context:\n' + FILES,
  { label: 'verify#' + (i + 1) + ':' + tf.lens.slice(0, 12), phase: 'Verify', schema: VERDICT_SCHEMA }
)))).filter(Boolean)
log('Verified ' + verdicts.length + ' top fixes. Synthesizing the redesign.')

phase('Synthesize')
const synth = await agent(
  'You are the lead game designer. Synthesize ALL of the following into ONE coherent, prioritized, DIRECTLY-IMPLEMENTABLE redesign that makes the Da Hilg nibbler mechanic genuinely FUN. Resolve conflicts between lenses; prefer the highest fun-per-effort changes; be bold where incremental tuning has failed but keep it shippable in the existing Unity codebase. Give exact tunable values and concrete code/juice changes with file + location.\n\n=== CONTEXT MAPS ===\n' + brief + '\n\n=== 6 LENS REVIEWS ===\n' + JSON.stringify(reviews, null, 1) + '\n\n=== ADVERSARIAL VERDICTS ON TOP FIXES ===\n' + JSON.stringify(verdicts, null, 1) + '\n\n=== FILES ===\n' + FILES + '\n\nProduce: the mechanic vision, the single fun-core loop, a ranked change list (each implementable), exact tunables, juice additions, a cut list, a light full-review addendum (HUD/controls/visual/correctness/other), and risks.',
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA }
)

return { maps, reviews, verdicts, synth }
