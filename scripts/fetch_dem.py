#!/usr/bin/env python3
"""Fetch a crisp 1 m bare-earth elevation patch for 1840 Dahill Lane from the
USGS 3DEP seamless DEM (source here: CA_AlamedaCounty_2021 1 m LiDAR DTM) and
write exports/dem_1m.json for the GLB exporter.

Bare-earth (DTM) = buildings and vegetation removed, so the ground is clean with
no Google-photoreal-style melted artifacts. ~30x crisper than the Terrarium DEM
baked into scene.json.

Usage:  scripts/.venv/bin/python scripts/fetch_dem.py [patch_meters]
"""
import json
import math
import os
import sys

import numpy as np
import requests
from PIL import Image

# Geocode origin (matches scripts/build_scene.py and src/engine/coords.js)
LAT0, LON0 = 37.6835313, -122.0686199
COSLAT = math.cos(math.radians(LAT0))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENE = json.load(open(os.path.join(ROOT, "src", "assets", "scene.json")))
CX, CY = SCENE["center"]                       # house centroid in ENU metres

PATCH = float(sys.argv[1]) if len(sys.argv) > 1 else 256.0  # square side, metres
HALF = PATCH / 2.0
PX = int(round(PATCH))                          # 1 px per metre (native 3DEP res)

SERVICE = ("https://elevation.nationalmap.gov/arcgis/rest/services/"
           "3DEPElevation/ImageServer/exportImage")


def en_to_ll(e, n):
    return LAT0 + n / 110540.0, LON0 + e / (COSLAT * 111320.0)


def main():
    # ENU patch corners centred on the house -> lat/lon request bbox
    lat_s, lon_w = en_to_ll(CX - HALF, CY - HALF)
    lat_n, lon_e = en_to_ll(CX + HALF, CY + HALF)
    params = {
        "bbox": f"{lon_w},{lat_s},{lon_e},{lat_n}",
        "bboxSR": 4326, "imageSR": 4326,
        "size": f"{PX},{PX}",
        "format": "tiff", "pixelType": "F32",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "image",
    }
    print(f"== DEM == 3DEP 1 m, {PATCH:.0f} m patch, {PX}x{PX} px around 1840 Dahill Ln")
    r = requests.get(SERVICE, params=params, timeout=120)
    r.raise_for_status()
    tmp = os.path.join(ROOT, "scripts", "_cache", "dem_1m.tiff")
    os.makedirs(os.path.dirname(tmp), exist_ok=True)
    open(tmp, "wb").write(r.content)

    arr = np.asarray(Image.open(tmp), dtype=np.float32)   # row 0 = north
    bad = (arr < -1000) | (arr > 9000) | ~np.isfinite(arr)
    if bad.any():
        arr[bad] = np.nan
        m = float(np.nanmean(arr))
        arr = np.where(np.isnan(arr), m, arr)
        print(f"  filled {int(bad.sum())} nodata px with mean {m:.2f}")
    rows, cols = arr.shape
    print(f"  elev range {arr.min():.2f}..{arr.max():.2f} m  mean {arr.mean():.2f}  "
          f"relief {arr.max()-arr.min():.2f} m  shape {rows}x{cols}")

    out = {
        "source": "USGS 3DEP 1m (CA_AlamedaCounty_2021 bare-earth DTM)",
        "cols": cols, "rows": rows,
        "latN": lat_n, "latS": lat_s, "lonW": lon_w, "lonE": lon_e,
        "Cx": CX, "Cy": CY, "LAT0": LAT0, "LON0": LON0, "COSLAT": COSLAT,
        "min": round(float(arr.min()), 2), "max": round(float(arr.max()), 2),
        "h": [round(float(v), 2) for v in arr.ravel()],
    }
    out_path = os.path.join(ROOT, "exports", "dem_1m.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    json.dump(out, open(out_path, "w"), separators=(",", ":"))
    print(f"  wrote {out_path} ({os.path.getsize(out_path)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
