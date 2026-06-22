#!/usr/bin/env python3
"""Guess each building's wall colour from Google Street View, so the generated
buildings carry real-ish facade tints instead of a flat stucco.

For every footprint in the patch: find the nearest Street View pano, shoot toward
the building, and take a dominant colour of the facade band (sky / roof / ground /
vegetation pixels rejected). Writes buildings_color.json {index:[r,g,b]}.

Place-aware: pass a place so the right scene is read and output lands in the right
dir (the orchestrator swaps exports/<place>/buildings_color.json into the root path
the exporter reads).
  place ∈ {dahill, canyon-middle-school, stanton-elementary}
    dahill  -> SCENE=src/assets/scene.json,  OUT=exports/
    other   -> SCENE=exports/<place>/scene.json, OUT=exports/<place>/

Coverage recovery vs the old version:
  - the centroid radius gate is dropped (every in-patch building is probed);
  - weak samples retry a 2nd heading / wider fov and the 2nd/3rd nearest pano;
  - dominant colour via a tiny k-means (k=3) instead of a plain median;
  - lower brightness floor (~40), wider wall band (0.25h..0.80h);
  - buildings still without a colour get a FALLBACK (median of the K nearest
    resolved buildings, else the aerial footprint median) so none fall through to
    the exporter's random palette;
  - a sidecar buildings_color_src.json marks each index "sv" | "knn" | "aerial".

Street View Static API bills per image (~$7/1000); the metadata probe is free.
Usage:  scripts/.venv/bin/python scripts/fetch_building_colors.py [place] [radius_m]
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

PLACES = {"dahill", "canyon-middle-school", "stanton-elementary", "meemaw", "xq"}

# --- level resolution -------------------------------------------------------
# Preferred: the env-var interface (mirrors fetch_sv_facades.py) so EVERY level fetches into its
# OWN sidecar dir and reads its OWN scene origin — no level is hardcoded. BCOL_SCENE / BCOL_OUT may
# be absolute or relative to ROOT. Falls back to the legacy positional `place` arg for back-compat.
PLACE = os.environ.get("BCOL_PLACE", "dahill")
rest = []
for a in sys.argv[1:]:
    if a in PLACES:
        PLACE = a
    else:
        rest.append(a)


def _abs(p):
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


if os.environ.get("BCOL_SCENE"):
    SCENE_PATH = _abs(os.environ["BCOL_SCENE"])
    OUT_DIR = _abs(os.environ.get("BCOL_OUT", os.path.dirname(SCENE_PATH)))
elif PLACE == "dahill":
    SCENE_PATH = os.path.join(ROOT, "src", "assets", "scene.json")
    OUT_DIR = os.path.join(ROOT, "exports")
else:
    SCENE_PATH = os.path.join(ROOT, "exports", PLACE, "scene.json")
    OUT_DIR = os.path.join(ROOT, "exports", PLACE)
os.makedirs(OUT_DIR, exist_ok=True)

# Radius gate effectively dropped: probe every building in the patch. Keep an arg
# escape hatch but default to a huge radius so nothing is gated out.
R = float(rest[0]) if len(rest) > 0 else 1e9

SCENE = json.load(open(SCENE_PATH))
C = SCENE["center"]
ORIGIN = SCENE.get("origin") or {}
# Shared flat-ENU frame anchored at the Dahill geocode origin (see fetch_aerial_google.py).
LAT0 = float(ORIGIN.get("lat", geo.LAT0))
LON0 = float(ORIGIN.get("lon", geo.LON0))
COSLAT = math.cos(math.radians(LAT0))


def load_key():
    for line in open(os.path.join(ROOT, ".env.local")):
        if line.startswith("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("no NEXT_PUBLIC_GOOGLE_MAPS_API_KEY in .env.local")


KEY = load_key()
SV = "https://maps.googleapis.com/maps/api/streetview"
sess = requests.Session()


def bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x))) % 360


def _kmeans3(pts, iters=8):
    """Tiny k-means (k=3) on Nx3 pixels; returns the centroid of the largest
    cluster (the dominant facade colour). Pure numpy, no sklearn dep."""
    n = len(pts)
    if n == 0:
        return None
    k = min(3, n)
    # seed from spread-out percentiles of luminance so clusters separate sky/shadow
    lum = pts.mean(1)
    order = np.argsort(lum)
    seeds = [pts[order[int((j + 0.5) / k * n)]] for j in range(k)]
    cen = np.array(seeds, dtype=np.float32)
    lab = np.zeros(n, dtype=np.int32)
    for _ in range(iters):
        d = ((pts[:, None, :] - cen[None, :, :]) ** 2).sum(2)
        lab = d.argmin(1)
        moved = False
        for j in range(k):
            m = lab == j
            if m.any():
                nc = pts[m].mean(0)
                if not np.allclose(nc, cen[j]):
                    moved = True
                cen[j] = nc
        if not moved:
            break
    counts = np.bincount(lab, minlength=k)
    return cen[counts.argmax()]


def facade_color(img):
    """Dominant RGB of facade-like pixels (drop sky / vegetation / very dark/bright).
    Returns (rgb01_list, kept_pixel_count). Wider band + lower floor than before."""
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, w, _ = a.shape
    band = a[int(h * 0.25):int(h * 0.80), int(w * 0.18):int(w * 0.82)].reshape(-1, 3)
    r, g, b = band[:, 0], band[:, 1], band[:, 2]
    lum = band.mean(1)
    veg = (g > r + 8) & (g > b + 8)
    sky = (b > r + 12) & (b > 120)
    keep = ~veg & ~sky & (lum > 40) & (lum < 240)
    kept = int(keep.sum())
    if kept < 1:
        return None, 0
    dom = _kmeans3(band[keep])
    if dom is None:
        return None, kept
    dom = dom / 255.0
    return [round(float(dom[0]), 3), round(float(dom[1]), 3), round(float(dom[2]), 3)], kept


def fetch_facade(plat, plon, head):
    """Try the primary shot, then a wider-fov / nudged-heading retry on a weak result.
    Returns (rgb01 | None, best_kept)."""
    best, best_kept = None, 0
    shots = [
        {"fov": "55", "pitch": "8", "dh": 0},
        {"fov": "75", "pitch": "6", "dh": -10},
        {"fov": "75", "pitch": "10", "dh": 10},
    ]
    for sh in shots:
        r = sess.get(SV, params={"size": "440x320", "location": f"{plat:.7f},{plon:.7f}",
                                 "heading": f"{(head + sh['dh']) % 360:.0f}", "fov": sh["fov"],
                                 "pitch": sh["pitch"], "source": "outdoor", "key": KEY}, timeout=30)
        if r.status_code != 200:
            continue
        col, kept = facade_color(Image.open(io.BytesIO(r.content)))
        if col and kept > best_kept:
            best, best_kept = col, kept
        if col and kept >= 80:   # strong enough — stop early, save image calls
            break
    return best, best_kept


def nearest_panos(blat, blon, n=3):
    """Up to n distinct nearby panos: exact location, then a few small offsets so a
    2nd/3rd pano (different vantage) can be tried when the 1st gives a weak result."""
    seen, out = set(), []
    offs = [(0, 0), (0.00022, 0), (-0.00022, 0), (0, 0.00028), (0, -0.00028)]
    for dlat, dlon in offs:
        meta = sess.get(f"{SV}/metadata", params={"location": f"{blat+dlat:.7f},{blon+dlon:.7f}",
                                                   "source": "outdoor", "key": KEY}, timeout=20).json()
        if meta.get("status") != "OK":
            continue
        pid = meta.get("pano_id")
        if pid and pid in seen:
            continue
        if pid:
            seen.add(pid)
        out.append((meta["location"]["lat"], meta["location"]["lng"]))
        if len(out) >= n:
            break
    return out


def aerial_footprint_median():
    """Median facade-ish colour sampled from each building's footprint in the place
    aerial JPG — the last-resort fallback so no building is left uncoloured.
    Returns {index: rgb01} (only for buildings whose footprint sampled cleanly)."""
    jpg = os.path.join(OUT_DIR, "google_aerial.jpg")
    js = os.path.join(OUT_DIR, "google_aerial.json")
    if not (os.path.exists(jpg) and os.path.exists(js)):
        return {}, None
    bnd = json.load(open(js))
    im = np.asarray(Image.open(jpg).convert("RGB"), dtype=np.float32)
    H, W, _ = im.shape
    E0, E1, Nt, Nb = bnd["E0"], bnd["E1"], bnd["Nt"], bnd["Nb"]
    out = {}
    overall = []
    for ib, b in enumerate(SCENE["buildings"]):
        xs = [p[0] for p in b["p"]]; ys = [p[1] for p in b["p"]]
        cx = sum(xs) / len(xs); cy = sum(ys) / len(ys)
        u = (cx - E0) / (E1 - E0); v = (Nt - cy) / (Nt - Nb)
        if not (0 <= u <= 1 and 0 <= v <= 1):
            continue
        px = int(u * (W - 1)); py = int(v * (H - 1))
        rad = 3
        patch = im[max(0, py - rad):py + rad + 1, max(0, px - rad):px + rad + 1].reshape(-1, 3)
        if len(patch) == 0:
            continue
        lum = patch.mean(1)
        keep = (lum > 40) & (lum < 240)
        if keep.sum() < 4:
            keep = np.ones(len(patch), bool)
        med = np.median(patch[keep], axis=0) / 255.0
        rgb = [round(float(med[0]), 3), round(float(med[1]), 3), round(float(med[2]), 3)]
        out[ib] = rgb
        overall.append(med)
    glob = (np.mean(overall, axis=0).tolist() if overall else None)
    return out, glob


def knn_fill(missing, resolved, centroids, k=6):
    """For each missing index, median of the K nearest RESOLVED buildings' colours."""
    if not resolved:
        return {}
    ridx = list(resolved.keys())
    rc = np.array([centroids[i] for i in ridx])
    out = {}
    for ib in missing:
        d = ((rc - np.array(centroids[ib])) ** 2).sum(1)
        near = [ridx[j] for j in np.argsort(d)[:k]]
        cols = np.array([resolved[j] for j in near])
        med = np.median(cols, axis=0)
        out[ib] = [round(float(med[0]), 3), round(float(med[1]), 3), round(float(med[2]), 3)]
    return out


