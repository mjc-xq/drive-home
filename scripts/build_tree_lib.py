#!/usr/bin/env python3
"""Build a clean library of INDIVIDUAL single-tree GLBs from the source assets.

STEP-1 investigation (scripts/_investigate_trees.py + _investigate_acacia.py)
proved that every source mesh is already ONE single tree:
  - Trees.glb  NormalTree_1..5  -> 5 small/medium trees (3-5.7 m wide, 3-6.9 m tall),
                                   each one trunk + canopy (Bark + Leaves materials).
  - Acacia.glb Acacia_Mesh      -> ONE large umbrella acacia. Its 23 m width is the
                                   natural flat crown, NOT a clump: the bottom 25 %
                                   (trunk band) contains a single ~2 m trunk column.
So there is nothing to cut apart - we just normalise each mesh into its own file.

Each exported tree is:
  * upright, +Z up (Blender convention; glTF export keeps +Y up via the gltf addon)
  * trunk base sitting exactly on Z = 0 (origin under the trunk centroid in XY)
  * one mesh per file, materials preserved

Outputs:
  exports/tree_lib/tree_00.glb .. tree_05.glb
  exports/tree_lib/manifest.json  (id, file, source, height_m, canopy_w_m, feature)

Run:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/build_tree_lib.py
"""
import bpy, os, json
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "exports", "tree_lib")
os.makedirs(OUT, exist_ok=True)
TREES_GLB = "/Users/mcohen/Downloads/Trees.glb"
ACACIA_GLB = "/Users/mcohen/Downloads/Acacia.glb"


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def bake_upright(objs):
    """Clear parents + apply transforms so each mesh stands in world +Z, real dims."""
    meshes = [o for o in objs if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    if meshes:
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return meshes


def trunk_base_xy(obj):
    """XY of the trunk centroid, from verts in the bottom 25 % of the mesh height."""
    me = obj.data
    zs = [v.co.z for v in me.vertices]
    zmin, zmax = min(zs), max(zs)
    band = zmin + 0.25 * (zmax - zmin)
    low = [v.co for v in me.vertices if v.co.z <= band]
    if not low:
        low = [v.co for v in me.vertices]
    return (sum(c.x for c in low) / len(low),
            sum(c.y for c in low) / len(low),
            zmin)


def recenter(obj):
    """Move trunk base to origin: XY under trunk centroid, Z so base sits on Z=0."""
    cx, cy, zmin = trunk_base_xy(obj)
    me = obj.data
    for v in me.vertices:
        v.co.x -= cx
        v.co.y -= cy
        v.co.z -= zmin
    me.update()


def canopy_width(obj):
    bb = [Vector(c) for c in obj.bound_box]
    return max(max(p.x for p in bb) - min(p.x for p in bb),
               max(p.y for p in bb) - min(p.y for p in bb))


def export_one(obj, path):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB',
                              use_selection=True, export_yup=True)


bpy.ops.wm.read_factory_settings(use_empty=True)
sources = bake_upright(import_glb(TREES_GLB)) + bake_upright(import_glb(ACACIA_GLB))

manifest = []
idx = 0
for obj in sources:
    recenter(obj)
    bpy.context.view_layer.update()
    d = obj.dimensions
    fname = f"tree_{idx:02d}.glb"
    feature = d.z >= 8.0 or canopy_width(obj) >= 12.0   # the big acacia
    entry = {
        "id": idx,
        "file": fname,
        "source": obj.name,
        "height_m": round(d.z, 2),
        "canopy_w_m": round(canopy_width(obj), 2),
        "feature": bool(feature),
    }
    export_one(obj, os.path.join(OUT, fname))
    manifest.append(entry)
    print(f"[lib] {fname}  src={obj.name:<16} H={entry['height_m']:>5} m  "
          f"W={entry['canopy_w_m']:>5} m  feature={feature}")
    idx += 1

meta = {
    "up_axis": "+Y (glTF, export_yup=True); trunk base at origin, canopy along +Y",
    "note": "Every source mesh is a single tree (see _investigation.json). "
            "Trees.glb=5 normal trees, Acacia.glb=1 large umbrella acacia.",
    "count": len(manifest),
    "trees": manifest,
}
json.dump(meta, open(os.path.join(OUT, "manifest.json"), "w"), indent=2)
print(f"\n[lib] wrote {len(manifest)} trees + manifest.json -> {OUT}")
