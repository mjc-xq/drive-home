#!/usr/bin/env python3
"""Extract REAL tree positions for 1840 Dahill Lane from the 2021 Alameda County
LiDAR (USGS LPC tiles in scripts/_cache/lpc_*.laz), in the curvature-correct ENU
frame shared with the exporter/app (scripts/geo.py).

Trees via a canopy-height model: LiDAR top surface (max Z per 1 m cell, noise
removed) minus the bare-earth 3DEP DTM; building footprints masked out; the
remaining tall cells peak-picked into trees.

Writes exports/trees.json: {trees: [[worldX, worldZ, canopyR_m, height_m], ...]}
Usage:  scripts/.venv/bin/python scripts/fetch_trees.py
"""
import json
import os
import sys

import numpy as np
import laspy
from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon
from shapely.strtree import STRtree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", "_cache")
EXPORTS = os.path.join(ROOT, "exports")
FT = 0.3048
HMIN, HMAX, NMS_M = 3.0, 35.0, 4.0

SCENE = json.load(open(os.path.join(ROOT, "src", "assets", "scene.json")))
DEM = json.load(open(os.path.join(EXPORTS, "dem_1m.json")))
latN, latS, lonW, lonE = DEM["latN"], DEM["latS"], DEM["lonW"], DEM["lonE"]
cols, rows, H = DEM["cols"], DEM["rows"], np.asarray(DEM["h"], dtype=np.float32)
HALF = (latN - latS) * 110540.0 / 2.0
CELL = 1.0
G = int(round(2 * HALF / CELL))


def dtm_ll(lat, lon):
    """bare-earth ground (m) sampled from the 1 m DEM at lat/lon (DEM grid is 4326-linear)."""
    fi = np.clip((np.asarray(lon) - lonW) / (lonE - lonW) * cols - 0.5, 0, cols - 1.001)
    fj = np.clip((latN - np.asarray(lat)) / (latN - latS) * rows - 0.5, 0, rows - 1.001)
    i = fi.astype(int); j = fj.astype(int); u = fi - i; v = fj - j
    a = H[j * cols + i]; b = H[j * cols + i + 1]; c = H[(j + 1) * cols + i]; d = H[(j + 1) * cols + i + 1]
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v


to_ft = Transformer.from_crs(4326, 2227, always_xy=True)   # lon/lat -> CA zone 3 ftUS
to_ll = Transformer.from_crs(2227, 4326, always_xy=True)
# patch bbox in feet from the world corners (curvature-correct)
cx = [x for x in (-HALF, HALF) for _ in (0, 1)]
cz = [z for _ in (0, 1) for z in (-HALF, HALF)]
clat, clon = geo.world_to_ll(np.array(cx), np.array(cz))
fx, fy = to_ft.transform(clon, clat)
FXMIN, FXMAX, FYMIN, FYMAX = min(fx) - 30, max(fx) + 30, min(fy) - 30, max(fy) + 30


def collect(path):
    xs, ys, zs = [], [], []
    with laspy.open(path) as f:
        for r in f.chunk_iterator(3_000_000):
            cl = np.asarray(r.classification); x = np.asarray(r.x); y = np.asarray(r.y); z = np.asarray(r.z)
            m = (cl != 7) & (cl != 18) & (x >= FXMIN) & (x <= FXMAX) & (y >= FYMIN) & (y <= FYMAX)
            if m.any():
                xs.append(x[m]); ys.append(y[m]); zs.append(z[m])
    if not xs:
        return (np.empty(0),) * 3
    return np.concatenate(xs), np.concatenate(ys), np.concatenate(zs)


