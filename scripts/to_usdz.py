#!/usr/bin/env python3
"""Convert a GLB to USDZ with textures embedded correctly (UVs preserved), so the
satellite ground stays sharp AND aligned in Quick Look. Self-converting a GLB with
Reality Converter / drag-to-USDZ tends to flip/re-origin the texture UVs — this path
(Blender's USD exporter) keeps them right; verify with `usdrecord` before shipping.

  blender --background --python scripts/to_usdz.py -- <in.glb> <out.usdz>
"""
import bpy, sys, os

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB, OUT = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

props = [p.identifier for p in bpy.ops.wm.usd_export.get_rna_type().properties]
kw = {"filepath": OUT}
for o in ("export_materials", "export_uvmaps", "generate_preview_surface", "overwrite_textures"):
    if o in props:
        kw[o] = True
if "export_textures_mode" in props:
    kw["export_textures_mode"] = "NEW"      # write the texture into the .usdz package
bpy.ops.wm.usd_export(**kw)
print(f"[to_usdz] wrote {OUT} ({os.path.getsize(OUT) // 1024} KB)")
