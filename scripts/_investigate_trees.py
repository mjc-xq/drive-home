#!/usr/bin/env python3
"""STEP 1 investigation: are the source tree meshes single trees or clumps?

For each mesh in Trees.glb (NormalTree_1..5) and Acacia.glb (Acacia_Mesh):
  - report mesh world dims (after applying its import transform)
  - count LOOSE PARTS (connected components) via bmesh
  - cluster loose-part centroids in the horizontal (XY in Blender after upright bake)
    into spatial groups -> a proxy for "how many separate trees"
  - render the mesh alone from the SIDE (EEVEE) to a PNG so we can see it.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/_investigate_trees.py
"""
import bpy, bmesh, os, math, json
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "exports", "tree_lib")
os.makedirs(OUT, exist_ok=True)
TREES_GLB = "/Users/mcohen/Downloads/Trees.glb"
ACACIA_GLB = "/Users/mcohen/Downloads/Acacia.glb"

report = {"meshes": []}


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def bake_upright(objs):
    meshes = [o for o in objs if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    if meshes:
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return meshes


def loose_parts(obj):
    """Return list of connected components; each = dict(verts, centroid xy, bbox)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    seen = set()
    comps = []
    vert_list = list(bm.verts)
    for seed in vert_list:
        if seed.index in seen:
            continue
        stack = [seed]
        seen.add(seed.index)
        comp = []
        while stack:
            v = stack.pop()
            comp.append(v)
            for e in v.link_edges:
                o = e.other_vert(v)
                if o.index not in seen:
                    seen.add(o.index)
                    stack.append(o)
        co = [v.co for v in comp]
        xs = [c.x for c in co]; ys = [c.y for c in co]; zs = [c.z for c in co]
        comps.append({
            "n": len(comp),
            "cx": sum(xs) / len(xs), "cy": sum(ys) / len(ys),
            "minx": min(xs), "maxx": max(xs),
            "miny": min(ys), "maxy": max(ys),
            "minz": min(zs), "maxz": max(zs),
        })
    bm.free()
    return comps


def cluster_xy(comps, link_dist):
    """Single-linkage cluster of component centroids in XY (Blender ground plane)."""
    n = len(comps)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        parent[find(a)] = find(b)

    for a in range(n):
        for b in range(a + 1, n):
            dx = comps[a]["cx"] - comps[b]["cx"]
            dy = comps[a]["cy"] - comps[b]["cy"]
            if math.hypot(dx, dy) <= link_dist:
                union(a, b)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def setup_render():
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x = 1000
    sc.render.resolution_y = 800
    sc.render.film_transparent = False
    try:
        sc.eevee.taa_render_samples = 16
    except Exception:
        pass
    # world light
    world = bpy.data.worlds.new("W") if not bpy.data.worlds else bpy.data.worlds[0]
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.6, 0.75, 0.95, 1.0)
        bg.inputs[1].default_value = 1.0
    # sun
    if "Sun" not in bpy.data.objects:
        sun_d = bpy.data.lights.new("Sun", 'SUN'); sun_d.energy = 3.0
        sun = bpy.data.objects.new("Sun", sun_d)
        sc.collection.objects.link(sun)
        sun.rotation_euler = (math.radians(55), 0, math.radians(35))


def render_side(obj, path):
    """Frame obj from the side (look along -Y) and render."""
    sc = bpy.context.scene
    bb = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    cx = sum(p.x for p in bb) / 8; cy = sum(p.y for p in bb) / 8; cz = sum(p.z for p in bb) / 8
    sx = max(p.x for p in bb) - min(p.x for p in bb)
    sz = max(p.z for p in bb) - min(p.z for p in bb)
    span = max(sx, sz, 1.0)
    cam_d = bpy.data.cameras.new("Cam")
    cam_d.type = 'ORTHO'
    cam_d.ortho_scale = span * 1.25
    cam = bpy.data.objects.get("Cam") or bpy.data.objects.new("Cam", cam_d)
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    cam.data = cam_d
    cam.location = (cx, cy - span * 3, cz)
    cam.rotation_euler = (math.radians(90), 0, 0)  # look toward +Y... we sit at -Y looking +Y
    sc.camera = cam
    # ground plane for context
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    # cleanup cam each time keeps framing fresh
    return path


bpy.ops.wm.read_factory_settings(use_empty=True)
setup_render()

jobs = [("Trees.glb", TREES_GLB), ("Acacia.glb", ACACIA_GLB)]
all_meshes = []
for label, path in jobs:
    objs = import_glb(path)
    meshes = bake_upright(objs)
    for m in meshes:
        all_meshes.append((label, m))

for label, m in all_meshes:
    d = m.dimensions
    comps = loose_parts(m)
    # link distance ~ a tree spacing. Use a fraction of overall width but min 1.5m.
    link = max(1.5, min(d.x, d.y) * 0.5) if (d.x and d.y) else 2.0
    # also try a few link distances to characterize
    clusters_by_link = {}
    for ld in (1.5, 2.5, 4.0, 6.0):
        clusters_by_link[ld] = len(cluster_xy(comps, ld))
    # per-cluster footprint at the "natural" link distance
    groups = cluster_xy(comps, 4.0)
    grp_info = []
    for g in groups:
        gx = [comps[i]["cx"] for i in g]; gy = [comps[i]["cy"] for i in g]
        gz0 = min(comps[i]["minz"] for i in g); gz1 = max(comps[i]["maxz"] for i in g)
        gminx = min(comps[i]["minx"] for i in g); gmaxx = max(comps[i]["maxx"] for i in g)
        gminy = min(comps[i]["miny"] for i in g); gmaxy = max(comps[i]["maxy"] for i in g)
        grp_info.append({
            "parts": len(g),
            "cx": round(sum(gx) / len(gx), 2), "cy": round(sum(gy) / len(gy), 2),
            "w": round(max(gmaxx - gminx, gmaxy - gminy), 2),
            "h": round(gz1 - gz0, 2),
        })
    info = {
        "source": label, "name": m.name,
        "dims_xyz": [round(d.x, 2), round(d.y, 2), round(d.z, 2)],
        "loose_parts": len(comps),
        "materials": [s.material.name if s.material else None for s in m.material_slots],
        "clusters_by_link_dist": clusters_by_link,
        "clusters_at_4m": len(groups),
        "cluster_footprints": sorted(grp_info, key=lambda c: -c["w"])[:20],
    }
    report["meshes"].append(info)
    print(f"\n=== {label} :: {m.name} ===")
    print(f"  dims (x,y,z) = {info['dims_xyz']}  materials={info['materials']}")
    print(f"  loose parts = {len(comps)}")
    print(f"  clusters by link-dist {clusters_by_link}")
    print(f"  -> {len(groups)} XY clusters at 4m link; top footprints:")
    for c in info["cluster_footprints"][:12]:
        print(f"       cluster parts={c['parts']:>3}  center=({c['cx']},{c['cy']})  w={c['w']}  h={c['h']}")

# render each mesh alone from the side
for label, m in all_meshes:
    for other in bpy.data.objects:
        if other.type == 'MESH':
            other.hide_render = (other is not m)
    safe = f"{label.replace('.glb','')}_{m.name}"
    p = os.path.join(OUT, f"_inv_{safe}.png")
    render_side(m, p)
    print(f"[render] {p}")

json.dump(report, open(os.path.join(OUT, "_investigation.json"), "w"), indent=2)
print("\n[done] report ->", os.path.join(OUT, "_investigation.json"))
