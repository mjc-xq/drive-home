#!/usr/bin/env python3
"""Run the existing neighborhood GLB pipeline for the school scene presets.

The legacy exporters always read src/assets/scene.json and write
exports/1840-dahill-*.glb. This wrapper snapshots those files, swaps in a school
scene, copies the fixed-name outputs to school-specific filenames, then restores
the Dahill working files.
"""
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

CONFIGS = {
    "canyon-middle-school": {
        "patch_m": 720,
        "aerial_radius_m": 410,
        "aerial_zoom": 19,
        "color_radius_m": 360,
    },
    "stanton-elementary": {
        "patch_m": 460,
        "aerial_radius_m": 270,
        "aerial_zoom": 19,
        "color_radius_m": 230,
    },
}

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


def copy_if_exists(src, dst):
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def remove_work_files():
    for rel in WORK_FILES[1:]:
        p = ROOT / rel
        if p.exists():
            p.unlink()
    sv_dir = ROOT / "exports" / "sv_facades"
    if sv_dir.exists():
        shutil.rmtree(sv_dir)


def backup_files(tmp):
    manifest = {}
    for rel in WORK_FILES:
        src = ROOT / rel
        if src.exists():
            dst = tmp / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            manifest[rel] = True
        else:
            manifest[rel] = False
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


def export_one(slug):
    cfg = CONFIGS[slug]
    exports = ROOT / "exports"
    scene_path = ROOT / "src" / "assets" / "scene.json"
    parcels_path = exports / "parcels.json"

    print(f"\n== exporting {slug} ==", flush=True)
    remove_work_files()
    run([PY, "scripts/build_school_scene.py", slug, scene_path, parcels_path])
    run([PY, "scripts/fetch_dem.py", cfg["patch_m"]])
    run([PY, "scripts/fetch_aerial_google.py", cfg["aerial_radius_m"], cfg["aerial_zoom"]])
    run([PY, "scripts/fetch_map_surfaces.py"])
    run([PY, "scripts/fetch_driveways.py"])
    run([PY, "scripts/gen_facade.py"])
    run([PY, "scripts/fetch_roof_colors.py"])
    run([PY, "scripts/fetch_building_colors.py", cfg["color_radius_m"]])

    env = os.environ.copy()
    env["SHOW_LOTLINES"] = "true"
    run(["node", "scripts/export_property_glb.mjs"], env=env)
    if BLENDER.exists():
        run([BLENDER, "--background", "--python", "scripts/place_trees.py"])
        run([BLENDER, "--background", "--python", "scripts/place_fences.py", "--", "exports/1840-dahill-property-trees.glb"])
        run([BLENDER, "--background", "--python", "scripts/organize_layers.py", "--", "exports/1840-dahill-property-trees.glb"])
    else:
        shutil.copy2(exports / "1840-dahill-property.glb", exports / "1840-dahill-property-trees.glb")

    run(["node", "scripts/export_stylized_glb.mjs"], env=env)
    if BLENDER.exists():
        run([BLENDER, "--background", "--python", "scripts/place_fences.py", "--", "exports/1840-dahill-stylized.glb"])
        run([BLENDER, "--background", "--python", "scripts/organize_layers.py", "--", "exports/1840-dahill-stylized.glb"])

    outputs = {
        "property": exports / "1840-dahill-property.glb",
        "property-trees": exports / "1840-dahill-property-trees.glb",
        "stylized": exports / "1840-dahill-stylized.glb",
    }
    for kind, src in outputs.items():
        copy_if_exists(src, exports / f"{slug}-{kind}.glb")
        blend = src.with_suffix(".blend")
        copy_if_exists(blend, exports / f"{slug}-{kind}.blend")

    if BLENDER.exists():
        for kind in ("property", "property-trees", "stylized"):
            glb = exports / f"{slug}-{kind}.glb"
            if glb.exists() and kind != "property":
                run([BLENDER, "--background", "--python", "scripts/to_usdz.py", "--", glb, exports / f"{slug}-{kind}.usdz"])

    sidecar_dir = exports / slug
    sidecar_dir.mkdir(parents=True, exist_ok=True)
    for name in SIDECARS:
        src = scene_path if name == "scene.json" else exports / name
        copy_if_exists(src, sidecar_dir / name)

    scene = json.loads(scene_path.read_text())
    print(
        f"done {slug}: buildings={len(scene.get('buildings', []))}, roads={len(scene.get('roads', []))}, "
        f"outputs={', '.join(p.name for p in sorted(exports.glob(slug + '-*.glb')))}",
        flush=True,
    )


def main():
    slugs = sys.argv[1:] or list(CONFIGS)
    unknown = [s for s in slugs if s not in CONFIGS]
    if unknown:
        sys.exit(f"unknown school slug(s): {', '.join(unknown)}")
    with tempfile.TemporaryDirectory(prefix="school-export-backup-") as d:
        tmp = Path(d)
        manifest = backup_files(tmp)
        try:
            for slug in slugs:
                export_one(slug)
        finally:
            print("\n== restoring current Dahill working files ==", flush=True)
            restore_files(tmp, manifest)


if __name__ == "__main__":
    main()
