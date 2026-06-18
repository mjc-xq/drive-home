#!/usr/bin/env python3
"""Bake the satellite aerial into PER-VERTEX colours for the terrain grid, so the
ground imagery rides with the geometry and can NEVER slide in a UV/texture export
(glTF->USDZ etc. mangle texture coords; vertex colours survive everything).

For each DEM cell (same lat/lon grid the exporter builds the terrain from), sample
aerial_opt.jpg at that cell's TRUE position (via the aerial's own flat-ENU
georeferencing, matching the app's uvAt) -> exports/terrain_colors.json
(flat [r,g,b] floats, row-major j*cols+i, matching export_property_glb.mjs).

Usage:  scripts/.venv/bin/python scripts/fetch_terrain_colors.py
"""
import json
import math
import os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORTS = os.path.join(ROOT, "exports")
LAT0, LON0 = 37.6835313, -122.0686199
COSLAT = math.cos(math.radians(LAT0))

DEM = json.load(open(os.path.join(EXPORTS, "dem_1m.json")))
A = json.load(open(os.path.join(ROOT, "src", "assets", "scene.json")))["aerial"]
img = np.asarray(Image.open(os.path.join(ROOT, "src", "assets", "aerial_opt.jpg")).convert("RGB"), dtype=np.float32)
H, W, _ = img.shape
cols, rows = DEM["cols"], DEM["rows"]
dLat, dLon = DEM["latN"] - DEM["latS"], DEM["lonE"] - DEM["lonW"]
E0, E1, Nt, Nb = A["E0"], A["E1"], A["Nt"], A["Nb"]

# cell-centre lat/lon grids (EXACTLY as the exporter terrain loop computes them)
j = np.arange(rows)[:, None]; i = np.arange(cols)[None, :]
lat = DEM["latN"] - (j + 0.5) / rows * dLat            # [rows,1] broadcast
lon = DEM["lonW"] + (i + 0.5) / cols * dLon            # [1,cols]
lat = np.broadcast_to(lat, (rows, cols))
lon = np.broadcast_to(lon, (rows, cols))
# -> flat ENU (the aerial's georeferencing) -> pixel
e = (lon - LON0) * COSLAT * 111320.0
n = (lat - LAT0) * 110540.0
px = np.clip(((e - E0) / (E1 - E0) * W).astype(int), 0, W - 1)
py = np.clip(((Nt - n) / (Nt - Nb) * H).astype(int), 0, H - 1)
srgb = img[py, px] / 255.0                              # [rows,cols,3] sRGB 0..1
# glTF/USD vertex colours (COLOR_0 / displayColor) are LINEAR — convert from the
# sRGB JPEG so viewers don't render them washed out.
lin = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
out = [round(float(v), 4) for v in lin.reshape(-1)]
json.dump({"cols": cols, "rows": rows, "rgb": out},
          open(os.path.join(EXPORTS, "terrain_colors.json"), "w"), separators=(",", ":"))
print(f"  baked {rows}x{cols} aerial vertex colours -> exports/terrain_colors.json "
      f"({os.path.getsize(os.path.join(EXPORTS,'terrain_colors.json'))//1024} KB)")
