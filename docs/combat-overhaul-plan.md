# Da Hilg Combat Overhaul — Plan (v2, extended)

Goal: combat that is **awesome, hilarious, and fun**, data-driven, height/posture-aware, with
required hit celebrations and absurd movement — and that scales to the new ~2,300-clip Mixamo
library. Two things the original plan missed are first-class here: **fighting nibblers** (the core
swarm mechanic — crush / kick / dislodge their clinging + climbing) and **per-character signature
movement** (e.g. Drew is flamboyant, dancy, walks seductively).

This keeps the original direction verbatim and **adds** to it. New/changed parts are marked **[+]**.

---

## 0. First Step (prerequisite, do before anything else)
Restore Unity compile: clean up the interrupted partial `DaHilgActor.cs` edit (partial signature/field
changes started but not completed) and get the project compiling. Verify with a batchmode compile
before touching combat structure. *(Note: the concurrent-session churn may have already reverted that
partial edit — confirm with a compile first; if clean, proceed.)*

## Core direction (unchanged)
Keep ONE Attack input, but make it data-driven:
`Attack -> pick a valid attack profile -> play attack -> resolve profile-aware hit -> pick matching
reaction -> attacker celebrates with a dance/taunt`.

## 1. Animation Library Model — `DaHilgAnimationLibrary` (ScriptableObjects)
Per-clip metadata: **Tags** (Punch, Kick, Sweep, JumpAttack, Slam, Dance, Taunt, Stumble, Prone,
Crawl, Celebrate, …), **TargetHeight** (High/Mid/Low/Ground), **ActorPosture** (standing/airborne/
crouched/prone), **RootMotionPolicy** (in-place/partial/full), **ContactTime**, **RecoveryTime**,
**AbsurdityWeight** (normal/goofy/ridiculous), **AllowedCharacters**, **FallbackClip**.

**[+] Source it from the new `mixamo-animation-library/`.** An editor importer reads
`manifest.json` (category + Mixamo description + frame range per clip) and seeds each entry's Tags /
TargetHeight / Posture from the category path (e.g. `combat/unarmed/attacks` → Tag=Punch/Kick,
TargetHeight=Mid/High; `combat/weapons/*` → weapon tag; `dance` → Celebrate; `poses` → Idle). Human
review/override after auto-seed.
**[+] `LibraryRole`** per clip: Attack / Reaction / Celebration / LocomotionVariant / IdleEmote /
**DislodgeMove** / **NibblerClip**.
**[+] Nibbler-target flags**: `CrushesGround` (stomp/slam squashes ground nibblers),
`HitsClinging`/`DislodgesClinging` (shake/roll/slam throws nibblers off the body).

## 2. Attack Profiles — `DaHilgCombatAttack`
clip pool / tag query, damage, reach, cone angle, **hit-height band**, windup/contact frame,
recovery, knockback, stagger duration, **reaction tags to request**, can-hit-prone, celebration
intensity, camera punch, score/crush values.
Examples (unchanged): QuickPunch (mid/high, light flinch), RoundKick (mid/low, bigger knockback,
stumble), LowSweep (low/ground, trips crawling/prone), JumpSlam (broad mid/ground, heavy knockdown),
AbsurdSpinHit (wide cone, low damage, big dance celebration).

**[+] Nibbler combat fields** — `NibblerHitMode` ∈ { Punt, Crush, Dislodge, Sweep }, `CrushValue`,
`DislodgeCount` (how many clinging nibblers thrown off), `DislodgesClinging` (bool).
**[+] Nibbler-tuned profiles** (the missing piece):
- **GroundStomp / JumpSlam** → `Crush` ground nibblers at the feet (Ground band, high CrushValue) — solves "the swarm at my feet ignores my punches".
- **LowSweep / SpinKick** → `Sweep`/`Punt` a low arc clear of nibblers.
- **BodyFlail / ShakeOff / RollEscape** → `Dislodge` clinging nibblers (the central escape mechanic; reuses/extends the existing Roll). Targets the *attached* set, not a world cone.
- **Punt / Kick** → send a single nibbler flying.

## 3. Height/Posture-Aware Hit Model
Replace the feet-only cone with posture-aware hurtboxes. Each actor exposes standing (feet→head),
crouch/crawl (low band), prone (ground band), airborne (shifted up) hurtboxes. Each attack has a hit
band (punch=chest/head, kick=leg/mid, sweep=ground/low, slam=broad). A hit lands only if distance +
cone + **vertical band ∩ target hurtbox** + target-state-allows. (Punch misses a prone target; low
sweep / stomp still hit.)

**[+] Nibblers are a GROUND/LOW height class.** A standing punch (chest/head band) **misses** the
swarm; ground/low attacks (sweep, stomp, kick) **hit** them. Same model, applied to the swarm.
**[+] Two resolution paths.** (a) WORLD CONE — ground/standing world targets (nibblers + actors).
(b) ATTACHED-SET DISLODGE — clinging nibblers ride the body's bones (existing cling system) and are
NOT in the world hurtbox; only `Dislodge` attacks (shake/roll/slam) clear them, removing up to
`DislodgeCount` from the attached set and spawning each as a "thrown-off" world ragdoll/tumble.

