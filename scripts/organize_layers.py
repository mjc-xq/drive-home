#!/usr/bin/env python3
"""Re-organize an exported neighborhood GLB into clean, well-named Blender
COLLECTIONS so the model is trivial to read, edit, and enable/disable - layer by
layer - for either a human or an AI working in Blender.

Runs as the FINAL post-step over a finished property/stylized GLB (after
place_trees.py + place_fences.py), mirroring their import -> edit -> re-export
shape:

  blender --background --python scripts/organize_layers.py -- <path-to-glb>
  (no arg -> defaults to exports/1840-dahill-property-trees.glb)

What it produces, from a flat pile of ~1000 nodes:

  Neighborhood
   - Terrain & Ground         Terrain / grass ground            (Satellite Ground -> off)
   - Buildings                Owner House / Neighborhood Houses / Street View Facades
   - Roads & Paths            Streets / Walkways
   - Creek                    water, banks, flow lines, rocks, reeds
   - Vegetation               Trees (sub-grouped by area NE/NW/SE/SW) / Grass in the Wind / Shrubs
   - Fences                   one sub-group per fence type (side / interlot / creek / front)
   - Property Lines           lot outlines                       (off by default)
   - Helpers                  Collision / LOD proxies            (off by default, kept invisible)
   - Unsorted                 anything unmatched (should stay empty - a tripwire)

Two artifacts are written:
  * <glb>            re-exported with the collection hierarchy baked into the
                     glTF node tree (export_hierarchy_full_collections), so the
                     grouping survives wherever the GLB lands (three.js, Quick
                     Look, re-import).
  * <glb stem>.blend the editable master: open it and every layer is a tidy,
                     toggle-able collection in the outliner.

The model geometry is never moved: we flatten the import's wrapper empties while
preserving each object's WORLD transform, so positions/animation are identical -
we only change how nodes are GROUPED, not where they sit.
"""
import bpy, os, sys, re, math

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB = os.path.abspath(argv[0]) if argv else os.path.join(
    ROOT, "exports/1840-dahill-property-trees.glb")
BLEND = os.path.splitext(GLB)[0] + ".blend"

# Per-instance wrapper empties carry the IDENTITY of one object on the empty,
# with the real mesh as its sole child (the stylized exporter wraps every tree
# this way: Tree_0007[empty] -> NormalTree_3[mesh]). We hand the name down to the
# mesh so the flattened object stays "Tree_0007", then drop the empty.
INSTANCE_RE = re.compile(r"^(?:Tree|Shrub|Fence[A-Za-z]+)_\d+$")


def strip(name):
    """Blender appends .001 on name clashes at import; match on the real stem."""
    return re.sub(r"\.\d+$", "", name or "")


# ---- layer taxonomy ----------------------------------------------------------
# (regex on the stripped object name, collection path under "Neighborhood").
# First match wins; Tree_* gets an extra per-area sub-group appended below.
# Paths that should ship DISABLED in the outliner are listed in HIDDEN.
RULES = [
    (r"^Collision_.*$",                 ("Helpers", "Collision")),
    (r"^LOD_.*$",                        ("Helpers", "LOD")),
    (r"^(LotLines|YourLots)$",          ("Property Lines",)),
    (r"^SatelliteGround$",              ("Terrain & Ground", "Satellite Ground (off)")),
    (r"^Roofs_photo$",                  ("Buildings", "Roof Photo (off)")),
    (r"^(Terrain|Terrain_Grass)$",      ("Terrain & Ground", "Ground")),
    (r"^House_.*$",                     ("Buildings", "Owner House")),
    (r"^(Doors|GarageDoors|GarageDoor_trim)$", ("Buildings", "Owner House")),
    (r"^SVFacade_.*$",                  ("Buildings", "Street View Facades")),
    (r"^Buildings_.*$",                 ("Buildings", "Neighborhood Houses")),
    (r"^(Roads|RoadLines)$",            ("Roads & Paths", "Streets")),
    (r"^.*Curbs?$",                     ("Roads & Paths", "Streets")),
    (r"^(Driveways|Driveways_Mapped|ParkingAreas_Mapped)$", ("Roads & Paths", "Streets")),
    (r"^(Sidewalks|Sidewalks_Mapped|Crosswalks_Mapped)$",   ("Roads & Paths", "Walkways")),
    (r"^Creek_.*$",                     ("Creek",)),
    (r"^Tree_\d+$",                     ("Vegetation", "Trees")),   # + area, see below
    (r"^GrassClump_.*$",               ("Vegetation", "Grass in the Wind")),
    (r"^Shrubs.*$",                     ("Vegetation", "Shrubs")),
    (r"^FenceGreen_.*$",               ("Fences", "Side Boundary (Fence Section)")),
    (r"^FencePink_.*$",                ("Fences", "Interlot Divider (Picket)")),
    (r"^FenceRed_.*$",                 ("Fences", "Creek Fence")),
    (r"^FenceBlack_.*$",               ("Fences", "Front Picket")),
]
RULES = [(re.compile(rx), path) for rx, path in RULES]

# Collections that open DISABLED (eye off) but still export (use_visible=False).
HIDDEN = {
    ("Helpers",), ("Helpers", "Collision"), ("Helpers", "LOD"),
    ("Property Lines",),
    ("Terrain & Ground", "Satellite Ground (off)"),
    ("Buildings", "Roof Photo (off)"),
}

# A splash of outliner colour per top group so the tree reads at a glance.
COLOR = {
    "Terrain & Ground": "COLOR_05",  # green-ish
    "Buildings":        "COLOR_02",  # orange
    "Roads & Paths":    "COLOR_08",  # grey/blue
    "Creek":            "COLOR_04",  # blue
    "Vegetation":       "COLOR_03",  # green
    "Fences":           "COLOR_01",  # red/brown
    "Property Lines":   "COLOR_06",  # purple
    "Helpers":          "COLOR_07",  # pink
    "Unsorted":         "COLOR_07",
}


