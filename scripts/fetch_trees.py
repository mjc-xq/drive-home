#!/usr/bin/env python3
"""Extract REAL tree positions for 1840 Dahill Lane from the 2021 Alameda County
LiDAR (USGS LPC tiles in scripts/_cache/lpc_*.laz).

The tiles are classified for ground/noise only (no vegetation class), so trees are
found via a canopy-height model (CHM): LiDAR top surface (max Z per 1 m cell, noise
removed) minus the bare-earth 3DEP DTM. Cells inside known building footprints are
masked out; the remaining tall cells are vegetation, peak-picked into trees.

Writes exports/trees.json: {trees: [[worldX, worldZ, canopyR_m, height_m], ...]}
in the GLB's Y-up world frame (house at origin, x=east, z=-north).

Usage:  scripts/.venv/bin/python scripts/fetch_trees.py
"""
import json
import os

import numpy as np
import laspy
from pyproj import Transformer
from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", "_cache")
EXPORTS = os.path.join(ROOT, "exports")
FT = 0.3048
HMIN, HMAX, NMS_M = 3.0, 35.0, 4.0      # tree height window (m) and min spacing (m)

SCENE = json.load(open(os.path.join(ROOT, "src", "assets", "scene.json")))
CX, CY = SCENE["center"]
DEM = json.load(open(os.path.join(EXPORTS, "dem_1m.json")))
LAT0, LON0, COSLAT = DEM["LAT0"], DEM["LON0"], DEM["COSLAT"]
HALF = (DEM["latN"] - DEM["latS"]) * 110540.0 / 2.0
CELL = 1.0
G = int(round(2 * HALF / CELL))

# bare-earth DTM bilinear sampler (world X,Z -> ground metres)
_Emin = (DEM["lonW"] - LON0) * COSLAT * 111320; _Emax = (DEM["lonE"] - LON0) * COSLAT * 111320
_Nmin = (DEM["latS"] - LAT0) * 110540; _Nmax = (DEM["latN"] - LAT0) * 110540
_dE, _dN = _Emax - _Emin, _Nmax - _Nmin
_cols, _rows, _h = DEM["cols"], DEM["rows"], np.asarray(DEM["h"], dtype=np.float32)


def dtm(X, Z):
    e = X + CX; n = CY - Z
    fi = np.clip((e - _Emin) / _dE * _cols - 0.5, 0, _cols - 1.001)
    fj = np.clip((_Nmax - n) / _dN * _rows - 0.5, 0, _rows - 1.001)
    i = fi.astype(int); j = fj.astype(int); u = fi - i; v = fj - j
    a = _h[j * _cols + i]; b = _h[j * _cols + i + 1]; c = _h[(j + 1) * _cols + i]; d = _h[(j + 1) * _cols + i + 1]
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v


to_ft = Transformer.from_crs(4326, 2227, always_xy=True)   # lon/lat -> CA zone 3 ftUS
to_ll = Transformer.from_crs(2227, 4326, always_xy=True)
corners = [(LON0 + e / (COSLAT * 111320), LAT0 + n / 110540) for e in (-HALF, HALF) for n in (-HALF, HALF)]
fx, fy = to_ft.transform([c[0] for c in corners], [c[1] for c in corners])
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
    e = (np.asarray(lon) - LON0) * COSLAT * 111320.0; n = (np.asarray(lat) - LAT0) * 110540.0
    wX = e - CX; wZ = CY - n; zm = Z * FT

    gi = np.floor((wX + HALF) / CELL).astype(int); gj = np.floor((wZ + HALF) / CELL).astype(int)
    ok = (gi >= 0) & (gi < G) & (gj >= 0) & (gj < G)
    gi, gj, zm = gi[ok], gj[ok], zm[ok]
    dsm = np.full(G * G, -1e9, dtype=np.float32)
    np.maximum.at(dsm, gj * G + gi, zm)

    cellX = (np.arange(G) + 0.5) * CELL - HALF
    XX, ZZ = np.meshgrid(cellX, cellX)
    ground = dtm(XX.ravel(), ZZ.ravel())
    chm = np.where(dsm > -1e8, dsm - ground, 0.0).reshape(G, G)   # [j, i]
    print(f"  CHM grid {G}x{G}; cells >= {HMIN} m: {(chm >= HMIN).sum():,}  max {chm.max():.1f} m")

    # building footprints near the patch (world rings) for masking
    polys = []
    for b in SCENE["buildings"]:
        ring = [(ee - CX, CY - nn) for ee, nn in b["p"]]
        cx = sum(p[0] for p in ring) / len(ring); cz = sum(p[1] for p in ring) / len(ring)
        if abs(cx) <= HALF + 30 and abs(cz) <= HALF + 30:
            polys.append(Polygon(ring).buffer(1.0))
    tree_strtree = STRtree(polys) if polys else None

    # peak-pick canopy maxima with min spacing, skipping building roofs
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

    out = {"source": "USGS 3DEP LiDAR 2021 CHM (canopy = LiDAR surface - bare-earth DTM)",
           "count": len(trees), "trees": trees}
    os.makedirs(EXPORTS, exist_ok=True)
    json.dump(out, open(os.path.join(EXPORTS, "trees.json"), "w"), separators=(",", ":"))
    hs = np.array([t[3] for t in trees]) if trees else np.array([0])
    print(f"  {len(trees)} trees  (height {hs.min():.1f}..{hs.max():.1f} m, median {np.median(hs):.1f})")
    print(f"  wrote {os.path.join(EXPORTS, 'trees.json')}")


if __name__ == "__main__":
    main()
