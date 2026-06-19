#!/usr/bin/env python3
"""Build scene.json for an arbitrary address or lat/lon place export.

This is the generic version of build_school_scene.py. It keeps the same scene
schema used by the existing neighborhood exporters, but writes a per-scene local
origin so exports can work outside Alameda County without inheriting the Dahill
lat/lon scale.

Examples:
  scripts/.venv/bin/python scripts/build_place_scene.py \
    --address "1 Ferry Building, San Francisco, CA" \
    --slug ferry-building --patch 420 \
    --scene-out src/assets/scene.json --parcels-out exports/parcels.json

  scripts/.venv/bin/python scripts/build_place_scene.py \
    --lat 37.7057868 --lon -122.0510441 --name "Canyon Middle School" \
    --slug canyon-middle-school --patch 720
"""
import argparse
import json
import math
import os
import re
import sys

import requests
from shapely.geometry import Point, Polygon, shape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_school_scene as scene_tools

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def slugify(value):
    value = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return value or "place-export"


def configure_origin(lat, lon):
    scene_tools.LAT0 = float(lat)
    scene_tools.LON0 = float(lon)
    scene_tools.COSLAT = math.cos(math.radians(scene_tools.LAT0))


def geocode(address):
    r = requests.get(
        "https://nominatim.openstreetmap.org/search",
        params={"q": address, "format": "json", "limit": 1, "polygon_geojson": 1},
        headers={"User-Agent": "place-scene-export/1.0 (local GLB pipeline)"},
        timeout=45,
    )
    r.raise_for_status()
    data = r.json()
    if not data:
        raise RuntimeError(f"no geocode result for address: {address}")
    return data[0]


def polygon_ll_to_en(poly_ll):
    if poly_ll.geom_type == "MultiPolygon":
        poly_ll = max(poly_ll.geoms, key=lambda p: p.area)
    if poly_ll.geom_type != "Polygon":
        raise ValueError(f"expected Polygon/MultiPolygon, got {poly_ll.geom_type}")
    ring = [scene_tools.ll_to_en(lat, lon) for lon, lat in poly_ll.exterior.coords]
    poly = Polygon(ring)
    if not poly.is_valid:
        poly = poly.buffer(0)
    return poly


def point_target_poly(lat, lon, radius_m):
    e, n = scene_tools.ll_to_en(lat, lon)
    return Point(e, n).buffer(radius_m, resolution=16)


def default_query_radius(patch_m):
    return min(max(patch_m * 0.65, 220.0), 500.0)


def make_target(args):
    geocoded = None
    if args.address:
        geocoded = geocode(args.address)
        lat = float(geocoded["lat"])
        lon = float(geocoded["lon"])
        name = args.name or geocoded.get("name") or args.address
    else:
        lat = float(args.lat)
        lon = float(args.lon)
        name = args.name or f"{lat:.6f},{lon:.6f}"

    configure_origin(lat, lon)

    poly_en = None
    source = "point buffer"
    if args.osm_way:
        tags, _poly_ll, poly_en = scene_tools.fetch_school_polygon(int(args.osm_way))
        source = f"OpenStreetMap way/{args.osm_way}"
        name = args.name or tags.get("name") or name
    elif geocoded and geocoded.get("geojson") and geocoded["geojson"].get("type") in {"Polygon", "MultiPolygon"}:
        try:
            poly_en = polygon_ll_to_en(shape(geocoded["geojson"]))
            source = f"Nominatim {geocoded.get('osm_type')}/{geocoded.get('osm_id')}"
        except Exception as exc:  # noqa: BLE001
            print(f"  warning: could not use geocode polygon ({exc}); using point buffer")

    if poly_en is None:
        poly_en = point_target_poly(lat, lon, args.target_radius)

    if poly_en.geom_type == "MultiPolygon":
        poly_en = max(poly_en.geoms, key=lambda p: p.area)
    if poly_en.is_empty or poly_en.geom_type != "Polygon":
        raise RuntimeError("target area is empty after geocoding")

    return {
        "lat": lat,
        "lon": lon,
        "name": name,
        "address": args.address,
        "poly": poly_en,
        "source": source,
        "geocode": geocoded,
    }


