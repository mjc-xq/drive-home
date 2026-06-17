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
  5. (ao) BAKE ambient occlusion to a shared TEXTURE atlas and wire it through glTF's
     standard occlusionTexture (the `glTF Material Output` node group) -> three's aoMap.
     Survives the loader's runtime furniture tinting (AO is its own map, not base colour).

Node names are PRESERVED (interior.js categorises by name), and Draco stays OFF
(verify_interior_node.mjs fails loudly otherwise). Re-run after any re-scan.
"""
import bpy, sys, math, json

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SRC, DST = argv[0], argv[1]
DO_AO = (len(argv) < 3) or (argv[2].lower() != "noao")
AO_RES = 2048      # AO atlas resolution
AO_STRENGTH = 0.75 # 0 = no AO, 1 = full (softened toward white in-shader)

WALL_PREFIXES = ("wall_", "joint_")
NONFURN_PREFIXES = ("wall_", "joint_", "door_", "window_", "floor_")
def is_furniture(n): return not n.startswith(NONFURN_PREFIXES)
def log(m): print("[bake] " + m, flush=True)
def tris(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)
def principled(m):
    return next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if (m and m.use_nodes) else None

# ---- clean scene + import -------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC, merge_vertices=False)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
tris_before = sum(tris(o) for o in meshes)
mats_before = len({ms.material.name for o in meshes for ms in o.material_slots if ms.material})
log(f"imported {len(meshes)} meshes, {tris_before} tris, {mats_before} materials")

# ---- 1. merge duplicate materials ----------------------------------------
def mat_sig(m):
    b = principled(m)
    if not b:
        return ("flat", tuple(round(c, 3) for c in m.diffuse_color)) if m else None
    bc = b.inputs["Base Color"]
    if bc.is_linked:
        src = bc.links[0].from_node
        return ("tex", getattr(getattr(src, "image", None), "name", src.name))
    return ("rgb", tuple(round(c, 3) for c in bc.default_value),
            round(b.inputs["Metallic"].default_value, 2), round(b.inputs["Roughness"].default_value, 2))

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
    if not bc.is_linked:
        c = bc.default_value
        c[0], c[1], c[2] = c[0] * 0.7, c[1] * 0.7, c[2] * 0.7
    b.inputs["Roughness"].default_value = max(b.inputs["Roughness"].default_value, 0.9)
    b.inputs["Metallic"].default_value = min(b.inputs["Metallic"].default_value, 0.3)

# ---- 3/4. solidify thin walls; decimate furniture -------------------------
def apply_mods(o):
    dg = bpy.context.evaluated_depsgraph_get()
    o.data = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear()

solidified = decimated = 0
for o in meshes:
    n, changed = o.name, False
    if n.startswith(WALL_PREFIXES) and min(o.dimensions) < 0.05:
        s = o.modifiers.new("sol", "SOLIDIFY"); s.thickness = 0.06; s.offset = 0.0
        solidified += 1; changed = True
    if is_furniture(n) and tris(o) > 500:
        o.modifiers.new("dec", "DECIMATE").ratio = 0.55
        decimated += 1; changed = True
    if changed:
        apply_mods(o)
log(f"solidified {solidified} walls, decimated {decimated} furniture pieces")

# ---- 5. AO -> shared texture atlas -> glTF occlusionTexture ----------------
if DO_AO:
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"; sc.cycles.samples = 32; sc.cycles.device = "CPU"
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]

    def textured(o):
        return any(ms.material and (lambda b: b and b.inputs["Base Color"].is_linked)(principled(ms.material))
                   for ms in o.material_slots)

    # 5a. per-object unwrap into a clean 'lightmap' layer (strip strays on flat meshes so a
    #     shared material never ends up with two different occlusion texCoords)
    for o in meshes:
        uvs = o.data.uv_layers
        if not textured(o):
            for l in list(uvs):
                uvs.remove(l)
        lm = uvs.get("lightmap") or uvs.new(name="lightmap")
        uvs.active = lm
        for x in bpy.data.objects:
            x.select_set(False)
        o.select_set(True); bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(island_margin=0.03, angle_limit=1.15)
        bpy.ops.object.mode_set(mode="OBJECT")

    # 5b. pack each object's 0-1 island block into its own grid cell of the shared atlas
    cols = math.ceil(math.sqrt(len(meshes))); s = 1.0 / cols; inset = 0.06
    for i, o in enumerate(meshes):
        cx, cy = i % cols, i // cols
        for d in o.data.uv_layers["lightmap"].data:
            u, v = d.uv
            d.uv = ((cx + inset + u * (1 - 2 * inset)) * s, (cy + inset + v * (1 - 2 * inset)) * s)
    log(f"lightmap atlas: {len(meshes)} objects in {cols}x{cols} grid")

    # 5c. bake AO (finite-distance contact, softened toward white in-shader) into the atlas
    img = bpy.data.images.new("AO_atlas", AO_RES, AO_RES, alpha=False)
    img.colorspace_settings.name = "Non-Color"
    bm = bpy.data.materials.new("AO_BAKE"); bm.use_nodes = True
    nt = bm.node_tree; nt.nodes.clear()
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion"); ao.inputs["Distance"].default_value = 0.5; ao.samples = 24
    mix = nt.nodes.new("ShaderNodeMixRGB"); mix.inputs["Fac"].default_value = AO_STRENGTH
    mix.inputs["Color1"].default_value = (1, 1, 1, 1)
    em = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    timg = nt.nodes.new("ShaderNodeTexImage"); timg.image = img
    nt.links.new(ao.outputs["Color"], mix.inputs["Color2"])
    nt.links.new(mix.outputs["Color"], em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    nt.nodes.active = timg  # bake target image node

    saved = {}
    for o in meshes:
        saved[o.name] = [ms.material for ms in o.material_slots]
        if not o.material_slots:
            o.data.materials.append(bm)
        else:
            for ms in o.material_slots:
                ms.material = bm
        o.data.uv_layers.active = o.data.uv_layers["lightmap"]
    sc.render.bake.target = "IMAGE_TEXTURES"; sc.render.bake.use_clear = True; sc.render.bake.margin = 6
    for x in bpy.data.objects:
        x.select_set(x.type == "MESH")
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.bake(type="EMIT")
    for o in meshes:
        sv = saved[o.name]
        if not sv:
            o.data.materials.clear()
        else:
            for ms, mat in zip(o.material_slots, sv):
                ms.material = mat

    # 5d. wire the atlas into the real materials via the `glTF Material Output` group
    ng = bpy.data.node_groups.get("glTF Material Output") or bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
    if not any(getattr(it, "in_out", "") == "INPUT" and it.name == "Occlusion" for it in ng.interface.items_tree):
        ng.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    for m in bpy.data.materials:
        if m is bm or not m.use_nodes:
            continue
        nt = m.node_tree
        uvn = nt.nodes.new("ShaderNodeUVMap"); uvn.uv_map = "lightmap"
        tx = nt.nodes.new("ShaderNodeTexImage"); tx.image = img; tx.interpolation = "Linear"
        nt.links.new(uvn.outputs["UV"], tx.inputs["Vector"])
        grp = nt.nodes.new("ShaderNodeGroup"); grp.node_tree = ng
        nt.links.new(tx.outputs["Color"], grp.inputs["Occlusion"])
    bpy.data.materials.remove(bm)
    # base UV back to active on textured meshes so base colour exports as TEXCOORD_0
    for o in meshes:
        for l in o.data.uv_layers:
            if l.name != "lightmap":
                o.data.uv_layers.active = l
                break
    log("AO atlas baked + wired to occlusionTexture")

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
    export_vertex_color="NONE",
    export_image_format="JPEG" if DO_AO else "AUTO",   # AO atlas as JPEG, not a 1.5 MB PNG
    export_jpeg_quality=85,
    use_visible=False,
)
log(json.dumps({
    "src": SRC, "dst": DST, "ao": DO_AO,
    "tris_before": tris_before, "tris_after": tris_after,
    "materials_before": mats_before, "materials_after": len(bpy.data.materials),
    "solidified_walls": solidified, "decimated_furniture": decimated,
}))
