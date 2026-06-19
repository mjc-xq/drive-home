#!/usr/bin/env python3
"""Fetch mapped service driveways/parking aisles around 1840 Dahill Lane.

Writes exports/driveways_osm.json in the exporters' world X/Z frame. This is kept
separate from scene.json because the historic scene builder intentionally skipped
private driveways; the GLB export needs them as pavement context, not as streets.
"""
import hashlib
import json
import math
import os
import sys

import requests

LAT0 = 37.6835313
LON0 = -122.0686199
COSLAT = math.cos(math.radians(LAT0))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", "_cache")
OUT = os.path.join(ROOT, "exports", "driveways_osm.json")
os.makedirs(CACHE, exist_ok=True)
os.makedirs(os.path.dirname(OUT), exist_ok=True)

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "fetch-driveways/1.0 (local GLB export)"
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def ll_to_en(lat, lon):
    return (lon - LON0) * COSLAT * 111320.0, (lat - LAT0) * 110540.0


def bbox_around_origin(radius_m):
    dlat = radius_m / 110540.0
    dlon = radius_m / (COSLAT * 111320.0)
    return LAT0 - dlat, LON0 - dlon, LAT0 + dlat, LON0 + dlon


def overpass(query):
    key = hashlib.md5(query.encode()).hexdigest()
    path = os.path.join(CACHE, f"overpass_{key}.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    last_err = None
    for endpoint in OVERPASS_ENDPOINTS:
        for _attempt in range(2):
            try:
                r = SESSION.post(endpoint, data={"data": query}, timeout=120)
                r.raise_for_status()
                data = r.json()
                with open(path, "w") as f:
                    json.dump(data, f)
                return data
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                print(f"overpass attempt failed ({endpoint}): {exc}", file=sys.stderr)
    raise RuntimeError(f"all overpass endpoints failed: {last_err}")


def main():
    center = json.load(open(os.path.join(ROOT, "src/assets/scene.json")))["center"]
    s, w, n, e = bbox_around_origin(420)
    query = (
        "[out:json][timeout:90];"
        "("
        f'way["highway"="service"]["service"~"^(driveway|parking_aisle|drive-through|alley)$"]({s},{w},{n},{e});'
        ");out tags geom;"
    )
    data = overpass(query)
    driveways = []
    seen = set()
    for el in data.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        service = tags.get("service", "service")
        pts = []
        for g in el["geometry"]:
            en = ll_to_en(g["lat"], g["lon"])
            x = en[0] - center[0]
            z = -(en[1] - center[1])
            pts.append([round(x, 2), round(z, 2)])
        if len(pts) < 2:
            continue
        key = tuple(tuple(p) for p in pts)
        if key in seen:
            continue
        seen.add(key)
        driveways.append({
            "id": el.get("id"),
            "service": service,
            "surface": tags.get("surface"),
            "access": tags.get("access"),
            "p": pts,
        })

    with open(OUT, "w") as f:
        json.dump({
            "source": "OpenStreetMap Overpass highway=service service=driveway|parking_aisle|drive-through|alley",
            "frame": "gltf-y-up; x=east, y=up, z=-north; house at origin",
            "count": len(driveways),
            "driveways": driveways,
        }, f)
    print(f"wrote {OUT} ({len(driveways)} mapped service/driveway ways)")


if __name__ == "__main__":
    main()
