#!/usr/bin/env python3
"""Fetch Alameda County Open Data parcel boundaries and convert them into the GLB
world frame.

Parcel boundaries are the real lot lines that fences typically run along (actual
fence geometry isn't in any public dataset). Flags the owner's two lots:
  416-120-67  house lot, and  416-120-68  back lot the creek runs through.

Writes exports/parcels.json: {parcels: [{apn, mine, ring: [[worldX, worldZ], ...]}]}
Also caches exports/parcels_raw.json with the bounded source query.
Usage:  scripts/.venv/bin/python scripts/fetch_parcels.py
"""
import json
import math
import os
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORTS = os.path.join(ROOT, "exports")
SCENE = json.load(open(os.path.join(ROOT, "src", "assets", "scene.json")))
DEM = json.load(open(os.path.join(EXPORTS, "dem_1m.json")))
ORIGIN = SCENE.get("origin") or {}
LAT0 = float(ORIGIN.get("lat", 37.6835313))
LON0 = float(ORIGIN.get("lon", -122.0686199))
COSLAT = math.cos(math.radians(LAT0))
CX, CY = SCENE["center"]
HALF = (DEM["latN"] - DEM["latS"]) * 110540.0 / 2.0
MINE = {"416-120-67", "416-120-68"}
SERVICE = "https://services5.arcgis.com/ROBnTHSNjoZ2Wm1P/arcgis/rest/services/Parcels/FeatureServer/0/query"
WEBM_R = 6378137.0


def ll_to_webm(lon, lat):
    lat = max(-85.05112878, min(85.05112878, lat))
    x = WEBM_R * math.radians(lon)
    y = WEBM_R * math.log(math.tan(math.pi / 4.0 + math.radians(lat) / 2.0))
    return x, y


def to_world(lon, lat):
    e = (lon - LON0) * COSLAT * 111320.0
    n = (lat - LAT0) * 110540.0
    x, z = e - CX, -(n - CY)
    return [round(float(x), 2), round(float(z), 2)]


def fetch_open_parcels():
    # Query just the DEM neighborhood envelope. Request only APN fields so the raw cache
    # does not persist owner/mailing/value attributes carried by the public FeatureServer.
    x0, y0 = ll_to_webm(DEM["lonW"], DEM["latS"])
    x1, y1 = ll_to_webm(DEM["lonE"], DEM["latN"])
    geom = f"{min(x0, x1):.3f},{min(y0, y1):.3f},{max(x0, x1):.3f},{max(y0, y1):.3f}"
    features = []
    offset = 0
    page = 2000
    while True:
        params = {
            "f": "json",
            "where": "1=1",
            "outFields": "APN,PrintParcel",
            "returnGeometry": "true",
            "outSR": "4326",
            "geometry": geom,
            "geometryType": "esriGeometryEnvelope",
            "inSR": "3857",
            "spatialRel": "esriSpatialRelIntersects",
            "resultOffset": str(offset),
            "resultRecordCount": str(page),
        }
        url = SERVICE + "?" + urllib.parse.urlencode(params)
        with urllib.request.urlopen(url, timeout=60) as r:
            data = json.load(r)
        if data.get("error"):
            raise RuntimeError(data["error"])
        chunk = data.get("features") or []
        features.extend(chunk)
        if len(chunk) < page or not data.get("exceededTransferLimit"):
            break
        offset += page
    return {
        "type": "FeatureCollection",
        "source": "Alameda County Open Data Parcel Boundaries",
        "service": SERVICE,
        "bbox_wgs84": [DEM["lonW"], DEM["latS"], DEM["lonE"], DEM["latN"]],
        "features": features,
    }


def rings_of_esri(geom):
    return (geom or {}).get("rings") or []


def main():
    raw_path = os.path.join(EXPORTS, "parcels_raw.json")
    gj = fetch_open_parcels()
    json.dump(gj, open(raw_path, "w"), separators=(",", ":"))
    out = []
    for f in gj["features"]:
        attrs = f.get("attributes") or f.get("properties") or {}
        apn = (attrs.get("APN") or attrs.get("PrintParcel") or "").strip()
        for ll in rings_of_esri(f.get("geometry")):
            ring = [to_world(x, y) for x, y in ll]
            if not any(abs(x) <= HALF + 10 and abs(z) <= HALF + 10 for x, z in ring):
                continue
            out.append({"apn": apn, "mine": apn in MINE, "ring": ring})
    mine = [p for p in out if p["mine"]]
    res = {"source": "Alameda County Open Data parcel boundaries (approximate lot lines; not legal survey)",
           "mine_apns": sorted(MINE), "count": len(out), "trees": None, "parcels": out}
    json.dump(res, open(os.path.join(EXPORTS, "parcels.json"), "w"), separators=(",", ":"))
    print(f"  {len(out)} parcels in patch, {len(mine)} flagged as yours "
          f"({', '.join(sorted({p['apn'] for p in mine}))})")
    print(f"  cached {len(gj['features'])} source features -> {raw_path}")
    print(f"  wrote {os.path.join(EXPORTS, 'parcels.json')}")


if __name__ == "__main__":
    main()
