#!/usr/bin/env python3
"""Vision-located street-view facade extractor — STEP 1 (raw wide frame + prior quad).

For each (building ib, edge i) selected by the existing street-facing logic, fetch ONE
WIDE raw 640x512 Street View frame that contains the whole building wall + ~30% margin
(roofline + a little ground), and compute the geometry-prior pixel quad (the 4 wall
corners projected into the image under the pinhole model). NO cropping, NO quality gate,
NO multi-tile stitch — the raw frame and the prior quad are handed to the vision step.

Reuses the verified formulas + secret-key rules from scripts/fetch_sv_facades.py:
  load_key (env first, then .env.local), fetch (retry transient), fetch_image (caches
  under scripts/_cache with a cache key that OMITS the secret + validates the JPEG),
  w2/world_to_en (flat-ENU <-> world, with the Z flip + scene center C), en_to_ll,
  centroid, wall_height, nearest_road, the ring de-dup, the metadata pano-snap, and the
  heading atan2(dEast,dNorth) % 360.

SECRET-KEY RULE (mandatory): the SV key is NEXT_PUBLIC_GOOGLE_MAPS_API_KEY in .env.local.
It is read via load_key() and is NEVER printed, logged, written to a manifest, included in
a cache key, or echoed in a URL. GOOGLE_GENERATIVE_AI_API_KEY is never read or referenced.

Usage:
  scripts/.venv/bin/python scripts/proto_facade_fetch.py 233,1 220,3 109,2
  scripts/.venv/bin/python scripts/proto_facade_fetch.py --build 233 --edge 1 [...]
  scripts/.venv/bin/python scripts/proto_facade_fetch.py --all
env: SVF_SCENE (default exports/xq/scene.json), SVF_OUT (default exports/xq/_proto_facades)
"""
import io
import json
import math
import os
import shutil
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENE = os.environ.get("SVF_SCENE") or os.path.join(ROOT, "exports", "xq", "scene.json")
OUT_DIR = os.environ.get("SVF_OUT") or os.path.join(ROOT, "exports", "xq", "_proto_facades")
# the existing (legacy crop) facades — used ONLY as the fallback source when a fresh fetch fails
LEGACY_FACADES = os.environ.get("SVF_LEGACY") or os.path.join(ROOT, "exports", "xq", "sv_facades")
CACHE = os.path.join(ROOT, "scripts", "_cache")

# constants — reused verbatim from fetch_sv_facades.py
IMG_W, IMG_H = 640, 512
PITCH = 6
CAM_EYE = 2.5
PANO_SNAP = 25.0
MAX_ROAD_DIST = 35.0
MIN_WALL = 2.5
MARGIN = 1.30          # ~30% extra context around the wall
FOV_MIN, FOV_MAX = 20.0, 110.0   # wider clamp than the legacy 35..90 so the margin isn't clipped


# --- scene origin (per-scene, falls back to Dahill) -----------------------
def _scene_origin():
    try:
        o = json.load(open(SCENE)).get("origin") or {}
        return float(o["lat"]), float(o["lon"])
    except Exception:
        return 37.6835313, -122.0686199


LAT0, LON0 = _scene_origin()
COSLAT = math.cos(math.radians(LAT0))


# --- secret key (mirror fetch_sv_facades.load_key 120-129) ----------------
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
    """Retry transient SSL/network errors (mirror fetch_sv_facades.fetch 140-150)."""
    import time as _time
    import urllib.request
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return r.read()
        except Exception as e:
            last = e
            _time.sleep(1.5 * (attempt + 1))
    raise last


def metadata(lat, lon):
    import urllib.parse
    url = "https://maps.googleapis.com/maps/api/streetview/metadata?" + urllib.parse.urlencode(
        {"location": f"{lat:.7f},{lon:.7f}", "source": "outdoor", "key": KEY}
    )
    return json.loads(fetch(url))


def _valid_jpeg(data):
    try:
        Image.open(io.BytesIO(data)).load()
        return True
    except Exception:
        return False


def fetch_image(lat, lon, heading, fov, pitch):
    """Fetch one raw 640x512 SV Static frame. Caches under scripts/_cache with a cache
    key that OMITS the secret (mirror line 181); validates the JPEG before caching."""
    import hashlib
    import urllib.parse
    params = {
        "size": f"{IMG_W}x{IMG_H}",
        "location": f"{lat:.7f},{lon:.7f}",
        "heading": f"{heading:.1f}",
        "fov": f"{fov:.1f}",
        "pitch": f"{pitch}",
        "source": "outdoor",
        "key": KEY,
    }
    ckey = "&".join(f"{k}={v}" for k, v in params.items() if k != "key")  # secret omitted
    h = hashlib.sha1(ckey.encode()).hexdigest()[:16]
    cached = os.path.join(CACHE, f"sv_{h}.jpg")
    if os.path.exists(cached) and os.path.getsize(cached) > 1000:
        data = open(cached, "rb").read()
        if _valid_jpeg(data):
            return data, True
        try:
            os.remove(cached)
        except OSError:
            pass
    url = "https://maps.googleapis.com/maps/api/streetview?" + urllib.parse.urlencode(params)
    data = fetch(url)
    os.makedirs(CACHE, exist_ok=True)
    if _valid_jpeg(data):
        open(cached, "wb").write(data)
    return data, False


