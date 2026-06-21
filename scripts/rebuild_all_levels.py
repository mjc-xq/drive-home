#!/usr/bin/env python3
"""Rebuild all 4 outdoor level property GLBs WITH Street View photo facades.

For each level it sets the fixed working-file locations the pipeline reads
(dahill = the current working scene; canyon/stanton/meemaw = restored from their
cached sidecars in exports/<region>/), fetches SV facades for the scene's
street-facing buildings (per-scene origin), runs the exporter (which projects
the facades onto the walls), and copies the result to exports/<slug>-property.glb.
Each region's facades are persisted back into its sidecar dir. The Dahill working
files are snapshotted up front and restored at the end, then Dahill is rebuilt
last so its outputs (with facades) are the final on-disk state.

Usage:  scripts/.venv/bin/python scripts/rebuild_all_levels.py [N_FACADE_TARGETS]
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = str(ROOT / "scripts" / ".venv" / "bin" / "python")
N_FAC = sys.argv[1] if len(sys.argv) > 1 else "400"

# slug -> (sidecar dir under exports/, output property glb name under exports/)
REGIONS = {
    "canyon": ("canyon-middle-school", "canyon-middle-school-property.glb"),
    "stanton": ("stanton-elementary", "stanton-elementary-property.glb"),
    "meemaw": ("meemaw", "meemaw-property.glb"),
}

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

WORK_FILES = [
    "src/assets/scene.json", "exports/dem_1m.json", "exports/google_aerial.jpg",
    "exports/google_aerial.json", "exports/map_surfaces_osm.json", "exports/driveways_osm.json",
    "exports/buildings_color.json", "exports/buildings_color_src.json",
    "exports/buildings_roof_color.json", "exports/trees.json", "exports/trees_placed.json",
    "exports/parcels.json", "exports/sv_facades.json", "exports/1840-dahill-property.glb",
]

CLEAR_BEFORE = [
    "exports/dem_1m.json", "exports/google_aerial.jpg", "exports/google_aerial.json",
    "exports/map_surfaces_osm.json", "exports/driveways_osm.json", "exports/buildings_color.json",
    "exports/buildings_color_src.json", "exports/buildings_roof_color.json", "exports/trees.json",
    "exports/trees_placed.json", "exports/parcels.json", "exports/sv_facades.json",
]


def run(cmd, *, env=None, check=True):
    print("+", " ".join(str(c) for c in cmd), flush=True)
    return subprocess.run([str(c) for c in cmd], cwd=ROOT, check=check, env=env)


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
        manifest["__sv__"] = True
    return manifest


def restore(tmp, manifest):
    for rel, existed in manifest.items():
        if rel == "__sv__":
            continue
        dst, src = ROOT / rel, tmp / rel
        if existed:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        elif dst.exists():
            dst.unlink()
    sv_dst = ROOT / "exports" / "sv_facades"
    if sv_dst.exists():
        shutil.rmtree(sv_dst)
    if manifest.get("__sv__"):
        shutil.copytree(tmp / "exports" / "sv_facades", sv_dst)


def clear_working():
    for rel in CLEAR_BEFORE:
        p = ROOT / rel
        if p.exists():
            p.unlink()
    sv = ROOT / "exports" / "sv_facades"
    if sv.exists():
        shutil.rmtree(sv)


def fetch_and_export(label):
    env = os.environ.copy()
    env["SHOW_LOTLINES"] = "true"
    print(f"\n-- facades + export: {label} --", flush=True)
    r = run([PY, "scripts/fetch_sv_facades.py", N_FAC], env=env, check=False)
    if r.returncode != 0:
        print(f"  ! facade fetch returned {r.returncode} for {label}; exporting with whatever was written", flush=True)
    run(["node", "scripts/export_property_glb.mjs"], env=env)
    produced = ROOT / "exports" / "1840-dahill-property.glb"
    if not produced.exists():
        sys.exit(f"exporter did not produce {produced} for {label}")
    return produced


def persist_region_facades(sidecar_dir):
    """Save the freshly-fetched facades into the region's sidecar dir for reproducibility."""
    sv = ROOT / "exports" / "sv_facades"
    man = ROOT / "exports" / "sv_facades.json"
    if sv.exists():
        dst = ROOT / "exports" / sidecar_dir / "sv_facades"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(sv, dst)
    if man.exists():
        shutil.copy2(man, ROOT / "exports" / sidecar_dir / "sv_facades.json")


def main():
    with tempfile.TemporaryDirectory(prefix="rebuild-all-") as d:
        tmp = Path(d)
        manifest = snapshot(tmp)
        try:
            for slug, (sidecar_dir, out_name) in REGIONS.items():
                src_dir = ROOT / "exports" / sidecar_dir
                if not src_dir.is_dir():
                    print(f"  ! missing sidecar dir for {slug}: {src_dir} — skipping", flush=True)
                    continue
                print(f"\n===== {slug} (from {sidecar_dir}) =====", flush=True)
                clear_working()
                copied = 0
                for name, dest_rel in SIDECAR_DEST.items():
                    s = src_dir / name
                    if s.exists():
                        dst = ROOT / dest_rel
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(s, dst)
                        copied += 1
                print(f"  restored {copied} sidecar files", flush=True)
                produced = fetch_and_export(slug)
                out = ROOT / "exports" / out_name
                shutil.copy2(produced, out)
                print(f"  wrote {out.relative_to(ROOT)} ({out.stat().st_size/1e6:.1f} MB)", flush=True)
                persist_region_facades(sidecar_dir)
        finally:
            print("\n===== restoring Dahill working files =====", flush=True)
            restore(tmp, manifest)

        # Dahill LAST, on the restored working files, so its outputs persist.
        print("\n===== dahill (current working scene) =====", flush=True)
        fetch_and_export("dahill")
        print("\nALL LEVELS REBUILT WITH FACADES.", flush=True)


if __name__ == "__main__":
    main()
