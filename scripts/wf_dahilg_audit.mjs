export const meta = {
  name: 'dahilg-audit',
  description: 'Re-audit EVERY Da Hilg request from the last ~12h against the actual current code/build; mark done/partial/broken/missing with evidence; root-cause + fix specs for all not-done',
  phases: [
    { title: 'Audit', detail: 'parallel lenses verify each request group against current code' },
    { title: 'Synthesize', detail: 'master status checklist + prioritized fix plan' },
  ],
}

const RT = '/Users/mcohen/dev/home/unity/DaHilgUnity/Assets/DaHilg/Scripts/Runtime'
const ED = '/Users/mcohen/dev/home/unity/DaHilgUnity/Assets/DaHilg/Scripts/Editor'
const SET = '/Users/mcohen/dev/home/unity/DaHilgUnity/Assets/DaHilg/Settings'
const DATA = '/Users/mcohen/dev/home/unity/DaHilgUnity/Assets/DaHilg/Data'
const TRANSCRIPT = '/Users/mcohen/.claude/projects/-Users-mcohen-dev-home/15f42074-d85e-41a3-9066-a488694d319b.jsonl'

const CTX = [
  'PROJECT: Da Hilg = Unity 6000.5 WebGL game (Built-in RP), a port of an R3F neighborhood swarm game (1840 Dahill). Built via `node scripts/build_dahilg.mjs`. The user is FURIOUS because many things claimed "done" are visibly broken in a fresh local build. Your job: verify the TRUTH against the ACTUAL current code (read the files; do not trust prior claims). Mark each requirement done / partial / broken / missing with file:line evidence, and for anything not truly DONE give the concrete root cause + an implementable fix.',
  '',
  'GROUND TRUTH from a fresh local screenshot (build #8, cache cleared): player Cece + all NPCs render in a T-POSE (arms straight out) instead of locomotion/idle; multiple nibblers render BUILDING-TALL (one sunk through the ground to its waist, taller than a house) far from camera; "26 riders / MARKED" shows but NO nibblers are visibly on the player; HUD has a big status panel upper-left + minimap upper-LEFT under it + a VIEW/PLAYER/LEVEL/MENU segmented bar upper-right. User also reports: desktop keyboard+mouse controls do NOT work; player does NOT spawn in front of their house.',
  '',
  'ALL USER REQUESTS over the last ~12h (verify EACH):',
  'R1 HUD theme: match the driving-game HUD theme — its fonts + colors; no overlap between any elements.',
  'R2 HUD compact: collapsible menus; health bar + nibbler counter HORIZONTAL + compact (not vertical).',
  'R3 HUD layout: SMALL status panel UPPER-LEFT; MINIMAP UPPER-RIGHT; compact COLLAPSIBLE controls elsewhere.',
  'R4 Anim/T-pose: player + NPCs use a standard locomotion rig (idle/walk/run) when moving — NOT stuck in T-pose/arms-out.',
  'R5 Emote rules: the PLAYER emotes ONLY on explicit player input or as a reaction to being attacked — never ambient/auto; emote orientation correct.',
  'R6 Nibbler target: nibblers chase the PLAYER, not the camera.',
  'R7 Nibbler count: MORE nibblers in the swarm.',
  'R8 Nibbler scale: NO giant/building-tall nibblers — correct small scale, on the ground (not sunk).',
  'R9 Core mechanic: nibblers visibly LUNGE + JUMP ON + CLING to the player and overwhelm them; the player can FLOP/ROLL to escape. THE central fun mechanic. Must be visibly working.',
  'R10 Fall-through: player/characters do not fall through the ground/level.',
  'R11 Fun/score: score chase / banking loop makes it fun.',
  'R12 Spawn: player spawns in FRONT of their house (1840 Dahill), facing the street, inside a safe zone.',
  'R13 Desktop controls: WASD + mouse-look work on desktop web with a REAL keyboard/mouse (a synthetic dispatched key worked, a real key may not — likely canvas focus / pointer-lock / touch-gate). ',
  'R14 Controller: gamepad/controller input works on web.',
  'R15 Mac target: a Mac desktop standalone build target exists + builds + runs (secondary).',
  'R16 iOS: loads on iPhone without the WASM call_indirect crash / reload loop (memory profile: HDR off, DPR1, pool cap, house level on mobile).',
  'R17 FPS melee: first-person melee fighting exists.',
  'R18 Minimap looks good: the minimap is currently ugly/terrible — redesign it to look clean and match the driving-game HUD aesthetic (good colors, clear safe/danger, not a cluttered red mess).',
  '',
  'KEY FILES (read what is relevant to your lens):',
  RT + '/DaHilgActor.cs (locomotion/idle/emote: UpdateLocomotionAnimation, PlayAnim, PlayEmote role guard, StepMotion, BodyHeight)',
  RT + '/DaHilgNibblerAgent.cs (scale in ctor/Spawn/Scatter/Crush; FSM chase/Windup/Lunge/Climb/Attached; PositionOnBody; ChooseAttachAnchor; camera-occlusion hide; SetPlayer target)',
  RT + '/DaHilgGameManager.cs (BuildNibblerPool scale+pool; SpawnNibbler; TickNibblers overwhelm/struggle; m_NibblerRoot; player spawn/SetLevel; safe zone)',
  RT + '/DaHilgHud.cs (RefreshResponsiveControls, SetPanelFrame, BuildTopPanel, BuildMinimap, segmented bar, collapse, fonts/colors, ShouldShowTouchControls)',
  RT + '/DaHilgCameraRig.cs (follow target, deoccluder min distance, Punch)',
  RT + '/DaHilgPlayerController.cs and any DaHilgInput*.cs (keyboard/mouse/gamepad reads, pointer lock)',
  ED + '/DaHilgProjectBuilder.cs (RebuildUnityScene, BuildAnimatorControllers, ValidateCharacterAnimationAssets, character+nibbler prefab setup, GeneratedAnimations, CustomizeWebGLExport index.html canvas focus + touch detect + cache-bust + mac build)',
  SET + '/  (DaHilgGameSettings.asset: NibblerScale, NibblerPoolSize, spawn fields; *Controllers/*.controller; GeneratedAnimations/)',
  DATA + '/  (level.meta.json, minimap.json: spawn/safe-zone data)',
  'Use git to check the recent refactor: `git log --oneline -10`, and `git show --stat <hash>` for commits 58692ffb 4f48616f 383496b5 742ef06d 037f35be (single-surface levels + "URP rendering" + windows-scale) — they may have broken characters/anims/nibbler scale.',
].join('\n')

