#!/usr/bin/env python3
"""Reusable, roster-agnostic headless Blender converter: Mixamo FBX -> dahilg GLB.

CORE PRINCIPLE of the dahilg character system: ALL characters (players, NPCs, the
nibbler swarm) share ONE canonical skeleton (standard Mixamo rig with the
"mixamorig:" prefix STRIPPED to plain bone names). Motions are therefore a SHARED,
REUSABLE library: any clip binds to any character by plain bone name. This script
converts a single character's Mixamo FBX export folder into:

  <out_dir>/<id>-mx.glb        -- the character body (skinned mesh + plain-named skeleton)
  <out_dir>/<id>-mx-anims.glb  -- a single multi-ACTION GLB = that character's
                                  contribution to the shared motion library

USAGE (each call is its own Blender process; an open Blender GUI is unaffected):

  /Applications/Blender.app/Contents/MacOS/Blender --background \
      --python scripts/convert_mixamo_fbx.py -- <fbx_folder> <character_id> <out_dir>

The FBX folder is a Mixamo-per-clip export: one "<...>@T-Pose.fbx" (the MESH, no clip)
plus one "<...>@<Clip>.fbx" per animation. The clip KEY is the substring after '@'
(before .fbx) with /[^A-Za-z0-9]+/ collapsed to '_'  (e.g. "Cece@Catwalk Walk.fbx"
-> "Catwalk_Walk"). The folder prefix is ignored; the character id is passed explicitly.

CRITICAL (the project's #1 recurring T-pose bug): in Blender 5.x FBX-imported actions
are SLOTTED, so action.fcurves is EMPTY. Use iter_fcurves() which falls back to walking
action.layers -> strips -> channelbags -> fcurves. We strip "mixamorig:" from every
fcurve data_path so paths like pose.bones["mixamorig:Hips"].location become
pose.bones["Hips"].location and bind to the shared plain-named skeleton.
"""

import os
import re
import sys

import bpy
from mathutils import Vector

PREFIX = "mixamorig:"

# CORE bones present on ALL rigs (from the shared migration contract). Finger / thumb /
# *_End leaf bones may differ per rig and are intentionally NOT required here.
CORE_BONES = [
    "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    "LeftUpLeg", "LeftLeg", "LeftFoot",
    "RightUpLeg", "RightLeg", "RightFoot",
]


# ---------------------------------------------------------------------------
# arg parsing (everything after the standalone "--")
# ---------------------------------------------------------------------------
def parse_args():
    argv = sys.argv
    if "--" not in argv:
        sys.exit("[convert] FATAL: pass args after '--': <fbx_folder> <character_id> <out_dir>")
    rest = argv[argv.index("--") + 1:]
    if len(rest) != 3:
        sys.exit(f"[convert] FATAL: expected 3 args after '--', got {len(rest)}: {rest}")
    fbx_folder, character_id, out_dir = rest
    if not os.path.isdir(fbx_folder):
        sys.exit(f"[convert] FATAL: fbx_folder is not a directory: {fbx_folder}")
    os.makedirs(out_dir, exist_ok=True)
    return fbx_folder, character_id, out_dir


def clip_key(fbx_path):
    """Clip key = substring after '@' (before .fbx) with non-alnum runs -> '_'."""
    base = os.path.basename(fbx_path)
    base = re.sub(r"\.fbx$", "", base, flags=re.IGNORECASE)
    after = base.split("@", 1)[1] if "@" in base else base
    return re.sub(r"[^A-Za-z0-9]+", "_", after).strip("_")


def list_fbx(fbx_folder):
    """Return (mesh_fbx, [clip_fbx, ...]) splitting on the '@T-Pose' mesh file."""
    files = sorted(
        os.path.join(fbx_folder, f)
        for f in os.listdir(fbx_folder)
        if f.lower().endswith(".fbx")
    )
    mesh_fbx, clips = None, []
    for f in files:
        if clip_key(f).lower() == "t_pose":
            mesh_fbx = f
        else:
            clips.append(f)
    if mesh_fbx is None:
        sys.exit(f"[convert] FATAL: no '@T-Pose.fbx' (mesh) file found in {fbx_folder}")
    return mesh_fbx, clips


# ---------------------------------------------------------------------------
# mixamorig:-stripping helpers
# ---------------------------------------------------------------------------
def strip_prefix(name):
    return name[len(PREFIX):] if name.startswith(PREFIX) else name


