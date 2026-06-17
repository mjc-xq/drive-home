#!/usr/bin/env python3
"""Wide-area data for the regional terrain GLB: a downsampled USGS 3DEP DEM and a
Mapbox satellite mosaic over a ±radius box around 1840 Dahill Lane.

Writes exports/region_dem.json (height grid + lat/lon bounds) and
exports/region_sat.jpg (+ region_sat.json with the mosaic's tile-aligned lat/lon
corners, for accurate web-mercator UVs).

Usage:  scripts/.venv/bin/python scripts/fetch_region.py [radius_m] [dem_px] [sat_zoom]
        default radius 8047 m (5 miles), dem 1024 px, sat zoom 14 (@2x)
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
CACHE = os.path.join(ROOT, "scripts", "_cache")
EXPORTS = os.path.join(ROOT, "exports")
os.makedirs(CACHE, exist_ok=True); os.makedirs(EXPORTS, exist_ok=True)

R = float(sys.argv[1]) if len(sys.argv) > 1 else 8047.0    # 5 miles
DEM_PX = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
ZOOM = int(sys.argv[3]) if len(sys.argv) > 3 else 14
HLAT, HLON = geo.HOUSE_LAT, geo.HOUSE_LON
COSH = math.cos(HLAT * math.pi / 180)

# lat/lon box around the house (true metres / degree)
dLat = R / 110990.0
dLon = R / (111320.0 * COSH)
latN, latS = HLAT + dLat, HLAT - dLat
lonW, lonE = HLON - dLon, HLON + dLon


def load_mapbox_token():
    for line in open(os.path.join(ROOT, ".env.local")):
        if line.startswith("NEXT_PUBLIC_MAPBOX_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("no NEXT_PUBLIC_MAPBOX_TOKEN in .env.local")


def fetch_dem():
    svc = ("https://elevation.nationalmap.gov/arcgis/rest/services/"
           "3DEPElevation/ImageServer/exportImage")
    params = {"bbox": f"{lonW},{latS},{lonE},{latN}", "bboxSR": 4326, "imageSR": 4326,
              "size": f"{DEM_PX},{DEM_PX}", "format": "tiff", "pixelType": "F32",
              "interpolation": "RSP_BilinearInterpolation", "f": "image"}
    print(f"== region DEM == 3DEP {DEM_PX}x{DEM_PX} over ±{R:.0f} m ({2*R/1609:.1f} mi span)")
    r = requests.get(svc, params=params, timeout=180); r.raise_for_status()
    arr = np.asarray(Image.open(io.BytesIO(r.content)), dtype=np.float32)
    bad = (arr < -1000) | (arr > 9000) | ~np.isfinite(arr)
    if bad.any():
        arr[bad] = np.nan; arr = np.where(np.isnan(arr), float(np.nanmean(arr)), arr)
    rows, cols = arr.shape
    print(f"  elev {arr.min():.1f}..{arr.max():.1f} m  relief {arr.max()-arr.min():.0f} m")
    json.dump({"source": "USGS 3DEP (regional, downsampled)", "cols": cols, "rows": rows,
               "latN": latN, "latS": latS, "lonW": lonW, "lonE": lonE,
               "h": [round(float(v), 1) for v in arr.ravel()]},
              open(os.path.join(EXPORTS, "region_dem.json"), "w"), separators=(",", ":"))
    print(f"  wrote exports/region_dem.json")


def ll_to_tile(lat, lon, z):
    n2 = 2.0 ** z
    x = (lon + 180.0) / 360.0 * n2
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n2
    return x, y


def tile_to_ll(x, y, z):
    n2 = 2.0 ** z
    lon = x / n2 * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n2))))
    return lat, lon


def fetch_sat():
    tok = load_mapbox_token()
    x0f, y0f = ll_to_tile(latN, lonW, ZOOM)   # NW
    x1f, y1f = ll_to_tile(latS, lonE, ZOOM)   # SE
    x0, y0, x1, y1 = int(math.floor(x0f)), int(math.floor(y0f)), int(math.ceil(x1f)), int(math.ceil(y1f))
    nx, ny = x1 - x0, y1 - y0
    px = 512  # @2x tiles
    print(f"== region satellite == Mapbox z{ZOOM}@2x, {nx}x{ny} tiles")
    mosaic = Image.new("RGB", (nx * px, ny * px))
    sess = requests.Session(); sess.headers["User-Agent"] = "fetch-region/1.0"
    for j in range(ny):
        for i in range(nx):
            tx, ty = x0 + i, y0 + j
            name = f"mbsat_{ZOOM}_{tx}_{ty}@2x.jpg"
            p = os.path.join(CACHE, name)
            if os.path.exists(p) and os.path.getsize(p) > 0:
                t = Image.open(p).convert("RGB")
            else:
                url = (f"https://api.mapbox.com/v4/mapbox.satellite/{ZOOM}/{tx}/{ty}@2x.jpg90"
                       f"?access_token={tok}")
                rr = sess.get(url, timeout=30); rr.raise_for_status()
                open(p, "wb").write(rr.content); t = Image.open(io.BytesIO(rr.content)).convert("RGB")
            if t.size != (px, px):
                t = t.resize((px, px), Image.LANCZOS)
            mosaic.paste(t, (i * px, j * px))
    # tile-aligned corners (exact mercator extent of the mosaic)
    lat_n, lon_w = tile_to_ll(x0, y0, ZOOM)
    lat_s, lon_e = tile_to_ll(x1, y1, ZOOM)
    out = mosaic
    if max(out.size) > 4096:
        s = 4096 / max(out.size); out = out.resize((int(out.width * s), int(out.height * s)), Image.LANCZOS)
    out.save(os.path.join(EXPORTS, "region_sat.jpg"), "JPEG", quality=80, optimize=True)
    json.dump({"latN": lat_n, "latS": lat_s, "lonW": lon_w, "lonE": lon_e, "px": out.size},
              open(os.path.join(EXPORTS, "region_sat.json"), "w"))
    print(f"  wrote exports/region_sat.jpg ({out.size[0]}x{out.size[1]}, {os.path.getsize(os.path.join(EXPORTS,'region_sat.jpg'))//1024} KB)")


if __name__ == "__main__":
    fetch_dem()
    fetch_sat()
