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
N = 256                                   # px per 3 m tile

rng = np.random.default_rng(1840)
stucco = np.array([206, 197, 181], np.float32)
img = np.clip(stucco + rng.normal(0, 6, (N, N, 3)), 0, 255).astype(np.uint8)
im = Image.fromarray(img, "RGB")
d = ImageDraw.Draw(im)

# faint floor band at the tile seam (top/bottom) so storeys read when tiled
d.rectangle([0, 0, N - 1, 3], fill=(150, 142, 128))
d.rectangle([0, N - 4, N - 1, N - 1], fill=(150, 142, 128))

# one centered window (≈1.5 m wide x 1.7 m tall within the 3 m tile)
ww, wh = int(0.50 * N), int(0.56 * N)
x0, y0 = (N - ww) // 2, int(0.20 * N)
d.rectangle([x0 - 4, y0 - 4, x0 + ww + 4, y0 + wh + 4], fill=(120, 110, 96))   # frame
d.rectangle([x0, y0, x0 + ww, y0 + wh], fill=(70, 84, 99))                      # glass
d.line([x0 + ww // 2, y0, x0 + ww // 2, y0 + wh], fill=(120, 110, 96), width=3)  # mullion
d.line([x0, y0 + wh // 2, x0 + ww, y0 + wh // 2], fill=(120, 110, 96), width=3)
# subtle highlight on glass
d.rectangle([x0 + 4, y0 + 4, x0 + ww // 2 - 4, y0 + wh // 2 - 4], fill=(96, 110, 126))

out = os.path.join(ROOT, "exports", "facade.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
im.save(out)
print(f"  wrote {out} ({N}x{N})")
