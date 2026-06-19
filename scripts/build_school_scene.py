#!/usr/bin/env python3
"""Build a scene.json for a Castro Valley school export.

This intentionally does not replace the Dahill scene by default. It writes the
same scene schema consumed by the existing GLB exporters, but centers the export
on a named school campus polygon from OSM.

Usage:
  scripts/.venv/bin/python scripts/build_school_scene.py canyon-middle-school /tmp/scene.json /tmp/parcels.json
  scripts/.venv/bin/python scripts/build_school_scene.py stanton-elementary /tmp/scene.json /tmp/parcels.json
"""
import hashlib
import json
import math
import os
import sys

import numpy as np
import requests
from shapely import affinity
from shapely.geometry import LineString, Point, Polygon, shape

LAT0 = 37.6835313
LON0 = -122.0686199
COSLAT = math.cos(math.radians(LAT0))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", "_cache")
os.makedirs(CACHE, exist_ok=True)

SCHOOLS = {
    "canyon-middle-school": {
        "name": "Canyon Middle School",
        "address": "19600 Cull Canyon Road, Castro Valley, CA 94552",
        "osm_way": 186603373,
        "patch_m": 720,
        "query_radius_m": 560,
    },
    "stanton-elementary": {
        "name": "Stanton Elementary School",
        "address": "2644 Somerset Avenue, Castro Valley, CA 94546",
        "osm_way": 349295674,
        "patch_m": 460,
        "query_radius_m": 370,
    },
}

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "school-scene-export/1.0 (local GLB pipeline)"
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def ll_to_en(lat, lon):
    return (lon - LON0) * COSLAT * 111320.0, (lat - LAT0) * 110540.0


def en_to_ll(e, n):
    return LAT0 + n / 110540.0, LON0 + e / (COSLAT * 111320.0)


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
                r = SESSION.post(endpoint, data={"data": query}, timeout=180)
                r.raise_for_status()
                data = r.json()
                with open(path, "w") as f:
                    json.dump(data, f)
                return data
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                print(f"  overpass attempt failed ({endpoint}): {exc}", file=sys.stderr)
    raise RuntimeError(f"all overpass endpoints failed: {last_err}")


def bbox_around(lat, lon, radius_m):
    dlat = radius_m / 110540.0
    dlon = radius_m / (COSLAT * 111320.0)
    return lat - dlat, lon - dlon, lat + dlat, lon + dlon


def fetch_school_polygon(osm_way):
    data = overpass(f"[out:json][timeout:60];way({osm_way});out tags geom;")
    ways = [el for el in data.get("elements", []) if el.get("type") == "way" and el.get("geometry")]
    if not ways:
        raise RuntimeError(f"OSM way {osm_way} did not return geometry")
    ll = [(g["lon"], g["lat"]) for g in ways[0]["geometry"]]
    if ll[0] != ll[-1]:
        ll.append(ll[0])
    poly_ll = Polygon(ll)
    ring_en = [ll_to_en(lat, lon) for lon, lat in ll]
    poly_en = Polygon(ring_en)
    if not poly_en.is_valid:
        poly_en = poly_en.buffer(0)
    return ways[0].get("tags", {}), poly_ll, poly_en


ROAD_KIND_MAP = {
    "secondary": "tertiary",
    "unclassified": "residential",
    "living_street": "residential",
    "residential": "residential",
    "tertiary": "tertiary",
    "service": "service",
}
ROAD_WIDTHS = {"residential": 7.5, "tertiary": 9.0, "service": 3.6}


def build_roads(center_lat, center_lon, radius_m):
    s, w, n, e = bbox_around(center_lat, center_lon, radius_m)
    query = (
        '[out:json][timeout:120];'
        f'way[highway~"^(residential|tertiary|secondary|unclassified|living_street|service)$"]'
        f'({s},{w},{n},{e});out tags geom;'
    )
    data = overpass(query)
    roads = []
    names = set()
    for el in data.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        kind = ROAD_KIND_MAP.get(tags.get("highway"))
        if kind is None:
            continue
        pts = [[round(v, 2) for v in ll_to_en(g["lat"], g["lon"])] for g in el["geometry"]]
        if len(pts) < 2:
            continue
        road = {"p": pts, "k": kind, "w": ROAD_WIDTHS[kind]}
        if kind == "service" and tags.get("service"):
            road["s"] = tags["service"]
        if tags.get("name"):
            road["n"] = tags["name"]
            names.add(tags["name"])
        roads.append(road)
    print(f"  roads: {len(roads)} ways; names: {', '.join(sorted(names)[:12])}")
    return roads


