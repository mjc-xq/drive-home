export const meta = {
  name: 'dahilg-full-adversarial-review',
  description: 'Full adversarial review of the Da Hilg deploy/cache/WASM fix, mobile-WebGL robustness, nibbler redesign correctness, and controls/HUD — then adversarial verify + synthesis',
  phases: [
    { title: 'Review', detail: '4 adversarial lenses across deploy, mobile, nibblers, controls/HUD' },
    { title: 'Verify', detail: 'adversarially confirm each blocker/major finding is real' },
    { title: 'Synthesize', detail: 'one prioritized fix list' },
  ],
}

const RT = '/Users/mcohen/dev/home/unity/DaHilgUnity/Assets/DaHilg/Scripts/Runtime'
const ED = '/Users/mcohen/dev/home/unity/DaHilgUnity/Assets/DaHilg/Scripts/Editor'
const CTX = [
  'PROJECT: "Da Hilg" — a Unity 6000.5 WebGL game (Built-in Render Pipeline), deployed via Vercel from git branch MAIN. Repo /Users/mcohen/dev/home (git remote drive-home).',
  'WHAT JUST HAPPENED: a user on an iPhone hit a WASM load crash on the LIVE site: "RuntimeError: call_indirect to a signature that does not match (evaluating entryFunction(argc,argv))". Diagnosis: vercel.json serves the Unity Build files (da-hilg.wasm.unityweb / .framework.js.unityweb / .data.unityweb) with Cache-Control immutable max-age=1yr, but the filenames are FIXED (not content-hashed), so a redeploy can serve a mismatched cached framework+wasm. Also: NONE of this session\'s fixes were deployed — origin/main is an OLD build; all fixes are on branch skunkworks-single-terrain (main can fast-forward to it).',
  'FIXES JUST APPLIED (under review): (1) DaHilgProjectBuilder.CustomizeWebGLExport now appends a per-build "?v=<ticks>" cache-bust to loaderUrl/dataUrl/frameworkUrl/codeUrl. (2) A fresh Unity WebGL build is being produced. (3) Plan: push HEAD to main (fast-forward) so Vercel deploys it.',
  'EARLIER THIS SESSION (also under review): killed-desktop-controls fix in DaHilgHud.ShouldShowTouchControls (now returns Application.isMobilePlatform || (Touchscreen.current != null && Mouse.current == null)); HUD root pickingMode Ignore; a driving-theme HUD redesign; a large nibbler "make it fun" redesign across DaHilgGameManager.cs / DaHilgNibblerAgent.cs / DaHilgActor.cs / DaHilgCameraRig.cs (buried-time overwhelm + struggle, 360 roll nova, telegraphed ballistic lunge with a Windup state, separation rewrite, camera shake/FOV punch, score combo+bank+highscore).',
  'KEY FILES:',
  ED + '/DaHilgProjectBuilder.cs  (CustomizeWebGLExport cache-bust, BuildWebGLExport, BuildMacStandalone)',
  '/Users/mcohen/dev/home/vercel.json  (Build-file cache headers + rewrites)',
  RT + '/DaHilgHud.cs  (ShouldShowTouchControls, touch zones m_MoveZone/m_LookZone, HandleWebTouchTap/HandleWebHudCommand JS bridge, buried-load gauge, score display)',
  RT + '/DaHilgInputRouter.cs  (keyboard/mouse/gamepad/touch input)',
  RT + '/DaHilgGameManager.cs  (buried-load + struggle, spawn director, roll/melee crush + score combo/bank, CrushImpact, SpawnNibbler behind-bias)',
  RT + '/DaHilgNibblerAgent.cs  (chase/Windup/ballistic-Lunge/Climb/Attached/Scatter/Crushed FSM, separation, crush pop)',
  RT + '/DaHilgActor.cs  (StepPlayer caps incl. pinned trudge, roll cooldown, PlayEmote, melee)',
  RT + '/DaHilgCameraRig.cs  (Cinemachine rig + Punch shake/FOV)',
].join('\n')

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'verdict', 'findings'],
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', description: 'one-line overall judgment for this lens' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id', 'title', 'severity', 'evidence', 'willItBreakOnMobileOrDeploy', 'fix'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        evidence: { type: 'string', description: 'file:line + concrete reasoning' },
        willItBreakOnMobileOrDeploy: { type: 'boolean' },
        fix: { type: 'string', description: 'concrete, implementable' },
      } } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'isReal', 'confidence', 'reasoning', 'refinedFix'],
  properties: {
    title: { type: 'string' },
    isReal: { type: 'boolean' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasoning: { type: 'string' },
    refinedFix: { type: 'string' },
  },
}

const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['willTheWasmCrashBeFixed', 'willItRunOnMobile', 'prioritizedFixes', 'deployChecklist', 'residualRisks'],
  properties: {
    willTheWasmCrashBeFixed: { type: 'string', description: 'yes/no/uncertain + why' },
    willItRunOnMobile: { type: 'string', description: 'yes/no/uncertain + why (esp. touch controls showing on mobile web)' },
    prioritizedFixes: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['rank', 'title', 'severity', 'file', 'change'],
      properties: { rank: { type: 'integer' }, title: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, change: { type: 'string' } } } },
    deployChecklist: { type: 'array', items: { type: 'string' } },
    residualRisks: { type: 'array', items: { type: 'string' } },
  },
}

