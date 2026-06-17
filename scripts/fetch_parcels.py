#!/usr/bin/env python3
"""Convert the Alameda County parcel GeoJSON (exports/parcels_raw.json, pulled from
the county's hosted ArcGIS layer) into exports/parcels.json in the GLB world frame.

Parcel boundaries are the real lot lines that fences typically run along (actual
fence geometry isn't in any public dataset). Flags the owner's two lots:
  416-120-67  house lot, and  416-120-68  back lot the creek runs through.

Writes exports/parcels.json: {parcels: [{apn, mine, ring: [[worldX, worldZ], ...]}]}
Usage:  scripts/.venv/bin/python scripts/fetch_parcels.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo  # curvature-correct ENU shared with the exporter / app

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORTS = os.path.join(ROOT, "exports")
DEM = json.load(open(os.path.join(EXPORTS, "dem_1m.json")))
HALF = (DEM["latN"] - DEM["latS"]) * 110540.0 / 2.0
MINE = {"416-120-67", "416-120-68"}


def to_world(lon, lat):
    x, z = geo.to_world(lat, lon)   # curvature-correct (E, -N), house at origin
    return [round(float(x), 2), round(float(z), 2)]


def rings_of(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"][0]]
    if geom["type"] == "MultiPolygon":
        return [poly[0] for poly in geom["coordinates"]]
    return []


def main():
    gj = json.load(open(os.path.join(EXPORTS, "parcels_raw.json")))
    out = []
    for f in gj["features"]:
        apn = (f["properties"].get("APN") or "").strip()
        for ll in rings_of(f["geometry"]):
            ring = [to_world(x, y) for x, y in ll]
            if not any(abs(x) <= HALF + 10 and abs(z) <= HALF + 10 for x, z in ring):
                continue
            out.append({"apn": apn, "mine": apn in MINE, "ring": ring})
    mine = [p for p in out if p["mine"]]
    res = {"source": "Alameda County Assessor parcels (lot lines; fences run along these)",
           "mine_apns": sorted(MINE), "count": len(out), "trees": None, "parcels": out}
    json.dump(res, open(os.path.join(EXPORTS, "parcels.json"), "w"), separators=(",", ":"))
    print(f"  {len(out)} parcels in patch, {len(mine)} flagged as yours "
          f"({', '.join(sorted({p['apn'] for p in mine}))})")
    print(f"  wrote {os.path.join(EXPORTS, 'parcels.json')}")


if __name__ == "__main__":
    main()