def build_creek(center_lat, center_lon, radius_m):
    s, w, n, e = bbox_around(center_lat, center_lon, radius_m)
    query = '[out:json][timeout:90];way[waterway]({},{},{},{});out tags geom;'.format(s, w, n, e)
    data = overpass(query)
    chains = []
    for el in data.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        pts = [ll_to_en(g["lat"], g["lon"]) for g in el["geometry"]]
        if len(pts) >= 2:
            line = LineString(pts)
            chains.append((line.length, pts, el.get("tags", {}).get("name", "Waterway")))
    if not chains:
        print("  creek: none mapped in patch")
        return None
    _length, pts, name = max(chains, key=lambda x: x[0])
    print(f"  creek: {name}, {len(pts)} pts")
    return {"p": [[round(x, 2), round(y, 2)] for x, y in pts], "n": name}


def parse_height(raw):
    if raw is None:
        return None
    try:
        return float(str(raw).replace("m", "").strip())
    except ValueError:
        return None


def osm_building_footprints(center_lat, center_lon, radius_m):
    s, w, n, e = bbox_around(center_lat, center_lon, radius_m)
    query = f'[out:json][timeout:150];way[building]({s},{w},{n},{e});out tags geom;'
    data = overpass(query)
    feats = []
    for el in data.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        ring = [(g["lon"], g["lat"]) for g in el["geometry"]]
        if len(ring) < 4:
            continue
        tags = el.get("tags", {})
        feats.append({
            "ring_ll": ring,
            "height": tags.get("height"),
            "levels": tags.get("building:levels"),
        })
    return feats


def build_buildings(center_lat, center_lon, radius_m, campus_poly):
    feats = osm_building_footprints(center_lat, center_lon, radius_m)
    buildings = []
    for feat in feats:
        ring_en = [ll_to_en(lat, lon) for lon, lat in feat["ring_ll"]]
        poly = Polygon(ring_en)
        if not poly.is_valid:
            poly = poly.buffer(0)
            if poly.geom_type == "MultiPolygon":
                poly = max(poly.geoms, key=lambda g: g.area)
        if poly.is_empty or poly.geom_type != "Polygon":
            continue
        poly = poly.simplify(0.25, preserve_topology=True)
        if poly.is_empty or poly.geom_type != "Polygon" or poly.area < 10.0:
            continue
        coords = list(poly.exterior.coords)
        if coords[0] == coords[-1]:
            coords = coords[:-1]
        buildings.append({
            "poly": Polygon(coords),
            "p": [[round(x, 2), round(y, 2)] for x, y in coords],
            "height_raw": parse_height(feat["height"]),
            "levels_raw": parse_height(feat["levels"]),
        })

    for idx, b in enumerate(buildings):
        if b["height_raw"] is not None:
            h = b["height_raw"]
        elif b["levels_raw"] is not None:
            h = b["levels_raw"] * 3.0
        else:
            h = 4.2 + ((idx * 37) % 16) / 10.0
        b["h"] = round(h, 1)

    campus_buildings = [
        (idx, b) for idx, b in enumerate(buildings)
        if campus_poly.intersects(b["poly"].centroid.buffer(0.1)) or campus_poly.intersects(b["poly"])
    ]
    if campus_buildings:
        house_idx = max(campus_buildings, key=lambda ib: ib[1]["poly"].area)[0]
    elif buildings:
        target = campus_poly.centroid
        house_idx = min(range(len(buildings)), key=lambda i: buildings[i]["poly"].centroid.distance(target))
    else:
        house_idx = None
    if house_idx is not None:
        print(
            f"  buildings: {len(buildings)} OSM footprints; primary idx={house_idx}, "
            f"campus buildings={len(campus_buildings)}"
        )
    else:
        print("  buildings: none found")
    return buildings, house_idx


