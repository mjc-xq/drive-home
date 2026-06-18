#!/usr/bin/env python3
"""Tile the three fence GLB assets along the owner's property lines, on top of an
already-built property GLB, mirroring scripts/place_trees.py.

Runs as a POST-step over the SAME output file so fences land in BOTH models:
  PHOTO    : export_property_glb.mjs -> place_trees.py (-> ...-property-trees.glb)
             -> place_fences.py rewrites exports/1840-dahill-property-trees.glb
  STYLIZED : export_stylized_glb.mjs (-> ...-stylized.glb)
             -> place_fences.py rewrites exports/1840-dahill-stylized.glb

Usage:
  blender --background --python scripts/place_fences.py -- <path-to-property-glb>
  (no arg -> defaults to exports/1840-dahill-property-trees.glb)

Four fence RUNS, each a polyline in WORLD coords (x,z) — the same coords as the
parcels.json p.ring the exporters draw as yellow YourLots lines:
  GREEN side   -> "Fence Section.glb" : two long road->creek side edges.
  PINK interlot-> "Picket fence.glb"  : the edge shared by both owner lots.
  RED creek    -> "Fence.glb"         : back lot boundary nearest the creek.
  BLACK front  -> "Picket fence.glb"  : short run off the house's road corners.

Each tiled section is a SEPARATE, individually deletable object named per run
(FenceGreen_0001, FencePink_0001, FenceRed_0001, FenceBlack_0001), parented to a
single empty "Fences". Colour/identity stays in each template's MATERIAL base
colour (the GLBs carry their own materials) so usdrecord/Quick Look render it.
"""
import bpy, os, sys, json, math, mathutils

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---- output GLB to rewrite (from argv after `--`, else photo+trees) ----------
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0]) if argv else os.path.join(
    ROOT, "exports/1840-dahill-property-trees.glb")

DL = "/Users/mcohen/Downloads"

# ---- frame constants (must match the exporters) ------------------------------
LAT0, LON0 = 37.6835313, -122.0686199
COSLAT = math.cos(LAT0 * math.pi / 180)

# ---- terrain height sampler — replicate export_property_glb.mjs terrainAt -----
D = json.load(open(os.path.join(ROOT, "exports/dem_1m.json")))
DCOLS, DROWS, DH = D["cols"], D["rows"], D["h"]
DLAT = D["latN"] - D["latS"]
DLON = D["lonE"] - D["lonW"]
CX, CY = D["Cx"], D["Cy"]                         # scene.json center C


def terrain_at(X, Z):
    """World (X,Z) glTF coords -> terrain elevation (absolute m, ~50)."""
    lat = LAT0 + (CY - Z) / 110540.0              # n = CY - Z ; lat from n
    lon = LON0 + (X + CX) / (COSLAT * 111320.0)   # e = X + CX ; lon from e
    fi = (lon - D["lonW"]) / DLON * DCOLS - 0.5
    fj = (D["latN"] - lat) / DLAT * DROWS - 0.5
    fi = max(0.0, min(DCOLS - 1.001, fi))
    fj = max(0.0, min(DROWS - 1.001, fj))
    i, j = int(fi), int(fj)
    u, v = fi - i, fj - j
    a = DH[j * DCOLS + i]; b = DH[j * DCOLS + i + 1]
    c = DH[(j + 1) * DCOLS + i]; d = DH[(j + 1) * DCOLS + i + 1]
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v


