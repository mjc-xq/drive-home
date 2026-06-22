#!/usr/bin/env python3
"""Headless Blender multi-angle renderer for QA of the neighborhood GLBs.

Imports a GLB and renders it from several angles (orbit + top + close-ups) with
EEVEE so z-fighting, wall/roof colours, facades, and window/door placement are
visible exactly as a game engine would show them (NO web-runtime polygon-offset
masking). Writes <out_prefix>_<view>.png for each view.

Usage (headless):
  /Applications/Blender.app/Contents/MacOS/Blender --background \
      --python scripts/render_glb_angles.py -- <glb> <out_prefix> [res]
"""
import math
import os
import sys

import bpy
import mathutils

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB = argv[0]
OUT = argv[1] if len(argv) > 1 else "/tmp/glb_render"
RES = int(argv[2]) if len(argv) > 2 else 1400


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)
    if os.environ.get("QA_KEEP_PROXIES"):
        return  # verify the raw GLB AS-IS (proves the alpha-MASK proxies are invisible in any viewer)
    # The game HIDES collision proxies + invisible LOD/helper meshes (Unity/web strip them);
    # a raw GLB viewer renders them and they z-fight the visual terrain. Delete them so this QA
    # render shows what the PLAYER actually sees (visual meshes only).
    doomed = []
    for ob in list(bpy.context.scene.objects):
        n = (ob.name or "").lower()
        if n.startswith(("collision", "lod_", "yourlots")) or "collision" in n:
            doomed.append(ob)
        elif ob.type == "MESH":
            # also drop fully-transparent helper materials (opacity-0 proxies)
            mats = [s.material for s in ob.material_slots if s.material]
            if mats and all(_is_invisible(m) for m in mats):
                doomed.append(ob)
    for ob in doomed:
        bpy.data.objects.remove(ob, do_unlink=True)
    print(f"removed {len(doomed)} collision/invisible meshes for QA render")


def _is_invisible(mat):
    try:
        if not mat.use_nodes:
            return False
        for node in mat.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                alpha = node.inputs.get("Alpha")
                if alpha is not None and alpha.default_value <= 0.01:
                    return True
    except Exception:
        pass
    return False


def scene_bounds():
    mins = mathutils.Vector((1e18, 1e18, 1e18))
    maxs = mathutils.Vector((-1e18, -1e18, -1e18))
    found = False
    for ob in bpy.context.scene.objects:
        if ob.type != "MESH":
            continue
        # skip collision proxies / invisible helpers from the bbox so framing targets visuals
        if ob.name.lower().startswith(("collision", "lod_", "yourlots", "grass_wind")):
            continue
        found = True
        for corner in ob.bound_box:
            w = ob.matrix_world @ mathutils.Vector(corner)
            mins.x, mins.y, mins.z = min(mins.x, w.x), min(mins.y, w.y), min(mins.z, w.z)
            maxs.x, maxs.y, maxs.z = max(maxs.x, w.x), max(maxs.y, w.y), max(maxs.z, w.z)
    if not found:
        mins = mathutils.Vector((-50, -50, 0))
        maxs = mathutils.Vector((50, 50, 10))
    return mins, maxs


def setup_world_and_sun():
    # bright daylight world ambient
    world = bpy.data.worlds.new("W")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.78, 0.84, 0.95, 1.0)  # bright sky ambient FILL
        bg.inputs[1].default_value = 2.4                       # strong ambient so shadows aren't pure black
    # EEVEE-Next doesn't reliably apply world ambient as diffuse FILL without a light probe, so
    # surfaces not hit by a sun render black. Light from MULTIPLE directions (key + 3 fills incl.
    # one from below) so every face gets diffuse and true material colour shows in QA.
    for i, (energy, rx, rz) in enumerate([
        (2.2, 58, -32),   # key
        (1.1, 60, 150),   # fill back
        (1.1, 62, 60),    # fill side
        (0.7, 130, -100), # under-fill (lights downward-facing faces)
    ]):
        sd = bpy.data.lights.new(f"Sun{i}", "SUN")
        sd.energy = energy
        sd.use_shadow = False
        so = bpy.data.objects.new(f"Sun{i}", sd)
        bpy.context.scene.collection.objects.link(so)
        so.rotation_euler = (math.radians(rx), 0, math.radians(rz))


def make_cam():
    cam = bpy.data.cameras.new("Cam")
    cam.lens = 38
    co = bpy.data.objects.new("Cam", cam)
    bpy.context.scene.collection.objects.link(co)
    bpy.context.scene.camera = co
    return co


def look_at(co, target):
    d = (co.location - target)
    co.rotation_euler = d.to_track_quat("Z", "Y").to_euler()


