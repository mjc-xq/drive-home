#!/usr/bin/env python3
"""Render the photoreal GLB straight-down orthographically over a KNOWN world
window so every output pixel maps to a known (East, North) in the property
model's ENU world frame (house at origin, x=East, z=-North, y=up).

  blender --background --python scripts/_measure_render_photoreal.py -- <glb> <out.png> <half_m> <px>

Camera: ORTHO, looks straight down (-Z world / down the up axis), centred on the
house origin, ortho_scale = 2*half_m. The render covers world x in [-half,half]
and world -z (i.e. North) in [-half,half]. Output is the true Google ground over
that exact window — the registration reference.
"""
import bpy, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB, OUT = argv[0], argv[1]
HALF = float(argv[2])
PX = int(argv[3])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 16
scene.cycles.device = "CPU"
scene.render.resolution_x = PX
scene.render.resolution_y = PX
scene.render.film_transparent = False
scene.view_settings.view_transform = "Standard"   # no filmic tone-curve; keep colours flat

# flat, shadow-free top lighting so the texture (not shading) drives correlation
world = bpy.data.worlds.new("w"); scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.4

cam_d = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_d)
scene.collection.objects.link(cam)
scene.camera = cam
cam_d.type = "ORTHO"
cam_d.ortho_scale = 2.0 * HALF
cam_d.clip_start = 1.0
cam_d.clip_end = 4000.0

# glTF Y-up imported -> Blender Z-up. world East = +X, North = +Y(blender) since
# gltf z=-North maps to blender Y=+North. Camera straight down over origin.
cam.location = Vector((0.0, 0.0, 1500.0))
cam.rotation_euler = (0.0, 0.0, 0.0)   # looks down -Z, image +x = East, image +y = North

scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print(f"[measure] photoreal top-down -> {OUT}  window=±{HALF} m  {PX}px", flush=True)
