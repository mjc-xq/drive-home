#!/usr/bin/env python3
"""Export an arbitrary address/lat-lon region with the neighborhood GLB pipeline.

This is the future-address wrapper. It uses build_place_scene.py, then runs the
same DEM/aerial/surface/color/property/stylized steps as the school exports. The
legacy exporters still write fixed 1840-dahill filenames internally, so this
wrapper snapshots/restores those files and copies results to <slug>-*.glb.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = ROOT / "scripts" / ".venv" / "bin" / "python"
BLENDER = Path("/Applications/Blender.app/Contents/MacOS/Blender")

WORK_FILES = [
    "src/assets/scene.json",
    "exports/dem_1m.json",
    "exports/google_aerial.jpg",
    "exports/google_aerial.json",
    "exports/map_surfaces_osm.json",
    "exports/driveways_osm.json",
    "exports/buildings_color.json",
    "exports/buildings_roof_color.json",
    "exports/trees.json",
    "exports/trees_placed.json",
    "exports/parcels.json",
    "exports/sv_facades.json",
    "exports/1840-dahill-property.glb",
    "exports/1840-dahill-property-trees.glb",
    "exports/1840-dahill-property-trees.blend",
    "exports/1840-dahill-stylized.glb",
    "exports/1840-dahill-stylized.blend",
]

SIDECARS = [
    "scene.json",
    "dem_1m.json",
    "google_aerial.jpg",
    "google_aerial.json",
    "map_surfaces_osm.json",
    "driveways_osm.json",
    "buildings_color.json",
    "buildings_roof_color.json",
    "trees_placed.json",
    "parcels.json",
]


def run(cmd, *, env=None):
    print("+", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], cwd=ROOT, check=True, env=env)


def backup_files(tmp):
    manifest = {}
    for rel in WORK_FILES:
        src = ROOT / rel
        manifest[rel] = src.exists()
        if src.exists():
            dst = tmp / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    return manifest


def restore_files(tmp, manifest):
    for rel, existed in manifest.items():
        src = tmp / rel
        dst = ROOT / rel
        if existed:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        elif dst.exists():
            dst.unlink()


def remove_work_files():
    for rel in WORK_FILES[1:]:
        p = ROOT / rel
        if p.exists():
            p.unlink()
    sv_dir = ROOT / "exports" / "sv_facades"
    if sv_dir.exists():
        shutil.rmtree(sv_dir)


def copy_if_exists(src, dst):
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def main():
    parser = argparse.ArgumentParser(description="Export one arbitrary place/address region.")
    loc = parser.add_mutually_exclusive_group(required=True)
    loc.add_argument("--address")
    loc.add_argument("--lat", type=float)
    parser.add_argument("--lon", type=float)
    parser.add_argument("--name")
    parser.add_argument("--slug", required=True)
    parser.add_argument("--osm-way", type=int)
    parser.add_argument("--patch", type=float, default=500.0)
    parser.add_argument("--query-radius", type=float)
    parser.add_argument("--target-radius", type=float, default=35.0)
    parser.add_argument("--aerial-radius", type=float)
    parser.add_argument("--aerial-zoom", type=int, default=19)
    parser.add_argument("--color-radius", type=float)
    parser.add_argument("--skip-streetview-colors", action="store_true")
    parser.add_argument("--skip-usdz", action="store_true")
    args = parser.parse_args()
    if args.lat is not None and args.lon is None:
        parser.error("--lon is required with --lat")

    exports = ROOT / "exports"
    scene_path = ROOT / "src" / "assets" / "scene.json"
    parcels_path = exports / "parcels.json"
    aerial_radius = args.aerial_radius or max(args.patch * 0.58, 240.0)
    color_radius = args.color_radius or min(max(args.patch * 0.48, 160.0), 280.0)

    build_cmd = [
        PY, "scripts/build_place_scene.py",
        "--slug", args.slug,
        "--patch", args.patch,
        "--scene-out", scene_path,
        "--parcels-out", parcels_path,
        "--target-radius", args.target_radius,
    ]
    if args.query_radius:
        build_cmd += ["--query-radius", args.query_radius]
    if args.name:
        build_cmd += ["--name", args.name]
    if args.osm_way:
        build_cmd += ["--osm-way", args.osm_way]
    if args.address:
        build_cmd += ["--address", args.address]
    else:
        build_cmd += ["--lat", args.lat, "--lon", args.lon]

    with tempfile.TemporaryDirectory(prefix="place-export-backup-") as d:
        tmp = Path(d)
        manifest = backup_files(tmp)
        try:
            print(f"== exporting {args.slug} ==", flush=True)
            remove_work_files()
            run(build_cmd)
            run([PY, "scripts/fetch_dem.py", args.patch])
            run([PY, "scripts/fetch_aerial_google.py", aerial_radius, args.aerial_zoom])
            run([PY, "scripts/fetch_map_surfaces.py"])
            run([PY, "scripts/fetch_driveways.py"])
            run([PY, "scripts/gen_facade.py"])
            run([PY, "scripts/fetch_roof_colors.py"])
            if not args.skip_streetview_colors:
                run([PY, "scripts/fetch_building_colors.py", color_radius])

            env = os.environ.copy()
            env["SHOW_LOTLINES"] = "true"
            run(["node", "scripts/export_property_glb.mjs"], env=env)
            if BLENDER.exists():
                run([BLENDER, "--background", "--python", "scripts/place_trees.py"])
                run([BLENDER, "--background", "--python", "scripts/organize_layers.py", "--", "exports/1840-dahill-property-trees.glb"])
            else:
                shutil.copy2(exports / "1840-dahill-property.glb", exports / "1840-dahill-property-trees.glb")

            run(["node", "scripts/export_stylized_glb.mjs"], env=env)
            if BLENDER.exists():
                run([BLENDER, "--background", "--python", "scripts/organize_layers.py", "--", "exports/1840-dahill-stylized.glb"])

            outputs = {
                "property": exports / "1840-dahill-property.glb",
                "property-trees": exports / "1840-dahill-property-trees.glb",
                "stylized": exports / "1840-dahill-stylized.glb",
            }
            for kind, src in outputs.items():
                copy_if_exists(src, exports / f"{args.slug}-{kind}.glb")
                copy_if_exists(src.with_suffix(".blend"), exports / f"{args.slug}-{kind}.blend")

            if BLENDER.exists() and not args.skip_usdz:
                for kind in ("property-trees", "stylized"):
                    glb = exports / f"{args.slug}-{kind}.glb"
                    if glb.exists():
                        run([BLENDER, "--background", "--python", "scripts/to_usdz.py", "--", glb, exports / f"{args.slug}-{kind}.usdz"])

            sidecar_dir = exports / args.slug
            sidecar_dir.mkdir(parents=True, exist_ok=True)
            for name in SIDECARS:
                src = scene_path if name == "scene.json" else exports / name
                copy_if_exists(src, sidecar_dir / name)

            scene = json.loads(scene_path.read_text())
            print(
                f"done {args.slug}: buildings={len(scene.get('buildings', []))}, roads={len(scene.get('roads', []))}, "
                f"outputs={', '.join(p.name for p in sorted(exports.glob(args.slug + '-*.glb')))}",
                flush=True,
            )
        finally:
            print("== restoring current working files ==", flush=True)
            restore_files(tmp, manifest)


if __name__ == "__main__":
    main()