def main():
    buildings = SCENE["buildings"]
    centroids = {ib: (sum(p[0] for p in b["p"]) / len(b["p"]),
                      sum(p[1] for p in b["p"]) / len(b["p"])) for ib, b in enumerate(buildings)}

    colors, src = {}, {}
    probed = 0
    for ib, b in enumerate(buildings):
        cx, cy = centroids[ib]
        if math.hypot(cx - C[0], cy - C[1]) > R:
            continue
        probed += 1
        blat = LAT0 + cy / 110540.0; blon = LON0 + cx / (COSLAT * 111320.0)
        best, best_kept = None, 0
        for plat, plon in nearest_panos(blat, blon, n=3):
            head = bearing(plat, plon, blat, blon)
            col, kept = fetch_facade(plat, plon, head)
            if col and kept > best_kept:
                best, best_kept = col, kept
            if best_kept >= 80:    # strong result on this pano — stop trying others
                break
        if best is not None:
            colors[ib] = best; src[ib] = "sv"

    sv_ok = len(colors)

    # --- fallback layer: aerial footprint median, then KNN of resolved buildings ---
    aerial_med, aerial_glob = aerial_footprint_median()
    in_patch = [ib for ib, (cx, cy) in centroids.items()
                if math.hypot(cx - C[0], cy - C[1]) <= R]
    missing = [ib for ib in in_patch if ib not in colors]

    # KNN from real SV results (preferred — keeps local character)
    knn = knn_fill(missing, {i: colors[i] for i in colors}, centroids)
    for ib in missing:
        if ib in aerial_med:
            colors[ib] = aerial_med[ib]; src[ib] = "aerial"
        elif ib in knn:
            colors[ib] = knn[ib]; src[ib] = "knn"
        elif aerial_glob is not None:
            colors[ib] = [round(float(aerial_glob[0]), 3), round(float(aerial_glob[1]), 3),
                          round(float(aerial_glob[2]), 3)]
            src[ib] = "aerial"
        elif knn:  # degenerate: no aerial, fall to any resolved-median
            any_med = np.median(np.array(list({i: colors[i] for i in colors if src.get(i) == "sv"}.values()) or [[0.6, 0.6, 0.6]]), axis=0)
            colors[ib] = [round(float(any_med[0]), 3), round(float(any_med[1]), 3), round(float(any_med[2]), 3)]
            src[ib] = "knn"

    json.dump(colors, open(os.path.join(OUT_DIR, "buildings_color.json"), "w"), separators=(",", ":"))
    json.dump(src, open(os.path.join(OUT_DIR, "buildings_color_src.json"), "w"), separators=(",", ":"))
    n_aerial = sum(1 for v in src.values() if v == "aerial")
    n_knn = sum(1 for v in src.values() if v == "knn")
    print(f"  [{PLACE}] {len(colors)}/{len(buildings)} buildings coloured "
          f"({sv_ok} SV, {n_aerial} aerial-fallback, {n_knn} knn-fallback; probed {probed}) "
          f"-> {os.path.relpath(os.path.join(OUT_DIR, 'buildings_color.json'), ROOT)}")


if __name__ == "__main__":
    main()
