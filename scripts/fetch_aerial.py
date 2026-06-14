#!/usr/bin/env python3
"""Regenerate src/assets/aerial_opt.jpg from Mapbox Satellite (high-res, tone
corrected) WITHOUT touching scene.json. Replaces the old ESRI z18 q68 source
(overexposed / low-res / old).

Mapbox satellite is orthorectified (true-nadir), so it keeps roof-top + ground
UVs aligned with scene.aerial bounds — which we hold BYTE-IDENTICAL by covering
the exact same tile-aligned extent at one zoom deeper (z19 == 2x the z18 grid,
sharing every z18 tile edge). We never write scene.json.

Usage:  MAPBOX_TOKEN=... scripts/.venv/bin/python scripts/fetch_aerial.py
        (or it reads NEXT_PUBLIC_MAPBOX_TOKEN from .env.local)
"""
import io
import json
import math
import os
import sys

import numpy as np
import requests
from PIL import Image

LAT0 = 37.6835313
LON0 = -122.0686199
COSLAT = math.cos(math.radians(LAT0))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", "_cache")
ASSETS = os.path.join(ROOT, "src", "assets")
os.makedirs(CACHE, exist_ok=True)

Z18 = 18                # the original mosaic was a 7x7 z18 grid centred on origin
HALF18 = 3              # tiles each side of centre at z18  -> 7x7
ZOOM = 19              # one deeper -> 2x linear resolution, edges still aligned
AT2X = True            # 512px tiles -> supersample, then downscale
OUT_PX = 3072          # final square (was 1792); ~2x the old detail
JPEG_Q = 76


def load_token():
    tok = os.environ.get("MAPBOX_TOKEN")
    if tok:
        return tok
    env = os.path.join(ROOT, ".env.local")
    if os.path.exists(env):
        for line in open(env):
            if line.startswith("NEXT_PUBLIC_MAPBOX_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("set MAPBOX_TOKEN or NEXT_PUBLIC_MAPBOX_TOKEN in .env.local")


def ll_to_tile(lat, lon, z):
    n2 = 2.0 ** z
    x = (lon + 180.0) / 360.0 * n2
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n2
    return x, y


def tile_to_ll(x, y, z):
    n2 = 2.0 ** z
    lon = x / n2 * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n2))))
    return lat, lon


def ll_to_en(lat, lon):
    return (lon - LON0) * COSLAT * 111320.0, (lat - LAT0) * 110540.0


def fetch_tile(session, z, x, y, token):
    suffix = "@2x" if AT2X else ""
    name = f"mapbox_{z}_{x}_{y}{suffix}.jpg"
    path = os.path.join(CACHE, name)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return Image.open(path).convert("RGB")
    url = (f"https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}{suffix}.jpg90"
           f"?access_token={token}")
    for _ in range(3):
        try:
            r = session.get(url, timeout=30)
            r.raise_for_status()
            open(path, "wb").write(r.content)
            return Image.open(io.BytesIO(r.content)).convert("RGB")
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise RuntimeError(f"tile {z}/{x}/{y} failed: {last}")


def tone_correct(img):
    """Kill the overexposure: soft-knee the highlights, then adaptive gamma to a
    natural mean, with a gentle saturation lift. Prints before/after stats."""
    a = np.asarray(img, dtype=np.float32) / 255.0
    lum = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    before_mean = float(lum.mean() * 255)
    before_blown = float((lum >= 245 / 255).mean() * 100)

    # 1) soft-knee highlight compression above a rolloff point
    knee = 0.80
    over = np.clip(a - knee, 0, None)
    a = np.where(a > knee, knee + over / (1.0 + over / (1.0 - knee)), a)

    # 2) adaptive gamma to bring mean luminance toward ~0.42 (≈107/255)
    m = float((a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)).mean())
    target = 0.42
    if m > 1e-3:
        gamma = float(np.clip(math.log(target) / math.log(m), 0.85, 1.7))
        a = np.power(a, gamma)
    else:
        gamma = 1.0

    # 3) gentle saturation + tiny contrast around mid
    g = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    a = g[..., None] + (a - g[..., None]) * 1.10
    a = np.clip(0.5 + (a - 0.5) * 1.06, 0, 1)

    out = (a * 255).astype(np.uint8)
    lum2 = out @ np.array([0.299, 0.587, 0.114])
    print(f"  tone: mean {before_mean:.0f}->{lum2.mean():.0f}, "
          f"blown(>=245) {before_blown:.1f}%->{(lum2>=245).mean()*100:.1f}%, gamma {gamma:.2f}")
    return Image.fromarray(out, "RGB")


def main():
    token = load_token()
    session = requests.Session()
    session.headers["User-Agent"] = "fetch-aerial/1.0"

    xc18, yc18 = (int(v) for v in ll_to_tile(LAT0, LON0, Z18))
    # z18 mosaic spanned tile edges [xc18-3, xc18+4]; the identical extent at z19
    # is tiles [2*(xc18-3) .. 2*(xc18+4)-1] = 14 tiles, sharing every z18 edge.
    scale = 2 ** (ZOOM - Z18)
    x0 = (xc18 - HALF18) * scale
    y0 = (yc18 - HALF18) * scale
    span = (2 * HALF18 + 1) * scale  # 14 tiles
    tile_px = 512 if AT2X else 256
    mosaic = Image.new("RGB", (span * tile_px, span * tile_px))
    print(f"== aerial == Mapbox z{ZOOM}{'@2x' if AT2X else ''}, {span}x{span} tiles "
          f"({span*tile_px}px) from ({x0},{y0})")
    for dy in range(span):
        for dx in range(span):
            t = fetch_tile(session, ZOOM, x0 + dx, y0 + dy, token)
            if t.size != (tile_px, tile_px):
                t = t.resize((tile_px, tile_px), Image.LANCZOS)
            mosaic.paste(t, (dx * tile_px, dy * tile_px))

    # bounds from the tile-aligned extent — must equal the existing scene.json
    lat_n, lon_w = tile_to_ll(x0, y0, ZOOM)
    lat_s, lon_e = tile_to_ll(x0 + span, y0 + span, ZOOM)
    e0, nt = ll_to_en(lat_n, lon_w)
    e1, nb = ll_to_en(lat_s, lon_e)
    bounds = {"E0": round(e0, 2), "E1": round(e1, 2),
              "Nt": round(nt, 2), "Nb": round(nb, 2)}
    have = json.load(open(os.path.join(ASSETS, "scene.json")))["aerial"]
    print(f"  bounds {bounds}  (scene.json {have})")
    if bounds != have:
        sys.exit(f"FATAL: bounds drift {bounds} != {have} — would break UV mapping")

    mosaic = mosaic.resize((OUT_PX, OUT_PX), Image.LANCZOS)
    mosaic = tone_correct(mosaic)
    out = os.path.join(ASSETS, "aerial_opt.jpg")
    mosaic.save(out, "JPEG", quality=JPEG_Q, optimize=True, progressive=True)
    print(f"  saved {out} ({os.path.getsize(out)/1024:.0f} KB, {OUT_PX}x{OUT_PX}); "
          f"scene.json untouched")


if __name__ == "__main__":
    main()
