#!/usr/bin/env python3
"""Detect DOOR / WINDOW / GARAGE openings in the vision-passed Street View facade crops, so the
exporter can emit real 3D opening geometry (recessed glass, door slab) at those positions instead
of a generic procedural window grid. This is the "place windows + doors in the mesh based on the
Street View" step (C3).

Runs AFTER filter_facades.py over the SAME manifest (only the kept, clean building-wall crops). For
each wall it asks a vision model for the openings as NORMALISED rects on the crop; because the crop
maps 1:1 onto the wall quad (U = wall left->right = x, V = eave(0)->ground(1) = y), those rects drop
straight onto the wall. Writes `openings` onto each wall in the manifest (in place).

Env: FF_MANIFEST, FF_DIR (same as filter_facades), FF_MODEL (default gpt-5-mini), FF_WORKERS,
     DFO_EFFORT (gpt-5 reasoning_effort, default low). Key: OPENAI_API_KEY.
"""
import base64
import json
import os
import sys
import time
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
MODEL = os.environ.get("FF_MODEL", "gpt-5-mini")
WORKERS = int(os.environ.get("FF_WORKERS", "8"))
MANIFEST = os.environ.get("FF_MANIFEST") or sys.exit("set FF_MANIFEST")
DIR = os.environ.get("FF_DIR") or os.path.dirname(MANIFEST)

PROMPT = (
    "This is a cropped, roughly head-on photo of a building's front wall (it fills the frame; U=0 is "
    "the wall's left edge, U=1 the right; V=0 the top/eave, V=1 the ground). Return ONLY JSON "
    '{"openings":[{"kind":"door"|"window"|"garage","x0":0..1,"y0":0..1,"x1":0..1,"y1":0..1}]} listing '
    "each CLEARLY-VISIBLE, well-bounded opening on the wall: windows, the front door, and garage "
    "doors. x0<x1, y0<y1 are the opening's normalised bounding box on THIS image. Only include "
    "openings you are confident about and that sit ON the wall plane (skip reflections, plants, cars, "
    "shadows, and anything not clearly a window/door). Empty list if none are clear."
)
VALID = {"door", "window", "garage"}


def detect(img_path):
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
    if MODEL.startswith("gpt-5"):
        body["reasoning_effort"] = os.environ.get("DFO_EFFORT", "low")
    else:
        body["temperature"] = 0
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                resp = json.loads(r.read())
            obj = json.loads(resp["choices"][0]["message"]["content"])
            return _clean(obj.get("openings", []))
        except Exception as e:
            last = e
            time.sleep(2.0 * (attempt + 1))
    return ("ERR", str(last)[:120])


def _clean(ops):
    out = []
    for o in ops or []:
        try:
            k = str(o.get("kind", "")).lower()
            if k not in VALID:
                k = "window"
            x0, y0, x1, y1 = float(o["x0"]), float(o["y0"]), float(o["x1"]), float(o["y1"])
        except Exception:
            continue
        x0, x1 = sorted((max(0.0, min(1.0, x0)), max(0.0, min(1.0, x1))))
        y0, y1 = sorted((max(0.0, min(1.0, y0)), max(0.0, min(1.0, y1))))
        if (x1 - x0) < 0.015 or (y1 - y0) < 0.02:   # too thin to be a real opening
            continue
        if (x1 - x0) > 0.97 and (y1 - y0) > 0.97:    # whole-frame "opening" is bogus
            continue
        out.append({"kind": k, "x0": round(x0, 4), "y0": round(y0, 4), "x1": round(x1, 4), "y1": round(y1, 4)})
    return out


def main():
    manifest = json.load(open(MANIFEST))
    walls = manifest.get("walls", [])
    if not walls:
        print(f"no walls in {MANIFEST}")
        return

    def work(w):
        return w, detect(os.path.join(DIR, w["image"]))

    n_open = 0
    errors = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for w, res in ex.map(work, walls):
            if isinstance(res, tuple) and res and res[0] == "ERR":
                errors += 1
                w["openings"] = []
                continue
            w["openings"] = res
            n_open += len(res)

    manifest["openings_model"] = {"model": MODEL, "errors": errors}
    json.dump(manifest, open(MANIFEST, "w"), indent=1)
    walls_with = sum(1 for w in walls if w.get("openings"))
    print(f"  [{os.path.basename(DIR)}] detected {n_open} openings across {walls_with}/{len(walls)} "
          f"facade walls (errors {errors}) -> {os.path.relpath(MANIFEST, ROOT)}")


if __name__ == "__main__":
    main()
