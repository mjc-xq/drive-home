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


def make_collision_helpers_transparent():
    """Keep invisible collision meshes invisible after Blender GLB re-export."""
    mat = bpy.data.materials.get("Collision_Invisible")
    if mat is None:
        mat = bpy.data.materials.new("Collision_Invisible")
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
        if obj.type != 'MESH' or not obj.name.startswith("Collision_"):
            continue
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        for poly in obj.data.polygons:
            poly.material_index = 0


# --- tree material upgrade -------------------------------------------------
# The library GLBs ship bad PBR (metalness 0.4 / roughness 0.3 -> shiny plastic)
# and the foliage uses alphaMode=BLEND on what are really alpha-tested cards.
# We fix the shared material datablocks ONCE here (every linked-dup instance
# references the same datablock, so a single edit propagates to all trees) and
# build a SMALL fixed set of leaf-tint variants for per-tree colour variation.

def _bsdf(mat):
    if not mat or not mat.use_nodes:
        return None
    return mat.node_tree.nodes.get("Principled BSDF")


def _set_input(bsdf, name, value):
    if bsdf and name in bsdf.inputs:
        bsdf.inputs[name].default_value = value


def fix_bark_material(mat):
    """Matte bark: kill metalness, raise roughness. Base-colour + normal map stay
    wired (we only touch scalar inputs, never unlink/replace texture nodes)."""
    bsdf = _bsdf(mat)
    _set_input(bsdf, "Metallic", 0.0)
    _set_input(bsdf, "Roughness", 0.88)
    mat.metallic = 0.0
    mat.roughness = 0.88


ALPHA_CUTOFF = 0.45   # foliage card alpha-test threshold


def wire_alpha_clip(mat, cutoff=ALPHA_CUTOFF):
    """Insert an alpha-CLIP node chain on the BSDF Alpha input so the glTF exporter
    emits alphaMode=MASK with alphaCutoff=cutoff.

    IMPORTANT (Blender 4.2+/5.x): the glTF exporter NO LONGER reads Material
    .blend_method to choose alpha mode - it inspects the Alpha node graph. A bare
    'alpha > cutoff' Math node is the pattern its detect_alpha_clip() recognises
    (search_node_tree.py), returning cutoff as alphaCutoff. Without it the
    texture-driven alpha would export as alphaMode=BLEND (the old, bad behaviour).
    Idempotent: skips if the GREATER_THAN clip node already exists."""
    bsdf = _bsdf(mat)
    if not bsdf:
        return
    nt = mat.node_tree
    alpha_in = bsdf.inputs.get("Alpha")
    if not alpha_in or not alpha_in.links:
        return                                     # alpha is a constant -> leave opaque
    if nt.nodes.get("_leaf_alpha_clip"):
        return                                     # already wired
    src_socket = alpha_in.links[0].from_socket     # texture alpha feeding the BSDF
    clip = nt.nodes.new("ShaderNodeMath")
    clip.name = clip.label = "_leaf_alpha_clip"
    clip.operation = 'GREATER_THAN'                # out = (alpha > cutoff) ? 1 : 0
    clip.inputs[1].default_value = cutoff
    clip.location = (bsdf.location.x - 250, bsdf.location.y - 320)
    nt.links.new(src_socket, clip.inputs[0])
    nt.links.new(clip.outputs[0], alpha_in)


def fix_leaf_material(mat, fix_pbr=True):
    """Crisp alpha-tested foliage. Inserts an alpha-clip node chain (-> glTF
    alphaMode=MASK, alphaCutoff); double-sided so cards show from both faces; tiny
    green emission so backlit leaves never read black. EEVEE blend settings are kept
    for correct viewport preview only (the exporter ignores them now).
    fix_pbr=False leaves metalness/roughness untouched (Acacia_Mat is already matte
    roughness=1.0/metal=0.0 - we only add alpha-clip + double-sided + tint to it)."""
    bsdf = _bsdf(mat)
    if fix_pbr:
        _set_input(bsdf, "Metallic", 0.0)
        _set_input(bsdf, "Roughness", 0.85)
        mat.metallic = 0.0
        mat.roughness = 0.85
    wire_alpha_clip(mat)                            # load-bearing: drives alphaMode=MASK
    # Viewport-only EEVEE hints (exporter no longer reads these for alpha mode).
    mat.blend_method = 'CLIP'
    if hasattr(mat, "shadow_method"):
        mat.shadow_method = 'CLIP'
    if hasattr(mat, "surface_render_method"):      # EEVEE-Next (Blender 4.2+/5.x)
        mat.surface_render_method = 'DITHERED'
    mat.alpha_threshold = ALPHA_CUTOFF
    mat.use_backface_culling = False               # -> glTF doubleSided=true
    if hasattr(mat, "show_transparent_back"):
        mat.show_transparent_back = True
    # Subtle self-lit green so foliage in shadow stays leafy, not black.
    if bsdf and "Emission Color" in bsdf.inputs:
        bc = bsdf.inputs["Base Color"].default_value
        bsdf.inputs["Emission Color"].default_value = (
            bc[0] * 0.6, bc[1] * 0.7, bc[2] * 0.5, 1.0)
        _set_input(bsdf, "Emission Strength", 0.06)