def strip_armature_bones(armature_obj):
    """Rename every armature bone to drop a leading 'mixamorig:'. Returns count renamed."""
    n = 0
    for bone in armature_obj.data.bones:
        if bone.name.startswith(PREFIX):
            bone.name = strip_prefix(bone.name)
            n += 1
    return n


def strip_vertex_groups(mesh_obj):
    n = 0
    for vg in mesh_obj.vertex_groups:
        if vg.name.startswith(PREFIX):
            vg.name = strip_prefix(vg.name)
            n += 1
    return n


def iter_fcurves(action):
    """Yield an action's fcurves.

    Blender 5.x slotted actions leave action.fcurves EMPTY (or, in 5.1.x, drop the
    attribute entirely) for FBX imports; the fcurves live under
    action.layers[].strips[].channelbag(s).fcurves. Yield the legacy collection when
    present, otherwise walk the slotted graph.
    """
    legacy = getattr(action, "fcurves", None)
    if legacy is not None and len(legacy) > 0:
        for fc in legacy:
            yield fc
        return
    for layer in getattr(action, "layers", []):
        for strip in getattr(layer, "strips", []):
            # Keyframe strips expose channelbags either as .channelbags (plural) or
            # via .channelbag(slot). Iterate the plural collection when available.
            bags = getattr(strip, "channelbags", None)
            if bags is None:
                continue
            for bag in bags:
                for fc in bag.fcurves:
                    yield fc


def strip_action_fcurves(action):
    """Rewrite every fcurve data_path on an action to drop 'mixamorig:'. Returns count."""
    n = 0
    for fc in iter_fcurves(action):
        if PREFIX in fc.data_path:
            fc.data_path = fc.data_path.replace(PREFIX, "")
            n += 1
    return n


def frame_range(action):
    lo, hi = None, None
    for fc in iter_fcurves(action):
        for kp in fc.keyframe_points:
            x = kp.co[0]
            lo = x if lo is None else min(lo, x)
            hi = x if hi is None else max(hi, x)
    if lo is None:
        # fall back to the action's declared range
        return tuple(round(v, 1) for v in action.frame_range)
    return (round(lo, 1), round(hi, 1))


