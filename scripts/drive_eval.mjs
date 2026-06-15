export const meta = {
  name: 'drive-eval',
  description: 'Driving-game eval panel: arcade-driving critics review the Drive mode (code + playtest data) against best practices and produce a prioritized punch-list + an "is it amazing yet?" verdict',
  phases: [
    { title: 'Critique', detail: 'one arcade-driving expert per dimension grades Drive + lists concrete fixes' },
    { title: 'Judge', detail: 'a creative director synthesizes a verdict + prioritized punch-list' },
  ],
}

const REPO = '/Users/mcohen/dev/home'

const CONTEXT = `
GAME: "1840 Dahill Lane" — Drive mode. A mobile-first Three.js web game where you
drive a real car around the player's real neighborhood (Hayward, CA) rendered with
Google Photorealistic 3D Tiles, and can route/drive to real addresses.

CODE TO READ (at ${REPO}):
- src/engine/engine.js — Drive lives here. updateDrive() has the car physics
  (speed/accel/drag/steer/yaw), the 4 cameras (DRIVE_CAMS: Cruise/Close/Top-down/
  Aerial + the branches), collision (insideBuilding/treePts/ANIMALS bounce), the
  point-and-drive nav override (inp2.navActive), auto-drive, the guide ribbon, the
  minimap (drawMinimap), Google Directions routing (fetchRoute/navTarget/ROUTE),
  resetToRoad, and the input handlers (onPointerDown/Move, joystick, keyboard).
- src/App.jsx + src/styles.css — the HUD (speedo, camera/car/reset/nav buttons,
  minimap, nav panel, car picker).

CURRENT STATE (ROUND 4 — the round-3 punch-list landed; re-grade the NEW code):
- SPEED REGRESSION FIXED (round-3 #1 blocker): stick-only auto-creep no longer pins
  to the top — it cruises GENTLY toward ~18 u/s (≈40 mph), corner-able; hold GO for
  real speed. The real top stays high (maxF 100·top ≈ 183-224 mph) but is decoupled
  from the FEEL: a feelRef (27·top ≈ 60 mph) is what FOV/speed-lines/gauge/engine-rev
  saturate against, so 40 mph FEELS like 150 while you can still pin 180+ on the open
  road (verified: --spd 0.86 at 38 mph). Launch still eased (45%→100% by ~22 mph).
- OFF-ROAD is now a real penalty: within the ±340 m block, off the street = lawns,
  maxF 24 (≈44 mph) + drag 0.5, so you slow hard and steer back to pavement. PAST
  ±340 m (no procedural roads, only real photoreal road) it's treated as open road so
  a cross-town blast to Meemaw's can hit triple digits.
- REAL SPEED-LINES: white center-radial streak overlay (masked clear in the middle so
  the road reads, gentle outward 'rush' animation), driven by --spd, building from
  ~18%. Vignette kept underneath, lighter. Chase FOV eased (46→76, sp^1.25, builds
  from the first mph). Top-down + Aerial cams have their own speed cues.
- PARTICLES (new): pooled skid-mark decals + additive tyre-smoke puffs spawn at the
  REAR WHEELS whenever the tail is out (|vlat|>6 or handbrake) and moving; a 6-spark
  gold burst on each coin pickup. Power-slides now SUSTAIN on throttle (grip recovery
  eased to 0.55× while on the gas) instead of being cancelled — gas holds the slide.
- SCORE LOOP (new): a run timer starts on first gas/coin and stops on the 18th coin;
  a quick-chain COMBO ramps (🔥×N, resets after 4 s); BEST time persists to
  localStorage. Coin HUD shows '💛 x/18 · 🔥×combo · ⏱ m:ss · 🏆 best'; finishing all
  18 toasts your time + a 'New best!' flag with a celebratory screen flash.
- NEIGHBOURHOOD CALLOUTS (new): a one-shot toast + soft chime when you drive within
  ~45 m of your house, Meemaw's, Canyon Middle, Stanton Elementary, or Dad's work
  (XQ). (verified: '👋 That's YOUR house — 1840 Dahill Lane!' on spawn.)
- MINIMAP TAP-TO-DRIVE (new): tap anywhere on the minimap → tapMinimap inverts the
  pixel→world transform and auto-drives the car there (reuses DEST/auto-drive). A
  reverse 'R' tell-tale lights in the speedo when speed<0; the dest bar shows live
  remaining distance + rough ETA (verified: '256 m · ~0:24').
- CHASE CAM auto-recenters fast (~600 ms after you let go, no speed gate) so two-thumb
  driving (steer + pedals) needs no third look-thumb; czoom + orbit reset on
  enterDrive and every camera cycle (no pinch-zoom leak).
- DRIFT/COLLISION/ARRIVAL/HORN/cars/nav as before: per-car {accel,top,grip,slip};
  hits = thunk+shake+haptic with a 200ms-cooldown-gated scrub; manual+auto arrival
  payoff; Google Directions road routes + auto-drive (cap 45) + back-to-road.
- Cameras 🎥 Cruise (default chase) → Top-down (drag-to-drive) → Aerial (Explore look)
  → Close. HUD: glass panels, right DOCK, speed module lifted above the pedals,
  GO/STOP pedals + handbrake + horn, framed minimap, coin/timer HUD, fading hint.
- STILL OPEN (minor): auto-drive cap (45 u/s) makes far trips slow; no on-road
  mini-challenges/time-trial start beyond the coin rally; tyre-smoke is additive grey
  (not tinted to surface).

This is a TOY/joyride: "drive around my real neighborhood and to real places."
Judge the CURRENT code. Has it crossed into 'amazing'? If not, what's the shortest
path there now?
`.trim()

