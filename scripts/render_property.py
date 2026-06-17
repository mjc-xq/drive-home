#!/usr/bin/env python3
"""Headless preview of the exported property GLB (non-destructive: factory scene).
  blender --background --python scripts/render_property.py -- <glb> <out_prefix> [aerial.jpg]
Writes <prefix>_3q.png (3/4 view) and <prefix>_top.png (top-down with the aerial
draped on the crisp LiDAR terrain via its exported UVs).
"""
import bpy, sys, math, os
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB, OUT = argv[0], argv[1]
AERIAL = argv[2] if len(argv) > 2 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]

# drape the aerial photo on the Terrain material (top-down sanity check)
if AERIAL and os.path.exists(AERIAL):
    img = bpy.data.images.load(AERIAL)
    for o in meshes:
        if o.name.split(".")[0] != "Terrain":
            continue
        for ms in o.material_slots:
            m = ms.material
            if not m or not m.use_nodes:
                continue
            nt = m.node_tree
            b = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
            tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = img
            uv = nt.nodes.new("ShaderNodeUVMap")
            nt.links.new(uv.outputs["UV"], tex.inputs["Vector"])
            if b:
                nt.links.new(tex.outputs["Color"], b.inputs["Base Color"])

# frame the whole model
lo = Vector((1e9, 1e9, 1e9)); hi = -lo
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
ctr = (lo + hi) / 2
span = max(hi.x - lo.x, hi.y - lo.y)

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 28
scene.cycles.device = "CPU"
scene.render.resolution_x = 1280
scene.render.resolution_y = 960
world = bpy.data.worlds.new("w"); scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.7
sun_d = bpy.data.lights.new("sun", "SUN"); sun_d.energy = 3.2
sun = bpy.data.objects.new("sun", sun_d); scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(52), 0, math.radians(40))

cam_d = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_d); scene.collection.objects.link(cam)
scene.camera = cam


def shoot(loc, suffix, ortho=None, aim=None):
    a = aim if aim is not None else ctr
    cam.location = loc
    d = a - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    if ortho:
        cam_d.type = "ORTHO"; cam_d.ortho_scale = ortho
    else:
        cam_d.type = "PERSP"; cam_d.lens = 32
    scene.render.filepath = OUT + suffix
    bpy.ops.render.render(write_still=True)
    print("[render] wrote", scene.render.filepath, flush=True)


# the house sits at glTF origin -> Blender (0, 0, elevation)
house = Vector((0, 0, ctr.z))
shoot(ctr + Vector((span * 0.62, -span * 0.62, span * 0.5)), "_3q.png")
shoot(ctr + Vector((0, 0.001, span)), "_top.png", ortho=span * 1.05)
shoot(house + Vector((0, 0.001, span)), "_lots.png", ortho=130, aim=house)