def longest_edge_theta(poly):
    coords = list(poly.exterior.coords)
    best_len, best_ang = -1.0, 0.0
    for k in range(len(coords) - 1):
        (x1, y1), (x2, y2) = coords[k], coords[k + 1]
        length = math.hypot(x2 - x1, y2 - y1)
        if length > best_len:
            best_len = length
            best_ang = math.degrees(math.atan2(y2 - y1, x2 - x1))
    return best_ang % 90.0


def max_rectangle(grid):
    rows, cols = grid.shape
    heights = np.zeros(cols, dtype=int)
    best = (0, 0, 0, 0, 0)
    for r in range(rows):
        heights = np.where(grid[r], heights + 1, 0)
        stack = []
        for c in range(cols + 1):
            h = int(heights[c]) if c < cols else 0
            start = c
            while stack and stack[-1][1] >= h:
                idx, hh = stack.pop()
                area = hh * (c - idx)
                if area > best[0]:
                    best = (area, r - hh + 1, idx, hh, c - idx)
                start = idx
            stack.append((start, h))
    return best


def roof_rects(poly, theta):
    cell = 0.5
    cx0, cy0 = poly.centroid.x, poly.centroid.y
    rot = affinity.rotate(poly, -theta, origin=(cx0, cy0))
    minx, miny, maxx, maxy = rot.bounds
    nx = max(1, int(math.ceil((maxx - minx) / cell)))
    ny = max(1, int(math.ceil((maxy - miny) / cell)))
    xs = minx + (np.arange(nx) + 0.5) * cell
    ys = miny + (np.arange(ny) + 0.5) * cell
    gx, gy = np.meshgrid(xs, ys)
    import shapely as _sh
    inside = _sh.contains_xy(rot, gx.ravel(), gy.ravel()).reshape(ny, nx)

    rects = []
    claimed_cells = 0
    for _ in range(4):
        cells, top, left, rh, rw = max_rectangle(inside)
        if cells * cell * cell < 12.0:
            break
        inside[top:top + rh, left:left + rw] = False
        claimed_cells += cells
        rcx = minx + (left + rw / 2.0) * cell
        rcy = miny + (top + rh / 2.0) * cell
        ang = math.radians(theta)
        dx, dy = rcx - cx0, rcy - cy0
        ox = cx0 + dx * math.cos(ang) - dy * math.sin(ang)
        oy = cy0 + dx * math.sin(ang) + dy * math.cos(ang)
        rects.append([round(ox, 2), round(oy, 2),
                      round(rw * cell, 2), round(rh * cell, 2), round(theta, 1)])
    if rects and claimed_cells * cell * cell >= 0.55 * poly.area:
        return rects
    return None


def forced_obb_rect(poly):
    mrr = poly.minimum_rotated_rectangle
    theta = longest_edge_theta(mrr)
    c = mrr.centroid
    rot = affinity.rotate(mrr, -theta, origin=(c.x, c.y))
    minx, miny, maxx, maxy = rot.bounds
    return [[round(c.x, 2), round(c.y, 2),
             round(maxx - minx, 2), round(maxy - miny, 2), round(theta, 1)]]


def attach_roofs(buildings, primary_idx):
    gabled = 0
    flat = 0
    for idx, b in enumerate(buildings):
        poly = b["poly"]
        rects = None
        if 20.0 <= poly.area <= 1800.0:
            rects = roof_rects(poly, longest_edge_theta(poly))
        if idx == primary_idx and rects is None and poly.area <= 2600:
            rects = forced_obb_rect(poly)
        if rects:
            b["r"] = rects
            gabled += 1
        else:
            flat += 1
    print(f"  roof rects: gabled={gabled}, flat={flat}")