# --- world <-> ENU (need scene center C; bound after scene load) ----------
def _make_frame(C):
    def w2(e, n):
        return (e - C[0], -(n - C[1]))

    def world_to_en(X, Z):
        return (X + C[0], C[1] - Z)

    return w2, world_to_en


def centroid(p):
    return (sum(q[0] for q in p) / len(p), sum(q[1] for q in p) / len(p))


def wall_height(b):
    # mirror export_property_glb.mjs wallHeight() / fetch_sv_facades.wall_height (214-218)
    H = b.get("h") or 4.5
    r = b.get("r")
    return (max(2.4, H * 0.8) if (r and len(r)) else H) + 0.5


def project_corner(Wx, Wy, Wz, P, world_to_en, heading, fov):
    """Pinhole projection of one world corner -> (u,v) pixels. CAM_EYE=2.5, PITCH=6.
    Raw (possibly out-of-frame) value is returned as the true prior."""
    We, Wn = world_to_en(Wx, Wz)
    Pe, Pn = world_to_en(P[0], P[1])
    dE = We - Pe
    dN = Wn - Pn
    dY = Wy - CAM_EYE
    hr = math.radians(heading)
    forward = dN * math.cos(hr) + dE * math.sin(hr)
    right = dE * math.cos(hr) - dN * math.sin(hr)
    pr = math.radians(PITCH)
    Zc = forward * math.cos(pr) + dY * math.sin(pr)
    Yc = -forward * math.sin(pr) + dY * math.cos(pr)
    Xc = right
    if abs(Zc) < 1e-6:
        Zc = 1e-6
    fx = (IMG_W / 2.0) / math.tan(math.radians(fov / 2.0))
    fov_v = 2.0 * math.degrees(math.atan(math.tan(math.radians(fov / 2.0)) * (IMG_H / IMG_W)))
    fy = (IMG_H / 2.0) / math.tan(math.radians(fov_v / 2.0))
    u = IMG_W / 2.0 + fx * (Xc / Zc)
    v = IMG_H / 2.0 - fy * (Yc / Zc)
    return [round(u, 1), round(v, 1)]


def parse_args(argv):
    """Return (ids:list[(ib,i)], do_all:bool). Accepts BUILD,EDGE pairs and/or
    --build B --edge I pairs, or --all."""
    ids = []
    do_all = False
    i = 0
    pending_build = None
    while i < len(argv):
        a = argv[i]
        if a == "--all":
            do_all = True
            i += 1
        elif a == "--build":
            pending_build = int(argv[i + 1])
            i += 2
        elif a == "--edge":
            if pending_build is None:
                sys.exit("--edge given without a preceding --build")
            ids.append((pending_build, int(argv[i + 1])))
            pending_build = None
            i += 2
        elif "," in a:
            b, e = a.split(",", 1)
            ids.append((int(b), int(e)))
            i += 1
        else:
            sys.exit(f"unrecognized arg: {a}")
    return ids, do_all


def street_facing_ids(scene, w2, world_to_en, nearest_road):
    """Every street-facing (ib,i) — same selection logic as fetch_sv_facades:
    house + N-nearest near-a-road, walk every edge, keep edges whose outward normal
    faces the road within MAX_ROAD_DIST and >= MIN_WALL wide and reasonably head-on."""
    buildings = scene["buildings"]
    house_idx = next((i for i, b in enumerate(buildings) if b.get("house")), None)
    hcw = w2(*centroid(buildings[house_idx]["p"])) if house_idx is not None else (0.0, 0.0)
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
    targets = ([house_idx] if house_idx is not None else []) + [ib for _, ib in ranked]
    out = []
    for ib in targets:
        b = buildings[ib]
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
            n1 = (-ez / wallW, ex / wallW)
            toC = (cw[0] - M[0], cw[1] - M[1])
            nrm = n1 if (n1[0] * toC[0] + n1[1] * toC[1]) < 0 else (-n1[0], -n1[1])
            droad, P = nearest_road(*M)
            if P is None or droad > MAX_ROAD_DIST:
                continue
            dPM = math.hypot(P[0] - M[0], P[1] - M[1]) or 1.0
            cos_face = (nrm[0] * (P[0] - M[0]) + nrm[1] * (P[1] - M[1])) / dPM
            if cos_face < 0.58:
                continue
            out.append((ib, i))
    return out


