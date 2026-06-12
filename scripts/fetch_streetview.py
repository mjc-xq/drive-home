#!/usr/bin/env python3
"""Fetch Google Street View photos for the drive level's 6 ring streets.

Mirrors the ring selection in src/engine/engine.js exactly: the 6 longest
named residential/tertiary roads, photo taken at the road's midpoint vertex
looking along the street. Writes src/assets/streetview/sv_<slug>.jpg plus a
manifest.json the engine joins against by street name. Re-run any time; the
engine shows billboards only for streets present in the manifest.

Usage:  GOOGLE_MAPS_API_KEY=... python3 scripts/fetch_streetview.py
(Static Street View API; the metadata probe is free, images bill per fetch.)
"""

import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request

LAT0 = 37.6835313
LON0 = -122.0686199
COSLAT = math.cos(math.radians(LAT0))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src", "assets", "streetview")

KEY = os.environ.get("GOOGLE_MAPS_API_KEY")
if not KEY:
    sys.exit("set GOOGLE_MAPS_API_KEY (never hardcode it in the repo)")


def en_to_ll(e, n):
    return LAT0 + n / 110540.0, LON0 + e / (COSLAT * 111320.0)


def ring_streets(scene):
    """Same selection as engine.js: 6 longest named residential/tertiary."""
    by_name = {}
    for r in scene["roads"]:
        if not r.get("n") or r["k"] not in ("residential", "tertiary"):
            continue
        pts = r["p"]
        length = sum(
            math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])
        )
        if r["n"] not in by_name or by_name[r["n"]][0] < length:
            by_name[r["n"]] = (length, r)
    names = sorted(by_name, key=lambda n: -by_name[n][0])[:6]
    out = []
    for n in names:
        pts = by_name[n][1]["p"]
        mid = len(pts) // 2
        m = pts[mid]
        a = pts[max(0, mid - 1)]
        b = pts[min(len(pts) - 1, mid + 1)]
        heading = math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) % 360
        out.append((n, m, heading))
    return out


def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read()


def main():
    scene = json.load(open(os.path.join(ROOT, "src", "assets", "scene.json")))
    os.makedirs(OUT, exist_ok=True)
    manifest = {}
    for name, (e, n), heading in ring_streets(scene):
        lat, lon = en_to_ll(e, n)
        loc = f"{lat:.7f},{lon:.7f}"
        meta_url = (
            "https://maps.googleapis.com/maps/api/streetview/metadata?"
            + urllib.parse.urlencode(
                {"location": loc, "source": "outdoor", "key": KEY}
            )
        )
        meta = json.loads(fetch(meta_url))
        if meta.get("status") != "OK":
            print(f"skip {name}: {meta.get('status')}")
            continue
        img_url = (
            "https://maps.googleapis.com/maps/api/streetview?"
            + urllib.parse.urlencode(
                {
                    "size": "640x400",
                    "location": loc,
                    "heading": f"{heading:.0f}",
                    "fov": "75",
                    "pitch": "0",
                    "source": "outdoor",
                    "key": KEY,
                }
            )
        )
        slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
        fname = f"sv_{slug}.jpg"
        data = fetch(img_url)
        open(os.path.join(OUT, fname), "wb").write(data)
        manifest[name] = {
            "file": fname,
            "heading": round(heading),
            "date": meta.get("date", ""),
            "copyright": meta.get("copyright", "© Google"),
        }
        print(f"ok   {name}: {fname} ({len(data)//1024} KB, pano {meta.get('date','?')})")
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"wrote manifest with {len(manifest)} streets")


if __name__ == "__main__":
    main()
