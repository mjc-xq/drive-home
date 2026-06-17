#!/usr/bin/env python3
"""Repeatable headless bake for the house-interior scan.

Run with the app's Blender (5.1+):
  blender --background --python scripts/bake_interior.py -- <src.glb> <dst.glb> [ao|noao]

What it does to the raw furniture-segmented room scan, in order:
  1. MERGE duplicate materials  (174 near-identical -> a handful; fewer draw calls)
  2. BAKE the runtime albedo fix (color*0.7, roughness>=0.9, metalness<=0.3) into the
     source materials so interior.js no longer has to do it at load
  3. SOLIDIFY the thin/zero-thickness wall slabs (real back-faces -> no DoubleSide hack;
     colliders get true thickness)
  4. DECIMATE the furniture (97% of the tris) to claw back phone perf
  5. (ao) BAKE ambient occlusion into a per-vertex COLOR_0 attribute (softened) so the
     flat-lit / solid-tinted rooms gain contact-shadow depth with no runtime cost

Node names are PRESERVED (interior.js categorises by name), and Draco stays OFF
(verify_interior_node.mjs fails loudly otherwise). Re-run after any re-scan.
"""
import bpy, sys, math, json

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SRC = argv[0]
DST = argv[1]
DO_AO = (len(argv) < 3) or (argv[2].lower() != "noao")

WALL_PREFIXES = ("wall_", "joint_")
STRUCT_PREFIXES = ("wall_", "joint_", "floor_")
NONFURN_PREFIXES = ("wall_", "joint_", "door_", "window_", "floor_")

def is_furniture(name):
    return not name.startswith(NONFURN_PREFIXES)

def log(msg):
    print("[bake] " + msg, flush=True)

# ---- clean scene + import -------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC, merge_vertices=False)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)
tris_before = sum(tris(o) for o in meshes)
mats_before = len({ms.material.name for o in meshes for ms in o.material_slots if ms.material})
log(f"imported {len(meshes)} meshes, {tris_before} tris, {mats_before} materials")

# ---- 1. merge duplicate materials ----------------------------------------
def principled(m):
    if not m or not m.use_nodes:
        return None
    return next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)

def mat_sig(m):
    if not m:
        return None
    b = principled(m)
    if not b:
        return ("flat", tuple(round(c, 3) for c in m.diffuse_color))
    bc = b.inputs["Base Color"]
    if bc.is_linked:
        src = bc.links[0].from_node
        img = getattr(src, "image", None)
        return ("tex", img.name if img else src.name)
    col = tuple(round(c, 3) for c in bc.default_value)
    return ("rgb", col,
            round(b.inputs["Metallic"].default_value, 2),
            round(b.inputs["Roughness"].default_value, 2))

canon = {}
for m in bpy.data.materials:
    canon.setdefault(mat_sig(m), m)
for o in meshes:
    for ms in o.material_slots:
        if ms.material:
            ms.material = canon[mat_sig(ms.material)]
for m in list(bpy.data.materials):
    if m.users == 0:
        bpy.data.materials.remove(m)
log(f"merged materials -> {len(bpy.data.materials)}")

# ---- 2. bake the runtime albedo correction into the surviving materials ---
for m in bpy.data.materials:
    b = principled(m)
    if not b:
        continue
    bc = b.inputs["Base Color"]
    if not bc.is_linked:  # textured mats keep their map; only tint flat colours
        c = bc.default_value
        c[0], c[1], c[2] = c[0] * 0.7, c[1] * 0.7, c[2] * 0.7
    b.inputs["Roughness"].default_value = max(b.inputs["Roughness"].default_value, 0.9)
    b.inputs["Metallic"].default_value = min(b.inputs["Metallic"].default_value, 0.3)

# ---- helper: bake all modifiers into mesh data (no ops/context needed) ----
def apply_mods(o):
    dg = bpy.context.evaluated_depsgraph_get()
    o.data = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear()

