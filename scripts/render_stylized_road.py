#!/usr/bin/env python3
"""Extra verification view for the stylized GLB: a street-level camera standing on
the road and looking ALONG it, so the dark asphalt, raised light curbs and dashed
YELLOW centre line are all clearly visible (and trees beside the road read as
seated). Camera eye is placed ~1.6 m above the sampled terrain so it sits above the
~50 m grade, never below it.

  blender --background --python scripts/render_stylized_road.py -- <glb> <out.png> ex ez lx lz
"""
import bpy, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB, OUT = argv[0], argv[1]
EX, EZ, LX, LZ = (float(a) for a in argv[2:6])   # glTF X,Z of eye and look (z = -north)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 32
scene.cycles.device = "CPU"
scene.render.resolution_x = 1280
scene.render.resolution_y = 720

world = bpy.data.worlds.new("w"); scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.55, 0.72, 0.92, 1.0)
bg.inputs["Strength"].default_value = 1.0
sun_d = bpy.data.lights.new("sun", "SUN"); sun_d.energy = 3.0
sun = bpy.data.objects.new("sun", sun_d); scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(50), 0, math.radians(35))

# glTF Y-up imports to Blender Z-up: world (gx, gy, gz) -> Blender (gx, -gz, gy).
terr = next((o for o in meshes if o.name.split(".")[0] == "Terrain_Grass"), None)
def ground_at(bx, by):
    if not terr:
        return 50.0
    best_h, best_d = 50.0, 1e18
    for v in terr.data.vertices:
        w = terr.matrix_world @ v.co
        d = (w.x - bx) ** 2 + (w.y - by) ** 2
        if d < best_d:
            best_d, best_h = d, w.z
    return best_h

eye_b = Vector((EX, -EZ, 0)); look_b = Vector((LX, -LZ, 0))
eye_b.z = ground_at(eye_b.x, eye_b.y) + 1.6     # eye height above grade
look_b.z = ground_at(look_b.x, look_b.y) + 0.6

cam_d = bpy.data.cameras.new("cam"); cam_d.lens = 24
cam_d.clip_start = 0.05; cam_d.clip_end = 4000.0
cam = bpy.data.objects.new("cam", cam_d); scene.collection.objects.link(cam)
scene.camera = cam
cam.location = eye_b
cam.rotation_euler = (look_b - eye_b).to_track_quat("-Z", "Y").to_euler()

scene.frame_set(1)
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("[road] eye", tuple(round(v, 1) for v in eye_b), "-> look", tuple(round(v, 1) for v in look_b), flush=True)
print("[road] wrote", OUT, flush=True)
