#!/usr/bin/env python3
"""Settle whether Acacia_Mesh is ONE tree or a clump.

Trunk test: take only vertices in the bottom 25% of the mesh height (where any
trunk meets the ground), project to XY, cluster them. One trunk column -> one
tree. Several well-separated columns -> a clump. Also render front + top views.
"""
import bpy, bmesh, os, math
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "exports", "tree_lib")
ACACIA_GLB = "/Users/mcohen/Downloads/Acacia.glb"


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


bpy.ops.wm.read_factory_settings(use_empty=True)
objs = import_glb(ACACIA_GLB)
meshes = [o for o in objs if o.type == 'MESH']
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
m = meshes[0]

bm = bmesh.new(); bm.from_mesh(m.data)
zs = [v.co.z for v in bm.verts]
zmin, zmax = min(zs), max(zs)
H = zmax - zmin
band = zmin + 0.25 * H        # bottom 25% = trunk region
low = [v.co for v in bm.verts if v.co.z <= band]
bm.free()
print(f"Acacia height {H:.2f} m; trunk-band verts (bottom 25%): {len(low)}")

# grid the trunk-band XY at 0.5 m and find occupied-cell connected blobs
CELL = 0.5
xs = [c.x for c in low]; ys = [c.y for c in low]
minx, miny = min(xs), min(ys)
occ = {}
for c in low:
    occ[(int((c.x - minx) / CELL), int((c.y - miny) / CELL))] = True
seen = set(); blobs = []
for cellk in occ:
    if cellk in seen:
        continue
    stack = [cellk]; seen.add(cellk); cells = []
    while stack:
        gx, gy = stack.pop(); cells.append((gx, gy))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                nk = (gx + dx, gy + dy)
                if nk in occ and nk not in seen:
                    seen.add(nk); stack.append(nk)
    blobs.append(cells)
blobs.sort(key=len, reverse=True)
print(f"trunk-band occupied-cell blobs (0.5 m grid, 8-connected): {len(blobs)}")
for b in blobs[:10]:
    bx = [minx + (gx + 0.5) * CELL for gx, gy in b]
    by = [miny + (gy + 0.5) * CELL for gx, gy in b]
    wx = max(bx) - min(bx) + CELL; wy = max(by) - min(by) + CELL
    print(f"   blob cells={len(b):>4}  center=({sum(bx)/len(bx):.2f},{sum(by)/len(by):.2f})  footprint={wx:.1f}x{wy:.1f} m")

# renders: front (look +X), top-down
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x = 1000; sc.render.resolution_y = 800
w = bpy.data.worlds.new("W"); sc.world = w; w.use_nodes = True
w.node_tree.nodes["Background"].inputs[0].default_value = (0.6, 0.75, 0.95, 1)
sun_d = bpy.data.lights.new("S", 'SUN'); sun_d.energy = 3.0
sun = bpy.data.objects.new("S", sun_d); sc.collection.objects.link(sun)
sun.rotation_euler = (math.radians(55), 0, math.radians(35))

bb = [m.matrix_world @ Vector(c) for c in m.bound_box]
cx = sum(p.x for p in bb) / 8; cy = sum(p.y for p in bb) / 8; cz = sum(p.z for p in bb) / 8
span = max(max(p.x for p in bb) - min(p.x for p in bb),
           max(p.y for p in bb) - min(p.y for p in bb),
           max(p.z for p in bb) - min(p.z for p in bb))

def shot(name, loc, rot):
    cd = bpy.data.cameras.new("C"); cd.type = 'ORTHO'; cd.ortho_scale = span * 1.2
    cam = bpy.data.objects.new("C", cd); sc.collection.objects.link(cam)
    cam.location = loc; cam.rotation_euler = rot; sc.camera = cam
    sc.render.filepath = os.path.join(OUT, name); bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam, do_unlink=True)
    print("[render]", os.path.join(OUT, name))

shot("_inv_Acacia_front.png", (cx - span * 3, cy, cz), (math.radians(90), 0, math.radians(-90)))
shot("_inv_Acacia_top.png", (cx, cy, cz + span * 3), (0, 0, 0))
