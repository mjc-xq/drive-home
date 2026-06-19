#!/usr/bin/env python3
"""Guess each building's wall colour from Google Street View, so the generated
buildings carry real-ish facade tints instead of a flat stucco.

For every footprint in the patch: find the nearest Street View pano, shoot toward
the building, and take a robust median of the facade band (sky / roof / ground /
vegetation pixels rejected). Writes exports/buildings_color.json {index:[r,g,b]}.

Street View Static API bills per image (~$7/1000); the metadata probe is free.
Usage:  scripts/.venv/bin/python scripts/fetch_building_colors.py [radius_m]
"""
import io
import json
import math
import os
import sys

import numpy as np
import requests
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORTS = os.path.join(ROOT, "exports")
R = float(sys.argv[1]) if len(sys.argv) > 1 else 196.0
SCENE = json.load(open(os.path.join(ROOT, "src", "assets", "scene.json")))
C = SCENE["center"]
ORIGIN = SCENE.get("origin") or {}
LAT0 = float(ORIGIN.get("lat", geo.LAT0))
LON0 = float(ORIGIN.get("lon", geo.LON0))
COSLAT = math.cos(math.radians(LAT0))


def load_key():
    for line in open(os.path.join(ROOT, ".env.local")):
        if line.startswith("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("no NEXT_PUBLIC_GOOGLE_MAPS_API_KEY in .env.local")


KEY = load_key()
SV = "https://maps.googleapis.com/maps/api/streetview"
sess = requests.Session()


def bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x))) % 360


def facade_color(img):
    """Median RGB of facade-like pixels (drop sky / vegetation / very dark/bright)."""
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, w, _ = a.shape
    band = a[int(h * 0.30):int(h * 0.74), int(w * 0.22):int(w * 0.78)].reshape(-1, 3)
    r, g, b = band[:, 0], band[:, 1], band[:, 2]
    lum = band.mean(1)
    veg = (g > r + 8) & (g > b + 8)
    sky = (b > r + 12) & (b > 120)
    keep = ~veg & ~sky & (lum > 35) & (lum < 235)
    if keep.sum() < 80:
        return None
    med = np.median(band[keep], axis=0) / 255.0
    return [round(float(med[0]), 3), round(float(med[1]), 3), round(float(med[2]), 3)]


def main():
    colors, ok, miss = {}, 0, 0
    for ib, b in enumerate(SCENE["buildings"]):
        cx = sum(p[0] for p in b["p"]) / len(b["p"]); cy = sum(p[1] for p in b["p"]) / len(b["p"])
        if math.hypot(cx - C[0], cy - C[1]) > R:
            continue
        blat = LAT0 + cy / 110540.0; blon = LON0 + cx / (COSLAT * 111320.0)
        loc = f"{blat:.7f},{blon:.7f}"
        meta = sess.get(f"{SV}/metadata", params={"location": loc, "source": "outdoor", "key": KEY}, timeout=20).json()
        if meta.get("status") != "OK":
            miss += 1; continue
        plat, plon = meta["location"]["lat"], meta["location"]["lng"]
        head = bearing(plat, plon, blat, blon)
        r = sess.get(SV, params={"size": "440x320", "location": f"{plat:.7f},{plon:.7f}",
                                 "heading": f"{head:.0f}", "fov": "55", "pitch": "8",
                                 "source": "outdoor", "key": KEY}, timeout=30)
        if r.status_code != 200:
            miss += 1; continue
        col = facade_color(Image.open(io.BytesIO(r.content)))
        if col:
            colors[ib] = col; ok += 1
        else:
            miss += 1
    json.dump(colors, open(os.path.join(EXPORTS, "buildings_color.json"), "w"), separators=(",", ":"))
    print(f"  {ok} wall colours from Street View, {miss} skipped -> exports/buildings_color.json")


if __name__ == "__main__":
    main()
