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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# SCENE/OUT_DIR/MANIFEST are env-overridable so multiple levels can fetch CONCURRENTLY
# (each reads its own sidecar scene.json -> its own origin via _scene_origin, writes its
# own facade dir) without touching the shared working files. Defaults = the Dahill working set.
SCENE = os.environ.get("SVF_SCENE") or os.path.join(ROOT, "src", "assets", "scene.json")
CACHE = os.path.join(ROOT, "scripts", "_cache")
OUT_DIR = os.environ.get("SVF_OUT") or os.path.join(ROOT, "exports", "sv_facades")
MANIFEST = os.environ.get("SVF_MANIFEST") or os.path.join(ROOT, "exports", "sv_facades.json")


# Per-scene origin — school/place exports (canyon, stanton, meemaw) carry their own
# origin in scene.json so the SV camera lands at the right real-world spot. Fall back
# to the Dahill origin. MUST match export_property_glb.mjs's S.origin handling.
def _scene_origin():
    try:
        o = json.load(open(SCENE)).get("origin") or {}
        return float(o["lat"]), float(o["lon"])
    except Exception:
        return 37.6835313, -122.0686199


LAT0, LON0 = _scene_origin()
COSLAT = math.cos(math.radians(LAT0))

# --- tuning ---------------------------------------------------------------
# Default: fetch EVERY road-facing building in the patch (user wants no missing facades). The old
# 400 cap silently dropped ~896 of dahill's ~1297 road-facing buildings to blank stucco. Metadata
# probes are free and image crops cache, so a one-time full fetch is bounded; pass a smaller N to cap.
N_NEAREST = int(sys.argv[1]) if len(sys.argv) > 1 else 100000
MAX_ROAD_DIST = 35.0      # wall faces a road only if nearest road point <= this
PANO_SNAP = 25.0          # snap P to pano if metadata pano is within this
MIN_WALL = 2.5            # skip slivers shorter than this (m)
IMG_W, IMG_H = 640, 512
PITCH = 6
FOV_MIN, FOV_MAX = 35.0, 90.0
CAM_EYE = 2.5   # Street View camera eye height above the road (m)
WALL_PAD = 0.6  # extra metres above the eave kept in the crop so the roof line reads

# --- wide-wall multi-tile capture ----------------------------------------
# The SV Static API caps a single image at 640 px wide, so a wide wall (downtown
# frontage / high-rise base up to ~90 m) captured in ONE shot is only ~7-20 px/m
# — well under the facade atlas's 40 px/m quality gate, so it's rejected and the
# building stays stucco. Fix: split a wide wall into N adjacent tiles, each PANNED
# from the SAME pano (one camera -> no lighting/parallax seam) with a narrow fov so
# each tile spends its 640 px on ~TILE_MAX_M of wall, then stitch left->right. A 90 m
# wall -> 7-8 tiles -> ~50 px/m at real resolution (no melty photo). Narrow walls
# (<= TILE_MAX_M) take N=1 and are byte-identical to the previous single-shot path.
TARGET_PPM = 50.0                 # aim comfortably above the atlas 40 px/m gate
TILE_MAX_M = IMG_W / TARGET_PPM    # ~12.8 m of wall per 640 px tile
MAX_TILES = 8                      # bound API cost; walls > ~100 m cap here
TILE_FOV_MIN = 12.0                # SV-static fov floor for a zoomed-in tile


def scene_fingerprint(scene):
    def r2(v):
        return f"{float(v or 0):.2f}"

    def r6(v):
        return f"{float(v or 0):.6f}"

    def pt(p):
        return [r2(p[0]), r2(p[1])]

    origin = scene.get("origin") or {}
    payload = {
        "origin": [r6(origin.get("lat")), r6(origin.get("lon"))],
        "center": pt(scene["center"]) if isinstance(scene.get("center"), list) else None,
        "buildings": [
            {
                "house": bool(b.get("house")),
                "h": r2(b.get("h")),
                "p": [pt(p) for p in b.get("p", [])],
            }
            for b in scene.get("buildings", [])
        ],
        "roads": [
            {
                "k": r.get("k") or "",
                "w": None if r.get("w") is None else r2(r.get("w")),
                "p": [pt(p) for p in r.get("p", [])],
            }
            for r in scene.get("roads", [])
        ],
    }
    return hashlib.sha1(json.dumps(payload, separators=(",", ":")).encode()).hexdigest()


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
    import time as _time
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return r.read()
        except Exception as e:  # transient SSL/network errors shouldn't kill a whole level fetch
            last = e
            _time.sleep(1.5 * (attempt + 1))
    raise last


