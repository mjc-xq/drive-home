#!/usr/bin/env python3
"""Instance INDIVIDUAL single-tree models from the clean library
(exports/tree_lib/tree_NN.glb, built by scripts/build_tree_lib.py) at the
positions in exports/trees_placed.json, each as a SEPARATE, individually
deletable object (Tree_0001, Tree_0002, ...), on top of the property GLB.

Why a library instead of the raw Trees.glb/Acacia.glb: the investigation
(scripts/_investigate_trees.py + _investigate_acacia.py, see
exports/tree_lib/_investigation.json) confirmed every source mesh is ONE single
tree - Trees.glb holds 5 normal trees, Acacia.glb holds 1 large umbrella acacia
(its 23 m span is the natural crown, a single ~2 m trunk column, not a clump).
The library normalises each into its own file with the trunk base at the origin,
so here we import each library tree once and link-duplicate it per placement.

Output: exports/1840-dahill-property-trees.glb  (open in Blender; delete any tree).

  blender --background --python scripts/place_trees.py
"""
import bpy, os, json, math, random

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROP = os.path.join(ROOT, "exports/1840-dahill-property.glb")
OUT = os.path.join(ROOT, "exports/1840-dahill-property-trees.glb")
LIB = os.path.join(ROOT, "exports/tree_lib")
MANIFEST = json.load(open(os.path.join(LIB, "manifest.json")))
PLACED = json.load(open(os.path.join(ROOT, "exports/trees_placed.json")))["trees"]
rng = random.Random(1840)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def bake_upright(objs):
    """Clear parents + apply transforms so each mesh stands in world Z with real dims."""
    meshes = [o for o in objs if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    if meshes:
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return meshes


def load_template(entry):
    """Import one library tree; return its (single) upright mesh, tagged feature."""
    meshes = bake_upright(import_glb(os.path.join(LIB, entry["file"])))
    m = meshes[0]
    m.name = f"_tmpl_{entry['file'].replace('.glb', '')}"
    m["feature"] = entry["feature"]
    m.hide_set(True)
    return m


bpy.ops.wm.read_factory_settings(use_empty=True)
import_glb(PROP)                                   # property scene (no trees)
templates = [load_template(e) for e in MANIFEST["trees"]]

# After import + bake each library tree stands in world +Z (Blender convention)
# with its trunk base at z~0. Print dims to confirm Z is the height.
for t in templates:
    d = t.dimensions
    print(f"[place] template {t.name!r} dims=({d.x:.1f},{d.y:.1f},{d.z:.1f}) feature={t['feature']}")

normals = [o for o in templates if not o["feature"]]
features = [o for o in templates if o["feature"]]


def zext(o):
    zs = [v[2] for v in o.bound_box]
    return max(zs) - min(zs)


def xyext(o):                                      # native canopy width
    xs = [v[0] for v in o.bound_box]; ys = [v[1] for v in o.bound_box]
    return max(max(xs) - min(xs), max(ys) - min(ys))


def zmin(o):
    return min(v[2] for v in o.bound_box)


coll = bpy.context.scene.collection
made = 0
for t in PLACED:
    big = t["canopyR"] >= 4.0 and features and rng.random() < 0.10   # occasional feature tree
    src = rng.choice(features if big else normals)
    inst = src.copy()                              # linked dup: separate OBJECT, shared mesh data
    coll.objects.link(inst)
    inst.hide_set(False)
    inst.name = f"Tree_{made + 1:04d}"
    inst.rotation_mode = 'XYZ'
    yaw = rng.uniform(0, 2 * math.pi)              # random yaw about world up
    inst.rotation_euler = (0.0, 0.0, yaw)
    nh = zext(src) or 1.0
    nw = xyext(src) or 1.0
    target = t["height"] * (1.1 if big else 1.0)
    wcap = 16.0 if big else 11.0                   # cap canopy width so no 40 m monster trees
    s = max(0.2, min(target / nh, wcap / nw)) * rng.uniform(0.92, 1.12)  # natural size variety
    inst.scale = (s, s, s)
    # world pos: glTF (x, base, z) -> Blender (x, -z, base); seat trunk base on terrain
    inst.location = (t["x"], -t["z"], t["base"] - zmin(src) * s)
    made += 1

for t in templates:                                # remove unused template originals
    bpy.data.objects.remove(t, do_unlink=True)

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_visible=False)
print(f"[place] instanced {made} trees from {len(templates)}-tree library -> {OUT} "
      f"({os.path.getsize(OUT) // 1024} KB)")
