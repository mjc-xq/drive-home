#!/usr/bin/env python3
"""Vision-located facade extractor — STEP 2 (Gemini 2.5): locate the clean wall quad + wall color.

For each `*.prior.json` produced by proto_facade_fetch.py (which sits next to its wide raw frame
and prior-overlay), ask Gemini 2.5 to return the 4 pixel corners of the LARGEST clean, head-on
building-wall plane (excluding road/sidewalk/parking/cars/people/trees and the ROOF), OR reject
when the wall is occluded/oblique/void. In the SAME call it returns the wall's dominant flat
material color (hex) — so even rejected walls (procedural fallback) get an accurate per-wall tint.

Writes `b<ib>_e<i>.vision.json` next to each prior. Deterministic rectify happens in step 3.

Chosen over Claude-workflow vision because the production scale is ~3000 walls across levels:
a parallel HTTP script is far cheaper/faster/rerunnable. Same role the OpenAI/Gemini call plays
in filter_facades.py, but it LOCATES the wall in a wide frame instead of grading a tight crop.

Env:
  FF_DIR       dir of *.prior.json (default exports/xq/sv_wide)
  FF_MODEL     Gemini model id (default gemini-2.5-flash)
  FF_WORKERS   parallel requests (default 8 — conservative for rate limits)
  FF_ONLY      optional comma list of ids "233_1,109_2" to limit (validation runs)
  FF_OVERWRITE 1 to redo walls that already have a .vision.json (default skip = resumable)
Key: GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY) in env or .env.local. NEVER printed/committed.
"""
import base64
import glob
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.environ.get("FF_DIR") or os.path.join(ROOT, "exports", "xq", "sv_wide")
MODEL = os.environ.get("FF_MODEL", "gemini-2.5-flash")
WORKERS = int(os.environ.get("FF_WORKERS", "8"))
ONLY = set(x.strip() for x in os.environ.get("FF_ONLY", "").split(",") if x.strip())
OVERWRITE = os.environ.get("FF_OVERWRITE") == "1"


