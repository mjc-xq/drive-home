#!/usr/bin/env python3
"""Ground-level perspective renders of the property GLB to verify the Street View
facades read as real houses. Non-destructive (factory scene). Cameras sit at a
PLAYER eye height ABOVE the terrain (~52 m absolute) and look at the house and
down Dahill Lane.

  blender --background --python scripts/render_ground.py -- <glb> <out_prefix>

Writes <prefix>_front.png, <prefix>_street.png, <prefix>_street2.png.
Blender's glTF importer converts Y-up -> Z-up, so glTF (x, y, z) -> Blender
(x, -z, y). The house sits at glTF origin; terrain there ~ 50 m absolute Z.
"""
import bpy, sys, math, os
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB, OUT = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]

# terrain height at the house (glTF origin) -> Blender Z. Sample Terrain verts
# within 8 m of the origin (the whole-patch bbox dips at the edges, far too low).
terr = next((o for o in meshes if o.name.split(".")[0] == "Terrain"), None)
ground_z = 47.9
if terr:
    zs = [(terr.matrix_world @ v.co).z for v in terr.data.vertices
          if abs((terr.matrix_world @ v.co).x) < 8 and abs((terr.matrix_world @ v.co).y) < 8]
    if zs:
        ground_z = sum(zs) / len(zs)
print(f"[ground] terrain Z near house ~ {ground_z:.2f} m")

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [
    e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items
] else "BLENDER_EEVEE"
scene.render.resolution_x = 1280
scene.render.resolution_y = 800
scene.render.film_transparent = False

world = bpy.data.worlds.new("w"); scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.50, 0.62, 0.85, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
sun_d = bpy.data.lights.new("sun", "SUN"); sun_d.energy = 3.0
sun = bpy.data.objects.new("sun", sun_d); scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(50), 0, math.radians(35))

cam_d = bpy.data.cameras.new("cam"); cam_d.lens = 28
cam_d.clip_start = 0.1; cam_d.clip_end = 4000.0
cam = bpy.data.objects.new("cam", cam_d); scene.collection.objects.link(cam)
scene.camera = cam


def g2b(x, y, z):
    """glTF (x=east, y=up, z=-north) -> Blender (x, -z, y). Inputs are in Blender
    world units already for x and z(north); y is absolute height."""
    return Vector((x, -z, y))


def shoot(eye, aim, suffix):
    """eye/aim are Blender world (x, y, z=height) vectors."""
    cam.location = Vector(eye)
    a = Vector(aim)
    cam.rotation_euler = (a - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = OUT + suffix
    bpy.ops.render.render(write_still=True)
    print("[ground] wrote", scene.render.filepath, flush=True)


eye = ground_z + 1.6   # player eye height above ground
# Blender world frame: x=east, y=-north, z=height. The house is at (0,0,~47.9).
# Dahill Lane runs along the SE edge; road point P for the front wall is glTF
# (21.7, *, 11.4) -> Blender (21.7, -11.4, h). Front walls (SVWall_b187_*) sit at
# Blender x[3..12], y[-2.5..10], z[47.4..51.7].
# 1) Stand on the street in front, look back at the house front wall.
shoot((22, -11, eye), (6, 2, ground_z + 1.8), "_front.png")
# 2) Closer head-on to the garage / front wall.
shoot((16, -8, eye), (5, 4, ground_z + 1.8), "_front2.png")
# 3) Down the street to the NW past the near neighbours (186, 199...).
shoot((20, -6, eye), (-35, 18, ground_z + 1.5), "_street.png")
# 4) Down the street the other way (SE) past 202/203/185.
shoot((8, 6, eye), (45, -35, ground_z + 1.5), "_street2.png")
