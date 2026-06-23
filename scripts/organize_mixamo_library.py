#!/usr/bin/env python3
"""Sort the extracted Mixamo animation GLBs into a gameplay-purpose folder hierarchy under
`mixamo-animation-library/`, with a README explaining the taxonomy + a manifest.

Hierarchy is by HOW a clip is used in-game (not by Mixamo's flat list), so designers can find
"a punch" right next to "a punch reaction", keep every weapon in its own folder, etc. See the
generated README for the full reasoning.

Classification is ordered keyword rules (first match wins) over the animation NAME (the Mixamo
description, which we kept as metadata). Order matters: specific/combat rules run before the
broad locomotion rules so e.g. "Reaction To Getting Clipped While Walking" lands in combat
reactions, not locomotion.

USAGE:
  python scripts/organize_mixamo_library.py --dry-run            # just print the distribution
  python scripts/organize_mixamo_library.py --src exports/mixamo_glb --dest mixamo-animation-library [--copy]
"""
import argparse
import json
import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Ordered (regex, folder) rules. FIRST MATCH WINS. Patterns are inflection-tolerant
# ((?:ing|s|es|ed|er)? after verbs) so "Kicking"/"Punches" match. Tune freely.
INF = r"(?:ing|ings|s|es|ed|er|ers)?"
RULES = [
    # ---- WEAPONS — each in its own folder (attacks/idles/reactions for that weapon together) ----
    (r"\b(?:katana|broadsword|greatsword|longsword|sword|saber|sabre|blade)s?\b|\bslash" + INF, "combat/weapons/sword"),
    (r"\b(?:knife|knives|dagger)\b|\bstab" + INF, "combat/weapons/knife"),
    (r"\b(?:pistol|handgun|revolver|sidearm)s?\b", "combat/weapons/pistol"),
    (r"\b(?:rifle|shotgun|smg|firearm|gun)s?\b|\b(?:shoot|aim|reload)" + INF, "combat/weapons/rifle"),
    (r"\b(?:bow|archer|archery|arrow|crossbow)s?\b", "combat/weapons/bow"),
    (r"\b(?:spear|javelin|polearm|halberd|trident|pike)s?\b", "combat/weapons/spear"),
    (r"\bshield", "combat/weapons/shield"),
    (r"\b(?:mace|warhammer|club|pipe|crowbar)s?\b", "combat/weapons/blunt"),
    (r"\bgrenade|\bthrow" + INF, "combat/weapons/throw"),
    # ---- STEALTH / TAKEDOWNS ----
    (r"\b(?:assassinat|takedown|sneak\s*attack|choke|strangl|hostage|execution|garrote|backstab|knock\s*out\s*from\s*behind)", "combat/stealth"),
    # ---- DEATH ----
    (r"\b(?:dying|death|dead|die|killed|fatality|collaps)" + INF, "combat/death"),
    # ---- COMBAT REACTIONS (before attacks + before locomotion) ----
    (r"\b(?:reaction|getting|knock|stagger|stun|impact|recoil|flinch|block|parry|guard|defend|hurt|injur|wound|dodg|evade|duck)" + INF, "combat/unarmed/reactions"),
    (r"\bhit\b", "combat/unarmed/reactions"),
    # ---- UNARMED ATTACKS ----
    (r"\b(?:punch|jab|hook|uppercut|elbow|knee|headbutt|kick|roundhouse|combo|melee|fight|brawl|martial|box|strike|attack|swing)" + INF, "combat/unarmed/attacks"),
    # ---- MAGIC ----
    (r"\b(?:spell|magic|cast|wizard|sorcer|conjur|enchant)" + INF, "magic"),
    # ---- DANCE ----
    (r"\b(?:danc|b-?boy|breakdanc|hip\s*hop|samba|salsa|capoeira|twerk|shuffle|popping|locking|uprock|swing\s*dance|ymca|gangnam|rumba|cha\s*cha|northern\s*soul|house\s*dance|jazz|flair|hand\s*hops|tutting|moonwalk|bellydanc|charleston)", "dance"),
    # ---- MUSIC ----
    (r"\b(?:guitar|bass\s|drum|piano|violin|saxophone|trumpet|conduct)" + INF + r"|\bsing" + INF + r"|\bdj\b|\brock\s*beat\b", "music"),
    # ---- SPORTS ----
    (r"\b(?:baseball|basketball|golf|soccer|tennis|bowl|hockey|cricket|dribbl|home\s*run|slam\s*dunk|goalkeep|free\s*throw|jump\s*shot|skateboard|surf|bat\b|quarterback|receiver|fieldgoal|field\s*goal|punt|touchdown|putting|scramble|hike)" + INF, "sports"),
    # ---- FITNESS / EXERCISE ----
    (r"\b(?:situp|sit-?up|crunch|push-?up|pushup|plank|jumping\s*jack|stretch|warm\s*up|workout|exercise|yoga|lunge|burpee)" + INF + r"|cycling\s*legs", "fitness"),
    # ---- CREATURE ----
    (r"\b(?:zombie|mutant|monster|creature|ape|gorilla|ghoul)s?\b", "creature"),
    # ---- EMOTES / GESTURES / EXPRESSIONS ----
    (r"\b(?:wav|cheer|clap|applaud|point|salut|thumbs?\s*up|nod|shak\w*\s*head|taunt|greet|hello|yawn|laugh|cry|angry|frustrat|talk|gestur|shrug|whatever|dismiss|beckon|come\s*here|threaten|insult|annoyed|happy|sad|excit|disappoint|bored|sigh|nervous|agree|disagree|think|idea|count|whisper|secret|wiggl|kiss|hug|wave|roar|yell|celebrat|pump\w*\s*fist|hokey\s*pokey|facepalm)" + INF, "emotes"),
    # ---- INTERACTION (props / the world) ----
    (r"\b(?:door|card|pet|pick\s*up|open|lever|switch|button|drive|steering|pour|cook|torch|deal|helicopter|pilot|object|lock|key|drink|eat|phone|text|typ)" + INF, "interaction"),
    # ---- MOVEMENT (special) ----
    (r"\b(?:climb|swim|crawl|vault|ledge|hang|mantle|push|pull|carry|drag|dive|roll|balanc|float|cartwheel|flip|handspring|somersault|acrobat)" + INF, "movement"),
    # ---- JUMP / FALL ----
    (r"\b(?:jump|leap|fall|land|airborne|hop)" + INF + r"|\bin\s*air\b", "jump"),
    # ---- SOCIAL / POSES ----
    (r"\b(?:sit|seated|kneel|lean|conversation|chat|rest|lying|lay\s*down|sleep|squat|pray|stand\s*up)" + INF, "social"),
    # ---- LOCOMOTION ----
    (r"\b(?:turn|rotate|pivot)" + INF + r"|\b180\b", "locomotion/turn"),
    (r"\b(?:crouch|sneak|stealth)" + INF, "locomotion/crouch"),
    (r"\b(?:run|jog|sprint)" + INF, "locomotion/run"),
    (r"\b(?:walk|strut|catwalk|march|strafe|step|stroll|tiptoe)" + INF, "locomotion/walk"),
    (r"\b(?:idle|breath|look|wait|stand|neutral)" + INF, "locomotion/idle"),
    # ---- STATIC POSES (reference / yoga / body-position clips) ----
    (r"\b(?:raised|supporting|reclin|arched|prone|hands?\s*behind\s*head|hand\s*on\s*hip|legs?\s*crossed|on\s+(?:right|left|one)\s+(?:foot|toe|toes|side|knee|leg|hand|arm))" + INF, "poses"),
    (r"\b(?:reach|grab|rummag|pick|examin|hold)" + INF, "interaction"),
]
COMPILED = [(re.compile(p, re.I), d) for p, d in RULES]