def area_tag(obj):
    """Compass quadrant of a tree about the scene origin (Blender X=East, Y=North)."""
    p = obj.matrix_world.translation
    return ("N" if p.y >= 0 else "S") + ("E" if p.x >= 0 else "W")


def classify(obj):
    base = strip(obj.name)
    for rx, path in RULES:
        if rx.match(base):
            if path == ("Vegetation", "Trees"):
                return path + ("Trees - " + area_tag(obj),)
            return path
    return ("Unsorted",)


# ---- collection plumbing -----------------------------------------------------
ROOT_NAME = "Neighborhood"
_cache = {}


def get_coll(path):
    """get-or-create the nested collection at `path` (a tuple of names), under
    the master scene collection, prefixed by the single Neighborhood root."""
    full = (ROOT_NAME,) + path
    if full in _cache:
        return _cache[full]
    parent = bpy.context.scene.collection if len(full) == 1 else get_coll(path[:-1] if path else ())
    # for the root itself path==() -> parent is scene collection, name=ROOT_NAME
    name = full[-1]
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
    if c.name not in {ch.name for ch in parent.children}:
        parent.children.link(c)
    _cache[full] = c
    return c


def put(obj, path):
    c = get_coll(path)
    for uc in list(obj.users_collection):
        uc.objects.unlink(obj)
    c.objects.link(obj)


def make_collision_helpers_transparent():
    """Keep the invisible collision/LOD proxies invisible after re-export
    (same material the place_* scripts use, so QA's alpha==0 check holds)."""
    mat = bpy.data.materials.get("Collision_Invisible") or bpy.data.materials.new("Collision_Invisible")
    mat.diffuse_color = (1.0, 0.0, 1.0, 0.0)
    mat.use_nodes = True
    mat.blend_method = 'BLEND'
    if hasattr(mat, "show_transparent_back"):
        mat.show_transparent_back = True
    if hasattr(mat, "surface_render_method"):
        mat.surface_render_method = 'BLENDED'
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        if "Base Color" in bsdf.inputs:
            bsdf.inputs["Base Color"].default_value = (1.0, 0.0, 1.0, 0.0)
        if "Alpha" in bsdf.inputs:
            bsdf.inputs["Alpha"].default_value = 0.0
    for obj in bpy.data.objects:
        if obj.type != 'MESH' or not (obj.name.startswith("Collision_") or obj.name.startswith("LOD_")):
            continue
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        for poly in obj.data.polygons:
            poly.material_index = 0


# ---- 1. import ---------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

# ---- 2. flatten wrapper empties (preserve WORLD transform) -------------------
# Hand per-instance names (Tree_0007, FenceGreen_0003, ...) from the wrapper
# empty down to its single mesh child before we drop the empties.
for e in [o for o in bpy.data.objects if o.type == 'EMPTY']:
    kids = list(e.children)
    mesh_kids = [c for c in kids if c.type == 'MESH']
    if INSTANCE_RE.match(strip(e.name)) and len(kids) == 1 and len(mesh_kids) == 1:
        nm = e.name
        e.name = nm + "__grp"          # free the name first
        mesh_kids[0].name = nm

# Snapshot every world matrix, un-parent everything, then restore the matrix so
# nothing moves; finally remove the now-childless grouping empties.
snap = {o.name: o.matrix_world.copy() for o in bpy.data.objects}
for o in bpy.data.objects:
    if o.parent:
        o.parent = None
        o.matrix_world = snap[o.name]
for e in [o for o in bpy.data.objects if o.type == 'EMPTY']:
    bpy.data.objects.remove(e, do_unlink=True)

# ---- 3. sort every object into its collection --------------------------------
from collections import Counter
tally = Counter()
unsorted = []
for o in [o for o in bpy.data.objects if o.type == 'MESH']:
    path = classify(o)
    put(o, path)
    tally[path] += 1
    if path == ("Unsorted",):
        unsorted.append(o.name)

# ---- 4. defaults: disable helper/optional layers, colour the top groups ------
for path in HIDDEN:
    if ("Neighborhood",) + path in _cache:
        get_coll(path).hide_viewport = True
for top, tag in COLOR.items():
    key = ("Neighborhood", top)
    if key in _cache:
        _cache[key].color_tag = tag

make_collision_helpers_transparent()

# ---- 5. write the editable .blend + the re-grouped GLB -----------------------
bpy.ops.wm.save_as_mainfile(filepath=BLEND)

export_kwargs = dict(filepath=GLB, export_format='GLB', use_visible=False,
                     export_animations=True, export_apply=False)
props = bpy.ops.export_scene.gltf.get_rna_type().properties
if "export_hierarchy_full_collections" in props.keys():
    export_kwargs["export_hierarchy_full_collections"] = True
bpy.ops.export_scene.gltf(**export_kwargs)

# ---- 6. report ---------------------------------------------------------------
print("[organize] collections:")
for path in sorted(tally, key=lambda p: (p[0], p[1:])):
    print(f"    {' / '.join(path):44s} {tally[path]:4d}")
print(f"[organize] {sum(tally.values())} meshes sorted -> {len(tally)} leaf collections")
if unsorted:
    print(f"[organize] WARNING: {len(unsorted)} UNSORTED objects: {unsorted[:20]}")
print(f"[organize] wrote {BLEND} ({os.path.getsize(BLEND)//1024} KB)")
print(f"[organize] wrote {GLB} ({os.path.getsize(GLB)//1024} KB)")
