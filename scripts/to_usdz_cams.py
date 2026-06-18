#!/usr/bin/env python3
"""Import the stylized GLB, add a TOP-DOWN orthographic camera and a GROUND-LEVEL
perspective camera, and export USDZ (cameras included) so `usdrecord --camera`
can render the prompt's two required views.

  blender --background --python scripts/to_usdz_cams.py -- <in.glb> <out.usdz>
"""
import bpy, sys, os, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB, OUT = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]

# whole-model bounds
lo = Vector((1e9, 1e9, 1e9)); hi = -lo
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
ctr = (lo + hi) / 2
span = max(hi.x - lo.x, hi.y - lo.y)


def add_cam(name, loc, aim, ortho=None, lens=24):
    cd = bpy.data.cameras.new(name)
    cam = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = loc
    d = Vector(aim) - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    cd.clip_start = 0.05; cd.clip_end = max(3000.0, span * 6)
    if ortho:
        cd.type = "ORTHO"; cd.ortho_scale = ortho
    else:
        cd.type = "PERSP"; cd.lens = lens
    return cam


# a sun so usdrecord's default render is lit (USD ships no lights otherwise)
sun_d = bpy.data.lights.new("Sun", "SUN"); sun_d.energy = 3.0
sun = bpy.data.objects.new("Sun", sun_d); bpy.context.scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(50), 0, math.radians(35))

# TOP-DOWN orthographic (per spec: ortho aperture, cam high above origin). The
# tiny Y offset on the look target avoids the degenerate look-straight-down gimbal.
add_cam("Cam_Top", (ctr.x, ctr.y + 0.001, ctr.z + 1200), (ctr.x, ctr.y, ctr.z), ortho=420)
# GROUND-LEVEL perspective on the south lawn looking across to the houses
gy = lo.z
add_cam("Cam_Ground", (40, -70, gy + 1.7), (30, 30, gy + 5.0), lens=20)

props = [p.identifier for p in bpy.ops.wm.usd_export.get_rna_type().properties]
kw = {"filepath": OUT}
for o in ("export_materials", "export_uvmaps", "generate_preview_surface", "overwrite_textures", "export_cameras", "export_lights"):
    if o in props:
        kw[o] = True
if "export_textures_mode" in props:
    kw["export_textures_mode"] = "NEW"
bpy.ops.wm.usd_export(**kw)
print(f"[to_usdz_cams] wrote {OUT} ({os.path.getsize(OUT) // 1024} KB)")
