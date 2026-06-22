#!/usr/bin/env python3
"""Vision-model QUALITY filter for Street View facade crops.

The fetch step is greedy: to maximise coverage it captures a crop for every road-facing
wall, but many crops are NOT a usable building facade — they're a street sign, utility
pole, parked car, tree/foliage, fence, sky, road, a privacy-blur, or a foreshortened
oblique smear. Baking those onto a wall looks terrible. The cheap pixel gates in
fetch_sv_facades.py (too-dark / too-green / too-flat) cannot tell a sign from a wall.

So this pass asks a VISION MODEL to grade each cached crop and KEEPS ONLY crisp,
roughly head-on building-wall crops. Everything else is dropped from the manifest and
falls back to the real-Street-View-coloured windowed-stucco wall (a clean procedural
wall beats a garbage photo). Crops are cached, so this re-reads them with no API
re-fetch and no Google Street View billing — only the (cheap) Gemini vision calls.

Env:
  FF_MANIFEST   sv_facades.json to filter (rewritten in place; .rejected.json sidecar written)
  FF_DIR        level dir that contains the sv_facades/ crops referenced by the manifest
  FF_MIN_QUALITY  keep threshold (default 0.6)
  FF_MODEL      Gemini model id (default gemini-2.0-flash)
  FF_WORKERS    parallel requests (default 12)
Key: GOOGLE_GENERATIVE_AI_API_KEY (env or .env.local).

Usage: FF_MANIFEST=exports/meemaw/sv_facades.json FF_DIR=exports/meemaw \
       scripts/.venv/bin/python scripts/filter_facades.py
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_key():
    if os.environ.get("OPENAI_API_KEY"):
        return os.environ["OPENAI_API_KEY"]
    env = os.path.join(ROOT, ".env.local")
    if os.path.exists(env):
        for line in open(env):
            if line.startswith("OPENAI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("set OPENAI_API_KEY in .env.local")


KEY = load_key()
# OpenAI vision grader. Default gpt-5-mini at reasoning_effort=low — an eval against hand-labelled
# crops showed that WITH THE STRICT PROMPT BELOW it rejects ALL the egregious junk (cars, street
# signs, trees, fences, blur) that gpt-4o-mini/4.1-mini let through, while keeping genuine walls.
# detail:low keeps each crop cheap. (Gemini free tier 429s on batch, so OpenAI.)
MODEL = os.environ.get("FF_MODEL", "gpt-5-mini")
MIN_Q = float(os.environ.get("FF_MIN_QUALITY", "0.6"))
WORKERS = int(os.environ.get("FF_WORKERS", "12"))
MANIFEST = os.environ.get("FF_MANIFEST") or sys.exit("set FF_MANIFEST")
DIR = os.environ.get("FF_DIR") or os.path.dirname(MANIFEST)

PROMPT = (
    "You are selecting Google Street View crops to BAKE as the front-wall texture of a building in "
    "a 3D game. Be STRICT: a bad bake looks terrible, so when in doubt REJECT. Respond ONLY with JSON "
    '{"is_facade": <bool>, "quality": <0..1>, "dominant": "<one of: building_wall, street_sign, '
    'utility_pole, vehicle, tree_foliage, fence_hedge, sky, road_ground, person, blur_privacy, '
    'mixed_clutter>"}. '
    "is_facade is TRUE only if ALL hold: (1) a building wall/facade (siding, stucco, brick, windows, "
    "door, or garage) FILLS most of the frame; (2) it is sharp and in focus; (3) it is viewed roughly "
    "head-on, not steeply angled. is_facade is FALSE if a car/truck, street sign, pole, tree/bush/hedge, "
    "fence, sky, lawn/road, or person occupies a prominent part of the frame, OR the building is "
    "distant/small, blurry, privacy-blurred, or strongly oblique. quality = how sharp, head-on, and "
    "wall-filling it is."
)


def classify(img_path):
    with open(img_path, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    body = {
        "model": MODEL,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{data}", "detail": "low"}},
        ]}],
    }
    # gpt-5* are reasoning models: they reject the default temperature and use reasoning_effort
    # (low = enough to judge a facade without burning tokens). Older chat models take temperature=0.
    if MODEL.startswith("gpt-5"):
        body["reasoning_effort"] = os.environ.get("FF_EFFORT", "low")
    else:
        body["temperature"] = 0
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions",
                                data=json.dumps(body).encode(),
                                headers={"Content-Type": "application/json",
                                         "Authorization": f"Bearer {KEY}"})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                resp = json.loads(r.read())
            return json.loads(resp["choices"][0]["message"]["content"])
        except Exception as e:  # transient 429/5xx/network — back off and retry
            last = e
            time.sleep(2.0 * (attempt + 1))
    raise last


def main():
    manifest = json.load(open(MANIFEST))
    walls = manifest.get("walls", [])
    if not walls:
        print(f"no walls in {MANIFEST}")
        return

    def grade(w):
        p = os.path.join(DIR, w["image"])
        try:
            return w, classify(p)
        except Exception as e:
            # On a hard error, KEEP the wall (a broken API must not erase every facade) but flag it.
            return w, {"is_facade": True, "quality": 0.6, "dominant": "error", "_err": str(e)[:120]}

    kept, rejected, errors = [], [], 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for w, v in ex.map(grade, walls):
            if v.get("dominant") == "error":
                errors += 1
            good = bool(v.get("is_facade")) and float(v.get("quality", 0)) >= MIN_Q
            if good:
                kept.append(w)
            else:
                rj = dict(w)
                rj["_grade"] = v
                rejected.append(rj)

    manifest["walls"] = kept
    manifest["count"] = len(kept)
    manifest["vision_filter"] = {"model": MODEL, "min_quality": MIN_Q,
                                 "kept": len(kept), "rejected": len(rejected), "errors": errors}
    json.dump(manifest, open(MANIFEST, "w"), indent=1)
    rj_path = MANIFEST.rsplit(".json", 1)[0] + ".rejected.json"
    json.dump(rejected, open(rj_path, "w"), indent=1)
    # rejection breakdown by dominant class
    by = {}
    for r in rejected:
        d = r["_grade"].get("dominant", "?")
        by[d] = by.get(d, 0) + 1
    print(f"  [{os.path.basename(DIR)}] facades kept {len(kept)}/{len(walls)} "
          f"(rejected {len(rejected)}; errors {errors}) -> {os.path.relpath(MANIFEST, ROOT)}")
    print(f"    rejected by: {json.dumps(by, sort_keys=True)}")


if __name__ == "__main__":
    main()