def classify(name):
    for rx, dest in COMPILED:
        if rx.search(name):
            return dest
    return "misc"


def key_of(name):
    return re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_")


TAXONOMY_DOC = """\
# Mixamo Animation Library

A shared, **character-agnostic** library of Mixamo animations as small, animation-only **GLB**
clips. Each clip is a skeleton + one action with the `mixamorig:` prefix STRIPPED from every bone
name and fcurve path, so it binds to the project's canonical plain-named Mixamo skeleton — meaning
**any** Mixamo-rigged character (players, NPCs, the nibbler swarm) can play any clip here with no
per-character re-export. GLBs are ~40–80 KB (vs ~200–500 KB for the FBX); the game ships GLB.

## How it was built
1. `scripts/mixamo_bulk_download.py` — bulk-download from your Mixamo account as FBX (no skin).
2. `scripts/extract_mixamo_anim_glb.py` — each FBX → a tiny anim-only GLB (plain bones, upright
   identity root), reusing the game's exact retarget technique (`scripts/convert_mixamo_fbx.py`).
   The original FBX are kept as the source archive.
3. `scripts/organize_mixamo_library.py` — sort into the hierarchy below.
`manifest.json` maps every clip → its Mixamo description, frame range, category, and source FBX.

## Why this hierarchy (organized by USE, not Mixamo's flat list)
Designers think "I need a punch and its reaction", "all the sword moves", "idle variations" — so
the folders mirror that.

- **locomotion/** — the core movement set, split so a state machine maps cleanly: `idle/ walk/
  run/ turn/ crouch/`.
- **jump/** — jumps, falls, landings (distinct transition states).
- **movement/** — traversal that isn't plain locomotion: climb, swim, crawl, vault, roll,
  cartwheel, push/pull/carry.
- **combat/**
  - **unarmed/attacks/** + **unarmed/reactions/** — kept as SIBLINGS on purpose: a punch and the
    reaction to being punched live one folder apart, so attacks pair with their hit reactions.
  - **death/** — deaths/collapses. **stealth/** — takedowns/assassinations/chokes.
  - **weapons/** — every weapon in **its own folder** (`sword/ rifle/ pistol/ bow/ knife/ blunt/
    spear/ shield/ throw/`) so a weapon's whole moveset stays together (no sword swing mixed with
    a rifle aim).
- **emotes/** — expressive gestures: wave, cheer, point, taunt, laugh, roar, celebrate.
- **social/** — sit/lean/kneel/rest/conversation (ambient life).
- **interaction/** — clips acting on a prop/the world: doors, pickups, levers, reach/grab.
- **dance/ music/ sports/ fitness/** — themed sets, isolated so they don't pollute core gameplay.
- **poses/** — static reference / body-position clips ("on one foot, arm raised").
- **creature/** — zombie/monster/ape motion.
- **misc/** — genuine oddballs the rules couldn't place (e.g. "Milking A Cow"). Kept rather than
  force-fit; review + move by hand if any belong elsewhere.

Classification is ordered keyword rules in `scripts/organize_mixamo_library.py` (first match wins;
combat/specific rules run before broad locomotion). Re-run it to reorganize after tuning the rules.

## Using a clip
The plain-bone skeleton retargets onto any character on the canonical rig (bone contract in
`scripts/convert_mixamo_fbx.py`). Feed chosen clips into the character motion build
(`build_dahilg_unity_assets.mjs` stages `anims/<state>.glb`). Use `manifest.json` to pick by
description + frame range.

## Contents
"""