def load_key():
    for var in ("GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
        if os.environ.get(var):
            return os.environ[var]
    env = os.path.join(ROOT, ".env.local")
    if os.path.exists(env):
        for line in open(env):
            for var in ("GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"):
                if line.startswith(var + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("set GOOGLE_GENERATIVE_AI_API_KEY in .env.local")


PROVIDER = os.environ.get("FF_PROVIDER", "gemini")  # gemini | openai | claude


def load_openai_key():
    if os.environ.get("OPENAI_API_KEY"):
        return os.environ["OPENAI_API_KEY"]
    env = os.path.join(ROOT, ".env.local")
    if os.path.exists(env):
        for line in open(env):
            if line.startswith("OPENAI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("set OPENAI_API_KEY in .env.local")


if PROVIDER == "openai":
    KEY = load_openai_key()
    MODEL = os.environ.get("FF_MODEL", "gpt-5-mini")
else:
    KEY = load_key()
ENDPOINT = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"

PROMPT = (
    "You are a precise computer-vision annotator extracting a building's FACADE texture for a 3D game. "
    "Two images: image 1 is a Google Street View frame ({W}x{H} px); image 2 is the SAME frame with a MAGENTA "
    "quad that is a ROUGH geometric GUESS of where building wall {bid} is (corners labeled A_top, B_top, "
    "B_ground, A_ground). The wall is about {wallW} m wide and {wallH} m tall, from about {dist} m. The magenta "
    "quad pixels (A_top,B_top,B_ground,A_ground) are {prior}.\n\n"
    "CRITICAL: the magenta quad is ONLY a rough hint and is OFTEN WRONG - its TOP is frequently TOO LOW and cuts "
    "off upper stories, and its SIDES sometimes spill onto a NEIGHBORING building. Do NOT just copy it. Trust the "
    "ACTUAL building you see in the photo.\n\n"
    "Return STRICT JSON only (no prose, no markdown). Pixel coordinates are in the {W}x{H} image: "
    "x in [0,{W}] left-to-right, y in [0,{H}] top-to-bottom.\n\n"
    "TASK 1 - return [[TLx,TLy],[TRx,TRy],[BRx,BRy],[BLx,BLy]] = the 4 corners of the ENTIRE SIDE of THIS "
    "building - the COMPLETE facade as it appears in the photo:\n"
    "- TOP = the building's REAL ROOFLINE / parapet (the very top of the building, ABOVE EVERY story). If the "
    "magenta top sits mid-building, RAISE your top to the actual roof. Include ALL floors - a 2-story building "
    "means BOTH stories; a 6-story building all six.\n"
    "- BOTTOM = the building's GROUND-FLOOR BASE, where the wall meets the ground/sidewalk. Exclude the "
    "road/street/sidewalk/parking surface in FRONT and any parked car/foreground - look BEHIND a foreground car "
    "to the building's base; do NOT raise the bottom up into the building to dodge an occluder (we want the WHOLE "
    "wall, every story).\n"
    "- LEFT and RIGHT = the real vertical edges of THIS building ONLY. Do NOT extend onto an adjacent/neighbor "
    "building even if the magenta quad does.\n"
    "- Follow the building's TRUE PERSPECTIVE (corners are usually NOT an axis-aligned rectangle).\n"
    "Set reject=true with corners [] ONLY if no usable building face is present (the frame is essentially all "
    "road/parking/sky), it is a different building, or it is too blurry/steeply-oblique to use.\n\n"
    "TASK 2 - wall_color: the dominant FLAT WALL MATERIAL color as #RRGGBB hex (the painted/siding/brick/stucco "
    "color of the wall FACE), EXCLUDING windows, glass, doors, trim, signage, shadows, and any car/tree/road/sky. "
    "Give your best estimate even if you reject.\n\n"
    'JSON shape: {{"reject": <bool>, "reason": "<short>", "corners": [[x,y],[x,y],[x,y],[x,y]], '
    '"wall_color": "#RRGGBB", "occlusion": "<none|low|medium|high>", "confidence": <0..1>}}'
)


def classify(prior):
    W, H = prior.get("image_size", [640, 512])
    wide = os.path.join(DIR, prior["image"])
    overlay = os.path.join(DIR, f"b{prior['building']}_e{prior['edge']}.prior_overlay.jpg")
    imgs = [wide] + ([overlay] if os.path.exists(overlay) else [])
    prompt = PROMPT.format(
        W=W, H=H, bid=f"b{prior['building']} e{prior['edge']}",
        wallW=prior.get("wallW"), wallH=prior.get("wallH"), dist=prior.get("dist"),
        prior=prior.get("prior_quad_px"))
    b64 = [base64.b64encode(open(p, "rb").read()).decode() for p in imgs]

    if PROVIDER == "openai":
        content = [{"type": "text", "text": prompt}]
        for d in b64:
            content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{d}", "detail": "high"}})
        body = {"model": MODEL, "response_format": {"type": "json_object"},
                "messages": [{"role": "user", "content": content}]}
        if MODEL.startswith("gpt-5"):
            body["reasoning_effort"] = os.environ.get("FF_EFFORT", "medium")
        else:
            body["temperature"] = 0
        req = urllib.request.Request("https://api.openai.com/v1/chat/completions",
                                     data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"})
    else:
        parts = [{"text": prompt}]
        for d in b64:
            parts.append({"inline_data": {"mime_type": "image/jpeg", "data": d}})
        body = {"contents": [{"role": "user", "parts": parts}],
                "generationConfig": {"temperature": 0, "responseMimeType": "application/json"}}
        req = urllib.request.Request(ENDPOINT + "?key=" + KEY,
                                     data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    last = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                resp = json.loads(r.read())
            if PROVIDER == "openai":
                txt = resp["choices"][0]["message"]["content"]
            else:
                txt = resp["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(txt)
        except urllib.error.HTTPError as e:
            last = e
            # 429 (rate limit) / 5xx — back off; 4xx other = give up
            if e.code not in (429, 500, 502, 503, 504):
                break
            time.sleep(2.0 * (attempt + 1))
        except Exception as e:
            last = e
            time.sleep(2.0 * (attempt + 1))
    raise last


def main():
    priors = sorted(glob.glob(os.path.join(DIR, "*.prior.json")))
    if ONLY:
        priors = [p for p in priors if os.path.basename(p).replace(".prior.json", "").lstrip("b").replace("_e", "_") in ONLY]
    if not priors:
        sys.exit(f"no *.prior.json in {DIR}")

    def work(pp):
        prior = json.load(open(pp))
        out = os.path.join(DIR, f"b{prior['building']}_e{prior['edge']}.vision.json")
        if os.path.exists(out) and not OVERWRITE:
            return ("skip", prior["building"], prior["edge"])
        try:
            v = classify(prior)
        except Exception as e:
            v = {"reject": True, "reason": f"error:{type(e).__name__}", "corners": [], "wall_color": None,
                 "occlusion": "unknown", "confidence": 0.0, "_err": str(e)[:160]}
        rec = {"building": prior["building"], "edge": prior["edge"], "model": MODEL,
               "image": prior["image"], "image_size": prior.get("image_size", [640, 512]), **v}
        json.dump(rec, open(out, "w"), indent=1)
        return (("reject" if v.get("reject") else "keep"), prior["building"], prior["edge"])

    kept = rejected = errors = skipped = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for status, ib, ie in ex.map(work, priors):
            if status == "keep":
                kept += 1
            elif status == "reject":
                rejected += 1
            elif status == "skip":
                skipped += 1
    # error count = vision.jsons with _err
    for pp in priors:
        vp = pp.replace(".prior.json", ".vision.json")
        if os.path.exists(vp):
            try:
                if json.load(open(vp)).get("_err"):
                    errors += 1
            except Exception:
                pass
    print(f"[{os.path.basename(DIR)}] vision: kept {kept}, rejected {rejected} "
          f"(errors {errors}, skipped {skipped}) of {len(priors)} priors via {MODEL}")


if __name__ == "__main__":
    main()
