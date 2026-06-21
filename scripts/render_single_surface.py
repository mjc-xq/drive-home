#!/usr/bin/env python3
"""Verification renderer for the single-surface Da Hilg levels.

Frames the PLAYABLE CORE (not the whole 1.2 km patch) so the painted ground reads, and
places an eye-level street camera at the real terrain height near the origin (the house) so
we can judge "walking/driving through it". EEVEE so z-fighting shows exactly as a game engine
would (no web polygon-offset masking).

  blender --background --python scripts/render_single_surface.py -- <glb> <out_prefix> [res]

Writes <prefix>_obliqueNE.jpg, _obliqueSE.jpg, _top.jpg, _eye.jpg, _eye2.jpg.
glTF Y-up -> Blender Z-up: glTF (x,y,z) -> Blender (x,-z,y).
"""
import bpy, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB = argv[0]
OUT = argv[1] if len(argv) > 1 else "/tmp/ss_render"
RES = int(argv[2]) if len(argv) > 2 else 1400

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

# hide invisible collision/LOD proxies for the QA render
for o in list(bpy.data.objects):
    n = o.name.split(".")[0]
    if n.startswith("Collision_") or n.startswith("LOD_"):
        o.hide_render = True
        o.hide_set(True)

meshes = [o for o in bpy.data.objects if o.type == "MESH" and not o.hide_render]

# terrain height at the glTF origin (house) -> Blender Z, by sampling Terrain verts near (0,0).
terr = next((o for o in meshes if o.name.split(".")[0] == "Terrain"), None) or (meshes[0] if meshes else None)
ground_z = 50.0
if terr:
    zs = []
    mw = terr.matrix_world
    for v in terr.data.vertices:
        wv = mw @ v.co
        if abs(wv.x) < 8 and abs(wv.y) < 8:   # Blender x,y == glTF x,-z (near origin)
            zs.append(wv.z)
    if zs:
        ground_z = sorted(zs)[len(zs) // 2]   # median terrain height at the house

# world (sun + sky) so it reads like daytime
world = bpy.data.worlds.new("W"); bpy.context.scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.62, 0.72, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.1
sun_data = bpy.data.lights.new("Sun", "SUN"); sun_data.energy = 3.0
sun = bpy.data.objects.new("Sun", sun_data); bpy.context.collection.objects.link(sun)
sun.rotation_euler = (math.radians(50), math.radians(20), math.radians(35))

scene = bpy.context.scene
try:
    scene.render.engine = "BLENDER_EEVEE_NEXT"
except Exception:
    try: scene.render.engine = "BLENDER_EEVEE"
    except Exception: pass
scene.render.resolution_x = RES
scene.render.resolution_y = int(RES * 0.7)
scene.render.image_settings.file_format = "JPEG"
scene.render.image_settings.quality = 90

cam_data = bpy.data.cameras.new("Cam")
cam = bpy.data.objects.new("Cam", cam_data); bpy.context.collection.objects.link(cam)
scene.camera = cam

def look_at(obj, target):
    d = (obj.location - Vector(target))
    obj.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()

def render(name):
    scene.render.filepath = f"{OUT}_{name}.jpg"
    bpy.ops.render.render(write_still=True)
    print("rendered", scene.render.filepath, flush=True)

# Blender coords: house at (0, 0, ground_z). Frame the ±~140 m core.
# oblique NE (look down the streets from above)
cam_data.lens = 28
cam.location = Vector((120, -160, ground_z + 95)); look_at(cam, (0, 10, ground_z)); render("obliqueNE")
cam.location = Vector((-150, 150, ground_z + 110)); look_at(cam, (-10, 0, ground_z)); render("obliqueSE")
# top-down ortho on the core
cam_data.type = "ORTHO"; cam_data.ortho_scale = 320
cam.location = Vector((0, 0, ground_z + 300)); cam.rotation_euler = (0, 0, 0); render("top")
cam_data.type = "PERSP"
# streetscape cameras: a low "driving into the block" view + a near-eye-level approach, both
# placed well outside the house footprint so we see the streetscape (houses lining painted roads).
cam_data.lens = 22
cam.location = Vector((95, -95, ground_z + 6)); look_at(cam, (0, 0, ground_z + 4)); render("eye")
cam.location = Vector((-90, 70, ground_z + 2.0)); look_at(cam, (20, -10, ground_z + 3)); render("eye2")

print("ground_z", ground_z, flush=True)
