#!/usr/bin/env python3
"""Sample each building's REAL roof colour from the Google aerial mosaic (median of the
footprint's interior pixels) so roofs render in their true colour — terracotta, gray
shingle, brown, etc. — instead of a random palette.

Footprints (src/assets/scene.json buildings[].p) are flat-ENU; the mosaic
(exports/google_aerial.jpg) is georeferenced by exports/google_aerial.json bounds, the
same mapping the exporter uses. Output: exports/buildings_roof_color.json {index: [r,g,b]}
in LINEAR space (glTF vertex colours are linear).

  scripts/.venv/bin/python scripts/fetch_roof_colors.py
"""
import json, os
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _abs(p):
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


# Level inputs via env (shares the BCOL_* interface used by fetch_building_colors.py so the
# orchestrator can set one pair of vars per level); falls back to dahill at the repo root.
SCENE_PATH = _abs(os.environ.get("RCOL_SCENE") or os.environ.get("BCOL_SCENE") or "src/assets/scene.json")
OUT_DIR = _abs(os.environ.get("RCOL_OUT") or os.environ.get("BCOL_OUT") or "exports")
S = json.load(open(SCENE_PATH))
A = json.load(open(os.path.join(OUT_DIR, "google_aerial.json")))
img = Image.open(os.path.join(OUT_DIR, "google_aerial.jpg")).convert("RGB")
W, H = img.size
arr = np.asarray(img, dtype=np.float32)
E0, E1, Nt, Nb = A["E0"], A["E1"], A["Nt"], A["Nb"]


def to_px(e, n):
    return ((e - E0) / (E1 - E0) * W, (Nt - n) / (Nt - Nb) * H)


def srgb_to_lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


out = {}
for ib, b in enumerate(S["buildings"]):
    ring = b.get("p")
    if not ring or len(ring) < 3:
        continue
    pts = [to_px(e, n) for e, n in ring]
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    if max(xs) < 0 or min(xs) > W or max(ys) < 0 or min(ys) > H:
        continue                                        # footprint outside the mosaic
    # shrink toward centroid to avoid eaves/shadow edges, then rasterise the polygon
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    inner = [(cx + (x - cx) * 0.72, cy + (y - cy) * 0.72) for x, y in pts]
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).polygon(inner, fill=255)
    m = np.asarray(mask) > 0
    if m.sum() < 6:
        continue
    px = arr[m]                                         # [k,3] sRGB 0..255
    # robust: drop the darkest/brightest 15% (tree shadow / specular) then median
    lum = px @ np.array([0.299, 0.587, 0.114])
    lo, hi = np.percentile(lum, [15, 85])
    keep = px[(lum >= lo) & (lum <= hi)]
    med = np.median(keep if len(keep) else px, axis=0)
    lin = srgb_to_lin(med)
    out[str(ib)] = [round(float(v), 4) for v in lin]

_outp = os.path.join(OUT_DIR, "buildings_roof_color.json")
json.dump(out, open(_outp, "w"), separators=(",", ":"))
print(f"  sampled real roof colours for {len(out)} buildings -> {os.path.relpath(_outp, ROOT)}")