const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'items'],
  properties: {
    lens: { type: 'string' },
    items: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['req', 'status', 'evidence', 'rootCause', 'fix'],
      properties: {
        req: { type: 'string', description: 'which Rn requirement' },
        status: { type: 'string', enum: ['done', 'partial', 'broken', 'missing'] },
        evidence: { type: 'string', description: 'file:line + what the code actually does' },
        rootCause: { type: 'string', description: 'if not done: the concrete cause (else "")' },
        fix: { type: 'string', description: 'if not done: exact implementable fix (else "")' },
      } } },
  },
}

const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['checklist', 'fixes', 'verifyPlan', 'missedRequests'],
  properties: {
    checklist: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['req', 'status', 'note'],
      properties: { req: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'broken', 'missing'] }, note: { type: 'string' } } } },
    fixes: { type: 'array', minItems: 6, items: { type: 'object', additionalProperties: false,
      required: ['rank', 'title', 'file', 'change', 'why'],
      properties: { rank: { type: 'integer' }, title: { type: 'string' }, file: { type: 'string' }, change: { type: 'string' }, why: { type: 'string' } } } },
    verifyPlan: { type: 'array', items: { type: 'string' } },
    missedRequests: { type: 'array', items: { type: 'string', description: 'any user request from the transcript not covered by R1-R17' } },
  },
}

