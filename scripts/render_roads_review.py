# Quick road/sidewalk review renders for a GLB.
#   blender --background --python scripts/render_roads_review.py -- <glb> <out_prefix>
# Emits <prefix>_top.png (top-down ortho, tight on the road net) and
# <prefix>_obl.png (oblique perspective, camera well above the 52 m terrain).
import bpy, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB, OUT = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

def is_helper(obj):
    return obj.name.startswith("Collision_") or obj.name.startswith("LOD_Buildings_Low")

for obj in bpy.data.objects:
    if is_helper(obj):
        obj.hide_render = True
        obj.hide_set(True)

meshes = [o for o in bpy.data.objects if o.type == "MESH" and not is_helper(o)]

lo = Vector((1e9, 1e9, 1e9)); hi = -lo
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
ctr = (lo + hi) / 2
span = max(hi.x - lo.x, hi.y - lo.y)

scene = bpy.context.scene
# EEVEE is plenty for a flat-shaded road/sidewalk layout review and ~20x faster than
# Cycles with the full tree canopy.
try:
    scene.render.engine = "BLENDER_EEVEE_NEXT"
except TypeError:
    scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1400
scene.render.resolution_y = 1100
scene.render.film_transparent = False
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "Medium High Contrast"
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1

world = bpy.data.worlds.new("w"); scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.55, 0.72, 0.92, 1.0)
bg.inputs["Strength"].default_value = 1.25

def aim(obj, target):
    d = target - obj.location
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()

sun_d = bpy.data.lights.new("sun_key", "SUN"); sun_d.energy = 3.2
sun = bpy.data.objects.new("sun_key", sun_d); scene.collection.objects.link(sun)
sun.location = ctr + Vector((-180, -120, 220)); aim(sun, ctr)

fill_d = bpy.data.lights.new("soft_fill", "AREA"); fill_d.energy = 520; fill_d.size = span * 1.4
fill = bpy.data.objects.new("soft_fill", fill_d); scene.collection.objects.link(fill)
fill.location = ctr + Vector((70, 95, 165)); aim(fill, ctr)

rim_d = bpy.data.lights.new("side_fill", "AREA"); rim_d.energy = 260; rim_d.size = span * 1.1
rim = bpy.data.objects.new("side_fill", rim_d); scene.collection.objects.link(rim)
rim.location = ctr + Vector((-130, 80, 125)); aim(rim, ctr)

cam_d = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_d); scene.collection.objects.link(cam)
scene.camera = cam

def shoot(loc, suffix, ortho=None, aim=None, lens=35):
    a = aim if aim is not None else ctr
    cam.location = loc
    d = a - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    cam_d.clip_start = 0.05; cam_d.clip_end = max(4000.0, span * 8)
    if ortho:
        cam_d.type = "ORTHO"; cam_d.ortho_scale = ortho
    else:
        cam_d.type = "PERSP"; cam_d.lens = lens
    scene.render.filepath = OUT + suffix
    bpy.ops.render.render(write_still=True)
    print("[render] wrote", scene.render.filepath, flush=True)

# full top-down ortho (whole patch)
shoot(ctr + Vector((0, 0.001, 1200)), "_top.png", ortho=span * 1.05)
# tight top-down ortho centred on origin (the house + nearest streets)
shoot(Vector((0, 0, 1200)), "_topz.png", ortho=170, aim=Vector((0, 0, 60)))
# oblique perspective (camera well above 52 m terrain)
shoot(Vector((110, -130, 150)), "_obl.png", aim=Vector((0, 0, 55)), lens=40)