## 4. Eligible / Weighted Attack Selection
Attack button picks from ELIGIBLE attacks (usable anim, sensible distance/posture, off cooldown, not
rolling/staggered/prone, avoid repeats, optionally bias absurd upward over time). Weighted by context:
nearby standing → punch/kick/jump; prone → sweep/slam/ground; **[+] clinging nibbler count high →
bias Dislodge (shake/roll/slam); ground nibbler swarm at feet → bias Stomp/LowSweep/SpinKick;** after
multi-hit → more absurd finishers. **[+] Filter by the actor's per-character attack pool (§9).**

## 5. Reaction System — `DaHilgCombatReaction`
Reaction by incoming attack tag, target posture, health, hit height, knockback, current anim,
randomness. Examples: punch→Hit/HeadSnap/StumbleBack; kick→Stumble/SpinBack/Fall; sweep→Trip/Knockdown;
slam-on-prone→GroundBounce/RollAway; heavy→Knockdown.
**[+] Nibbler reactions**: Crushed (squash flat), Punted (sent flying), Dislodged (thrown off the body,
tumble + detach), Stunned — from the nibbler anim set + library `NibblerClip`s.

## 6. Required Hit Celebration
Every successful hit queues a short attacker celebration after recovery (0.4–1.2 s micro-dance / taunt
step / shimmy / spin / finger-guns / flex). Bigger hit → bigger celebration; multi-hit/crush →
stronger; interruptible by danger/damage; optional tiny embarrassed recovery after a miss.
**[+] Per-character celebration pools** (Drew = flamboyant dance fragments; etc.) pulled from the
library `dance`/`emotes` categories; **[+] nibbler-crush celebrations scale with crush count.**

## 7. Absurd Movement While Fighting (transient overlay, not permanent)
Attacker overlays: boxing shuffle, moonwalk step-back, spin recovery, dance-step advance, ridiculous
sidestep. Target overlays: wobble retreat, stumble spin, crawl scramble, roll-away, panic dance
stumble. Temporary movement mode only.
**[+] Flavored per character** (Drew's overlays are dancy/seductive — see §9).

## 8. [+] Scaling architecture — Playables tagged-clip layer
2,300 clips can't each be an Animator state. Add a `DaHilgClipPlayer` built on `PlayableGraph` +
`AnimationClipPlayable`/`AnimationMixerPlayable` that plays ANY library clip by name/tag and crossfades
it over the base locomotion (the existing Animator stays the locomotion bridge short-term). One-shot
tagged clips (attack / reaction / celebration / overlay) route through the Playables layer; this is
what makes the big library usable without hand-authoring states. Library GLB clips import as
`AnimationClip`s addressable by the manifest key.

## 9. [+] Per-Character Signature Movement & Moves (the user's ask)
Each of Mike / Kelli / Cece / Drew gets a `MovementProfile` + signature pools (via `AllowedCharacters`
+ per-character tag queries into the categorized library):
- **Drew** — flamboyant, dancy, **walks seductively**: signature locomotion (catwalk/strut/sway walk,
  dancy run, hip-swing idle), dance-based attacks (capoeira/breakdance hits), flamboyant dance
  celebrations, seductive idle; absurd-movement overlays skew dancy.
- **Mike / Kelli / Cece** — distinct personalities (e.g. Mike = solid boxer; Kelli, Cece TBD), each
  with their own walk/run/idle overrides, signature attacks, and celebration flavor.
`MovementProfile` = per-char locomotion clip overrides + a "flavor" weight biasing overlay/celebration
picks + a signature-attack list. The huge library makes this cheap — it's just tag queries per char.

## 10. [+] Nibbler Motion Enrichment
Nibblers also use far more of the library: varied lunge/bite/cling attacks, the new Crushed/Punted/
Dislodged reactions, climbing/clinging variants, and idle scatter — from the `creature`/small clips +
the existing nibbler-anims, so the swarm reads alive and the crush/dislodge mechanics have real
reaction animation.

## Implementation phases (extends the original)
0. Restore compile (First Step). 1. `DaHilgAnimationLibrary` SO + importer from
`mixamo-animation-library/manifest.json` + tag validation. 2. `CombatAttack` + `CombatReaction` data
(+ nibbler fields). 3. Posture-aware hurtboxes on `DaHilgActor` + nibbler height class + attached-set.
4. `DaHilgClipPlayer` (Playables scaling layer). 5. Replace `StartMelee`/hard-coded combo with
`TryAttack` → `ResolveAttackHit` (world-cone + attached-set-dislodge paths); `StartAttack(profile)`
instead of cycling `s_ComboStates`. 6. Celebration queue + reaction selection. 7. Per-character
`MovementProfile` + signature pools. 8. Nibbler combat (crush/punt/dislodge) + nibbler reactions +
motion enrichment. 9. Editor preview/debug UI (attack × target posture × nibbler state). 10. Play-mode
tuning — make it awesome, hilarious, fun.
