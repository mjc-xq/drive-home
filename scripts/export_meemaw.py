#!/usr/bin/env python3
"""Build the "meemaw" residential level (4311 Circle Ave, Castro Valley) GLB.

Mirrors scripts/export_school_regions.py exactly, but for a RESIDENTIAL address it
uses scripts/build_place_scene.py (the generic lat/lon scene builder) instead of
build_school_scene.py. The legacy exporters always read src/assets/scene.json and
write exports/1840-dahill-property.glb, so this wrapper:

  1. snapshots the Dahill working files,
  2. swaps in the meemaw scene + fetches its geo layers,
  3. runs the SAME exporter (export_property_glb.mjs),
  4. copies the fixed-name output -> exports/meemaw-property.glb (+ sidecars),
  5. RESTORES the Dahill working files (in a finally block, even on failure).

The downstream build (scripts/build_dahilg_assets.mjs) is already meemaw-aware and
turns exports/meemaw-property.glb into public/da-hilg/meemaw.glb + meemaw.meta.json.

Usage:  scripts/.venv/bin/python scripts/export_meemaw.py
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

# 4311 Circle Ave, Castro Valley, CA 94546 — Grandma's house (residential, like 1840 Dahill).
MEEMAW = {
    "lat": 37.6995618,
    "lon": -122.0639216,
    "name": "Meemaw's",
    "slug": "meemaw",
    # Residential / dahill-scale patch (dahill exports use a ~256-460 m patch; stanton uses 460).
    "patch_m": 460,
    "aerial_radius_m": 270,
    "aerial_zoom": 19,
    "color_radius_m": 230,
}

# Same WORK_FILES list as export_school_regions.py (snapshot + restore so the repo is
# left in its original Dahill state afterward).
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

# Sidecars saved under exports/meemaw/ for reproducibility (same set as the school wrapper).
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
    # Skip index 0 (scene.json) — build_place_scene.py rewrites it. Same as the school wrapper.
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


def export_meemaw():
    cfg = MEEMAW
    exports = ROOT / "exports"
    scene_path = ROOT / "src" / "assets" / "scene.json"
    parcels_path = exports / "parcels.json"

    print(f"\n== exporting {cfg['slug']} ({cfg['name']}) ==", flush=True)
    remove_work_files()

    # 1) Build the meemaw scene from lat/lon into src/assets/scene.json (+ parcels outline).
    run([
        PY, "scripts/build_place_scene.py",
        "--lat", cfg["lat"], "--lon", cfg["lon"],
        "--name", cfg["name"], "--slug", cfg["slug"],
        "--patch", cfg["patch_m"],
        "--scene-out", scene_path,
        "--parcels-out", parcels_path,
    ])

    # 2) Fetch the geo layers (same order as export_school_regions.export_one). All scripts
    #    are called with NO place arg, so PLACE=dahill -> they read src/assets/scene.json
    #    (now the meemaw scene, with its own origin) and write exports/ root paths.
    run([PY, "scripts/fetch_dem.py", cfg["patch_m"]])
    run([PY, "scripts/fetch_aerial_google.py", cfg["aerial_radius_m"], cfg["aerial_zoom"]])
    run([PY, "scripts/fetch_map_surfaces.py"])
    run([PY, "scripts/fetch_driveways.py"])
    run([PY, "scripts/gen_facade.py"])
    run([PY, "scripts/fetch_roof_colors.py"])
    run([PY, "scripts/fetch_building_colors.py", cfg["color_radius_m"]])

    # 3) Run the exporter (SHOW_LOTLINES=true like the school wrapper). Writes
    #    exports/1840-dahill-property.glb.
    env = os.environ.copy()
    env["SHOW_LOTLINES"] = "true"
    run(["node", "scripts/export_property_glb.mjs"], env=env)

    # 4) Copy exports/1840-dahill-property.glb -> exports/meemaw-property.glb.
    src_glb = exports / "1840-dahill-property.glb"
    out_glb = exports / "meemaw-property.glb"
    if not src_glb.exists():
        raise RuntimeError("exporter did not produce exports/1840-dahill-property.glb")
    shutil.copy2(src_glb, out_glb)
    print(f"  copied {src_glb.name} -> {out_glb.name}", flush=True)

    # 5) Save the sidecars under exports/meemaw/ for reproducibility.
    sidecar_dir = exports / cfg["slug"]
    sidecar_dir.mkdir(parents=True, exist_ok=True)
    for name in SIDECARS:
        src = scene_path if name == "scene.json" else exports / name
        copy_if_exists(src, sidecar_dir / name)

    scene = json.loads(scene_path.read_text())
    print(
        f"done {cfg['slug']}: buildings={len(scene.get('buildings', []))}, "
        f"roads={len(scene.get('roads', []))}, output={out_glb.name} "
        f"({out_glb.stat().st_size / 1024:.0f} KB)",
        flush=True,
    )


def main():
    with tempfile.TemporaryDirectory(prefix="meemaw-export-backup-") as d:
        tmp = Path(d)
        manifest = backup_files(tmp)
        try:
            export_meemaw()
        finally:
            print("\n== restoring current Dahill working files ==", flush=True)
            restore_files(tmp, manifest)


if __name__ == "__main__":
    main()
