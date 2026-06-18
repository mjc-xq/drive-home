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
S = json.load(open(os.path.join(ROOT, "src/assets/scene.json")))
A = json.load(open(os.path.join(ROOT, "exports/google_aerial.json")))
img = Image.open(os.path.join(ROOT, "exports/google_aerial.jpg")).convert("RGB")
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

json.dump(out, open(os.path.join(ROOT, "exports/buildings_roof_color.json"), "w"), separators=(",", ":"))
print(f"  sampled real roof colours for {len(out)} buildings -> exports/buildings_roof_color.json")
