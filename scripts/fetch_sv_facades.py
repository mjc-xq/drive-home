#!/usr/bin/env python3
"""Fetch Google Street View facades for the playable-core buildings and emit a
manifest the GLB exporter drapes onto the street-facing walls.

For the owner's house (scene.json building with house:true) plus the N nearest
buildings to the house that sit within ~35 m of a road, we walk every footprint
edge. An edge is "street-facing" when its OUTWARD normal points toward the
nearest road point P and P is within MAX_ROAD_DIST. For each such wall we put a
Street View Static camera AT P, heading = bearing P->M (wall midpoint), and a
field of view that just frames the wall width at that distance, then save the
JPEG. The exporter (export_property_glb.mjs) reads exports/sv_facades.json and
emits each textured wall as its own primitive/material carrying its SV crop.

Frame (matches export_property_glb.mjs):
  flat-ENU: e=(lon-LON0)*COSLAT*111320, n=(lat-LAT0)*110540
  world (glTF Y-up): X=e-C[0], Z=-(n-C[1])  ; C = scene.json center
  inverse: lat=LAT0+n/110540, lon=LON0+e/(COSLAT*111320)

Usage:  scripts/.venv/bin/python scripts/fetch_sv_facades.py [N_NEAREST]
        (metadata probe is free; each image bills once, then caches in _cache)
"""
import hashlib
import io
import json
import math
import os
import sys
import urllib.parse
import urllib.request

from PIL import Image

LAT0 = 37.6835313
LON0 = -122.0686199
COSLAT = math.cos(math.radians(LAT0))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENE = os.path.join(ROOT, "src", "assets", "scene.json")
CACHE = os.path.join(ROOT, "scripts", "_cache")
OUT_DIR = os.path.join(ROOT, "exports", "sv_facades")
MANIFEST = os.path.join(ROOT, "exports", "sv_facades.json")

# --- tuning ---------------------------------------------------------------
N_NEAREST = int(sys.argv[1]) if len(sys.argv) > 1 else 60  # nearest buildings + house (was 18; raised to cover the playable patch, ~150-170 m out from the house)
MAX_ROAD_DIST = 35.0      # wall faces a road only if nearest road point <= this
PANO_SNAP = 25.0          # snap P to pano if metadata pano is within this
MIN_WALL = 2.5            # skip slivers shorter than this (m)
IMG_W, IMG_H = 640, 512
PITCH = 6
FOV_MIN, FOV_MAX = 35.0, 90.0
CAM_EYE = 2.5   # Street View camera eye height above the road (m)
WALL_PAD = 0.6  # extra metres above the eave kept in the crop so the roof line reads


def load_key():
    for var in ("GOOGLE_MAPS_API_KEY", "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY"):
        if os.environ.get(var):
            return os.environ[var]
    env = os.path.join(ROOT, ".env.local")
    if os.path.exists(env):
        for line in open(env):
            if line.startswith("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY in .env.local")


KEY = load_key()


# --- frame helpers --------------------------------------------------------
def en_to_ll(e, n):
    return LAT0 + n / 110540.0, LON0 + e / (COSLAT * 111320.0)


def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read()


def metadata(lat, lon):
    url = "https://maps.googleapis.com/maps/api/streetview/metadata?" + urllib.parse.urlencode(
        {"location": f"{lat:.7f},{lon:.7f}", "source": "outdoor", "key": KEY}
    )
    return json.loads(fetch(url))


def fetch_image(lat, lon, heading, fov, pitch):
    params = {
        "size": f"{IMG_W}x{IMG_H}",
        "location": f"{lat:.7f},{lon:.7f}",
        "heading": f"{heading:.1f}",
        "fov": f"{fov:.1f}",
        "pitch": f"{pitch}",
        "source": "outdoor",
        "key": KEY,
    }
    # cache key omits the secret key
    ckey = "&".join(f"{k}={v}" for k, v in params.items() if k != "key")
    h = hashlib.sha1(ckey.encode()).hexdigest()[:16]
    cached = os.path.join(CACHE, f"sv_{h}.jpg")
    if os.path.exists(cached) and os.path.getsize(cached) > 1000:
        return open(cached, "rb").read(), True
    url = "https://maps.googleapis.com/maps/api/streetview?" + urllib.parse.urlencode(params)
    data = fetch(url)
    os.makedirs(CACHE, exist_ok=True)
    open(cached, "wb").write(data)
    return data, False


