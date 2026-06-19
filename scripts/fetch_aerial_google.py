#!/usr/bin/env python3
"""Fetch a Google satellite mosaic (2D Map Tiles API) over the property and write
exports/google_aerial.jpg + exports/google_aerial.json (flat-ENU bounds matching
the exporter's aerial UV convention). Use Google because it's the imagery the owner
verifies against; the exporter prefers this over the Mapbox aerial_opt.jpg when present.

Usage:  scripts/.venv/bin/python scripts/fetch_aerial_google.py [radius_m] [zoom]
"""
import io
import json
import math
import os
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", "_cache")
EXPORTS = os.path.join(ROOT, "exports")
os.makedirs(CACHE, exist_ok=True); os.makedirs(EXPORTS, exist_ok=True)
from PIL import Image

SCENE = json.load(open(os.path.join(ROOT, "src/assets/scene.json")))
ORIGIN = SCENE.get("origin") or {}
LAT0 = float(ORIGIN.get("lat", 37.6835313))
LON0 = float(ORIGIN.get("lon", -122.0686199))
COSLAT = math.cos(math.radians(LAT0))
HLAT = LAT0 + SCENE["center"][1] / 110540.0
HLON = LON0 + SCENE["center"][0] / (COSLAT * 111320.0)
R = float(sys.argv[1]) if len(sys.argv) > 1 else 230.0
Z = int(sys.argv[2]) if len(sys.argv) > 2 else 19


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


def main():
    sess = requests.post(f"https://tile.googleapis.com/v1/createSession?key={KEY}",
                         json={"mapType": "satellite", "language": "en-US", "region": "US"}, timeout=30)
    sess.raise_for_status()
    token = sess.json()["session"]
    mpt = 156543.03 * COSLAT / (2 ** Z) * 256          # metres per tile
    half = max(1, int(math.ceil(R / mpt)))
    xc, yc = (int(v) for v in ll_to_tile(HLAT, HLON, Z))
    x0, y0, span = xc - half, yc - half, 2 * half + 1
    print(f"== google aerial == z{Z}, {span}x{span} tiles (~{span*mpt:.0f} m) around 1840 Dahill Ln")
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
    if max(out.size) > 4096:
        f = 4096 / max(out.size); out = out.resize((int(out.width * f), int(out.height * f)), Image.LANCZOS)
    out.save(os.path.join(EXPORTS, "google_aerial.jpg"), "JPEG", quality=85, optimize=True)
    json.dump({"E0": round(e0, 2), "E1": round(e1, 2), "Nt": round(nt, 2), "Nb": round(nb, 2),
               "source": f"Google satellite 2D Map Tiles z{Z}"},
              open(os.path.join(EXPORTS, "google_aerial.json"), "w"))
    print(f"  bounds E[{e0:.0f},{e1:.0f}] N[{nb:.0f},{nt:.0f}]  {out.size[0]}x{out.size[1]}px "
          f"({os.path.getsize(os.path.join(EXPORTS,'google_aerial.jpg'))//1024} KB)")


if __name__ == "__main__":
    main()
