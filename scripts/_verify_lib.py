#!/usr/bin/env python3
"""Render each library tree alone, seated on a ground plane at Z=0, to prove each
exported file is a single upright tree with its trunk base on the ground."""
import bpy, os, json, math
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, "exports", "tree_lib")
man = json.load(open(os.path.join(LIB, "manifest.json")))["trees"]


def fresh():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x = 800; sc.render.resolution_y = 700
    w = bpy.data.worlds.new("W"); sc.world = w; w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.72, 0.95, 1)
    sun_d = bpy.data.lights.new("S", 'SUN'); sun_d.energy = 3.0
    sun = bpy.data.objects.new("S", sun_d); sc.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(55), 0, math.radians(35))
    # ground plane at Z=0
    bpy.ops.mesh.primitive_plane_add(size=120, location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(bpy.data.materials.new("grnd"))
    return sc


for e in man:
    sc = fresh()
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(LIB, e["file"]))
    objs = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    bb = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    cz = (max(p.z for p in bb) + min(p.z for p in bb)) / 2
    span = max(max(p.x for p in bb) - min(p.x for p in bb),
               max(p.z for p in bb) - min(p.z for p in bb), 1.0)
    cd = bpy.data.cameras.new("C"); cd.type = 'ORTHO'; cd.ortho_scale = span * 1.3
    cam = bpy.data.objects.new("C", cd); sc.collection.objects.link(cam)
    cam.location = (0, -span * 3, cz); cam.rotation_euler = (math.radians(90), 0, 0)
    sc.camera = cam
    p = os.path.join(LIB, f"_lib_{e['file'].replace('.glb','')}.png")
    sc.render.filepath = p; bpy.ops.render.render(write_still=True)
    zmin = min(p.z for p in bb)
    print(f"[verify] {e['file']}  base_z={zmin:+.3f}  H={max(p.z for p in bb)-zmin:.2f}  -> {p}")
