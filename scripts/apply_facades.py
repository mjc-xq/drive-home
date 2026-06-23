#!/usr/bin/env python3
"""Vision-located facade extractor — STEP 3 (apply): rectify accepted walls + rebuild the manifest
and per-wall colors. Deterministic; no network, no model calls.

Reads the per-wall vision results (b<ib>_e<i>.vision.json from detect_facade_corners.py OR a Claude
workflow) next to the wide frames, and the LEGACY street-facing manifest (sv_facades.unfiltered.json)
which already carries each wall's A/B footprint + heading/fov/dist/wallW/wallH in the exporter's frame.
For every wall:
  - ACCEPTED (vision not reject + 4 valid corners + passes QC): perspective-rectify the wide frame to
    the wall aspect (PIL QUAD) -> <leveldir>/sv_facades/b<ib>_e<i>.jpg, and KEEP it in the new manifest.
  - REJECTED / no-vision / QC-fail: dropped from the manifest -> the wall renders as procedural stucco.
  - wall_color (from vision) recorded per (building,edge) -> wall_colors.json, and the per-building
    MEDIAN overrides buildings_color.json so the stucco tint matches the real building (the user's
    "pull the color wall-by-wall" ask). Buildings with no vision color keep their existing color.

Env:
  FF_DIR       wide-frame + vision dir (default exports/xq/sv_wide)
  FF_LEVELDIR  level export dir (default exports/xq) — holds sv_facades/, sv_facades.json, colors
  FF_PXPERM    rectify px/m (default 40)
"""
import glob
import json
import math
import os
import statistics
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.environ.get("FF_DIR") or os.path.join(ROOT, "exports", "xq", "sv_wide")
LEVELDIR = os.environ.get("FF_LEVELDIR") or os.path.join(ROOT, "exports", "xq")
PXPERM = float(os.environ.get("FF_PXPERM", "40"))
OUT_FACADES = os.path.join(LEVELDIR, "sv_facades")
UNFILTERED = os.path.join(LEVELDIR, "sv_facades.unfiltered.json")


def hex_to_rgb01(h):
    if not h or not isinstance(h, str):
        return None
    h = h.strip().lstrip("#")
    if len(h) != 6:
        return None
    try:
        return [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    except ValueError:
        return None


def rectify(wide_path, corners, wallW, wallH, out_path):
    """PIL QUAD warp of [TL,TR,BR,BL] -> head-on rect at wall aspect. Returns (w,h,std) or None."""
    img = Image.open(wide_path).convert("RGB")
    out_w = max(8, round(wallW * PXPERM))
    out_h = max(8, round(wallH * PXPERM))
    TL, TR, BR, BL = corners
    data = (TL[0], TL[1], BL[0], BL[1], BR[0], BR[1], TR[0], TR[1])  # UL,LL,LR,UR -> source
    out = img.transform((out_w, out_h), Image.QUAD, data, resample=Image.BICUBIC)
    # QC: luminance std (void/flat detect) on a downsample
    g = out.convert("L").resize((64, 32))
    px = list(g.getdata())
    mean = sum(px) / len(px)
    std = (sum((v - mean) ** 2 for v in px) / len(px)) ** 0.5
    out.save(out_path, format="JPEG", quality=92)
    return out_w, out_h, std


def valid_corners(c):
    if not isinstance(c, list) or len(c) != 4:
        return False
    for p in c:
        if not isinstance(p, list) or len(p) != 2:
            return False
        if not all(isinstance(v, (int, float)) for v in p):
            return False
    # non-degenerate area
    xs = [p[0] for p in c]
    ys = [p[1] for p in c]
    return (max(xs) - min(xs)) > 6 and (max(ys) - min(ys)) > 6


def main():
    if not os.path.exists(UNFILTERED):
        sys.exit(f"missing legacy manifest {UNFILTERED}")
    base = json.load(open(UNFILTERED))
    walls_in = base.get("walls", [])
    os.makedirs(OUT_FACADES, exist_ok=True)

    kept, rejected, novision, qcfail = [], 0, 0, 0
    wall_colors = {}            # "ib_ie" -> [r,g,b]
    by_building = {}            # ib -> [ [r,g,b], ... ]

    for w in walls_in:
        ib, ie = w["building"], w["edge"]
        vj = os.path.join(DIR, f"b{ib}_e{ie}.vision.json")
        wide = os.path.join(DIR, f"b{ib}_e{ie}_wide.jpg")
        if not os.path.exists(vj):
            novision += 1
            continue
        v = json.load(open(vj))

        # color (recorded even if the facade is rejected — drives the procedural stucco tint)
        rgb = hex_to_rgb01(v.get("wall_color"))
        if rgb:
            wall_colors[f"{ib}_{ie}"] = [round(x, 4) for x in rgb]
            by_building.setdefault(ib, []).append(rgb)

        if v.get("reject") or not valid_corners(v.get("corners")) or not os.path.exists(wide):
            rejected += 1
            continue
        out_img = os.path.join(OUT_FACADES, f"b{ib}_e{ie}.jpg")
        try:
            ow, oh, std = rectify(wide, v["corners"], w["wallW"], w["wallH"], out_img)
        except Exception as e:
            qcfail += 1
            print(f"  b{ib}_e{ie}: rectify error {type(e).__name__} -> drop", file=sys.stderr)
            continue
        if std < 12:                       # void / featureless -> drop to procedural
            qcfail += 1
            try:
                os.remove(out_img)
            except OSError:
                pass
            continue
        nw = dict(w)
        nw["image"] = os.path.join("sv_facades", f"b{ib}_e{ie}.jpg")
        nw["crop_kind"] = "vision-rectified"
        nw["crop_v"] = [0.0, 1.0]
        kept.append(nw)

    # ---- write the new facade manifest (drop-in for the exporter) ----
    out = dict(base)
    out["walls"] = kept
    out["count"] = len(kept)
    out["crop_kind"] = "vision-rectified"
    out["vision_apply"] = {"kept": len(kept), "rejected": rejected, "qcfail": qcfail,
                           "novision": novision, "total": len(walls_in)}
    json.dump(out, open(os.path.join(LEVELDIR, "sv_facades.json"), "w"), indent=1)

    # ---- per-wall colors + per-building median override ----
    json.dump(wall_colors, open(os.path.join(LEVELDIR, "wall_colors.json"), "w"), indent=1)
    bc_path = os.path.join(LEVELDIR, "buildings_color.json")
    bc = json.load(open(bc_path)) if os.path.exists(bc_path) else {}
    src_path = os.path.join(LEVELDIR, "buildings_color_src.json")
    src = json.load(open(src_path)) if os.path.exists(src_path) else {}
    updated = 0
    for ib, cols in by_building.items():
        med = [round(statistics.median([c[k] for c in cols]), 4) for k in range(3)]
        bc[str(ib)] = med
        src[str(ib)] = "sv-wall"
        updated += 1
    json.dump(bc, open(bc_path, "w"), indent=1)
    json.dump(src, open(src_path, "w"), indent=1)

    print(f"[{os.path.basename(LEVELDIR)}] facades kept {len(kept)}/{len(walls_in)} "
          f"(rejected {rejected}, qcfail {qcfail}, no-vision {novision}); "
          f"wall colors {len(wall_colors)} on {updated} buildings -> buildings_color.json")


if __name__ == "__main__":
    main()