phase('Review')
const LENSES = [
  { key: 'deploy-cache-wasm', title: 'Deploy / cache / WASM mismatch', focus: 'Will the "?v=<ticks>" cache-bust in CustomizeWebGLExport actually fix the call_indirect signature mismatch? Check: does the query break the vercel.json header path-matching or br Content-Encoding? Does Unity\'s loader accept query strings on dataUrl/frameworkUrl/codeUrl/loader? Is index.html itself cached such that the phone keeps the OLD bare-name references (so it never fetches the new ?v= URLs without a hard reload)? Is pushing HEAD->main (fast-forward) correct, and does it drag in anything that breaks the deploy? Any OTHER deploy footgun (StreamingAssets paths, .vercelignore stripping needed files, gzip/br mismatch)?' },
  { key: 'mobile-webgl', title: 'Mobile / WebGL robustness', focus: 'Will the game be PLAYABLE on an iPhone (mobile Safari, WebGL)? CRITICAL: ShouldShowTouchControls() returns Application.isMobilePlatform || (Touchscreen.current != null && Mouse.current == null) — but on mobile WEB, Application.isMobilePlatform is FALSE and Touchscreen.current may be NULL until the first touch, so the on-screen touch joystick/look/buttons may never appear -> unplayable. Verify against DaHilgHud + DaHilgInputRouter + the HandleWebTouchTap/HandleWebHudCommand JS bridge (is there an external HTML touch UI that compensates?). Also: iOS Safari + Unity 6 WebGL memory/wasm limits, the immutable cache, touch look/move, and whether the HUD fits a phone screen.' },
  { key: 'nibbler-correctness', title: 'Nibbler redesign correctness', focus: 'Adversarially hunt bugs in the 6-batch nibbler redesign. Edge cases in: buried-load accumulator + the guaranteed struggle-out (can it ever soft-lock or never escape?), the pinned trudge, the 360 roll nova + mass-scaled radius, the NEW Windup->ballistic-Lunge FSM (does the CharacterController enable/disable stay correct across Windup/Lunge/Climb/Attached/whiff? can a nibbler get stuck, never attach so the game is trivially easy, or double-attach?), the separation rewrite (could it thin the swarm below the stagger threshold so overwhelm never triggers?), camera shake/FOV (does it ever leave FOV wrong or fight Cinemachine?), and the score combo/bank (NaN, negative, lost on level switch?).' },
  { key: 'controls-hud', title: 'Controls + HUD regressions', focus: 'Did the killed-desktop-controls fix + HUD redesign + gauge rebind introduce regressions? Check: desktop mouse-look/pointer-lock + WASD still work (pickingMode Ignore root, prompt/crosshair non-picking), no element overlap at phone/desktop aspect ratios, the buried-load gauge + cause ticker + score combo display correctly, the collapsible panel + level dialog + PUNCH still wire up, and the menu/touch command bridge still works.' },
]
const reviews = (await parallel(LENSES.map(L => () => agent(
  'You are a senior Unity/WebGL engineer doing an ADVERSARIAL review through ONE lens: "' + L.title + '". Assume something is broken; find it; ground every finding in file:line. The user is FURIOUS that the live game crashed on their phone, so prioritize anything that would break the deploy or mobile play.\n\nLENS FOCUS: ' + L.focus + '\n\nCONTEXT:\n' + CTX + '\n\nRead the relevant files and return concrete findings (severity, evidence with file:line, whether it breaks mobile/deploy, and a concrete fix).',
  { label: 'review:' + L.key, phase: 'Review', schema: FINDINGS_SCHEMA }
)))).filter(Boolean)
log('Reviews done: ' + reviews.length + ' lenses. Verifying blockers/majors.')

phase('Verify')
const majors = []
for (const r of reviews) for (const f of (r.findings || [])) if (f.severity === 'blocker' || f.severity === 'major') majors.push({ lens: r.lens, finding: f })
const verdicts = (await parallel(majors.map((m, i) => () => agent(
  'Adversarially VERIFY this claimed ' + m.finding.severity + ' (lens: ' + m.lens + '). Try to REFUTE it — is it actually real, or does something already handle it? Read the code. Default to skeptical but be correct.\nTITLE: ' + m.finding.title + '\nEVIDENCE: ' + m.finding.evidence + '\nCLAIMED FIX: ' + m.finding.fix + '\n\nCONTEXT:\n' + CTX,
  { label: 'verify#' + (i + 1) + ':' + m.lens.slice(0, 12), phase: 'Verify', schema: VERDICT_SCHEMA }
)))).filter(Boolean)
log('Verified ' + verdicts.length + ' findings. Synthesizing.')

phase('Synthesize')
const synth = await agent(
  'Synthesize this full adversarial review into a single prioritized, implementable fix list. Answer two questions directly and honestly: (1) Will the WASM call_indirect crash actually be fixed by the cache-bust + fresh build + push-to-main? (2) Will the game be PLAYABLE on an iPhone (esp. do touch controls appear on mobile web)? Then rank the fixes (blockers first) with file + concrete change, give a deploy checklist, and list residual risks.\n\n=== REVIEWS ===\n' + JSON.stringify(reviews, null, 1) + '\n\n=== VERIFY VERDICTS ===\n' + JSON.stringify(verdicts, null, 1) + '\n\n=== CONTEXT ===\n' + CTX,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA }
)

return { reviews, verdicts, synth }
