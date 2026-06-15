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

CURRENT STATE (ROUND 2 — a full game-feel pass just landed; re-grade the NEW code):
- Acceleration: accel 14 u/s^2 × per-car, road drag 0.10 — builds smoothly to a
  high top speed (maxF 140 u/s ≈ 313 mph × per-car 'top'). Off-road maxF 28 (slow).
- SENSE OF SPEED (new): perceptual engine rev with a gear feel (audio.engineUpdate
  now gets the real 140 ceiling, was a bugged 36); camera FOV kicks 46→~73 with
  speed²; camera pulls back + look-leads ahead with speed; a #fx vignette/speed-rush
  overlay fades in past ~110 mph. Frame-rate-independent camera smoothing.
- DRIFT (new): arcade lateral slip — the tail steps out turning hard at speed, far
  more on the HANDBRAKE (Space / ✋ hold button); grip recovers it, throttle powers
  out; the body leans into the slide.
- PER-CAR HANDLING (new): each car has {accel, top, grip, slip} — Sienna heavy+
  grippy, RAV4 balanced, Ferrari fast+slidey, Toy Racer twitchy.
- COLLISION FEEDBACK (new): hits scrub speed to a near-stop in the same direction
  (no more backward fling) + a thunk sfx + decaying camera shake + haptic buzz +
  a 'watch the critters' toast on animals. (Collision is still on the INVISIBLE
  procedural footprints while photoreal tiles are shown.)
- ARRIVAL (new): detected for MANUAL driving too (was auto-only) — chime arpeggio,
  a celebratory green/gold screen flash, 'You made it to X!' toast.
- HORN (new): H key / 📣 button.
- Cameras (🎥 cycle order now Cruise → Top-down → Aerial → Close): Cruise = high
  chase (default, clean); Top-down = near-overhead heading-up, supports DRAG-TO-DRIVE
  (drag → car drives there, reverses if behind, faster the farther); Aerial = the
  exact Explore high-orbit while driving; Close = low cinematic (melty, now LAST).
- Cars: picker (🚗). Navigation (🧭): address presets + free text; **Google Directions**
  road-following route on the minimap + guide ribbon; **auto-drive (🤖)** follows the
  route (capped ~45 u/s); back-to-road (🛣️) snaps to the route/nearest road.
- HUD: REDESIGNED — glass .panel system, a right-side control DOCK, a bottom-centre
  SPEED MODULE (big number + colour speed bar), framed minimap, handbrake/horn
  buttons, a fading drive hint.
- STILL NOT DONE (last round's lower items): no collectibles/coins or score loop;
  throttle+steer still share the left stick; minimap isn't tap-to-drive; auto-drive
  cap (45) is slow for far trips and there's no ETA in the dest bar.

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