def compute_one(scene, w2, world_to_en, nearest_road, ib, i):
    """Recipe steps 3-7 with the WIDE fov. Returns a prior dict (no secret) plus
    lat/lon/heading/fov for the fetch, or None if the wall is not road-facing."""
    b = scene["buildings"][ib]
    en_ring = list(b["p"])
    if len(en_ring) > 1 and en_ring[0] == en_ring[-1]:
        en_ring.pop()
    ring = [w2(e, n) for e, n in en_ring]
    n = len(ring)
    if i >= n:
        return None
    A = ring[i]
    B = ring[(i + 1) % n]
    ex = B[0] - A[0]
    ez = B[1] - A[1]
    wallW = math.hypot(ex, ez)
    if wallW < MIN_WALL:
        return None
    M = ((A[0] + B[0]) / 2.0, (A[1] + B[1]) / 2.0)
    wallH = wall_height(b)

    droad, P = nearest_road(*M)
    if P is None or droad > MAX_ROAD_DIST:
        return None

    # pano-snap (lines 391-405): move P onto a nearby pano for a better photo
    e, nn = world_to_en(*P)
    lat, lon = en_to_ll(e, nn)
    try:
        meta = metadata(lat, lon)
    except Exception:
        meta = {"status": "ERROR"}
    if meta.get("status") == "OK":
        ploc = meta["location"]
        from_e = (ploc["lng"] - LON0) * COSLAT * 111320.0
        from_n = (ploc["lat"] - LAT0) * 110540.0
        pano_w = w2(from_e, from_n)
        if math.hypot(pano_w[0] - P[0], pano_w[1] - P[1]) <= PANO_SNAP:
            P = pano_w
            lat, lon = ploc["lat"], ploc["lng"]

    d = math.hypot(P[0] - M[0], P[1] - M[1])
    d = max(d, 1.0)
    Men = world_to_en(*M)
    Pen = world_to_en(*P)
    heading = math.degrees(math.atan2(Men[0] - Pen[0], Men[1] - Pen[1])) % 360.0

    # WIDE fov: max(width+30%, ground->roofline+30% converted to horizontal), clamped
    fov_h_wall = 2.0 * math.degrees(math.atan((wallW / 2.0 * MARGIN) / d))
    ang_top = math.degrees(math.atan2(wallH - CAM_EYE, d))
    ang_bot = math.degrees(math.atan2(0.0 - CAM_EYE, d))
    fov_v_need = (ang_top - ang_bot) * MARGIN
    fov_h_from_v = 2.0 * math.degrees(
        math.atan(math.tan(math.radians(fov_v_need / 2.0)) * (IMG_W / IMG_H))
    )
    fov = max(fov_h_wall, fov_h_from_v)
    fov = max(FOV_MIN, min(FOV_MAX, fov))

    Ax, Az = A
    Bx, Bz = B
    q_At = project_corner(Ax, wallH, Az, P, world_to_en, heading, fov)
    q_Bt = project_corner(Bx, wallH, Bz, P, world_to_en, heading, fov)
    q_Bg = project_corner(Bx, 0.0, Bz, P, world_to_en, heading, fov)
    q_Ag = project_corner(Ax, 0.0, Az, P, world_to_en, heading, fov)

    return {
        "building": ib,
        "edge": i,
        "P_world": [round(P[0], 3), round(P[1], 3)],
        "lat": lat,
        "lon": lon,
        "heading": round(heading, 1),
        "fov": round(fov, 1),
        "pitch": PITCH,
        "dist": round(d, 1),
        "wallW": round(wallW, 1),
        "wallH": round(wallH, 2),
        "image_size": [IMG_W, IMG_H],
        "prior_quad_px": [q_At, q_Bt, q_Bg, q_Ag],
        "corners_world": {
            "A_ground": [round(Ax, 3), 0.0, round(Az, 3)],
            "B_ground": [round(Bx, 3), 0.0, round(Bz, 3)],
            "A_top": [round(Ax, 3), round(wallH, 3), round(Az, 3)],
            "B_top": [round(Bx, 3), round(wallH, 3), round(Bz, 3)],
        },
    }