# ---- fence runs (WORLD coords x,z) -------------------------------------------
RUNS = [
    {"name": "FenceGreen", "glb": f"{DL}/Fence Section.glb",
     "polyline": [[1.46, 20.34], [-13.53, -0.98], [-28.83, -22.64]]},
    {"name": "FenceGreen", "glb": f"{DL}/Fence Section.glb",
     "polyline": [[18.28, 5.19], [0.06, -17.97], [-17.11, -39.91]]},
    {"name": "FencePink", "glb": f"{DL}/Picket fence.glb", "even_fit": True,
     "polyline": [[-13.53, -0.98], [-7.65, -5.04], [-3.47, -10.33], [0.06, -17.97]]},
    # creek-side fence pulled ONTO LAND (east bank), inside the property — the parcel
    # line itself dips into the ~10 m creek ribbon (centreline ~x-32.5), so following it
    # literally put the fence in the water. Judgement: run it ~5 m inside the bank.
    {"name": "FenceRed", "glb": f"{DL}/Fence.glb",
     "polyline": [[-28.83, -22.64], [-27.0, -31.0], [-25.5, -39.0], [-17.11, -39.91]]},
    {"name": "FenceBlack", "glb": f"{DL}/Picket fence.glb", "even_fit": True,
     "polyline": [[12.06, 2.53], [15.5, 7], [8.68, 14.12]]},
]

# per-asset unit scale (-> meters), whether the native run axis is Y not X, and a
# target fence HEIGHT in metres. The Fence Section.glb panel is authored ~3.2 m tall
# (reads as a solid wall), so we squash it to a believable ~1.9 m fence; the picket
# and creek fences are already ~1.1-1.9 m, so leave them at native height (None).
ASSET = {
    "Fence Section.glb": {"scale": 1.0,   "yrun": False, "height": 1.9},  # X-run, m
    "Picket fence.glb":  {"scale": 0.001, "yrun": False, "height": None}, # X-run, mm
    "Fence.glb":         {"scale": 0.01,  "yrun": True,  "height": None},  # Y-run, cm
}


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def load_template(path):
    """Import one fence GLB, scale to meters, orient so the run axis is +X with
    its START at local X=0 and base at Z=0, then join to a single mesh object
    whose origin is at the run-start on the ground. Returns (obj, length_m)."""
    objs = import_glb(path)
    meshes = [o for o in objs if o.type == 'MESH']
    base = os.path.basename(path)
    spec = ASSET[base]

    # clear parents (keep world transform), then bake the unit scale in
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # scale to meters about world origin
    for o in meshes:
        o.scale = (spec["scale"],) * 3
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # join the (possibly many) meshes into one object
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active

    # Fence.glb runs along native Y; rotate -90 about Z (baked into mesh data, so
    # it works in background mode) so the run axis becomes +X like the others.
    if spec["yrun"]:
        obj.data.transform(mathutils.Matrix.Rotation(-math.pi / 2, 4, 'Z'))

    bpy.context.view_layer.update()
    bb = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
    xs = [v.x for v in bb]; ys = [v.y for v in bb]; zs = [v.z for v in bb]
    # squash the panel's HEIGHT (Blender +Z) to the target so tall wall-like
    # panels read as a see-through fence, not an opaque wall.
    height = max(zs) - min(zs)
    if spec["height"] and height > 1e-3:
        sz = spec["height"] / height
        obj.data.transform(mathutils.Matrix.Diagonal((1.0, 1.0, sz, 1.0)))
        # bound_box is cached; after a mesh-data transform it is stale, so read the
        # post-squash extents from the actual vertices (else the base-shift below
        # uses the OLD min and the panel ends up floating above the terrain).
        vs = [obj.matrix_world @ v.co for v in obj.data.vertices]
        xs = [v.x for v in vs]; ys = [v.y for v in vs]; zs = [v.z for v in vs]
    length = max(xs) - min(xs)
    # move geometry so start is at local X=0, centred in Y, base at Z=0
    shift = mathutils.Vector((-min(xs), -(min(ys) + max(ys)) / 2.0, -min(zs)))
    obj.data.transform(mathutils.Matrix.Translation(shift))
    obj.matrix_world = mathutils.Matrix.Identity(4)
    obj.hide_set(True)
    return obj, length


# ---- build scene -------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
import_glb(OUT)                                    # the property model (+trees)

templates = {}
for r in RUNS:
    base = os.path.basename(r["glb"])
    if base not in templates:
        templates[base] = load_template(r["glb"])
        print(f"[fences] template {base!r} length={templates[base][1]:.2f} m")

