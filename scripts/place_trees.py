#!/usr/bin/env python3
"""Instance the real tree models (Downloads/Trees.glb NormalTree_1..5 + Acacia.glb)
at the positions in exports/trees_placed.json, each as a SEPARATE, individually
deletable object (Tree_0001, Tree_0002, ...), on top of the property GLB.

Output: exports/1840-dahill-property-trees.glb  (open in Blender; delete any tree).

  blender --background --python scripts/place_trees.py
"""
import bpy, os, json, math, random

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROP = os.path.join(ROOT, "exports/1840-dahill-property.glb")
OUT = os.path.join(ROOT, "exports/1840-dahill-property-trees.glb")
TREES_GLB = "/Users/mcohen/Downloads/Trees.glb"
ACACIA_GLB = "/Users/mcohen/Downloads/Acacia.glb"
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


bpy.ops.wm.read_factory_settings(use_empty=True)
import_glb(PROP)                                   # property scene (no trees)
templates = bake_upright(import_glb(TREES_GLB)) + bake_upright(import_glb(ACACIA_GLB))
for t in templates:                                # park templates off-scene; deleted after instancing
    t.hide_set(True)

# After import + transform bake the trees stand in world +Z (Blender convention).
# Print dims to confirm Z is the height before instancing.
for t in templates:
    d = t.dimensions
    print(f"[place] template {t.name!r} dims=({d.x:.1f},{d.y:.1f},{d.z:.1f})")

normals = [o for o in templates if o.name.startswith("NormalTree")]
acacia = [o for o in templates if o.name.startswith("Acacia")]


def zext(o):
    zs = [v[2] for v in o.bound_box]
    return max(zs) - min(zs)


def zmin(o):
    return min(v[2] for v in o.bound_box)


coll = bpy.context.scene.collection
made = 0
for t in PLACED:
    big = t["canopyR"] >= 3.4 and acacia and rng.random() < 0.18
    src = rng.choice(acacia if big else normals)
    inst = src.copy()                              # linked dup: separate OBJECT, shared mesh data
    coll.objects.link(inst)
    inst.hide_set(False)
    inst.name = f"Tree_{made + 1:04d}"
    inst.rotation_mode = 'XYZ'
    yaw = rng.uniform(0, 2 * math.pi)              # random yaw about world up
    inst.rotation_euler = (0.0, 0.0, yaw)
    nh = zext(src) or 1.0
    target = t["height"] * (1.15 if big else 1.0)
    s = max(0.15, target / nh)
    inst.scale = (s, s, s)
    # world pos: glTF (x, base, z) -> Blender (x, -z, base); seat trunk base on terrain
    inst.location = (t["x"], -t["z"], t["base"] - zmin(src) * s)
    made += 1

for t in templates:                                # remove unused template originals
    bpy.data.objects.remove(t, do_unlink=True)

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_visible=False)
print(f"[place] instanced {made} trees -> {OUT} ({os.path.getsize(OUT)//1024} KB)")
