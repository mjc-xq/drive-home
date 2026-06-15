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

CURRENT STATE (ROUND 7 — the round-6 'neighborhood fantasy' punch-list landed; re-grade):
- POI BEACONS (round-6 #1 gap, fixed): a tall additive light-pillar over each of the 5
  real places, drawn THROUGH the world (depthTest off, renderOrder 998) so you can SEE
  your school / Meemaw's from across the neighbourhood and aim at it. Pink=to-find,
  green=found, nearest un-found pulses; opacity fades in by distance, shows within
  ~1.2 km in Drive (verified: home beacon visible + opacity scales with distance; the
  far POIs — Stanton 1.2km, Canyon 2.8km — pop in on approach via the chain route).
- FINISH-LINE ARRIVAL (round-6 #2): reaching a place now fires ~24 gold sparks + a 5-note
  fanfare + a beat of slow-mo & white flash + an 'ARRIVED' card (place, points, trip
  score). The <45 m POI and <14 m destination triggers are unified so they don't double-
  fire. (Was just a toast + 650 ms flash.)
- MOTION BLUR (round-6 #3): the streak layer smears (filter:blur on #fx.fast::before)
  only when truly flying — a cheap, mobile-safe approximation of the missing #1 speed
  cue, gated to high speed + reduced-motion.
- POWER-SLIDE reward: on the gas + |speed|>10 + turning, the throttle now actively pushes
  the tail out (car.vlat += steer·throttle·slip·9·dt), so flooring it through a corner
  HOLDS a drift instead of relying on eased grip-recovery alone.
- HANDLING tuning: top-end steer divisor 0.03→0.05 (yaw stops climbing past ~60 mph so
  the blast stays pointable); off-road softened (maxF 24→38, lawn drag 0.5→0.28) so a
  clipped corner is a loose surface, not glue (verified 43 mph reachable off-road);
  analog keyboard steering (kSteer ramps ~0.15 s) so desktop arrows ease in like touch.
- HIGH-SPEED FEEL (from round 5): an uncapped spHi term layers ON TOP of the ~60 mph feel
  cap — above 60 the FOV adds a second kick (→~84°), the camera sinks the car back, rumble
  + speed-lines keep intensifying, so the 180-220 mph blast reads faster than a 40 cruise.
- CHAIN-TRIP FARE LOOP (the 'one more run' fix): reaching a place awards trip points
  (250 + speed·4 + combo·50), then AUTO-ROUTES you to the nearest un-found place via the
  Google guide ('🏁 Next stop: drive to X!'). Verified: spawning finds home → routed to
  Stanton Elem with a live '1.2 km · ~2:14' ETA + guide ribbon. Returning players are
  pointed at their next stop on drive entry. 5 one-shot discoveries → a chained road trip.
- FERRARI UNLOCK gated to all-5 places (persisted localStorage). Locked in the 🚗 picker
  ('🔒 find all 5 places to unlock', disabled row); unlock fires a toast + chime + refreshes
  the picker. Verified: Ferrari locked:true on a fresh save, Sienna/RAV4/Toy unlocked.
- GRAB-THE-WHEEL: any real steer/gas/brake/key input instantly cancels auto-drive ('🕹️ You
  took the wheel!') so the player never fights the robot.
- PROGRESSIVE BRAKE: car.brakeAmt ramps in over ~0.25 s (a quick tap trail-brakes light for
  corner entry, a hold hauls down hard, peak softened -46→-34). LOAD-TRANSFER pitch: the
  body dives forward under braking / squats back under power, divided by per-car grip
  (Sienna wallows, Ferrari crisp) — the car finally has longitudinal WEIGHT.
- COMBO CRESCENDO: ×3 'Combo!' + whoosh, ×5 'ON FIRE!' chime + #fx flash + a pulsing HUD
  chip, ×8 'UNSTOPPABLE!' — chaining now looks/sounds like it's building (was silent).
- IN-DRIVE HUD now unifies the goals: 💛 coins · 🏆 x/5 places · 🔥 combo · 🏁 trip score · ⏱
  clock, all in the top module. Cameras REORDERED Cruise→Close→Top-down→Aerial (the
  speed-rich low Close cam is one tap away); a 🪄 TRACE dock button jumps straight to
  one-finger draw-to-drive; the 🎥 camera-name label bumped to a legible 9.5px.
- Everything from rounds 1-4 still live: tyre-screech + throttle-aware engine + whoosh;
  analog throttle + engine-braking; camera whip/asymmetric-FOV/roll; speed-lines; particles
  (skid/smoke/coin-burst, surface-tinted); near-miss reward; crash slow-mo+flash; per-car
  handling; minimap tap-to-drive + reverse 'REV' pedal label; ghost steer-stick; off-road
  lawn penalty; Google routes + smarter auto-drive cap; back-to-road; horn.
- STILL OPEN (minor): no ghost/leaderboard for the coin time-trial; chain trips are
  guide-only (you drive them, no forced race clock); collision is on invisible footprints.

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
