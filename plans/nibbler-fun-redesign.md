# Nibbler "Make It Fun" Redesign — implementation plan

Source: adversarial gameplay-design workflow (6 lenses + adversarial verify + synthesis), run 2026-06-21.
Full raw output: workflow task wdv4z3ba1.

## Diagnosis (why it isn't fun)
1. **No goal / no stakes** — Nibblers mode has no win/lose, no objective, no score target; health clamps at 0 with no death. It's a sandbox with no destination.
2. **Instant-count stun-lock (keystone anti-fun)** — overwhelm gates read live attached count: 15=crawl, 24=pinned (cap=0, frozen) with NO struggle/escape. The JS original used a buried-TIME accumulator + guaranteed mash-to-thrash-out. Port = helpless death-spiral.
3. **Self-sustaining relentless faucet** — every attach re-`MarkPlayer()`s you → permanently in the 0.14s fast-spawn regime (~7/sec); you can never visibly clear the field.
4. **Un-dodgeable snap-grab** — lunge is a guaranteed Lerp-to-anchor once in ~2m, no telegraph, no whiff. Threat is binary: sprint (you outrun them 8.2 vs 4.5, totally safe) or stop (piled on, no counterplay).
5. **Blunted counters** — jump sheds only 1/3 (bailing with a teacup); roll-crush is the bright spot but 1.55s cooldown vs 0.14s spawner = net-zero progress; cooldown clamp at Actor.cs:224 makes any RollCooldown<0.93 inert.
6. **No juice** — crushes/attaches are flat; attached nibblers are weightless decals; no shake, pop, or feedback. No audio/particles exist in the project at all.

## The fun core (vision)
> Bait the swarm into a fat cluster, read your buried-load meter rising, choose the moment, unleash a mass-scaled crush **nova** (screen-shaking firework + score fountain), bank the score at a safe zone. Risk the pile, own the release, get the fireworks. **Never hard-locked** — overwhelm is a felt 2-3s build with a guaranteed thrash-out.

## Prioritized changes (de-risked order)
1. **[KEYSTONE] Buried-TIME overwhelm + guaranteed struggle-out** (GameManager + Actor). `m_BuriedLoad` accumulator: +dt*tierMul (2.2/1.0/0.35 by stagger/down/stop bands), bleed -dt*1.8. Gate crawl on load>=2.6, pin on load>=5.6 (not instant count). Pinned cap = RunSpeed*0.4 (heavy trudge, NEVER 0/frozen). Struggle: +dt*0.85 + 0.5/jump; at >=1 scatter 5, load-=1.6.
2. **Count-scaled crush juice** (GameManager + CameraRig + NibblerAgent). `CrushImpact(count,center)`: additive camera shake AFTER CameraRig.Follow in LateUpdate; FOV punch (ThirdPerson/Shoulder/High only); per-body scale-pop-to-1.3x→0 + spin + launch ~6.5/3.5 + 0.30s despawn; score popcorn. **No Time.timeScale** (breaks the 0.12s melee delay + all Time.time gates).
3. **Roll = omnidirectional mass-scaled nova, honest cooldown** (Actor + GameManager + NibblerAgent). Fix Actor.cs:224 to `now + RollCooldown`; RollCooldown 1.55→0.9. When attached>=7 drop the side gate → 360 crush recentered on body. Radius 1.38+0.04*nearby, cap 2.2. Flat 35/kill + one-time +50 when crushed>=8 (NO multiplier).
4. **Stop self-mark; exposure-driven swell + far-wander cull** (GameManager + NibblerAgent). DELETE `MarkPlayer()` at line 684 (keep attach flash). Replace wall-clock baseTarget with a decaying marked-clock curve (~6/14/22 at 30/60/90s). Hold interval ~0.22-0.30s. Cull Chase/Scatter nibblers beyond ~42m (earned relief).
5. **Telegraphed whiffable lunge + camera-behind spawn bias** (NibblerAgent + GameManager). 0.18s crouch/scale wind-up tell; ballistic arc with per-frame attach test (roll/strafe = WHIFF→Chase). Spawn bias: reject dot(camForward)>0.6, ThirdPerson/Shoulder/High only. (Bump danger pressure after, since whiffs lower throughput.)
6. **Jump = real radial peel, load-scaled height** (GameManager + Actor). Shed 0.40*attached (not /3) when attached>=7. Jump height *1/(1+attached/14) floor 0.6 (gate behind keystone struggle).
7. **Separation fix → aimable doughnut** (NibblerAgent). Bug: separation is normalized INTO the desired unit vector. Use absolute radius ~0.6m, soft falloff, apply AFTER seek (un-normalized), strength ~3.0. Shrink chase ring toward torso.
8. **HUD: buried-load gauge headline + SAFE banner** (Hud). Center, always visible (remove collapse gate), bound to buried-load with stagger/down/pin waypoints; red edge overlay = vignette; demote health to corner pip; NN/36 → debug; SAFE relief banner; "-X HP/s, N riders" cause ticker.
9. **No-fail score/streak bank** (GameManager + Hud). Crushes → at-risk score + decaying combo; safe zone BANKS it (+banner); PlayerPrefs high-score. Pinned bleeds at-risk score. **NO** death screen / mash-QTE / arena clock (reference omitted fail state on purpose).

## Hard cuts (don't do)
- Time.timeScale hit-stop; super-linear roll multiplier; hard DOWNED+QTE fail state + arena clock; BUILD/SURGE/LULL spawn-freeze; analog speed tax from 1st clinger; k_JumpRadius→1.6; chase ring 1.2-2.2m; reusing m_NibblerFill as both danger gauge and charge meter.

## Risks
- Lower roll cooldown + 5.7 lurch = ledge-grief on canyon/stanton — keep >=0.85, test ledges, damp near bounds.
- Whiffable lunges soften pressure — bump danger spawn together or it deflates to whack-a-mole.
- Buried-load + struggle + trudge could over-correct to ZERO stakes — verify high-load escape is dramatic-but-earned; keep at-risk-score bleed.
- Stronger separation may drop attached below stagger — instrument avg attached, nudge attach radius/target not undo separation.
- Change ONE variable, build, watch one run before stacking — many interacting subsystems.
- Land cheap isolated changes as separate commits (user reverted stock tunables once).

## Tunables (DaHilgGameSettings.asset / consts)
RollCooldown 1.55→0.9; pinned cap 0→RunSpeed*0.4; jump-shed /3→0.40*; jump height load-scaled; RollCrushRadius 1.38→1.38+0.04*nearby cap2.2; flat 35 + 50@>=8; k_StartShieldSeconds 3→5; new: buried-load FALL_T 2.6 / STOP_T 5.6 / tier muls, NibblerSeparationRadius 0.6, marked-clock target bands.