phase('Audit')
const LENSES = [
  { key: 'hud', focus: 'Audit R1,R2,R3,R18 (HUD theme/fonts/colors, no-overlap, collapsible, horizontal-compact health+nibbler, SMALL panel upper-left, MINIMAP upper-RIGHT, compact collapsible controls, and the MINIMAP looking clean/good not an ugly red mess). Read DaHilgHud.cs fully (BuildMinimap especially). For each, status + evidence + (if not done) exact RefreshResponsiveControls/SetPanelFrame/BuildMinimap fix for desktop AND phone, including a concrete minimap restyle.' },
  { key: 'anim', focus: 'Audit R4 (T-pose vs locomotion) + R5 (player emote only on input/attack, orientation). Find WHY characters T-pose: are Animator clips missing/broken (GeneratedAnimations not regenerated, controller has no states, refactor broke rig/clip wiring)? Read DaHilgActor + DaHilgProjectBuilder anim generation + the .controller assets. Exact fix to restore idle/walk/run + emote-only-on-input.' },
  { key: 'nibblers', focus: 'Audit R6 (chase player not camera), R7 (more nibblers), R8 (giant scale — find the REAL cause of building-tall nibblers; trace NibblerScale value, every localScale write, parent scale, character prefab/rootbone scale, skinned-mesh bounds), R9 (visible lunge+jump-on+cling+overwhelm + flop/roll escape — does the FSM actually attach them ON the body and is the camera-occlusion hide making them invisible?), R10 (fall-through), R11 (score fun). Read DaHilgNibblerAgent + DaHilgGameManager. Exact fixes.' },
  { key: 'spawn', focus: 'Audit R12 (spawn in front of the house, facing street, safe zone). Find where player start pos+facing is set (DaHilgGameManager spawn/SetLevel, level.meta.json/minimap.json safe-zone or spawn marker). Why does the player NOT spawn at the house front? Exact fix.' },
  { key: 'controls', focus: 'Audit R13 (desktop WASD+mouse-look with REAL keyboard/mouse) + R14 (gamepad on web). Trace input reads (DaHilgPlayerController/DaHilgInput), canvas focus/tabindex + pointer-lock in the generated index.html (DaHilgProjectBuilder CustomizeWebGLExport), and ShouldShowTouchControls. Why would a real keypress not reach Unity while a dispatched one does (focus)? Exact fix so desktop controls + gamepad just work.' },
  { key: 'platform', focus: 'Audit R15 (Mac standalone build target exists + works), R16 (iOS memory profile + no WASM crash + house level on mobile), R17 (FPS melee exists). Read DaHilgProjectBuilder (BuildMacStandalone, CustomizeWebGLExport mobile/cache-bust) + MobileWeb gating + the melee code. Status + evidence + any gaps.' },
  { key: 'transcript', focus: 'Enumerate EVERY distinct request the user made in the last ~12h and flag any NOT covered by R1-R18. Read the human/user-role text from the transcript jsonl at ' + TRANSCRIPT + ' using jq (e.g. `jq -r "select(.type==\\"user\\") | .message.content" ' + TRANSCRIPT + ' 2>/dev/null | tail -200`) or plain grep for user-role lines, then read the text. Map each found request to an Rn or report it as a missed item. status=done only if confirmable in code; else broken/missing/partial.' },
]
const audits = (await parallel(LENSES.map(L => () => agent(
  'You are a senior Unity engineer doing a TRUTHFUL audit of ONE group of requirements against the ACTUAL current code (read the files / run git / grep). Do not trust prior "done" claims. For each requirement: status (done/partial/broken/missing), file:line evidence of what the code really does, and if not DONE the concrete root cause + an implementable fix.\n\nYOUR LENS: ' + L.focus + '\n\n' + CTX,
  { label: 'audit:' + L.key, phase: 'Audit', schema: AUDIT_SCHEMA }
)))).filter(Boolean)
log('Audited ' + audits.length + ' lenses. Synthesizing master status + fix plan.')

phase('Synthesize')
const synth = await agent(
  'Synthesize these audits into: (1) a master checklist covering R1-R17 with a single honest status each + short note; (2) a prioritized, directly-implementable fix list (rank, title, file, exact change, why) ordering by player impact — T-pose/locomotion, giant-nibbler scale, visible attach mechanic, desktop controls, spawn point first; HUD layout + nice-to-haves after; (3) an in-engine verify plan per fix; (4) any missedRequests not in R1-R17.\n\n=== AUDITS ===\n' + JSON.stringify(audits, null, 1) + '\n\n=== CONTEXT ===\n' + CTX,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA }
)

return { audits, synth }
