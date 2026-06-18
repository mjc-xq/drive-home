#!/usr/bin/env python3
"""VERIFY the placed-trees GLB: render close-ups (camera above the ~50 m terrain)
proving each placed object is a single distinct tree seated on the ground, plus a
wide shot showing varied individual trees."""
import bpy, os, math, statistics
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLB = os.path.join(ROOT, "exports", "1840-dahill-property-trees.glb")
OUT = os.path.join(ROOT, "exports", "tree_lib")

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x = 1200; sc.render.resolution_y = 850
try:
    sc.eevee.taa_render_samples = 24
except Exception:
    pass
w = bpy.data.worlds.new("W"); sc.world = w; w.use_nodes = True
w.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.72, 0.95, 1)
sun_d = bpy.data.lights.new("S", 'SUN'); sun_d.energy = 3.2
sun = bpy.data.objects.new("S", sun_d); sc.collection.objects.link(sun)
sun.rotation_euler = (math.radians(52), 0, math.radians(40))

bpy.ops.import_scene.gltf(filepath=GLB)
trees = [o for o in bpy.data.objects if o.name.startswith("Tree_") and o.type == 'MESH']
print(f"[vp] placed tree objects: {len(trees)}")

# world centroid (XY) + base Z of each placed tree
def world_base(o):
    bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return (sum(p.x for p in bb) / 8, sum(p.y for p in bb) / 8,
            min(p.z for p in bb), max(p.z for p in bb))

info = [(o, *world_base(o)) for o in trees]
bases = [i[3] for i in info]
print(f"[vp] base Z: min={min(bases):.1f} max={max(bases):.1f} median={statistics.median(bases):.1f}")

def cam(name, loc, rot, ortho=None, persp_lens=None):
    cd = bpy.data.cameras.new("C")
    if ortho:
        cd.type = 'ORTHO'; cd.ortho_scale = ortho
    else:
        cd.type = 'PERSP'; cd.lens = persp_lens or 35
    c = bpy.data.objects.new("C", cd); sc.collection.objects.link(c)
    c.location = loc; c.rotation_euler = rot; sc.camera = c
    sc.render.filepath = os.path.join(OUT, name); bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(c, do_unlink=True)
    print("[vp render]", os.path.join(OUT, name))

# pick a dense cluster: sort by x then take a tree near the median base, look at it
info.sort(key=lambda t: (t[1], t[2]))
mid = info[len(info) // 2]
o, ox, oy, oz0, oz1 = mid
# CLOSE-UP 1: a few trees around (ox,oy), camera backed off + above terrain
cam("placed_closeup_1.png",
    (ox - 30, oy - 30, oz1 + 12),
    (math.radians(68), 0, math.radians(-45)),
    persp_lens=50)

# CLOSE-UP 2: another neighbourhood (1/4 through the sorted list)
q = info[len(info) // 4]
o2, qx, qy, qz0, qz1 = q
cam("placed_closeup_2.png",
    (qx + 16, qy - 16, qz1 + 7),
    (math.radians(72), 0, math.radians(45)),
    persp_lens=45)

# WIDE SHOT: frame all trees from a 3/4 aerial, ortho so individuals read
allbb = [Vector((i[1], i[2], 0)) for i in info]
cx = sum(p.x for p in allbb) / len(allbb); cy = sum(p.y for p in allbb) / len(allbb)
spanx = max(i[1] for i in info) - min(i[1] for i in info)
spany = max(i[2] for i in info) - min(i[2] for i in info)
span = max(spanx, spany)
czt = statistics.median(bases)
cam("placed_wide.png",
    (cx - span * 0.5, cy - span * 0.7, czt + span * 0.6),
    (math.radians(58), 0, math.radians(-35)),
    persp_lens=28)

# WIDE TOP-DOWN: confirm spacing / no overlapping clumps
cam("placed_top.png",
    (cx, cy, czt + span * 1.1),
    (0, 0, 0),
    ortho=span * 1.1)
