#!/usr/bin/env python3
"""Quick EEVEE preview of a baked interior GLB, for verifying the bake visually.
  blender --background --python scripts/render_interior.py -- <glb> <out_prefix>
Injects the COLOR_0 (AO) -> Base Color multiply that three.js applies automatically,
so the render approximates the in-app look. Renders a dollhouse 3/4 view.
"""
import bpy, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB, OUT = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]

# replicate three.js: multiply COLOR_0 into Base Color where the attribute exists
for o in meshes:
    if "AO" not in o.data.color_attributes:
        continue
    for ms in o.material_slots:
        m = ms.material
        if not m or not m.use_nodes:
            continue
        b = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not b:
            continue
        nt = m.node_tree
        ca = nt.nodes.new("ShaderNodeVertexColor"); ca.layer_name = "AO"
        mix = nt.nodes.new("ShaderNodeMixRGB"); mix.blend_type = "MULTIPLY"; mix.inputs["Fac"].default_value = 1.0
        bc = b.inputs["Base Color"]
        if bc.is_linked:
            nt.links.new(bc.links[0].from_socket, mix.inputs["Color1"])
        else:
            mix.inputs["Color1"].default_value = bc.default_value
        nt.links.new(ca.outputs["Color"], mix.inputs["Color2"])
        nt.links.new(mix.outputs["Color"], bc)

# frame the whole model
lo = Vector((1e9, 1e9, 1e9)); hi = -lo
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
ctr = (lo + hi) / 2
size = (hi - lo).length

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 24
scene.cycles.device = "CPU"
scene.render.resolution_x = scene.render.resolution_y = 900
scene.render.film_transparent = False
world = bpy.data.worlds.new("w"); scene.world = world
world.use_nodes = True
import os
FLAT = os.environ.get("FLAT") == "1"
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0 if FLAT else 0.6

if not FLAT:
    sun_d = bpy.data.lights.new("sun", "SUN"); sun_d.energy = 3.0
    sun = bpy.data.objects.new("sun", sun_d); scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(55), 0, math.radians(35))

cam_d = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_d); scene.collection.objects.link(cam)
scene.camera = cam
# dollhouse 3/4 view from above
cam.location = ctr + Vector((size * 0.55, -size * 0.55, size * 0.7))
d = ctr - cam.location
cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
cam_d.lens = 28

scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("[render] wrote", OUT, flush=True)