def main():
    parser = argparse.ArgumentParser(description="Build a generic place scene for the GLB export pipeline.")
    loc = parser.add_mutually_exclusive_group(required=True)
    loc.add_argument("--address")
    loc.add_argument("--lat", type=float)
    parser.add_argument("--lon", type=float)
    parser.add_argument("--name")
    parser.add_argument("--slug")
    parser.add_argument("--osm-way", type=int, help="Optional OSM way id to use as the target outline.")
    parser.add_argument("--patch", type=float, default=500.0, help="DEM/export square side in meters.")
    parser.add_argument("--query-radius", type=float, help="OSM query radius in meters; defaults to a bounded patch-based radius.")
    parser.add_argument("--target-radius", type=float, default=35.0, help="Fallback point-outline radius in meters.")
    parser.add_argument("--scene-out", default=os.path.join(ROOT, "src", "assets", "scene.json"))
    parser.add_argument("--parcels-out")
    args = parser.parse_args()

    if args.lat is not None and args.lon is None:
        parser.error("--lon is required with --lat")

    target = make_target(args)
    patch = float(args.patch)
    query_radius = float(args.query_radius or default_query_radius(patch))
    slug = args.slug or slugify(target["name"])
    center = [round(target["poly"].centroid.x, 2), round(target["poly"].centroid.y, 2)]
    center_lat, center_lon = scene_tools.en_to_ll(center[0], center[1])

    print(f"== {target['name']} ==")
    if target["address"]:
        print(f"  address: {target['address']}")
    print(f"  origin: {target['lat']:.7f},{target['lon']:.7f}")
    print(f"  target source: {target['source']}; area={target['poly'].area:.0f} m2")
    print(f"  center: {center_lat:.7f},{center_lon:.7f}; patch={patch:.0f} m")

    roads = scene_tools.build_roads(center_lat, center_lon, query_radius)
    creek = scene_tools.build_creek(center_lat, center_lon, query_radius)
    buildings, primary_idx = scene_tools.build_buildings(center_lat, center_lon, query_radius, target["poly"])
    if primary_idx is not None:
        scene_tools.attach_roofs(buildings, primary_idx)

    out_buildings = []
    for idx, b in enumerate(buildings):
        ob = {"p": b["p"], "h": b["h"]}
        if "r" in b:
            ob["r"] = b["r"]
        if idx == primary_idx:
            ob["house"] = True
            ob["label"] = target["name"]
        out_buildings.append(ob)

    aerial = {
        "E0": round(center[0] - patch / 2, 2),
        "E1": round(center[0] + patch / 2, 2),
        "Nt": round(center[1] + patch / 2, 2),
        "Nb": round(center[1] - patch / 2, 2),
    }
    scene = {
        "name": target["name"],
        "slug": slug,
        "address": target["address"],
        "origin": {"lat": round(target["lat"], 8), "lon": round(target["lon"], 8)},
        "center": center,
        "terrain": {"n": 0, "half": patch / 2, "h": []},
        "aerial": aerial,
        "buildings": out_buildings,
        "roads": roads,
        "targetAreas": [{
            "name": target["name"],
            "source": target["source"],
            "p": [[round(x, 2), round(y, 2)] for x, y in list(target["poly"].exterior.coords)],
        }],
        "meta": {
            "kind": "generic-place-export",
            "patch_m": patch,
            "query_radius_m": query_radius,
            "centerLat": round(center_lat, 7),
            "centerLon": round(center_lon, 7),
        },
    }
    if creek:
        scene["creek"] = creek

    os.makedirs(os.path.dirname(os.path.abspath(args.scene_out)), exist_ok=True)
    with open(args.scene_out, "w") as f:
        json.dump(scene, f, separators=(",", ":"))
    print(f"  wrote scene {args.scene_out} ({os.path.getsize(args.scene_out)/1024:.0f} KB)")

    if args.parcels_out:
        parcels = {
            "source": f"{target['source']} target outline for {target['name']}",
            "count": 1,
            "parcels": [{
                "apn": slug,
                "name": target["name"],
                "mine": True,
                "skipBuildings": False,
                "ring": scene_tools.campus_ring_world(target["poly"], center),
            }],
        }
        os.makedirs(os.path.dirname(os.path.abspath(args.parcels_out)), exist_ok=True)
        with open(args.parcels_out, "w") as f:
            json.dump(parcels, f, separators=(",", ":"))
        print(f"  wrote target outline {args.parcels_out}")


if __name__ == "__main__":
    main()
