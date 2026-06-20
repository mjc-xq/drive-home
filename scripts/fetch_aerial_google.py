#!/usr/bin/env python3
"""Fetch a Google satellite mosaic (2D Map Tiles API) over the property and write
google_aerial.jpg + google_aerial.json (flat-ENU bounds matching the exporter's
aerial UV convention). Use Google because it's the imagery the owner verifies
against; the exporter prefers this over the Mapbox aerial_opt.jpg when present.

Place-aware: pass a place so the right scene origin is read and the output lands
in the right dir (the orchestrator swaps exports/<place>/google_aerial.* into the
root paths the exporter reads). Bounds math is unchanged — only the IMAGE and its
bounds json change; the footprint it describes is the same flat-ENU frame.

  place ∈ {dahill, canyon-middle-school, stanton-elementary}
    dahill  -> SCENE=src/assets/scene.json,  OUT=exports/
    other   -> SCENE=exports/<place>/scene.json, OUT=exports/<place>/

Usage:  scripts/.venv/bin/python scripts/fetch_aerial_google.py [place] [radius_m] [zoom]
"""
import io
import json
import math
import os
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", "_cache")
os.makedirs(CACHE, exist_ok=True)
from PIL import Image, ImageFilter
import numpy as np

PLACES = {"dahill", "canyon-middle-school", "stanton-elementary"}


def _arg(i):
    """Positional arg i (after the optional leading place arg has been stripped)."""
    return sys.argv[i] if len(sys.argv) > i else None


# --- place resolution (place arg is optional + position-agnostic vs numbers) ---
PLACE = "dahill"
rest = []
for a in sys.argv[1:]:
    if a in PLACES:
        PLACE = a
    else:
        rest.append(a)

if PLACE == "dahill":
    SCENE_PATH = os.path.join(ROOT, "src/assets/scene.json")
    OUT_DIR = os.path.join(ROOT, "exports")
else:
    SCENE_PATH = os.path.join(ROOT, "exports", PLACE, "scene.json")
    OUT_DIR = os.path.join(ROOT, "exports", PLACE)
os.makedirs(OUT_DIR, exist_ok=True)

SCENE = json.load(open(SCENE_PATH))
ORIGIN = SCENE.get("origin") or {}
# The whole pipeline shares ONE flat-ENU frame anchored at the Dahill geocode origin
# (scene.json carries no per-place origin; each place's `center` is an offset in THAT
# frame). Keep the same LAT0/LON0 so the computed lat/lon lands on the real place.
LAT0 = float(ORIGIN.get("lat", 37.6835313))
LON0 = float(ORIGIN.get("lon", -122.0686199))
COSLAT = math.cos(math.radians(LAT0))
HLAT = LAT0 + SCENE["center"][1] / 110540.0
HLON = LON0 + SCENE["center"][0] / (COSLAT * 111320.0)

# Default radius from the place's own aerial footprint (half the larger span, +10% pad)
_aerial = SCENE.get("aerial") or {}
if _aerial:
    _halfE = abs(_aerial["E1"] - _aerial["E0"]) / 2
    _halfN = abs(_aerial["Nt"] - _aerial["Nb"]) / 2
    _R_DEFAULT = max(_halfE, _halfN) * 1.04
else:
    _R_DEFAULT = 280.0

R = float(rest[0]) if len(rest) > 0 else _R_DEFAULT
Z = int(rest[1]) if len(rest) > 1 else 20  # was 19; z20 ~= 2x linear detail
MAXPX = 8192  # was 4096; z20 canyon ~7600px stays under the cap


def load_key():
    for line in open(os.path.join(ROOT, ".env.local")):
        if line.startswith("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("no NEXT_PUBLIC_GOOGLE_MAPS_API_KEY")


KEY = load_key()


def ll_to_tile(lat, lon, z):
    n = 2.0 ** z
    return (lon + 180.0) / 360.0 * n, (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n


def tile_to_ll(x, y, z):
    n = 2.0 ** z
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n)))), x / n * 360.0 - 180.0


def ll_to_en(lat, lon):
    return (lon - LON0) * COSLAT * 111320.0, (lat - LAT0) * 110540.0