def campus_ring_world(poly, center):
    ring = []
    for e, n in list(poly.exterior.coords):
        ring.append([round(e - center[0], 2), round(-(n - center[1]), 2)])
    return ring


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in SCHOOLS:
        names = ", ".join(SCHOOLS)
        sys.exit(f"usage: build_school_scene.py <{names}> [scene_out] [parcels_out]")
    slug = sys.argv[1]
    scene_out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "src", "assets", "scene.json")
    parcels_out = sys.argv[3] if len(sys.argv) > 3 else None
    cfg = SCHOOLS[slug]

    print(f"== {cfg['name']} ==")
    tags, campus_ll, campus_en = fetch_school_polygon(cfg["osm_way"])
    center = [round(campus_en.centroid.x, 2), round(campus_en.centroid.y, 2)]
    center_lat, center_lon = en_to_ll(center[0], center[1])
    print(f"  address: {cfg['address']}")
    print(f"  campus area: {campus_en.area:.0f} m2; center {center_lat:.7f},{center_lon:.7f}")

    roads = build_roads(center_lat, center_lon, cfg["query_radius_m"])
    creek = build_creek(center_lat, center_lon, cfg["query_radius_m"])
    buildings, primary_idx = build_buildings(center_lat, center_lon, cfg["query_radius_m"], campus_en)
    if primary_idx is None:
        raise RuntimeError(f"no building footprint found for {cfg['name']}")
    attach_roofs(buildings, primary_idx)

    out_buildings = []
    for idx, b in enumerate(buildings):
        ob = {"p": b["p"], "h": b["h"]}
        if "r" in b:
            ob["r"] = b["r"]
        if idx == primary_idx:
            ob["house"] = True
            ob["label"] = cfg["name"]
        out_buildings.append(ob)

    patch = cfg["patch_m"]
    lat_s, lon_w = en_to_ll(center[0] - patch / 2, center[1] - patch / 2)
    lat_n, lon_e = en_to_ll(center[0] + patch / 2, center[1] + patch / 2)
    aerial = {
        "E0": round(center[0] - patch / 2, 2),
        "E1": round(center[0] + patch / 2, 2),
        "Nt": round(center[1] + patch / 2, 2),
        "Nb": round(center[1] - patch / 2, 2),
    }
    terrain = {"n": 0, "half": patch / 2, "h": []}
    scene = {
        "name": cfg["name"],
        "slug": slug,
        "address": cfg["address"],
        "center": center,
        "terrain": terrain,
        "aerial": aerial,
        "buildings": out_buildings,
        "roads": roads,
        "targetAreas": [{
            "name": cfg["name"],
            "source": f"OpenStreetMap way/{cfg['osm_way']}",
            "p": [[round(x, 2), round(y, 2)] for x, y in list(campus_en.exterior.coords)],
        }],
        "meta": {
            "kind": "school-region-export",
            "patch_m": patch,
            "centerLat": round(center_lat, 7),
            "centerLon": round(center_lon, 7),
            "bbox": [round(lat_s, 7), round(lon_w, 7), round(lat_n, 7), round(lon_e, 7)],
            "schoolTags": tags,
        },
    }
    if creek:
        scene["creek"] = creek

    os.makedirs(os.path.dirname(os.path.abspath(scene_out)), exist_ok=True)
    with open(scene_out, "w") as f:
        json.dump(scene, f, separators=(",", ":"))
    print(f"  wrote scene {scene_out} ({os.path.getsize(scene_out)/1024:.0f} KB)")

    if parcels_out:
        os.makedirs(os.path.dirname(os.path.abspath(parcels_out)), exist_ok=True)
        ring = campus_ring_world(campus_en, center)
        parcels = {
            "source": f"OpenStreetMap campus boundary for {cfg['name']}",
            "count": 1,
            "parcels": [{
                "apn": slug,
                "name": cfg["name"],
                "mine": True,
                "skipBuildings": False,
                "ring": ring,
            }],
        }
        with open(parcels_out, "w") as f:
            json.dump(parcels, f, separators=(",", ":"))
        print(f"  wrote campus outline {parcels_out}")


if __name__ == "__main__":
    main()