# Number of foliage tint variants. Kept deliberately small: instances are linked
# duplicates that share MESH geometry, and a downstream build step instances
# trees by (mesh, material). Assigning per-instance materials fragments that
# instancing, so we cap variants at LEAF_VARIANTS and assign them by
# (template, variant) -> ~6 templates x 4 variants = ~24 (mesh,material) combos
# spread over ~865 trees => each combo still reused ~36x. Raising this number
# linearly reduces instancing reuse, so keep it 3-6.
LEAF_VARIANTS = 4
# Multiplicative tint per variant: (R, G, B) factors applied to base colour to
# nudge green/yellow/brightness ~+-10% so the canopy isn't a flat monoculture.
LEAF_TINTS = [
    (1.00, 1.00, 1.00),    # unchanged reference
    (1.08, 1.04, 0.90),    # warmer / yellower, a touch brighter
    (0.92, 1.00, 0.94),    # cooler, deeper green
    (1.02, 0.92, 0.88),    # drier / olive, slightly dimmer
]


def make_leaf_variants(mat):
    """Return LEAF_VARIANTS copies of an (already fixed) leaf material, each with a
    slightly different base-colour tint. Variant 0 reuses the original datablock so
    the common case adds no extra material."""
    variants = [mat]
    base = _bsdf(mat).inputs["Base Color"].default_value if _bsdf(mat) else None
    for i in range(1, LEAF_VARIANTS):
        v = mat.copy()
        v.name = f"{mat.name}_v{i}"
        b = _bsdf(v)
        if b and base is not None:
            r, g, bl = LEAF_TINTS[i % len(LEAF_TINTS)]
            b.inputs["Base Color"].default_value = (
                min(base[0] * r, 1.0), min(base[1] * g, 1.0),
                min(base[2] * bl, 1.0), base[3])
            if "Emission Color" in b.inputs:        # keep emission in step with tint
                bc = b.inputs["Base Color"].default_value
                b.inputs["Emission Color"].default_value = (
                    bc[0] * 0.6, bc[1] * 0.7, bc[2] * 0.5, 1.0)
        variants.append(v)
    return variants


def upgrade_tree_materials():
    """Fix every tree material in place and build leaf-tint variant tables.
    Returns {leaf_material_name: [variant_mats...]} for per-instance assignment."""
    leaf_variant_sets = {}
    for mat in bpy.data.materials:
        n = mat.name
        if "Bark" in n:                              # NormalTree_Bark
            fix_bark_material(mat)
        elif "Leaves" in n or n.startswith("Acacia"):  # NormalTree_Leaves, Acacia_Mat
            # Acacia PBR is already fine (roughness=1.0) -> keep it; only foliage
            # cards (Leaves) get the matte PBR override.
            fix_leaf_material(mat, fix_pbr="Leaves" in n)
            leaf_variant_sets[n] = make_leaf_variants(mat)
    return leaf_variant_sets


def assign_leaf_variant(inst, leaf_variant_sets, variant_idx):
    """Swap this instance's leaf material slots to the chosen tint variant using an
    OBJECT-level link, so mesh data stays shared and other instances are untouched.
    variant_idx is fixed per (template, variant) so identical (mesh,material) pairs
    recur many times -> instancing reuse stays high."""
    # Read original names from the shared mesh DATA before flipping link to OBJECT
    # (once link='OBJECT', slot.material reports the per-object override instead).
    data_mats = inst.data.materials
    for i, slot in enumerate(inst.material_slots):
        orig = data_mats[i].name if i < len(data_mats) and data_mats[i] else ""
        variants = leaf_variant_sets.get(orig)
        if not variants:
            continue
        slot.link = 'OBJECT'                         # per-object override, keeps mesh shared
        slot.material = variants[variant_idx % len(variants)]


bpy.ops.wm.read_factory_settings(use_empty=True)
import_glb(PROP)                                   # property scene (no trees)
templates = [load_template(e) for e in MANIFEST["trees"]]

# Fix shared bark/leaf PBR + alpha mode and build the leaf tint-variant tables.
# Done after all templates import so every library material datablock exists.
leaf_variant_sets = upgrade_tree_materials()

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
    # Per-tree foliage tint: one of LEAF_VARIANTS, seeded so it's deterministic.
    # Same mesh (src) + same variant index -> identical export combo, so only
    # ~(templates x LEAF_VARIANTS) distinct (mesh,material) pairs ever exist.
    assign_leaf_variant(inst, leaf_variant_sets, rng.randrange(LEAF_VARIANTS))
    made += 1

for t in templates:                                # remove unused template originals
    bpy.data.objects.remove(t, do_unlink=True)

make_collision_helpers_transparent()
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_visible=False)
print(f"[place] instanced {made} trees from {len(templates)}-tree library -> {OUT} "
      f"({os.path.getsize(OUT) // 1024} KB)")
