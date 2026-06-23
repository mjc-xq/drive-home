#!/usr/bin/env python3
"""Fetch REAL per-tree positions for an Oakland level from the city's Davey tree inventory
(ArcGIS FeatureServer, ~71k trees, no auth) and emit exports/<level>/trees_placed.json in the
same flat-ENU world frame the single-surface exporter + place_trees.py use.

Each tree carries species (drives model choice), real DBH -> canopy radius + height (i-Tree/USFS
open-grown allometry), health scaling, and a street-vs-yard tag from the inventory `location`
field (Front/Median = street strip, Left/Right/Rear = yard). This replaces the sparse/guessed xq
trees with a dense, real, species-typed street+yard census.

Usage: scripts/.venv/bin/python scripts/fetch_oakland_trees.py xq
"""
import json, math, os, sys, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SLUG = sys.argv[1] if len(sys.argv) > 1 else "xq"
SCENE = os.path.join(ROOT, "exports", SLUG, "scene.json")
OUT = os.path.join(ROOT, "exports", SLUG, "trees_placed.json")
FS = "https://services6.arcgis.com/ZhjOrCUbgkqbFWaB/arcgis/rest/services/davey_tree_survey/FeatureServer/0/query"

scene = json.load(open(SCENE)); C = scene["center"]; O = scene["origin"]
LAT0, LON0 = O["lat"], O["lon"]; COSLAT = math.cos(math.radians(LAT0))
def w2(e, n): return (e - C[0], -(n - C[1]))
def ll2world(lat, lon):
    e = (lon - LON0) * COSLAT * 111320.0; n = (lat - LAT0) * 110540.0
    return (e - C[0], -(n - C[1]))

# bbox in lat/lon from the building extent (+margin)
cents = []
for b in scene["buildings"]:
    if not b.get("p"): continue
    r = [w2(e, n) for e, n in b["p"]]
    cents.append((sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r)))
minx = min(c[0] for c in cents); maxx = max(c[0] for c in cents)
minz = min(c[1] for c in cents); maxz = max(c[1] for c in cents)
def world2ll(x, z):  # inverse
    e = x + C[0]; n = C[1] - z
    return (LAT0 + n / 110540.0, LON0 + e / (COSLAT * 111320.0))
(latA, lonA) = world2ll(minx, maxz); (latB, lonB) = world2ll(maxx, minz)
m = 0.0015
lo_lon, hi_lon = min(lonA, lonB) - m, max(lonA, lonB) + m
lo_lat, hi_lat = min(latA, latB) - m, max(latA, latB) + m

where = f"longitude>{lo_lon} AND longitude<{hi_lon} AND latitude>{lo_lat} AND latitude<{hi_lat}"
url = FS + "?" + urllib.parse.urlencode({"where": where, "outFields": "common,scientific,dbh,health,location", "f": "geojson", "resultRecordCount": 5000})
data = json.loads(urllib.request.urlopen(url, timeout=60).read())
feats = data.get("features", [])

# optional DTM for per-tree base elevation
dem = None
dp = os.path.join(ROOT, "exports", SLUG, "dem_1m.json")
if os.path.exists(dp):
    dem = json.load(open(dp))
def base_at(lat, lon):
    if not dem: return 0.0
    cols, rows = dem["cols"], dem["rows"]; H = dem["h"]
    fi = (lon - dem["lonW"]) / (dem["lonE"] - dem["lonW"]) * cols
    fj = (dem["latN"] - lat) / (dem["latN"] - dem["latS"]) * rows
    i = min(cols - 1, max(0, int(fi))); j = min(rows - 1, max(0, int(fj)))
    try: return float(H[j][cols * 0 + i]) if isinstance(H[0], list) else float(H[j * cols + i])
    except Exception: return 0.0

# species -> height coefficient (open-grown CA street species); canopy diam ~= 25*DBH
TALL = ("platanus", "sycamore", "plane", "liquidambar", "ulmus", "fraxinus", "ginkgo", "quercus", "metrosideros")
SHORT = ("magnolia", "pyrus", "lagerstroemia", "prunus", "citrus", "olea", "tristania", "water gum")
def coeff(sci):
    s = (sci or "").lower()
    if any(t in s for t in TALL): return 0.60
    if any(t in s for t in SHORT): return 0.42
    return 0.50
HEALTH = {"Good": 1.0, "Fair": 0.85, "Poor": 0.7, "Dead": 0.55}
STREET = {"Front", "Median"}

trees = []; nstreet = 0
for f in feats:
    p = f.get("properties", {}); g = f.get("geometry", {})
    coords = g.get("coordinates")
    if not coords: continue
    lon, lat = coords[0], coords[1]
    x, z = ll2world(lat, lon)
    if not (minx - 20 <= x <= maxx + 20 and minz - 20 <= z <= maxz + 20): continue
    dbh = p.get("dbh") or 0
    try: dbh = float(dbh)
    except Exception: dbh = 0
    if dbh < 1.5: dbh = 6.0  # missing/sapling -> a modest default so it still reads as a tree
    hf = HEALTH.get(p.get("health"), 0.9)
    height = round((1.3 + coeff(p.get("scientific")) * dbh) * hf, 2)
    canopyR = round(min(5.0, max(1.4, dbh * 0.0254 * 25 / 2)), 2)
    loc = p.get("location") or ""
    if loc in STREET: nstreet += 1
    trees.append({"i": len(trees), "x": round(x, 2), "z": round(z, 2),
                  "base": round(base_at(lat, lon), 2), "canopyR": canopyR, "height": height,
                  "species": p.get("scientific") or p.get("common") or "", "street": loc in STREET})

json.dump({"source": "Oakland Davey tree inventory (ArcGIS FeatureServer)", "frame": "flat-ENU world XZ",
           "count": len(trees), "trees": trees}, open(OUT, "w"))
print(f"[{SLUG}] Oakland trees: {len(trees)} (street/median {nstreet}, yard {len(trees)-nstreet}) from {len(feats)} fetched -> {os.path.relpath(OUT, ROOT)}")
hs = sorted(t["height"] for t in trees)
if hs: print(f"  height {hs[0]}..{hs[-1]}m median {hs[len(hs)//2]}m")