def main():
    scene = json.load(open(SCENE))
    C = scene["center"]

    def w2(e, n):
        return (e - C[0], -(n - C[1]))

    def world_to_en(X, Z):
        return (X + C[0], C[1] - Z)

    def centroid(p):
        return (sum(q[0] for q in p) / len(p), sum(q[1] for q in p) / len(p))

    def wall_height(b):
        # mirror export_property_glb.mjs wallHeight()
        H = b.get("h") or 4.5
        r = b.get("r")
        return (max(2.4, H * 0.8) if (r and len(r)) else H) + 0.5

    def crop_to_wall(jpg, d, fov, wallH):
        """Crop the SV image vertically to the band the wall (ground..eave) occupies
        under a simple pinhole model, so the wall quad's 0..1 V maps ground->eave
        instead of including roof+sky. Returns (PNG bytes, v0, v1)."""
        fov_v = 2.0 * math.degrees(math.atan(math.tan(math.radians(fov / 2.0)) * IMG_H / IMG_W))

        def vrow(y):
            ang = math.degrees(math.atan2(y - CAM_EYE, d))  # elevation above horizontal
            rel = ang - PITCH                                # relative to optical axis
            return min(1.0, max(0.0, 0.5 - rel / fov_v))     # top->bottom in [0,1]

        v_base = vrow(0.0)
        v_top = vrow(wallH + WALL_PAD)
        im = Image.open(io.BytesIO(jpg)).convert("RGB")
        y0 = int(round(v_top * IMG_H))
        y1 = int(round(v_base * IMG_H))
        y0 = max(0, min(IMG_H - 2, y0))
        y1 = max(y0 + 2, min(IMG_H, y1))
        crop = im.crop((0, y0, IMG_W, y1))
        buf = io.BytesIO()
        crop.save(buf, format="JPEG", quality=88)
        return buf.getvalue(), round(v_top, 3), round(v_base, 3)

    # road segments in world XZ
    roadsegs = []
    for r in scene["roads"]:
        pl = r["p"] if isinstance(r, dict) else r
        if not isinstance(pl, list) or len(pl) < 2:
            continue
        wp = [w2(e, n) for e, n in pl]
        for a, b in zip(wp, wp[1:]):
            roadsegs.append((a, b))

    def nearest_road(px, pz):
        best = 1e9
        bp = None
        for (ax, az), (bx, bz) in roadsegs:
            dx = bx - ax
            dz = bz - az
            L2 = dx * dx + dz * dz or 1.0
            t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L2))
            cx = ax + t * dx
            cz = az + t * dz
            d = math.hypot(px - cx, pz - cz)
            if d < best:
                best = d
                bp = (cx, cz)
        return best, bp

    buildings = scene["buildings"]
    house_idx = next(i for i, b in enumerate(buildings) if b.get("house"))
    hcw = w2(*centroid(buildings[house_idx]["p"]))

    # target set: house + N nearest buildings to the house that are near a road
    ranked = []
    for ib, b in enumerate(buildings):
        if ib == house_idx:
            continue
        cw = w2(*centroid(b["p"]))
        droad, _ = nearest_road(*cw)
        if droad > MAX_ROAD_DIST:
            continue
        dh = math.hypot(cw[0] - hcw[0], cw[1] - hcw[1])
        ranked.append((dh, ib))
    ranked.sort()
    targets = [house_idx] + [ib for _, ib in ranked[:N_NEAREST]]

    os.makedirs(OUT_DIR, exist_ok=True)
    walls = []
    n_fetch = n_cache = 0
    for ib in targets:
        b = buildings[ib]
        # de-duplicate the closing vertex exactly as the exporter's emitRing does,
        # so edge i here matches edge i of the extruded wall. Keep the flat-ENU
        # coords alongside so the manifest carries A,B in the exporter's frame.
        en_ring = list(b["p"])
        if len(en_ring) > 1 and en_ring[0] == en_ring[-1]:
            en_ring.pop()
        ring = [w2(e, n) for e, n in en_ring]
        cw = w2(*centroid(en_ring))
        for i in range(len(ring)):
            A = ring[i]
            B = ring[(i + 1) % len(ring)]
            ex = B[0] - A[0]
            ez = B[1] - A[1]
            wallW = math.hypot(ex, ez)
            if wallW < MIN_WALL:
                continue
            M = ((A[0] + B[0]) / 2.0, (A[1] + B[1]) / 2.0)
            # outward normal = the perpendicular pointing away from the centroid
            n1 = (-ez / wallW, ex / wallW)
            toC = (cw[0] - M[0], cw[1] - M[1])
            nrm = n1 if (n1[0] * toC[0] + n1[1] * toC[1]) < 0 else (-n1[0], -n1[1])
            droad, P = nearest_road(*M)
            if P is None or droad > MAX_ROAD_DIST:
                continue
            # the wall must face the road: outward normal points toward P
            if nrm[0] * (P[0] - M[0]) + nrm[1] * (P[1] - M[1]) <= 0:
                continue

            # SV camera at P; snap to nearest pano if metadata gives a closer one
            e, n = world_to_en(*P)
            lat, lon = en_to_ll(e, n)
            meta = metadata(lat, lon)
            if meta.get("status") != "OK":
                print(f"  b{ib} e{i}: no pano ({meta.get('status')}) skip")
                continue
            ploc = meta["location"]
            # move P to the pano if it is within PANO_SNAP of the road point
            from_e = (ploc["lng"] - LON0) * COSLAT * 111320.0
            from_n = (ploc["lat"] - LAT0) * 110540.0
            pano_w = w2(from_e, from_n)
            if math.hypot(pano_w[0] - P[0], pano_w[1] - P[1]) <= PANO_SNAP:
                P = pano_w
                lat, lon = ploc["lat"], ploc["lng"]

            d = math.hypot(P[0] - M[0], P[1] - M[1])
            if d < 1.0:
                d = 1.0
            Men = world_to_en(*M)
            Pen = world_to_en(*P)
            heading = math.degrees(math.atan2(Men[0] - Pen[0], Men[1] - Pen[1])) % 360.0
            fov = max(FOV_MIN, min(FOV_MAX, 2.0 * math.degrees(math.atan((wallW / 2.0) / d))))

            data, cached = fetch_image(lat, lon, heading, fov, PITCH)
            n_cache += cached
            n_fetch += (not cached)
            wallH = wall_height(b)
            cropped, v_top, v_base = crop_to_wall(data, d, fov, wallH)
            fname = f"b{ib}_e{i}.jpg"
            open(os.path.join(OUT_DIR, fname), "wb").write(cropped)
            walls.append(
                {
                    "building": ib,
                    "edge": i,
                    "house": bool(b.get("house")),
                    # A,B as flat-ENU footprint vertices (de-duplicated ring) so the
                    # exporter rebuilds the exact world wall quad it extrudes for edge i
                    "A": en_ring[i],
                    "B": en_ring[(i + 1) % len(en_ring)],
                    # cropped image: V 0..1 maps wall eave(+pad)->ground, so the
                    # exporter flips V to fill the wall base..top. wallH carried for it.
                    "image": os.path.join("sv_facades", fname),
                    "wallH": round(wallH, 2),
                    "heading": round(heading, 1),
                    "fov": round(fov, 1),
                    "dist": round(d, 1),
                    "wallW": round(wallW, 1),
                    "crop_v": [v_top, v_base],
                    "date": meta.get("date", ""),
                }
            )
            tag = "cache" if cached else "fetch"
            print(
                f"  b{ib} e{i}: w={wallW:4.1f} d={d:4.1f} hdg={heading:5.1f} fov={fov:4.1f} [{tag}] {meta.get('date','?')}"
            )

    json.dump(
        {
            "note": "Street View facades for playable-core walls; consumed by export_property_glb.mjs",
            "targets": targets,
            "house_idx": house_idx,
            "count": len(walls),
            "walls": walls,
        },
        open(MANIFEST, "w"),
        indent=1,
    )
    print(
        f"\ntargets: {len(targets)} buildings (house {house_idx} + {len(targets)-1} near)"
        f"\nwalls textured: {len(walls)}  (fetched {n_fetch}, cached {n_cache})"
        f"\nwrote {MANIFEST}"
    )


if __name__ == "__main__":
    main()
