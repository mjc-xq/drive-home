#!/usr/bin/env python3
"""Headless preview of the stylized neighbourhood GLB (NO aerial drape — solid
flat colours only). Verifies the grass animation actually moves by rendering the
same ground-level view at two animation frames.

  blender --background --python scripts/render_stylized.py -- <glb> <out_prefix>

Writes:
  <prefix>_top.png    top-down orthographic
  <prefix>_ground.png ground-level perspective (frame 1)
  <prefix>_ground_b.png ground-level perspective (later anim frame; grass swayed)
  <prefix>_3q.png     3/4 aerial perspective
"""
import bpy, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB, OUT = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]

# whole-model bounds (exclude nothing)
lo = Vector((1e9, 1e9, 1e9)); hi = -lo
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
ctr = (lo + hi) / 2
span = max(hi.x - lo.x, hi.y - lo.y)

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 24
scene.cycles.device = "CPU"
scene.render.resolution_x = 1280
scene.render.resolution_y = 960
scene.render.film_transparent = False

world = bpy.data.worlds.new("w"); scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.55, 0.72, 0.92, 1.0)   # sky blue
bg.inputs["Strength"].default_value = 1.0

sun_d = bpy.data.lights.new("sun", "SUN"); sun_d.energy = 3.0
sun = bpy.data.objects.new("sun", sun_d); scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(50), 0, math.radians(35))

cam_d = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_d); scene.collection.objects.link(cam)
scene.camera = cam


def shoot(loc, suffix, ortho=None, aim=None, lens=28, frame=1):
    scene.frame_set(frame)
    a = aim if aim is not None else ctr
    cam.location = loc
    d = a - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    cam_d.clip_start = 0.05; cam_d.clip_end = max(3000.0, span * 6)
    if ortho:
        cam_d.type = "ORTHO"; cam_d.ortho_scale = ortho
    else:
        cam_d.type = "PERSP"; cam_d.lens = lens
    scene.render.filepath = OUT + suffix
    bpy.ops.render.render(write_still=True)
    print("[render] wrote", scene.render.filepath, flush=True)


# top-down orthographic (per spec: aperture ~1500, cam high, ortho)
shoot(ctr + Vector((0, 0.001, 1200)), "_top.png", ortho=420)

# 3/4 aerial perspective
shoot(ctr + Vector((span * 0.55, -span * 0.55, span * 0.45)), "_3q.png")

# ground-level perspective: sample terrain elevation near origin so the eye sits
# ~1.7 m above the actual grade rather than the patch's lowest point.
terr = next((o for o in meshes if o.name.split(".")[0] == "Terrain_Grass"), None)
def ground_at(px, py, radius=8.0):
    if not terr:
        return lo.z
    best_h, best_d = lo.z, 1e18
    for v in terr.data.vertices:
        w = terr.matrix_world @ v.co
        d = (w.x - px) ** 2 + (w.y - py) ** 2
        if d < best_d:
            best_d, best_h = d, w.z
    return best_h

# a) open street-level view looking across the lawn toward the creek + trees
eye_xy = (40, -70)
look_xy = (30, 30)
gy = ground_at(*eye_xy)
ly = ground_at(*look_xy)
eye = Vector((eye_xy[0], eye_xy[1], gy + 1.7))
look = Vector((look_xy[0], look_xy[1], ly + 4.0))
shoot(eye, "_ground.png", aim=look, lens=20, frame=1)

# b) low close-up of a grass patch at TWO animation frames -> proves the wind
#    animation actually moves the blades (compare _grass_f01 vs _grass_f40).
# pick a grass clump on the open south-lawn area and frame a tight close-up so the
# blades fill the frame; render the same view at two frames to show the wind sway.
grass_objs = [o for o in bpy.data.objects if o.name.split(".")[0].startswith("GrassClump")]
focus = Vector((30, 24, 0))   # open lawn area that frames cleanly (off buildings)
target = min(grass_objs, key=lambda o: (o.matrix_world.translation - focus).length) if grass_objs else None
if target:
    gp = target.matrix_world.translation
    geye = Vector((gp.x + 1.2, gp.y - 3.2, gp.z + 2.2))
    glook = Vector((gp.x, gp.y, gp.z + 0.4))
    shoot(geye, "_grass_f01.png", aim=glook, lens=55, frame=1)
    shoot(geye, "_grass_f40.png", aim=glook, lens=55, frame=40)
    print("[grass] clump", target.name, "at", tuple(round(v, 1) for v in gp), flush=True)