def tone_correct(img):
    """Mirror fetch_aerial.py's proven tone pass: soft-knee highlights, adaptive
    gamma to a natural mean (~0.45 target), gentle saturation + mid-contrast, then
    an UnsharpMask. Prints before/after stats."""
    a = np.asarray(img, dtype=np.float32) / 255.0
    lum = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    before_mean = float(lum.mean() * 255)
    before_blown = float((lum >= 245 / 255).mean() * 100)

    # 1) soft-knee highlight compression above a rolloff point
    knee = 0.80
    over = np.clip(a - knee, 0, None)
    a = np.where(a > knee, knee + over / (1.0 + over / (1.0 - knee)), a)

    # 2) adaptive gamma toward a natural mean luminance (~0.45)
    m = float((a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)).mean())
    target = 0.45
    if m > 1e-3:
        gamma = float(np.clip(math.log(target) / math.log(m), 0.85, 1.7))
        a = np.power(a, gamma)
    else:
        gamma = 1.0

    # 3) gentle saturation + tiny contrast around mid
    g = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    a = g[..., None] + (a - g[..., None]) * 1.06
    a = np.clip(0.5 + (a - 0.5) * 1.06, 0, 1)

    out = Image.fromarray((a * 255).astype(np.uint8), "RGB")
    out = out.filter(ImageFilter.UnsharpMask(radius=1.4, percent=70, threshold=2))
    lum2 = np.asarray(out) @ np.array([0.299, 0.587, 0.114])
    print(f"  tone: mean {before_mean:.0f}->{lum2.mean():.0f}, "
          f"blown(>=245) {before_blown:.1f}%->{(lum2>=245).mean()*100:.1f}%, gamma {gamma:.2f}, +unsharp")
    return out


def main():
    sess = requests.post(f"https://tile.googleapis.com/v1/createSession?key={KEY}",
                         json={"mapType": "satellite", "language": "en-US", "region": "US"}, timeout=30)
    sess.raise_for_status()
    token = sess.json()["session"]
    mpt = 156543.03 * COSLAT / (2 ** Z) * 256          # metres per tile
    half = max(1, int(math.ceil(R / mpt)))
    xc, yc = (int(v) for v in ll_to_tile(HLAT, HLON, Z))
    x0, y0, span = xc - half, yc - half, 2 * half + 1
    print(f"== google aerial [{PLACE}] == z{Z}, {span}x{span} tiles (~{span*mpt:.0f} m) "
          f"R={R:.0f} around {HLAT:.6f},{HLON:.6f}")
    s = requests.Session()
    mosaic = Image.new("RGB", (span * 256, span * 256))
    for dy in range(span):
        for dx in range(span):
            tx, ty = x0 + dx, y0 + dy
            p = os.path.join(CACHE, f"gtile_{Z}_{tx}_{ty}.jpg")
            if os.path.exists(p) and os.path.getsize(p) > 0:
                t = Image.open(p).convert("RGB")
            else:
                r = s.get(f"https://tile.googleapis.com/v1/2dtiles/{Z}/{tx}/{ty}?session={token}&key={KEY}", timeout=30)
                r.raise_for_status(); open(p, "wb").write(r.content); t = Image.open(io.BytesIO(r.content)).convert("RGB")
            mosaic.paste(t, (dx * 256, dy * 256))
    lat_n, lon_w = tile_to_ll(x0, y0, Z)               # NW corner
    lat_s, lon_e = tile_to_ll(x0 + span, y0 + span, Z) # SE corner
    e0, nt = ll_to_en(lat_n, lon_w)
    e1, nb = ll_to_en(lat_s, lon_e)
    out = mosaic
    if max(out.size) > MAXPX:
        f = MAXPX / max(out.size); out = out.resize((int(out.width * f), int(out.height * f)), Image.LANCZOS)
    out = tone_correct(out)
    jpg_path = os.path.join(OUT_DIR, "google_aerial.jpg")
    json_path = os.path.join(OUT_DIR, "google_aerial.json")
    out.save(jpg_path, "JPEG", quality=90, optimize=True)
    json.dump({"E0": round(e0, 2), "E1": round(e1, 2), "Nt": round(nt, 2), "Nb": round(nb, 2),
               "source": f"Google satellite 2D Map Tiles z{Z}"},
              open(json_path, "w"))
    print(f"  bounds E[{e0:.0f},{e1:.0f}] N[{nb:.0f},{nt:.0f}]  {out.size[0]}x{out.size[1]}px "
          f"({os.path.getsize(jpg_path)//1024} KB) -> {os.path.relpath(jpg_path, ROOT)}")


if __name__ == "__main__":
    main()
