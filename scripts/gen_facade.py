#!/usr/bin/env python3
"""Generate a tileable stucco + window facade texture -> exports/facade.png.
One tile = 3 m x 3 m (matches TILE in export_property_glb.mjs), so walls get a
regular grid of windows ~one per storey. Tileable in both directions.

Usage:  scripts/.venv/bin/python scripts/gen_facade.py
"""
import os
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
N = 256                                   # px per 5 m tile (matches TILE=5 in the exporter)

rng = np.random.default_rng(1840)
stucco = np.array([206, 197, 181], np.float32)
img = np.clip(stucco + rng.normal(0, 6, (N, N, 3)), 0, 255).astype(np.uint8)
im = Image.fromarray(img, "RGB")
d = ImageDraw.Draw(im)

# faint floor band at the tile seam (top/bottom) so storeys read when tiled
d.rectangle([0, 0, N - 1, 3], fill=(150, 142, 128))
d.rectangle([0, N - 4, N - 1, N - 1], fill=(150, 142, 128))

# ONE window per 5 m tile (sparser than the old 3 m grid -> far fewer windows), placed
# OFF-CENTRE and a touch under square so the tiled wall reads less like a rigid grid.
def window(cx, ww, wh, y0):
    x0 = cx - ww // 2
    d.rectangle([x0 - 4, y0 - 4, x0 + ww + 4, y0 + wh + 4], fill=(120, 110, 96))   # frame
    d.rectangle([x0, y0, x0 + ww, y0 + wh], fill=(70, 84, 99))                      # glass
    d.line([x0 + ww // 2, y0, x0 + ww // 2, y0 + wh], fill=(120, 110, 96), width=3)  # mullion
    d.line([x0, y0 + wh // 2, x0 + ww, y0 + wh // 2], fill=(120, 110, 96), width=3)
    d.rectangle([x0 + 4, y0 + 4, x0 + ww // 2 - 4, y0 + wh // 2 - 4], fill=(96, 110, 126))

window(int(0.36 * N), int(0.26 * N), int(0.32 * N), int(0.24 * N))   # ~1.3 m wide x 1.6 m tall, left of centre

out = os.path.join(ROOT, "exports", "facade.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
im.save(out)
print(f"  wrote {out} ({N}x{N})")
