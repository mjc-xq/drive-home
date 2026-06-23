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

Fence RUNS, each a polyline in WORLD coords (x,z) — the same coords as the
parcels.json p.ring the exporters draw as yellow YourLots lines. The owner's
property is the UNION of two adjacent parcels (APN 416-120-67 + 416-120-68);
their rings share an interior divider edge. The runs are authored from that
union geometry, NOT hand-tuned chords:
  GREEN perimeter -> "Fence Section.glb" : the OUTER union ring — one run per
                     side so every side of the property gets exactly one fence
                     line (no bare sides, no double rows). The street-facing
                     FRONT side is split into two runs with a GATE GAP between
                     them so the yard entrance is not walled off.
  PINK divider    -> "Picket fence.glb"  : the interior shared lot-divider line
                     (the edge dropped from the union), where the two parcels
                     touch — the intended place for the picket fence.

Each tiled section is a SEPARATE, individually deletable object named per run
(FenceGreen_0001, FencePink_0001, ...), parented to a single empty "Fences".
Colour/identity stays in each template's MATERIAL base colour (the GLBs carry
their own materials) so usdrecord/Quick Look render it.
"""
import bpy, os, sys, json, math, mathutils

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---- output GLB to rewrite (from argv after `--`, else photo+trees) ----------
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0]) if argv else os.path.join(
    ROOT, "exports/1840-dahill-property-trees.glb")

SCENE_PATH = os.path.join(ROOT, "src", "assets", "scene.json")
SCENE = json.load(open(SCENE_PATH)) if os.path.exists(SCENE_PATH) else {}
SCENE_SLUG = str(SCENE.get("slug") or "").lower()
if SCENE_SLUG and "dahill" not in SCENE_SLUG:
    print(f"[fences] skipping Dahill owner-lot fence runs for scene slug {SCENE_SLUG!r}", flush=True)
    sys.exit(0)

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
# Authored from the UNION of the two owner parcels (APN 416-120-67 + 416-120-68;
# see exports/parcels.json). The shared interior divider edge is DROPPED from the
# outer ring (it becomes the FencePink picket run instead). FenceGreen runs the
# OUTER perimeter, one run per side, so every side gets exactly one fence line.
#
#   union outer ring (CCW), from parcels.json (rounded):
#     (18.26,5.17) (14.96,8.26) (8.67,14.06) (2.06,19.71) (1.46,20.26)   <- FRONT (street)
#     (-13.51,-0.98) (-28.79,-22.54)                                      <- NW side
#     (-28.95,-22.87) (-29.11,-23.18) (-35.81,-32.67) (-27.43,-41.2) (-17.09,-39.75) <- BACK/rear
#     (0.06,-17.9) -> back to (18.26,5.17)                                <- SE side
#   interior divider (shared edge, dropped from ring):
#     (-13.51,-0.98) (-7.64,-5.02) (-3.47,-10.29) (0.06,-17.9)            <- PINK picket
#
# The FRONT (street-facing) side faces the streetSpawn (+X,+Z); it is split into
# two GREEN runs with a ~3.5 m GATE GAP between them so the yard entrance from the
# street is left open like a real front yard (not walled off).
RUNS = [
    # FRONT side (street), LEFT of the gate: corner -> gate-left
    {"name": "FenceGreen", "glb": f"{DL}/Fence Section.glb",
     "polyline": [[18.26, 5.17], [14.96, 8.26], [11.27, 11.66]]},
    # FRONT side (street), RIGHT of the gate: gate-right -> corner   [GATE GAP between]
    {"name": "FenceGreen", "glb": f"{DL}/Fence Section.glb",
     "polyline": [[8.69, 14.04], [2.06, 19.71], [1.46, 20.26]]},
    # NW side: front corner -> back-left corner
    {"name": "FenceGreen", "glb": f"{DL}/Fence Section.glb",
     "polyline": [[1.46, 20.26], [-13.51, -0.98], [-28.79, -22.54]]},
    # BACK / rear: across the back of the property to the SE back corner
    {"name": "FenceGreen", "glb": f"{DL}/Fence Section.glb",
     "polyline": [[-28.79, -22.54], [-28.95, -22.87], [-29.11, -23.18],
                  [-35.81, -32.67], [-27.43, -41.2], [-17.09, -39.75]]},
    # SE side: back corner -> front-right corner (closes the perimeter)
    {"name": "FenceGreen", "glb": f"{DL}/Fence Section.glb",
     "polyline": [[-17.09, -39.75], [0.06, -17.9], [18.26, 5.17]]},
    # PINK picket fence on the INTERIOR shared lot-divider line (the dropped edge).
    {"name": "FencePink", "glb": f"{DL}/Picket fence.glb", "even_fit": True,
     "polyline": [[-13.51, -0.98], [-7.64, -5.02], [-3.47, -10.29], [0.06, -17.9]]},
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


# ---- build scene -------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
import_glb(OUT)                                    # the property model (+trees)

# Purge any fences ALREADY baked into the master from a prior run of this script
# (the empty group "Fences"/"Fences.001..." and every Fence* section under it).
# Without this, each re-bake STACKS a fresh ring on top of the old one — that is
# exactly how the masters ended up with stale FenceBlack/FenceRed/double rows.
# Stripping first makes the bake idempotent: re-running just rewrites the ring.
def purge_old_fences():
    doomed = [o for o in bpy.data.objects
              if o.name == "Fences" or o.name.startswith("Fences.")
              or o.name.startswith("FenceGreen") or o.name.startswith("FencePink")
              or o.name.startswith("FenceRed") or o.name.startswith("FenceBlack")]
    for o in doomed:
        bpy.data.objects.remove(o, do_unlink=True)
    if doomed:
        print(f"[fences] purged {len(doomed)} stale fence objects from master")


purge_old_fences()

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


# tiny end-overlap so adjacent panels share their seam even if an asset's visible
# rails/pickets sit a hair inside its bound-box edge — kills hairline gaps without
# a visible double post.
OVERLAP = 1.03


def emit(src, name, p0, p1, L, n):
    """Place one panel spanning world points p0->p1 (a single resampled span of the
    run). The panel is oriented by an explicit 3D basis: local +X is mapped to the
    FULL 3D run direction (including the terrain rise from p0 to p1), so the far end
    lands EXACTLY on grade at p1 and the next panel — which starts at that same p1 —
    meets it with no gap. (The old Euler pitch-about-world-Y only worked for an
    axis-aligned run; every Dahill run is ~45 deg diagonal, so it tilted the panel
    sideways -> floats, buries, and seams that don't meet.) Local +Z is the panel's
    up, tilting with the slope; local +Y (thickness) stays horizontal."""
    x0, z0 = p0; x1, z1 = p1
    if math.hypot(x1 - x0, z1 - z0) < 1e-6:
        return None
    # world glTF (X, up, Z) -> Blender (X, -Z, up); sample terrain for the up coord.
    p0b = mathutils.Vector((x0, -z0, terrain_at(x0, z0)))
    p1b = mathutils.Vector((x1, -z1, terrain_at(x1, z1)))
    run = p1b - p0b
    span3 = run.length
    if span3 < 1e-6:
        return None
    ax = run / span3                               # local +X -> 3D run (slope incl.)
    up = mathutils.Vector((0.0, 0.0, 1.0))
    ay = up.cross(ax)                              # local +Y -> horizontal, perp to run
    ay = ay.normalized() if ay.length > 1e-6 else mathutils.Vector((0.0, 1.0, 0.0))
    az = ax.cross(ay).normalized()                # local +Z -> panel up (tilts w/ slope)
    basis = mathutils.Matrix((ax, ay, az)).transposed().to_4x4()  # columns = ax,ay,az
    inst = src.copy()                              # separate object, shared mesh
    coll.objects.link(inst)
    inst.hide_set(False)
    inst.parent = parent
    inst.name = f"{name}_{n:04d}"
    sx = (span3 / L) * OVERLAP                     # X-fit (+overlap); thickness/height native
    inst.matrix_world = (mathutils.Matrix.Translation(p0b) @ basis
                         @ mathutils.Matrix.Diagonal((sx, 1.0, 1.0, 1.0)))
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
    # AND the terrain (each panel is a straight chord between two grade samples; a long
    # chord floats over bumps / buries in dips between its endpoints). 3 m hugs a yard's
    # gentle undulation closely while keeping picket spacing believable.
    PANEL_MAX = 3.0
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

make_collision_helpers_transparent()
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_visible=False)
total = sum(counts.values())
print(f"[fences] placed {total} sections {counts} -> {OUT} "
      f"({os.path.getsize(OUT) // 1024} KB)")