def metadata(lat, lon):
    url = "https://maps.googleapis.com/maps/api/streetview/metadata?" + urllib.parse.urlencode(
        {"location": f"{lat:.7f},{lon:.7f}", "source": "outdoor", "key": KEY}
    )
    return json.loads(fetch(url))


def _valid_jpeg(data):
    """A flaky download can be truncated; PIL then crashes when the bytes are later re-encoded
    during the tile stitch. Force a full decode up front so we can reject + re-fetch bad bytes."""
    try:
        Image.open(io.BytesIO(data)).load()
        return True
    except Exception:
        return False


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
        data = open(cached, "rb").read()
        if _valid_jpeg(data):
            return data, True
        try:                       # truncated cache from an earlier flaky fetch — drop + re-fetch
            os.remove(cached)
        except OSError:
            pass
    url = "https://maps.googleapis.com/maps/api/streetview?" + urllib.parse.urlencode(params)
    data = fetch(url)
    os.makedirs(CACHE, exist_ok=True)
    if _valid_jpeg(data):          # only cache COMPLETE images so a bad fetch can't poison the cache
        open(cached, "wb").write(data)
    return data, False


def main():
    scene = json.load(open(SCENE))
    fingerprint = scene_fingerprint(scene)
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

    def crop_to_wall(jpg, d, fov, wallH, wallW, wall_ang=None):
        """Crop the SV image to EXACTLY the front-wall rectangle so the panel shows ONLY the
        wall face (no roof, no sky, no neighbours): horizontally to the wall's angular width
        centred on the camera heading, vertically from ground (y=0) to the eave (y=wallH) under
        the pinhole model. The crop then maps 1:1 onto the wall quad (no roof pad).
        `wall_ang` (deg) overrides the horizontal angular width — a multi-tile capture passes the
        tile SEGMENT's angular span (which is foreshortened on oblique end tiles) instead of the
        head-on width derived from wallW."""
        fov_v = 2.0 * math.degrees(math.atan(math.tan(math.radians(fov / 2.0)) * IMG_H / IMG_W))

        def vrow(y):
            ang = math.degrees(math.atan2(y - CAM_EYE, d))  # elevation above horizontal
            rel = ang - PITCH                                # relative to optical axis
            return min(1.0, max(0.0, 0.5 - rel / fov_v))     # top->bottom in [0,1]

        # The modeled wallH (from unreliable OSM heights) sits ABOVE the real eave in the photo,
        # so vrow(wallH) lands in the ROOF. Crop the top to a conservative eave fraction so the
        # roofline/sky never bleeds onto the wall (loses at most a sliver of wall top), and never
        # crop above the horizon (v>=0.5) since a street-captured house wall is below it.
        v_top = max(0.5, vrow(wallH * 0.68))   # conservative eave — keeps roof OFF the wall
        # Stop ~0.3 m above the true ground line, not at y=0: that trims the curb / grass strip /
        # foreground apron AND the Google watermark band (both sit in the bottom slice) so the panel
        # is wall siding, not pavement. The 3D wall foot still meets the terrain underneath.
        v_bot = vrow(0.3)
        # horizontal: wall is centred on the heading and spans this fraction of the H-fov
        if wall_ang is None:
            wall_ang = 2.0 * math.degrees(math.atan((wallW / 2.0) / d))
        frac = min(1.0, wall_ang / fov)
        u_lo, u_hi = 0.5 - frac / 2.0, 0.5 + frac / 2.0
        im = Image.open(io.BytesIO(jpg)).convert("RGB")
        x0 = max(0, min(IMG_W - 2, int(round(u_lo * IMG_W))))
        x1 = max(x0 + 2, min(IMG_W, int(round(u_hi * IMG_W))))
        y0 = max(0, min(IMG_H - 2, int(round(v_top * IMG_H))))
        y1 = max(y0 + 2, min(IMG_H, int(round(v_bot * IMG_H))))
        crop = im.crop((x0, y0, x1, y1))
        buf = io.BytesIO()
        crop.save(buf, format="JPEG", quality=90)
        return buf.getvalue()

    def _angdiff(a, b):
        return (a - b + 180.0) % 360.0 - 180.0   # signed degrees in (-180, 180]

    def capture_wall(P, lat, lon, A, B, wallW, wallH, d_mid, heading_mid, fov_mid):
        """Return (crop_jpeg_bytes, n_tiles, all_cached). For a wall wider than TILE_MAX_M, pan
        the SAME pano across the wall in N adjacent tiles and stitch them left->right (A->B), so
        the captured wall gets ~TARGET_PPM px/m instead of being squeezed into one 640 px frame.
        N==1 reproduces the previous single-shot path exactly (narrow walls unchanged)."""
        n = max(1, min(MAX_TILES, int(math.ceil(wallW / TILE_MAX_M))))
        if n == 1:
            data, cached = fetch_image(lat, lon, heading_mid, fov_mid, PITCH)
            return crop_to_wall(data, d_mid, fov_mid, wallH, wallW), 1, cached
        Ax, Az = A
        Bx, Bz = B
        Pen = world_to_en(*P)
        crops = []
        all_cached = True
        for k in range(n):
            t0, t1 = k / n, (k + 1) / n
            sAx, sAz = Ax + t0 * (Bx - Ax), Az + t0 * (Bz - Az)
            sBx, sBz = Ax + t1 * (Bx - Ax), Az + t1 * (Bz - Az)
            sMx, sMz = (sAx + sBx) / 2.0, (sAz + sBz) / 2.0
            sA_en, sB_en, sM_en = world_to_en(sAx, sAz), world_to_en(sBx, sBz), world_to_en(sMx, sMz)
            bA = math.degrees(math.atan2(sA_en[0] - Pen[0], sA_en[1] - Pen[1]))
            bB = math.degrees(math.atan2(sB_en[0] - Pen[0], sB_en[1] - Pen[1]))
            seg_ang = abs(_angdiff(bA, bB))                       # tile's angular span from P
            hdg = math.degrees(math.atan2(sM_en[0] - Pen[0], sM_en[1] - Pen[1])) % 360.0
            fov_t = max(TILE_FOV_MIN, min(FOV_MAX, seg_ang * 1.06))   # frame the segment + 6% pad
            d_t = math.hypot(P[0] - sMx, P[1] - sMz) or 1.0
            data, cached = fetch_image(lat, lon, hdg, fov_t, PITCH)
            all_cached = all_cached and cached
            crops.append(crop_to_wall(data, d_t, fov_t, wallH, wallW, wall_ang=seg_ang))
        # stitch: normalise every tile to a common height, concat in A->B order
        ims = [Image.open(io.BytesIO(c)).convert("RGB") for c in crops]
        Hc = max(im.height for im in ims)
        ims = [im.resize((max(2, int(round(im.width * Hc / im.height))), Hc)) for im in ims]
        Wt = sum(im.width for im in ims)
        canvas = Image.new("RGB", (Wt, Hc))
        x = 0
        for im in ims:
            canvas.paste(im, (x, 0))
            x += im.width
        out = io.BytesIO()
        canvas.save(out, format="JPEG", quality=90)
        return out.getvalue(), n, all_cached

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
    # house anchor is optional — schools/places may have no house:true building. Without one,
    # rank by distance to the scene centre (world origin) so the whole patch is still covered.
    house_idx = next((i for i, b in enumerate(buildings) if b.get("house")), None)
    hcw = w2(*centroid(buildings[house_idx]["p"])) if house_idx is not None else (0.0, 0.0)

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
    targets = ([house_idx] if house_idx is not None else []) + [ib for _, ib in ranked[:N_NEAREST]]

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
            # the wall must face the road AND be reasonably HEAD-ON. A perspective SV photo of a
            # grazing/oblique wall foreshortens badly and maps onto the flat quad as a smeared or
            # black panel. Require the camera ray within ~48 deg of the wall normal; more-oblique
            # walls fall back to the clean stylized wall colour (a side wall physically has no
            # head-on street capture, so a photo there can never look right).
            dPM = math.hypot(P[0] - M[0], P[1] - M[1]) or 1.0
            cos_face = (nrm[0] * (P[0] - M[0]) + nrm[1] * (P[1] - M[1])) / dPM
            if cos_face < 0.58:   # ~54 deg max obliquity (was 0.67/~48): recover corner-lot &
                continue          # cul-de-sac walls whose only pano is oblique (the content gates
                                  # below still reject any genuinely smeared/blurry crop)

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

            wallH = wall_height(b)
            try:
                cropped, n_tiles, cached = capture_wall(P, lat, lon, A, B, wallW, wallH, d, heading, fov)
            except Exception as _e:   # a corrupt tile or transient failure skips THIS wall, never the run
                print(f"  b{ib} e{i}: capture failed ({type(_e).__name__}) skip")
                continue
            n_cache += cached
            n_fetch += (not cached)
            # skip facades whose crop is too DARK — deep-shadow / north-facing walls render as black
            # panels; they fall back to the clean stylized wall colour instead.
            _g = Image.open(io.BytesIO(cropped)).convert("L")
            _bright = sum(_g.getdata()) / max(1, _g.width * _g.height)
            if _bright < 58:
                print(f"  b{ib} e{i}: facade too dark ({_bright:.0f}) skip")
                continue
            # skip facades dominated by VEGETATION: set-back houses whose "wall band" is really the
            # front yard / bushes rather than a wall. Those fall back to the clean stylized wall colour,
            # so the photos that DO show are real walls (the user: make sure every photo fits).
            _rgb = Image.open(io.BytesIO(cropped)).convert("RGB").resize((48, 24))
            _pix = list(_rgb.getdata())
            _green = sum(1 for (r, g, b) in _pix if g > r * 1.06 and g > b * 1.10)
            if _green > 0.45 * len(_pix):
                print(f"  b{ib} e{i}: facade too green/vegetation ({100 * _green // len(_pix)}%) skip")
                continue
            # skip FLAT/BLURRY crops (featureless gray/blue panels from privacy-blurred or far walls):
            # a real wall has windows/edges -> meaningful luminance variance. Low std = no wall content.
            _lum = list(_g.resize((64, 32)).getdata())
            _mean = sum(_lum) / len(_lum)
            _std = (sum((v - _mean) ** 2 for v in _lum) / len(_lum)) ** 0.5
            if _std < 22:
                print(f"  b{ib} e{i}: facade too flat/blurry (std {_std:.0f}) skip")
                continue
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
                    # cropped image is EXACTLY the wall rectangle (eave->ground, wall width), so it
                    # maps 1:1 onto the wall quad: U 0..1 = wall left..right, V 0=eave .. 1=ground.
                    "image": os.path.join("sv_facades", fname),
                    "wallH": round(wallH, 2),
                    "heading": round(heading, 1),
                    "fov": round(fov, 1),
                    "dist": round(d, 1),
                    "wallW": round(wallW, 1),
                    "crop_kind": "wall-only-ground-to-eave",
                    "crop_v": [0.0, 1.0],
                    "date": meta.get("date", ""),
                }
            )
            tag = "cache" if cached else "fetch"
            print(
                f"  b{ib} e{i}: w={wallW:4.1f} d={d:4.1f} hdg={heading:5.1f} fov={fov:4.1f} x{n_tiles} [{tag}] {meta.get('date','?')}"
            )

    json.dump(
        {
            "note": "Street View facades for playable-core walls; consumed by export_property_glb.mjs",
            "scene_fingerprint": fingerprint,
            "crop_kind": "wall-only-ground-to-eave",
            "uv": "U wall-left-to-right, V 0=eave, V 1=ground",
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