const ASSESS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    score: { type: 'number', description: '1-10 how good this dimension is for an amazing arcade joyride' },
    strengths: { type: 'array', items: { type: 'string' } },
    issues: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'med', 'low'] },
          fix: { type: 'string', description: 'concrete, specific change (file/function + what to do)' },
          effort: { type: 'string', enum: ['S', 'M', 'L'] },
        },
        required: ['title', 'severity', 'fix'],
      },
    },
  },
  required: ['dimension', 'score', 'issues'],
}

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    overallScore: { type: 'number', description: '1-10' },
    amazing: { type: 'boolean', description: 'true only if this is already an amazing driving game' },
    summary: { type: 'string' },
    punchList: {
      type: 'array',
      description: 'prioritized, concrete changes to make it amazing — highest impact first',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          fix: { type: 'string' },
          impact: { type: 'string', enum: ['high', 'med', 'low'] },
          effort: { type: 'string', enum: ['S', 'M', 'L'] },
        },
        required: ['title', 'fix', 'impact'],
      },
    },
  },
  required: ['overallScore', 'amazing', 'summary', 'punchList'],
}

const DIMS = [
  { key: 'handling', title: 'Car handling & game feel', focus: 'The physics in updateDrive: acceleration curve, top speed, braking, steering response & grip at speed, weight/momentum, how it feels to whip around corners. Is it satisfying and EASY + FUN to drive (the bar the user set)? Should there be drift/handbrake, throttle-on-exit, better tyre grip, a touch of slide? Is the off-road penalty right? Read the speed/steer block and the collision bounce.' },
  { key: 'camera', title: 'Cameras & sense of speed', focus: 'The 4 drive cameras and how they convey speed and let you read the road. Sense of speed (FOV kick, camera pull-back at speed, motion lines, shake), smoothing, which is the best default, and whether the melty-photogrammetry problem is well-managed. Read the camera branches + DRIVE_CAMS.' },
  { key: 'controls', title: 'Controls & navigation UX', focus: 'Touch + keyboard controls, the joystick/steer, the Top-down drag-to-drive (reverse + distance speed), the address nav + Google route + auto-drive + back-to-road, the minimap, the car picker. Is it intuitive, discoverable, one-handed-friendly on a phone, and FUN? Read the input handlers, nav, minimap.' },
  { key: 'fun', title: 'Fun, juice & goals', focus: 'What makes it a JOYRIDE worth coming back to: feedback/juice (audio, particles, crash/skid feedback, arrival celebration), the "drive to a real place" hook, any goals/score/collectibles/challenges, surprise & delight. What is the single biggest thing missing to make driving around your real neighborhood amazing?' },
]

function critPrompt(d) {
  return `You are a veteran arcade-driving-game designer (think Burnout / Forza Horizon / Crazy Taxi feel) reviewing ONE dimension: ${d.title}.
${CONTEXT}

Read the relevant code at ${REPO} (use Read/Grep — focus on src/engine/engine.js Drive sections and src/App.jsx). You may use WebSearch (load via ToolSearch) to ground yourself in current arcade-driving game-feel best practices.

FOCUS: ${d.focus}

Be candid and specific. Score this dimension 1-10 for "an amazing, easy & fun arcade joyride around your real neighborhood." List strengths, then concrete ISSUES each with a specific fix (name the file/function and the exact change) and effort S/M/L. Prioritize what would most raise the fun. Return via the structured tool.`
}

function judgePrompt(assessments) {
  return `You are the creative director for "1840 Dahill Lane" Drive mode. Four arcade-driving experts graded it:
${JSON.stringify(assessments, null, 1)}
${CONTEXT}

Synthesize a single verdict. Give overallScore (1-10), amazing (true ONLY if it's already an amazing driving game — be honest, the bar is high), a short summary, and a PRIORITIZED punchList (highest fun-impact first) of concrete changes to get it to amazing — each with why, a specific fix (file/function + change), impact, effort. Dedupe across experts. Keep the punch-list focused (the ~8 highest-leverage items). Return the structured object.`
}

phase('Critique')
const assessments = (await parallel(DIMS.map(d => () =>
  agent(critPrompt(d), { phase: 'Critique', schema: ASSESS_SCHEMA, label: `crit:${d.key}` })
))).filter(Boolean)

phase('Judge')
const report = await agent(judgePrompt(assessments), { phase: 'Judge', schema: REPORT_SCHEMA, label: 'judge' })

return { scores: assessments.map(a => ({ dimension: a.dimension, score: a.score })), report }