# ---- 3. solidify thin walls; 4. decimate furniture; subdivide for AO ------
solidified = decimated = 0
for o in meshes:
    n = o.name
    changed = False
    if DO_AO and n.startswith(STRUCT_PREFIXES):
        sub = o.modifiers.new("sub", "SUBSURF")
        sub.subdivision_type = "SIMPLE"      # linear: keeps flat shape, just adds verts for AO
        sub.levels = sub.render_levels = 2
        changed = True
    if n.startswith(WALL_PREFIXES) and min(o.dimensions) < 0.05:
        sol = o.modifiers.new("sol", "SOLIDIFY")
        sol.thickness = 0.06
        sol.offset = 0.0
        solidified += 1
        changed = True
    if is_furniture(n) and tris(o) > 500:
        dec = o.modifiers.new("dec", "DECIMATE")
        dec.ratio = 0.55
        decimated += 1
        changed = True
    if changed:
        apply_mods(o)
log(f"solidified {solidified} walls, decimated {decimated} furniture pieces")

# ---- 5. AO bake -> per-vertex COLOR_0 -------------------------------------
if DO_AO:
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 16
    sc.cycles.device = "CPU"
    sc.render.bake.target = "VERTEX_COLORS"
    sc.render.bake.use_clear = True

    ao_mat = bpy.data.materials.new("AO_BAKE")
    ao_mat.use_nodes = True
    nt = ao_mat.node_tree
    nt.nodes.clear()
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao.inputs["Distance"].default_value = 0.6
    ao.samples = 16
    emit = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(ao.outputs["Color"], emit.inputs["Color"])
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])

    STRENGTH = 0.7  # soften so AO never fully blacks out (multiplied in three.js)
    for i, o in enumerate(meshes):
        me = o.data
        if "AO" not in me.color_attributes:
            me.color_attributes.new(name="AO", type="FLOAT_COLOR", domain="POINT")
        me.color_attributes.active_color_name = "AO"
        me.color_attributes.render_color_index = me.color_attributes.find("AO")
        saved = [ms.material for ms in o.material_slots]
        if not saved:
            o.data.materials.append(ao_mat)
        else:
            for ms in o.material_slots:
                ms.material = ao_mat
        for ob in bpy.data.objects:
            ob.select_set(False)
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        try:
            bpy.ops.object.bake(type="EMIT")
        except RuntimeError as e:
            log(f"  bake skipped for {o.name}: {e}")
        if saved:
            for ms, mat in zip(o.material_slots, saved):
                ms.material = mat
        else:
            o.data.materials.clear()
        # soften toward white
        at = me.color_attributes["AO"]
        for d in at.data:
            c = d.color
            c[0] = 1.0 - (1.0 - c[0]) * STRENGTH
            c[1] = 1.0 - (1.0 - c[1]) * STRENGTH
            c[2] = 1.0 - (1.0 - c[2]) * STRENGTH
        if (i + 1) % 50 == 0:
            log(f"  AO baked {i + 1}/{len(meshes)}")
    if ao_mat.users == 0:
        bpy.data.materials.remove(ao_mat)
    log("AO bake complete")

# ---- export ---------------------------------------------------------------
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
tris_after = sum(tris(o) for o in meshes)
bpy.ops.export_scene.gltf(
    filepath=DST,
    export_format="GLB",
    export_draco_mesh_compression_enable=False,   # loader + verify script require no-Draco
    export_normals=False,                         # original is POSITION-only; three computes flat
    export_yup=True,
    export_apply=False,                           # modifiers already baked into mesh data
    export_materials="EXPORT",
    export_vertex_color="ACTIVE",
    export_vertex_color_name="AO",
    export_all_vertex_colors=DO_AO,
    use_visible=False,
)
log(json.dumps({
    "src": SRC, "dst": DST, "ao": DO_AO,
    "tris_before": tris_before, "tris_after": tris_after,
    "materials_before": mats_before, "materials_after": len(bpy.data.materials),
    "solidified_walls": solidified, "decimated_furniture": decimated,
}))