def render_to(path):
    sc = bpy.context.scene
    for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
        try:
            sc.render.engine = eng
            break
        except Exception:
            continue
    try:
        sc.eevee.taa_render_samples = 16
    except Exception:
        pass
    sc.render.resolution_x = RES
    sc.render.resolution_y = int(RES * 0.78)
    sc.render.image_settings.file_format = "JPEG"
    sc.render.image_settings.quality = 88
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    reset()
    import_glb(GLB)
    setup_world_and_sun()
    mins, maxs = scene_bounds()
    center = (mins + maxs) * 0.5
    size = (maxs - mins)
    span = max(size.x, size.y, 30.0)
    co = make_cam()

    # wide orbit views at 35deg elevation from 4 compass directions
    el = math.radians(34)
    dist = span * 0.62
    views = []
    for name, az in [("ne", 45), ("nw", 135), ("sw", 225), ("se", 315)]:
        a = math.radians(az)
        loc = mathutils.Vector((
            center.x + dist * math.cos(el) * math.cos(a),
            center.y + dist * math.cos(el) * math.sin(a),
            center.z + dist * math.sin(el) + span * 0.1,
        ))
        views.append((name, loc, center))
    # top-down (z-fighting + coverage)
    views.append(("top", mathutils.Vector((center.x, center.y, center.z + span * 0.95)), center))
    # eye-level close-ups near the WORLD ORIGIN (the playable core / house, where the SV facades
    # live). FIXED distance so large levels still get a real close-up; camera clearly above the
    # target so the framing stays upright (no track-quat flip).
    gz = mins.z
    top = maxs.z + 20.0
    # Seat eye-level cameras on the ACTUAL ground (raycast straight down), NOT the global min Z — on
    # hilly levels the terrain rises toward the centre, so anchoring to min Z buried the camera below
    # grade (washed-out floating frames). Raycast finds the real surface height at each spot.
    def ground_z(x, y, fallback):
        deps = bpy.context.evaluated_depsgraph_get()
        hit, loc, *_ = bpy.context.scene.ray_cast(deps, mathutils.Vector((x, y, top)), mathutils.Vector((0, 0, -1)))
        return loc.z if hit else fallback
    # Aim eye-level shots at the BUILDING cluster centroid, not the bounds centre — on levels whose
    # DEM patch extends past the housing, the bounds centre lands on empty terrain (meemaw).
    def building_center():
        sx = sy = n = 0.0
        for ob in bpy.context.scene.objects:
            if ob.type != "MESH":
                continue
            nm = ob.name or ""
            if "Collision" in nm or not (nm.startswith("Buildings") or nm.startswith("House")):
                continue
            for c in ob.bound_box:
                w = ob.matrix_world @ mathutils.Vector(c)
                sx += w.x; sy += w.y; n += 1
        return (sx / n, sy / n) if n else (center.x, center.y)
    bcx, bcy = building_center()
    cgz = ground_z(bcx, bcy, gz)                   # ground at the building cluster (the eye target)
    # EYE-LEVEL close-ups: a ~1.6 m person a short distance from the buildings, looking nearly level,
    # so facades + ground FILL the frame instead of empty sky.
    for name, ang, cd in [("close1", 35, 18.0), ("close2", 215, 18.0), ("close3", 120, 26.0)]:
        a = math.radians(ang)
        camx, camy = bcx + cd * math.cos(a), bcy + cd * math.sin(a)
        eg = ground_z(camx, camy, cgz)            # ground under the camera's own feet
        loc = mathutils.Vector((camx, camy, eg + 1.6))
        tgt = mathutils.Vector((bcx, bcy, cgz + 1.4))
        views.append((name, loc, tgt))
    # zoomed top-down on the content centre: best view for INTERSECTION z-fighting + curb/crosswalk detail
    views.append(("topcore", mathutils.Vector((center.x, center.y, gz + 90.0)), mathutils.Vector((center.x, center.y, gz))))
    # low oblique street-level sweeps to catch road JUNCTIONS, curb thickness, and dashes at a grazing angle
    for name, ang in [("street1", 70), ("street2", 250)]:
        a = math.radians(ang)
        camx, camy = bcx + 26.0 * math.cos(a), bcy + 26.0 * math.sin(a)
        eg = ground_z(camx, camy, cgz)
        loc = mathutils.Vector((camx, camy, eg + 1.7))
        views.append((name, loc, mathutils.Vector((bcx, bcy, cgz + 1.4))))

    for name, loc, tgt in views:
        co.location = loc
        look_at(co, tgt)
        render_to(f"{OUT}_{name}.jpg")
        print(f"rendered {OUT}_{name}.jpg")


main()
