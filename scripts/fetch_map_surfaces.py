#!/usr/bin/env python3
"""Fetch mapped driveway, parking, sidewalk, crossing, and kerb geometry.

The GLB exporters use this as the highest-priority source layer for paved
surfaces. OSM line features are preserved as source polylines, and service ways
also get simple buffered polygons so driveways are editable surfaces instead of
being implied by road ribbons.
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
OUT = os.path.join(ROOT, "exports", "map_surfaces_osm.json")
os.makedirs(CACHE, exist_ok=True)
os.makedirs(os.path.dirname(OUT), exist_ok=True)

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "fetch-map-surfaces/1.0 (local GLB export)"
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


def signed_area(ring):
    return sum(
        ring[i][0] * ring[(i + 1) % len(ring)][1]
        - ring[(i + 1) % len(ring)][0] * ring[i][1]
        for i in range(len(ring))
    ) / 2.0


def world_points(geom, center):
    pts = []
    for g in geom:
        e, n = ll_to_en(g["lat"], g["lon"])
        pts.append([round(e - center[0], 2), round(-(n - center[1]), 2)])
    return pts


def buffer_polyline(points, width):
    """Return a lightweight mitered polygon around an open polyline."""
    if len(points) < 2:
        return []
    left = []
    right = []
    half = width / 2.0
    for i, p in enumerate(points):
        normals = []
        for a_i, b_i in ((i - 1, i), (i, i + 1)):
            if a_i < 0 or b_i >= len(points):
                continue
            a = points[a_i]
            b = points[b_i]
            dx = b[0] - a[0]
            dz = b[1] - a[1]
            L = math.hypot(dx, dz)
            if L < 0.01:
                continue
            dx /= L
            dz /= L
            normals.append([-dz, dx])
        if not normals:
            continue
        nx = sum(n[0] for n in normals)
        nz = sum(n[1] for n in normals)
        L = math.hypot(nx, nz) or 1.0
        nx /= L
        nz /= L
        left.append([round(p[0] + nx * half, 2), round(p[1] + nz * half, 2)])
        right.append([round(p[0] - nx * half, 2), round(p[1] - nz * half, 2)])
    if len(left) < 2:
        return []
    ring = left + list(reversed(right))
    if signed_area(ring) < 0:
        ring.reverse()
    return ring


def feature_kind(tags):
    highway = tags.get("highway")
    service = tags.get("service")
    footway = tags.get("footway")
    if highway == "service" and service in {
        "driveway",
        "parking_aisle",
        "drive-through",
        "alley",
    }:
        return "driveway"
    if tags.get("amenity") == "parking" or tags.get("parking"):
        return "parking"
    if highway == "footway" and footway == "crossing":
        return "crossing"
    if highway == "footway" and footway == "sidewalk":
        return "sidewalk"
    if highway in {"path", "pedestrian", "steps"}:
        return "sidewalk"
    if tags.get("barrier") == "kerb":
        return "kerb"
    return None


def main():
    center = json.load(open(os.path.join(ROOT, "src/assets/scene.json")))["center"]
    s, w, n, e = bbox_around_origin(430)
    query = (
        "[out:json][timeout:120];"
        "("
        f'way["highway"="service"]["service"~"^(driveway|parking_aisle|drive-through|alley)$"]({s},{w},{n},{e});'
        f'way["amenity"="parking"]({s},{w},{n},{e});'
        f'relation["amenity"="parking"]({s},{w},{n},{e});'
        f'way["parking"]({s},{w},{n},{e});'
        f'way["highway"="footway"]["footway"~"^(sidewalk|crossing)$"]({s},{w},{n},{e});'
        f'way["highway"~"^(path|pedestrian|steps)$"]({s},{w},{n},{e});'
        f'way["barrier"="kerb"]({s},{w},{n},{e});'
        ");out tags geom;"
    )
    data = overpass(query)

    out = {
        "source": "OpenStreetMap Overpass mapped service, parking, sidewalk, crossing, and kerb features",
        "frame": "gltf-y-up; x=east, y=up, z=-north; house at origin",
        "driveways": [],
        "drivewayPolygons": [],
        "parkingAreas": [],
        "sidewalks": [],
        "crossings": [],
        "kerbs": [],
    }
    seen = set()
    for el in data.get("elements", []):
        if el.get("type") not in {"way", "relation"} or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        kind = feature_kind(tags)
        if not kind:
            continue
        pts = world_points(el["geometry"], center)
        if len(pts) < 2:
            continue
        key = (kind, tuple(tuple(p) for p in pts))
        if key in seen:
            continue
        seen.add(key)
        rec = {
            "id": el.get("id"),
            "kind": kind,
            "service": tags.get("service"),
            "surface": tags.get("surface"),
            "access": tags.get("access"),
            "p": pts,
        }
        closed = len(pts) >= 4 and math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < 0.5
        if kind == "driveway":
            width = 5.0 if tags.get("service") == "parking_aisle" else 3.6
            out["driveways"].append(rec)
            poly = pts[:-1] if closed else buffer_polyline(pts, width)
            if len(poly) >= 3:
                out["drivewayPolygons"].append({**rec, "width": width, "polygon": poly})
        elif kind == "parking":
            ring = pts[:-1] if closed else pts
            if len(ring) >= 3:
                if signed_area(ring) < 0:
                    ring = list(reversed(ring))
                out["parkingAreas"].append({**rec, "polygon": ring})
        elif kind == "sidewalk":
            out["sidewalks"].append(rec)
        elif kind == "crossing":
            out["crossings"].append(rec)
        elif kind == "kerb":
            out["kerbs"].append(rec)

    out["count"] = {k: len(v) for k, v in out.items() if isinstance(v, list)}
    with open(OUT, "w") as f:
        json.dump(out, f)
    print(
        "wrote {} (driveways {}, driveway polygons {}, parking {}, sidewalks {}, crossings {}, kerbs {})".format(
            OUT,
            len(out["driveways"]),
            len(out["drivewayPolygons"]),
            len(out["parkingAreas"]),
            len(out["sidewalks"]),
            len(out["crossings"]),
            len(out["kerbs"]),
        )
    )


if __name__ == "__main__":
    main()
