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

CURRENT STATE (ROUND 5 — the round-4 punch-list landed; re-grade the NEW code):
- AUDIO (round-4 #1 gap, fixed): a looping tyre-SCREECH voice (bandpassed noise, Q5.5)
  ridden each frame from the slip amount + handbrake, so power-slides/skids now make
  noise; engineUpdate is THROTTLE-AWARE (filter opens + intake roar + a touch louder on
  the gas) with a filtered-noise 'whoosh' on tip-in; near-miss fires the same whoosh.
- ANALOG THROTTLE: GO squeezes 0→1 over ~0.4 s (feather power out of a slide) instead
  of a binary switch (verified ramp 1→3→5→9→13→18 mph); lifting off applies real
  ENGINE-BRAKING (acc -= speed·0.45, cap 11) so the car coasts down into corners.
- CAMERA WHIP: the chase look-point is a lerped _lookV (rate 7) carrying a drift/steer
  lateral lead, so the car slides toward frame-edge on a hard corner and snaps back;
  ASYMMETRIC FOV (widens at rate 6, relaxes at 2.2 → every GO stab shoves wide fast);
  continuous high-speed rumble past ~55 mph; a Dutch-tilt ROLL into corners/drift. All
  gated by reduced-motion.
- POI META-GOAL (fuses the two best things): the 5 real places (home, Meemaw's, Canyon
  Middle, Stanton, Dad's work/XQ) now PLOT on the minimap (pink ring = to-find, green =
  found; off-map ones clamp to the edge as a 'that way' hint), tick lasting progress
  saved to localStorage, show '🏆 x/5 places found' on the start card, and celebrate
  all-5. (verified: poisFound=['home'] persisted on spawn.) Coin rally (18 coins) +
  run-timer/combo/best-time still live alongside it.
- NEAR-MISS reward (Burnout loop): skimming a tree/animal/parked car within ~1.6 m at
  >14 u/s WITHOUT a hit → combo tick + whoosh + '💨 Close one! ×N' (650 ms cooldown).
- CRASH payoff: impact>34 → a beat of global SLOW-MO (timeScale 0.32, recovers) + a
  white #fx flash + 'CRUNCH! <mph>' toast. Animals now DEFLECT (speed×0.5) instead of
  flinging the car backward.
- AUTO-DRIVE cap now scales with distance-to-next-turn (clamp(dist·1.4, 22, maxF)), so
  long straight legs of a cross-town route run fast, only corners/arrival slow it.
- DISCOVERABILITY: a faint resting 'steer' ghost-stick bottom-left for the first few
  seconds; the STOP pedal label flips to 'REV' when reversing (verified); the 🎥 button
  shows the current camera NAME (verified Cruise→Top-down).
- POLISH: spin-recovery assist (tail tucks in faster when you're not steering, so slides
  are catchable); softer high-speed steering falloff (0.03) so the open-road blast stays
  pointable; surface-tinted smoke (brown dust off-road, grey on tarmac).
- Everything from before still live: feelRef speed-decoupling (40 mph feels like 150,
  real top 180-220); off-road lawn penalty; real speed-lines; per-car {accel,top,grip,
  slip}; minimap tap-to-drive + live ETA; chase auto-recenter; Google Directions routes;
  back-to-road; horn; 4 cameras (Cruise/Top-down drag-to-drive/Aerial/Close).
- STILL OPEN (minor): no time-trial/race start beyond the coin rally + landmark hunt;
  no leaderboard; the procedural collision is on invisible footprints under the tiles.

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