def draw_prior_overlay(raw_bytes, prior):
    """Raw frame with the magenta prior quad + corner labels A_top/B_top/B_ground/A_ground.
    The A/B labels are load-bearing: they define the left/right pixel convention."""
    im = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    draw = ImageDraw.Draw(im)
    q = prior["prior_quad_px"]            # [A_top, B_top, B_ground, A_ground]
    labels = ["A_top", "B_top", "B_ground", "A_ground"]
    magenta = (255, 0, 255)
    pts = [(p[0], p[1]) for p in q]
    for k in range(4):
        a = pts[k]
        bp = pts[(k + 1) % 4]
        draw.line([a, bp], fill=magenta, width=3)
    for k, (px, py) in enumerate(pts):
        r = 4
        draw.ellipse([px - r, py - r, px + r, py + r], outline=magenta, width=2)
        tx = min(max(px + 5, 0), IMG_W - 60)
        ty = min(max(py - 6, 0), IMG_H - 12)
        draw.text((tx, ty), labels[k], fill=magenta)
    return im


def main():
    ids, do_all = parse_args(sys.argv[1:])
    scene = json.load(open(SCENE))
    C = scene["center"]
    w2, world_to_en = _make_frame(C)

    # road segments in world XZ (lines 306-329)
    roadsegs = []
    for r in scene["roads"]:
        pl = r["p"] if isinstance(r, dict) else r
        if not isinstance(pl, list) or len(pl) < 2:
            continue
        wp = [w2(e, nn) for e, nn in pl]
        for a, bb in zip(wp, wp[1:]):
            roadsegs.append((a, bb))

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
            dd = math.hypot(px - cx, pz - cz)
            if dd < best:
                best = dd
                bp = (cx, cz)
        return best, bp

    if do_all:
        ids = street_facing_ids(scene, w2, world_to_en, nearest_road)

    if not ids:
        sys.exit("no (building,edge) ids — pass BUILD,EDGE pairs or --all")

    os.makedirs(OUT_DIR, exist_ok=True)
    fell_back = []
    for ib, i in ids:
        raw_name = f"b{ib}_e{i}_wide.jpg"
        raw_path = os.path.join(OUT_DIR, raw_name)
        prior_name = f"b{ib}_e{i}.prior.json"
        prior_path = os.path.join(OUT_DIR, prior_name)
        overlay_name = f"b{ib}_e{i}.prior_overlay.jpg"
        overlay_path = os.path.join(OUT_DIR, overlay_name)

        prior = compute_one(scene, w2, world_to_en, nearest_road, ib, i)
        used_fallback = False
        if prior is None:
            # wall not road-facing / too short — try the geometry anyway for a fallback copy
            used_fallback = True
        else:
            try:
                jpg, _ = fetch_image(prior["lat"], prior["lon"], prior["heading"], prior["fov"], PITCH)
                if not _valid_jpeg(jpg):
                    raise ValueError("invalid jpeg")
                open(raw_path, "wb").write(jpg)
                # prior overlay
                try:
                    ov = draw_prior_overlay(jpg, prior)
                    ov.save(overlay_path, format="JPEG", quality=92)
                except Exception:
                    pass
                # write prior.json (image field points at the raw frame)
                prior_out = dict(prior)
                prior_out["image"] = raw_name
                json.dump(prior_out, open(prior_path, "w"), indent=1)
            except Exception as ex:
                used_fallback = True
                print(f"# b{ib} e{i}: fresh fetch failed ({type(ex).__name__}: {ex}) -> fallback", file=sys.stderr)

        if used_fallback:
            # COPY the existing legacy facade to the _wide.jpg path as fallback
            src = os.path.join(LEGACY_FACADES, f"b{ib}_e{i}.jpg")
            if os.path.exists(src):
                shutil.copyfile(src, raw_path)
                fell_back.append((ib, i))
                # still emit a prior.json if geometry resolved, so step 2 has the prior
                if prior is not None:
                    prior_out = dict(prior)
                    prior_out["image"] = raw_name
                    prior_out["fallback"] = True
                    json.dump(prior_out, open(prior_path, "w"), indent=1)
            else:
                print(f"# b{ib} e{i}: NO fallback (legacy {src} missing) — skipped", file=sys.stderr)
                continue

        line = {
            "building": ib,
            "edge": i,
            "raw": raw_path,
            "prior": prior_path if (prior is not None) else None,
            "overlay": overlay_path if (prior is not None and not used_fallback) else None,
            "wallW": prior["wallW"] if prior else None,
            "wallH": prior["wallH"] if prior else None,
            "dist": prior["dist"] if prior else None,
            "fov": prior["fov"] if prior else None,
            "fallback": used_fallback,
        }
        print(json.dumps(line))

    if fell_back:
        print(
            "# fell back to legacy facade for ids: "
            + ", ".join(f"b{ib}_e{i}" for ib, i in fell_back),
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