def main():
    X, Y, Z = [], [], []
    for name in ("lpc_w6105.laz", "lpc_w6108.laz"):
        p = os.path.join(CACHE, name)
        if not os.path.exists(p):
            continue
        x, y, z = collect(p); print(f"  {name}: {len(x):,} points in patch")
        X.append(x); Y.append(y); Z.append(z)
    X, Y, Z = np.concatenate(X), np.concatenate(Y), np.concatenate(Z)

    lon, lat = to_ll.transform(X, Y)
    wX, wZ = geo.to_world(np.asarray(lat), np.asarray(lon))    # curvature-correct world
    zm = Z * FT

    gi = np.floor((wX + HALF) / CELL).astype(int); gj = np.floor((wZ + HALF) / CELL).astype(int)
    ok = (gi >= 0) & (gi < G) & (gj >= 0) & (gj < G)
    gi, gj, zm = gi[ok], gj[ok], zm[ok]
    dsm = np.full(G * G, -1e9, dtype=np.float32)
    np.maximum.at(dsm, gj * G + gi, zm)

    cellX = (np.arange(G) + 0.5) * CELL - HALF
    XX, ZZ = np.meshgrid(cellX, cellX)
    glat, glon = geo.world_to_ll(XX.ravel(), ZZ.ravel())
    ground = dtm_ll(glat, glon)
    chm = np.where(dsm > -1e8, dsm - ground, 0.0).reshape(G, G)
    print(f"  CHM grid {G}x{G}; cells >= {HMIN} m: {(chm >= HMIN).sum():,}  max {chm.max():.1f} m")

    polys = []
    for b in SCENE["buildings"]:
        llat, llon = geo.flat_to_ll(np.array([e for e, n in b["p"]]), np.array([n for e, n in b["p"]]))
        ring = list(zip(*geo.to_world(llat, llon)))
        cxv = sum(p[0] for p in ring) / len(ring); czv = sum(p[1] for p in ring) / len(ring)
        if abs(cxv) <= HALF + 30 and abs(czv) <= HALF + 30:
            polys.append(Polygon(ring).buffer(1.0))
    # mask road corridors too, so canopy overhanging the street isn't placed in it
    for r in SCENE.get("roads", []):
        pl = r.get("p") if isinstance(r, dict) else r
        if not isinstance(pl, list) or len(pl) < 2:
            continue
        llat, llon = geo.flat_to_ll(np.array([e for e, n in pl]), np.array([n for e, n in pl]))
        line = list(zip(*geo.to_world(llat, llon)))
        if any(abs(x) <= HALF + 30 and abs(z) <= HALF + 30 for x, z in line):
            polys.append(LineString(line).buffer(4.5))   # ~road half-width + curb
    tree_strtree = STRtree(polys) if polys else None

    cand = np.argwhere(chm >= HMIN)
    order = np.argsort(-chm[cand[:, 0], cand[:, 1]])
    cand = cand[order]
    R = int(round(NMS_M / CELL))
    taken = np.zeros((G, G), bool)
    trees = []
    for j, i in cand:
        if taken[j, i]:
            continue
        h = float(chm[j, i])
        if h > HMAX:
            continue
        x = (i + 0.5) * CELL - HALF; z = (j + 0.5) * CELL - HALF
        if tree_strtree is not None:
            pt = Point(x, z)
            if any(polys[k].contains(pt) for k in tree_strtree.query(pt)):
                taken[max(0, j - R):j + R + 1, max(0, i - R):i + R + 1] = True
                continue
        cr = min(5.0, max(1.5, h * 0.28))
        trees.append([round(x, 2), round(z, 2), round(cr, 2), round(h, 2)])
        taken[max(0, j - R):j + R + 1, max(0, i - R):i + R + 1] = True

    out = {"source": "USGS 3DEP LiDAR 2021 CHM (curvature-correct ENU)",
           "count": len(trees), "trees": trees}
    json.dump(out, open(os.path.join(EXPORTS, "trees.json"), "w"), separators=(",", ":"))
    hs = np.array([t[3] for t in trees]) if trees else np.array([0])
    print(f"  {len(trees)} trees  (height {hs.min():.1f}..{hs.max():.1f} m, median {np.median(hs):.1f})")
    print(f"  wrote {os.path.join(EXPORTS, 'trees.json')}")


if __name__ == "__main__":
    main()
