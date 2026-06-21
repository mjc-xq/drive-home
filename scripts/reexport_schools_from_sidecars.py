#!/usr/bin/env python3
"""Re-export the canyon/stanton levels through the CURRENT export_property_glb.mjs
using their CACHED sidecar data (exports/<region>/), with NO network re-fetch.

The legacy export_school_regions.py re-fetches every geo layer (DEM/aerial/OSM/
colors) from the network before exporting. After an exporter code change we just
need to re-run the exporter against the already-captured per-region data, so this
wrapper restores each region's sidecars into the fixed working-file locations,
runs the exporter, copies the fixed-name output to the region's <slug>-property.glb,
and finally restores the Dahill working files so the repo is left clean.

Usage:  scripts/.venv/bin/python scripts/reexport_schools_from_sidecars.py [canyon stanton]
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# region slug -> (sidecar dir under exports/, output property glb name under exports/)
REGIONS = {
    "canyon": ("canyon-middle-school", "canyon-middle-school-property.glb"),
    "stanton": ("stanton-elementary", "stanton-elementary-property.glb"),
    "meemaw": ("meemaw", "meemaw-property.glb"),
}

# fixed working files the exporter reads, and where each sidecar lands.
# key = sidecar filename in exports/<region>/ ; value = destination path (repo-relative)
SIDECAR_DEST = {
    "scene.json": "src/assets/scene.json",
    "dem_1m.json": "exports/dem_1m.json",
    "google_aerial.jpg": "exports/google_aerial.jpg",
    "google_aerial.json": "exports/google_aerial.json",
    "map_surfaces_osm.json": "exports/map_surfaces_osm.json",
    "driveways_osm.json": "exports/driveways_osm.json",
    "buildings_color.json": "exports/buildings_color.json",
    "buildings_color_src.json": "exports/buildings_color_src.json",
    "buildings_roof_color.json": "exports/buildings_roof_color.json",
    "trees_placed.json": "exports/trees_placed.json",
    "parcels.json": "exports/parcels.json",
}

# working files to snapshot/restore so the Dahill state survives (superset of SIDECAR_DEST
# destinations plus the per-region things the exporter might write).
WORK_FILES = [
    "src/assets/scene.json",
    "exports/dem_1m.json",
    "exports/google_aerial.jpg",
    "exports/google_aerial.json",
    "exports/map_surfaces_osm.json",
    "exports/driveways_osm.json",
    "exports/buildings_color.json",
    "exports/buildings_color_src.json",
    "exports/buildings_roof_color.json",
    "exports/trees.json",
    "exports/trees_placed.json",
    "exports/parcels.json",
    "exports/sv_facades.json",
    "exports/1840-dahill-property.glb",
]

# working files that must be cleared before swapping in a region's data so Dahill
# layers don't bleed into the region export (mirrors export_school_regions.remove_work_files).
CLEAR_BEFORE = [
    "exports/dem_1m.json",
    "exports/google_aerial.jpg",
    "exports/google_aerial.json",
    "exports/map_surfaces_osm.json",
    "exports/driveways_osm.json",
    "exports/buildings_color.json",
    "exports/buildings_color_src.json",
    "exports/buildings_roof_color.json",
    "exports/trees.json",
    "exports/trees_placed.json",
    "exports/parcels.json",
    "exports/sv_facades.json",
]


def run(cmd, *, env=None):
    print("+", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], cwd=ROOT, check=True, env=env)


def snapshot(tmp):
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
    sv = ROOT / "exports" / "sv_facades"
    if sv.exists():
        shutil.copytree(sv, tmp / "exports" / "sv_facades")
        manifest["__sv_dir__"] = True
    return manifest


def restore(tmp, manifest):
    for rel, existed in manifest.items():
        if rel == "__sv_dir__":
            continue
        dst = ROOT / rel
        src = tmp / rel
        if existed:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        elif dst.exists():
            dst.unlink()
    sv_dst = ROOT / "exports" / "sv_facades"
    if sv_dst.exists():
        shutil.rmtree(sv_dst)
    if manifest.get("__sv_dir__"):
        shutil.copytree(tmp / "exports" / "sv_facades", sv_dst)


def clear_working():
    for rel in CLEAR_BEFORE:
        p = ROOT / rel
        if p.exists():
            p.unlink()
    sv = ROOT / "exports" / "sv_facades"
    if sv.exists():
        shutil.rmtree(sv)


def export_region(slug):
    sidecar_dir_name, out_name = REGIONS[slug]
    sidecar_dir = ROOT / "exports" / sidecar_dir_name
    if not sidecar_dir.is_dir():
        sys.exit(f"missing sidecar dir for {slug}: {sidecar_dir}")

    print(f"\n== re-export {slug} from {sidecar_dir.relative_to(ROOT)} ==", flush=True)
    clear_working()
    copied = 0
    for name, dest_rel in SIDECAR_DEST.items():
        src = sidecar_dir / name
        if src.exists():
            dest = ROOT / dest_rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            copied += 1
    print(f"  restored {copied} sidecar files into working locations", flush=True)

    # stage this region's persisted SV facades so the re-export keeps them (no re-fetch)
    sv_src = sidecar_dir / "sv_facades"
    if sv_src.is_dir():
        shutil.copytree(sv_src, ROOT / "exports" / "sv_facades")
    man_src = sidecar_dir / "sv_facades.json"
    if man_src.exists():
        shutil.copy2(man_src, ROOT / "exports" / "sv_facades.json")

    env = os.environ.copy()
    env["SHOW_LOTLINES"] = "true"
    run(["node", "scripts/export_property_glb.mjs"], env=env)

    produced = ROOT / "exports" / "1840-dahill-property.glb"
    if not produced.exists():
        sys.exit(f"exporter did not produce {produced}")
    out = ROOT / "exports" / out_name
    shutil.copy2(produced, out)
    print(f"  wrote {out.relative_to(ROOT)} ({out.stat().st_size/1e6:.1f} MB)", flush=True)


def main():
    slugs = sys.argv[1:] or list(REGIONS)
    unknown = [s for s in slugs if s not in REGIONS]
    if unknown:
        sys.exit(f"unknown region slug(s): {', '.join(unknown)} (known: {', '.join(REGIONS)})")
    with tempfile.TemporaryDirectory(prefix="reexport-sidecar-") as d:
        tmp = Path(d)
        manifest = snapshot(tmp)
        try:
            for slug in slugs:
                export_region(slug)
        finally:
            print("\n== restoring Dahill working files ==", flush=True)
            restore(tmp, manifest)
            print("done.", flush=True)


if __name__ == "__main__":
    main()