def write_readme(dest, counts, total):
    lines = [TAXONOMY_DOC, f"\n**{total} clips** across {len(counts)} categories:\n"]
    for c in sorted(counts):
        lines.append(f"- `{c}/` — {counts[c]}")
    open(os.path.join(dest, "README.md"), "w").write("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--src", default="exports/mixamo_glb")
    ap.add_argument("--dest", default="mixamo-animation-library")
    ap.add_argument("--copy", action="store_true", help="copy instead of move")
    ap.add_argument("--map", default=os.path.join(ROOT, "scripts", "mixamo_categories.json"),
                    help="Claude-judged {name: category} map; preferred over the keyword rules")
    ap.add_argument("--names", default=os.path.join(ROOT, "scripts", "mixamo_anims.json"),
                    help="for --dry-run: classify the full catalog of names")
    args = ap.parse_args()

    if args.dry_run:
        names = list(json.load(open(args.names)).values())
        dist = {}
        misc = []
        for nm in names:
            c = classify(nm)
            dist[c] = dist.get(c, 0) + 1
            if c == "misc":
                misc.append(nm)
        print(f"=== distribution over {len(names)} catalog names ===")
        for c in sorted(dist, key=lambda k: -dist[k]):
            print(f"  {dist[c]:5d}  {c}")
        print(f"\nmisc sample ({len(misc)}): {misc[:25]}")
        return

    src = args.src if os.path.isabs(args.src) else os.path.join(ROOT, args.src)
    dest = args.dest if os.path.isabs(args.dest) else os.path.join(ROOT, args.dest)
    index = json.load(open(os.path.join(src, "index.json")))
    # Claude's per-clip categorization (judgment) is preferred; the keyword classify() is only a
    # fallback for the handful of names not in the map.
    themap = json.load(open(args.map)) if (args.map and os.path.exists(args.map)) else {}
    manifest = {}
    counts = {}
    n_map = n_rule = 0
    for key, meta in index.items():
        g = os.path.join(src, key + ".glb")
        if not os.path.exists(g):
            continue
        nm = meta.get("name", key)
        cat = themap.get(nm)
        if cat:
            n_map += 1
        else:
            cat = classify(nm); n_rule += 1
        outdir = os.path.join(dest, cat)
        os.makedirs(outdir, exist_ok=True)
        (shutil.copy2 if args.copy else shutil.move)(g, os.path.join(outdir, key + ".glb"))
        manifest[key] = {**meta, "category": cat, "path": f"{cat}/{key}.glb"}
        counts[cat] = counts.get(cat, 0) + 1
    json.dump(manifest, open(os.path.join(dest, "manifest.json"), "w"), indent=1)
    write_readme(dest, counts, len(manifest))
    print(f"organized {len(manifest)} clips into {len(counts)} categories "
          f"({n_map} by Claude map, {n_rule} by keyword fallback) -> {os.path.relpath(dest, ROOT)}")
    for c in sorted(counts, key=lambda k: -counts[k]):
        print(f"  {counts[c]:5d}  {c}")


if __name__ == "__main__":
    main()