parent = bpy.data.objects.new("Fences", None)      # empty group node
bpy.context.scene.collection.objects.link(parent)

coll = bpy.context.scene.collection
counts = {}


def cum_lengths(pl):
    """Cumulative arc length at each polyline vertex; total length."""
    cum = [0.0]
    for k in range(len(pl) - 1):
        cum.append(cum[-1] + math.hypot(pl[k + 1][0] - pl[k][0],
                                        pl[k + 1][1] - pl[k][1]))
    return cum, cum[-1]


def point_at(pl, cum, s):
    """World (x,z) at arc length s along polyline pl (cum = cum_lengths)."""
    s = max(0.0, min(cum[-1], s))
    for k in range(len(pl) - 1):
        if s <= cum[k + 1] or k == len(pl) - 2:
            seg = cum[k + 1] - cum[k]
            t = 0.0 if seg < 1e-9 else (s - cum[k]) / seg
            return (pl[k][0] + (pl[k + 1][0] - pl[k][0]) * t,
                    pl[k][1] + (pl[k + 1][1] - pl[k][1]) * t)
    return (pl[-1][0], pl[-1][1])


def emit(src, name, p0, p1, L, n):
    """Place one panel spanning world points p0->p1 (a single resampled span of the
    run). Fitted in X to the span length, yawed to the chord, and PITCHED about its
    run axis so its base follows the terrain slope between p0 and p1 (no float/bury
    on banks). The panel origin (local X=0, base Z=0) sits on grade at p0."""
    x0, z0 = p0; x1, z1 = p1
    dx, dz = x1 - x0, z1 - z0
    span = math.hypot(dx, dz)
    if span < 1e-6:
        return None
    ux, uz = dx / span, dz / span
    y0 = terrain_at(x0, z0)
    y1 = terrain_at(x1, z1)
    yaw = math.atan2(-uz, ux)                      # world (x,z)->Blender (x,-z)
    # tilt base to follow the slope: with mode 'ZYX' the local +X (run) far end
    # rises by -sin(ry)*L, so negate so the panel end lands at the uphill height.
    pitch = -math.atan2(y1 - y0, span)
    inst = src.copy()                              # separate object, shared mesh
    coll.objects.link(inst)
    inst.hide_set(False)
    inst.parent = parent
    inst.name = f"{name}_{n:04d}"
    inst.rotation_mode = 'ZYX'                     # apply yaw(Z) first, then pitch(Y)
    inst.rotation_euler = (0.0, pitch, yaw)
    inst.scale = (span / L, 1.0, 1.0)              # X-fit; height/posts stay upright
    inst.location = (x0, -z0, y0)                  # base on terrain at the span start
    return inst


def place(run):
    src, L = templates[os.path.basename(run["glb"])]
    name, pl = run["name"], run["polyline"]
    n = counts.get(name, 0)
    # Treat the WHOLE run as one continuous path and tile EQUAL panels along arc
    # length. This absorbs tiny OSM/parcel micro-segments (the red creek run has two
    # ~0.35 m stubs) into full-length panels instead of crushing each segment to a
    # spiky fragment, and gives clean even panels that terminate exactly at the end.
    # Cap the panel length at PANEL_MAX so panels stay short enough to TRACK CORNERS
    # (each panel is a chord of an arc-length span; long panels would cut bends).
    PANEL_MAX = 6.0
    cum, total = cum_lengths(pl)
    if total < 1e-6:
        counts[name] = n
        return
    target = min(L, PANEL_MAX)
    count = max(1, round(total / target))
    panel = total / count
    for c in range(count):
        n += 1
        emit(src, name, point_at(pl, cum, c * panel),
             point_at(pl, cum, (c + 1) * panel), L, n)
    counts[name] = n


for r in RUNS:
    place(r)

for base, (obj, _L) in templates.items():          # drop unused template originals
    bpy.data.objects.remove(obj, do_unlink=True)

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_visible=False)
total = sum(counts.values())
print(f"[fences] placed {total} sections {counts} -> {OUT} "
      f"({os.path.getsize(OUT) // 1024} KB)")
