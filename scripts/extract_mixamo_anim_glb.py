#!/usr/bin/env python3
"""Batch-extract SMALL, character-agnostic animation GLBs from Mixamo anim-only FBX.

The Mixamo bulk downloader fetches each clip WITHOUT skin (skeleton + 1 action, no mesh).
This turns each into a tiny GLB that ANY Mixamo-rigged character can use, with the SAME
technique the game's convert_mixamo_fbx.py uses for the character motion library:
  - strip the 'mixamorig:' prefix from bone names AND every fcurve data_path, so the clip
    binds to the shared plain-named skeleton (the project's canonical rig);
  - bake the FBX importer's 90deg object rotation so the exported root is identity/upright.

ONE Blender process loops the whole folder (fast). Per FBX -> <out>/<key>.glb (armature +
1 action, plain bones, NO mesh = small) + index.json {key: {name, frames, src_fbx, size}}.
The original FBX is untouched. RESUMABLE (skips keys already in index with a GLB on disk).

USAGE:
  Blender --background --python scripts/extract_mixamo_anim_glb.py -- <in_fbx_dir> <out_glb_dir> [limit]
"""
import json
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import convert_mixamo_fbx as cv  # reuse the exact strip/orient/export helpers


def parse():
    rest = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(rest) < 2:
        sys.exit("args after '--': <in_fbx_dir> <out_glb_dir> [limit]")
    indir, outdir = rest[0], rest[1]
    limit = int(rest[2]) if len(rest) > 2 else 0
    os.makedirs(outdir, exist_ok=True)
    return indir, outdir, limit


def main():
    indir, outdir, limit = parse()
    fbxs = sorted(f for f in os.listdir(indir) if f.lower().endswith(".fbx"))
    if limit:
        fbxs = fbxs[:limit]
    index_path = os.path.join(outdir, "index.json")
    index = json.load(open(index_path)) if os.path.exists(index_path) else {}

    ok = fail = 0
    for n, fname in enumerate(fbxs, 1):
        src = os.path.join(indir, fname)
        key = cv.clip_key(src)                       # no '@' -> clean whole-name key
        out = os.path.join(outdir, key + ".glb")
        if key in index and os.path.exists(out):
            continue                                  # resume
        try:
            cv.reset_scene()
            imported = cv.import_fbx(src)
            arm = cv.find_armature(imported)
            if arm is None:
                print(f"[xtract] {fname}: no armature, skip", flush=True); fail += 1; continue
            cv.strip_armature_bones(arm)
            cv.apply_armature_rotation(arm)

            act = None
            if arm.animation_data and arm.animation_data.action:
                act = arm.animation_data.action
            if act is None:
                acts = list(bpy.data.actions)
                act = max(acts, key=lambda a: len(list(cv.iter_fcurves(a)))) if acts else None
            if act is None:
                print(f"[xtract] {fname}: no action, skip", flush=True); fail += 1; continue

            cv.strip_action_fcurves(act)
            act.name = key
            act.use_fake_user = True

            bpy.ops.object.select_all(action="DESELECT")
            arm.select_set(True)
            bpy.context.view_layer.objects.active = arm
            if arm.animation_data is None:
                arm.animation_data_create()
            arm.animation_data.action = act

            cv.export_glb(out, animations=True, animation_mode="ACTIONS")
            lo, hi = cv.frame_range(act)
            index[key] = {
                "name": os.path.splitext(fname)[0],   # the Mixamo description
                "frames": [lo, hi],
                "src_fbx": fname,
                "size": os.path.getsize(out),
            }
            ok += 1
            if n % 25 == 0 or n == len(fbxs):
                json.dump(index, open(index_path, "w"), indent=0)
                print(f"[xtract] {n}/{len(fbxs)} ok={ok} fail={fail} last={key}.glb "
                      f"({index[key]['size']//1024}KB)", flush=True)
        except Exception as e:
            fail += 1
            print(f"[xtract] {fname}: ERR {str(e)[:90]}", flush=True)

    json.dump(index, open(index_path, "w"), indent=0)
    print(f"[xtract] DONE ok={ok} fail={fail} total_index={len(index)} -> {outdir}", flush=True)


main()