# ---------------------------------------------------------------------------
# scene helpers
# ---------------------------------------------------------------------------
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(path):
    """Import one FBX with automatic bone orientation. Returns the imported objects."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=True)
    return [o for o in bpy.data.objects if o not in before]


def find_armature(objects):
    for o in objects:
        if o.type == "ARMATURE":
            return o
    return None


def meshes_of(objects):
    return [o for o in objects if o.type == "MESH"]


def remove_object(obj):
    bpy.data.objects.remove(obj, do_unlink=True)


def assert_no_mixamorig(armature_obj, actions, where):
    """sys.exit(1) if any bone name or any fcurve data_path still contains 'mixamorig:'."""
    bad = []
    for bone in armature_obj.data.bones:
        if PREFIX in bone.name:
            bad.append(f"bone:{bone.name}")
    for act in actions:
        for fc in iter_fcurves(act):
            if PREFIX in fc.data_path:
                bad.append(f"fcurve[{act.name}]:{fc.data_path}")
                break
    if bad:
        print(f"[convert] FATAL ({where}): residual 'mixamorig:' found: {bad[:10]}", flush=True)
        sys.exit(1)


def assert_core_bones(armature_obj, character_id):
    """sys.exit(1) unless the full CORE bone set is present with Hips as the single root."""
    names = {b.name for b in armature_obj.data.bones}
    missing = [b for b in CORE_BONES if b not in names]
    if missing:
        print(f"[convert] FATAL ({character_id}): missing CORE bones: {missing}", flush=True)
        sys.exit(1)
    roots = [b.name for b in armature_obj.data.bones if b.parent is None]
    if roots != ["Hips"]:
        print(
            f"[convert] FATAL ({character_id}): expected single root 'Hips', got roots={roots}",
            flush=True,
        )
        sys.exit(1)


def rest_height(armature_obj):
    """Rough rest-pose height in metres from edit-bone head/tail Z extent (incl. object scale)."""
    zs = []
    for b in armature_obj.data.bones:
        zs.append(b.head_local.z)
        zs.append(b.tail_local.z)
    if not zs:
        return 0.0
    sz = armature_obj.matrix_world.to_scale().z
    return (max(zs) - min(zs)) * abs(sz)


# ---------------------------------------------------------------------------
# export helpers (mirror this repo's glTF export conventions)
# ---------------------------------------------------------------------------
def export_glb(filepath, *, animations, animation_mode=None):
    """Export the current scene to GLB. RNA-guard the animation-mode prop (organize_layers.py
    pattern) so the script works across Blender builds."""
    kwargs = dict(
        filepath=filepath,
        export_format="GLB",
        export_yup=True,
        export_skins=True,
        export_animations=animations,
        export_apply=False,
        use_selection=False,
        export_draco_mesh_compression_enable=False,
    )
    props = bpy.ops.export_scene.gltf.get_rna_type().properties
    if animation_mode is not None and "export_animation_mode" in props.keys():
        kwargs["export_animation_mode"] = animation_mode
    bpy.ops.export_scene.gltf(**kwargs)


# ---------------------------------------------------------------------------
# orientation fix
# ---------------------------------------------------------------------------
def apply_armature_rotation(arm):
    """Bake the FBX importer's Y-up->Z-up object rotation (armature object ends up at
    rotation_euler=[90,0,0]) into the bone rest so the EXPORTED glTF Armature node is identity
    and the character STANDS upright (not face-up on its back). transform_apply on an armature
    preserves the world pose of any action later evaluated on it (baked-rest + identity-object
    == unbaked-rest + rotated-object), so clip content -- including fall/death animations -- is
    unchanged; only the neutral rest reference frame is corrected."""
    if bpy.context.object is not None and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)


def ground_rig_to_feet(arm):
    """Lift the whole rig so its lowest mesh point (the soles) sits at Z=0, then bake the
    translation. The runtime/web place the model assuming the GLB ORIGIN is at the FEET
    (feet at body y=0), but Mixamo/Meshy bodies often export with the origin at the HIPS
    (~1 m above the soles), which sinks the character ~1 m underground. This restores the
    feet-at-origin convention the engines expect. Returns the lift applied (m)."""
    if bpy.context.object is not None and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.update()

    def lowest_z():
        # Measure the SKELETON-DEFORMED mesh (depsgraph), not the undeformed bound_box: the
        # mesh object origin sits at the hips here, so its bind bbox reads ~0 while the rig
        # the skeleton actually poses reaches ~-1 m. Only the deformed Z reflects the feet.
        dg = bpy.context.evaluated_depsgraph_get()
        mn = None
        for o in bpy.data.objects:
            if o.type != 'MESH':
                continue
            ev = o.evaluated_get(dg)
            m = ev.to_mesh()
            mw = ev.matrix_world
            for v in m.vertices:
                z = (mw @ v.co).z
                if mn is None or z < mn:
                    mn = z
            ev.to_mesh_clear()
        return mn

    minz = lowest_z()
    print(f"[convert]   ground: pre-lift lowest mesh Z = {minz}", flush=True)
    if minz is None or abs(minz) < 1e-4:
        return 0.0
    # Move the whole rig UP so the soles reach Z=0. Translate the armature (the mesh follows
    # as its child/deform), then bake into both so the exported root stays identity.
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.data.objects:
        if o.type in ('ARMATURE', 'MESH'):
            o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    arm.location.z -= minz
    bpy.context.view_layer.update()
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    bpy.context.view_layer.update()
    print(f"[convert]   ground: post-lift lowest mesh Z = {lowest_z()} (lifted {-minz:.3f} m)", flush=True)
    return -minz


# ---------------------------------------------------------------------------
# MESH PASS
# ---------------------------------------------------------------------------
def do_mesh_pass(mesh_fbx, character_id, out_dir):
    reset_scene()
    imported = import_fbx(mesh_fbx)
    armature = find_armature(imported)
    if armature is None:
        sys.exit(f"[convert] FATAL ({character_id}): no armature in mesh FBX {mesh_fbx}")

    n_bones = strip_armature_bones(armature)
    n_vg = 0
    dropped = []
    for m in list(meshes_of(imported)):
        n_vg += strip_vertex_groups(m)
        if len(m.vertex_groups) == 0:
            dropped.append(m.name)
            remove_object(m)

    meshes = meshes_of([o for o in bpy.data.objects])
    vert_count = sum(len(m.data.vertices) for m in meshes)

    assert_core_bones(armature, character_id)
    assert_no_mixamorig(armature, [], f"{character_id} mesh-pass")

    # Stand the rig up: bake out the import's [90,0,0] object rotation so the glTF root is
    # identity (otherwise every character ships face-up on its back).
    apply_armature_rotation(armature)
    # Put the FEET at the origin (y=0): the engines place the body assuming feet-at-origin,
    # but these rigs export with the origin at the hips -> feet ~1 m underground without this.
    lift = ground_rig_to_feet(armature)

    rh = rest_height(armature)
    if not (1.4 <= rh <= 2.2):
        print(f"[convert] WARNING ({character_id}): rest height {rh:.2f} m outside 1.4-2.2 m", flush=True)

    out_path = os.path.join(out_dir, f"{character_id}-mx.glb")
    bpy.ops.object.select_all(action="DESELECT")
    export_glb(out_path, animations=False)

    bone_names = sorted(b.name for b in armature.data.bones)
    print(f"\n[convert] === MESH PASS: {character_id} ===", flush=True)
    print(f"[convert]   source        : {mesh_fbx}", flush=True)
    print(f"[convert]   output        : {out_path} ({os.path.getsize(out_path)} bytes)", flush=True)
    print(f"[convert]   mesh verts    : {vert_count}", flush=True)
    print(f"[convert]   dropped meshes: {dropped if dropped else 'none'}", flush=True)
    print(f"[convert]   bones renamed : {n_bones}, vgroups renamed: {n_vg}", flush=True)
    print(f"[convert]   bone count    : {len(bone_names)}", flush=True)
    print(f"[convert]   rest height   : {rh:.2f} m", flush=True)
    print(f"[convert]   bones         : {bone_names}", flush=True)
    return out_path


# ---------------------------------------------------------------------------
# CLIP PASS
# ---------------------------------------------------------------------------
def do_clip_pass(mesh_fbx, clip_fbxs, character_id, out_dir):
    """Build a single multi-ACTION GLB. Keep the T-Pose armature+mesh as the base; for
    each clip FBX import it, strip mixamorig: from the new armature bones AND the action's
    fcurve data_paths, rename the action to its clip key, set use_fake_user, then delete the
    freshly-imported armature+meshes (keeping ONLY the renamed action datablock)."""
    reset_scene()

    base_objs = import_fbx(mesh_fbx)
    base_arm = find_armature(base_objs)
    if base_arm is None:
        sys.exit(f"[convert] FATAL ({character_id}): no armature in base mesh FBX {mesh_fbx}")
    strip_armature_bones(base_arm)
    for m in list(meshes_of(base_objs)):
        strip_vertex_groups(m)
        if len(m.vertex_groups) == 0:
            remove_object(m)

    # Bake out the import's [90,0,0] object rotation on the BASE armature so the clip GLB's
    # root is identity (matches the body GLB). transform_apply preserves the world pose of the
    # rest-relative actions transferred from each clip import, so animations are unaffected.
    apply_armature_rotation(base_arm)

    total_paths_stripped = 0
    kept_actions = []
    summary = []  # (key, frame_range, paths_stripped)

    for fbx in clip_fbxs:
        key = clip_key(fbx)
        before_actions = set(bpy.data.actions)
        imported = import_fbx(fbx)
        new_arm = find_armature(imported)
        # The mesh pass bakes the FBX importer's 90deg object rotation into the armature rest pose.
        # Do the same for every clip armature BEFORE keeping its action; otherwise the action curves
        # remain authored in the sideways Mixamo import basis and get rebound onto an upright rig.
        if new_arm:
            apply_armature_rotation(new_arm)
        new_actions = [a for a in bpy.data.actions if a not in before_actions]
        if not new_actions:
            # Some FBX imports stash the action on the armature's animation_data.
            if new_arm and new_arm.animation_data and new_arm.animation_data.action:
                new_actions = [new_arm.animation_data.action]
        if len(new_actions) == 0:
            print(f"[convert] WARNING ({character_id}): no action imported from {fbx}", flush=True)
            for o in imported:
                remove_object(o)
            continue
        # one action per Mixamo clip FBX; if >1, keep the longest
        action = max(new_actions, key=lambda a: len(list(iter_fcurves(a))))
        # Strip the action's fcurve data_paths FIRST (this is the mechanism that rebinds
        # the clip to the shared plain-named skeleton: pose.bones["mixamorig:Hips"]... ->
        # pose.bones["Hips"]...). Do it before renaming the new armature's bones so the
        # count reflects the real rewrite rather than Blender's incidental auto-rename.
        stripped = strip_action_fcurves(action)
        total_paths_stripped += stripped
        if new_arm:
            strip_armature_bones(new_arm)
        action.name = key
        action.use_fake_user = True
        kept_actions.append(action)
        summary.append((key, frame_range(action), stripped))

        # drop any extra duplicate actions imported alongside (keep only the renamed one)
        for a in new_actions:
            if a is not action:
                bpy.data.actions.remove(a)
        # delete the freshly-imported armature + its meshes (the action references the
        # shared plain bone names, so it rebinds to the base armature on export)
        for o in imported:
            try:
                remove_object(o)
            except Exception:
                pass

    if not kept_actions:
        print(f"[convert] FATAL ({character_id}): no actions kept; cannot export clip GLB", flush=True)
        sys.exit(1)

    # final residual check across every kept action + the base armature
    assert_core_bones(base_arm, character_id)
    assert_no_mixamorig(base_arm, kept_actions, f"{character_id} clip-pass")

    # activate the base armature and give it animation_data so ACTIONS export sees the rig
    bpy.ops.object.select_all(action="DESELECT")
    base_arm.select_set(True)
    bpy.context.view_layer.objects.active = base_arm
    if base_arm.animation_data is None:
        base_arm.animation_data_create()
    base_arm.animation_data.action = kept_actions[0]

    out_path = os.path.join(out_dir, f"{character_id}-mx-anims.glb")
    export_glb(out_path, animations=True, animation_mode="ACTIONS")

    # verify the GLB actually contains the actions (guards against a silent
    # single-action fallback): re-import into a temp scene and count animations.
    n_anims_in_glb = verify_glb_animations(out_path)

    print(f"\n[convert] === CLIP PASS: {character_id} ===", flush=True)
    print(f"[convert]   output            : {out_path} ({os.path.getsize(out_path)} bytes)", flush=True)
    print(f"[convert]   actions kept      : {len(kept_actions)}", flush=True)
    print(f"[convert]   fcurve paths fixed: {total_paths_stripped}", flush=True)
    print(f"[convert]   GLB animation cnt : {n_anims_in_glb}", flush=True)
    print(f"[convert]   actions (name : frames):", flush=True)
    for key, (lo, hi), stripped in sorted(summary):
        print(f"[convert]       {key:32s} [{lo} .. {hi}]  ({stripped} paths)", flush=True)

    if n_anims_in_glb < len(kept_actions):
        print(
            f"[convert] FATAL ({character_id}): exported GLB has {n_anims_in_glb} animations but "
            f"{len(kept_actions)} actions were kept -- multi-ACTION export FAILED. NOT falling back.",
            flush=True,
        )
        sys.exit(1)
    return out_path


def verify_glb_animations(glb_path):
    """Re-import the exported GLB into a fresh scene and count its glTF animations."""
    reset_scene()
    before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=glb_path)
    n = len([a for a in bpy.data.actions if a not in before])
    return n


# ---------------------------------------------------------------------------
def main():
    fbx_folder, character_id, out_dir = parse_args()
    mesh_fbx, clip_fbxs = list_fbx(fbx_folder)

    print(f"\n[convert] ##### {character_id} #####", flush=True)
    print(f"[convert]   fbx_folder : {fbx_folder}", flush=True)
    print(f"[convert]   out_dir    : {out_dir}", flush=True)
    print(f"[convert]   mesh fbx   : {os.path.basename(mesh_fbx)}", flush=True)
    print(f"[convert]   clip fbxs  : {[os.path.basename(c) for c in clip_fbxs]}", flush=True)
    print(f"[convert]   clip keys  : {sorted(clip_key(c) for c in clip_fbxs)}", flush=True)

    do_mesh_pass(mesh_fbx, character_id, out_dir)
    do_clip_pass(mesh_fbx, clip_fbxs, character_id, out_dir)

    print(f"\n[convert] DONE {character_id}", flush=True)


if __name__ == "__main__":
    main()
