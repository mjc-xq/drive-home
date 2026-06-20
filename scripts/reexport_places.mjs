// Re-export Canyon + Stanton -property.glb through the SAME improved, Blender-free
// exporter the game uses for Dahill — WITHOUT re-fetching (uses each place's already-
// fetched data in exports/<place>/).
//
// export_property_glb.mjs is hardcoded to read repo-root exports/*.json + src/assets/
// scene.json and write exports/1840-dahill-property.glb, so for each place we: back up
// Dahill's root state, swap the place's data into those root paths, run the export, copy
// the result to exports/<place>-property.glb, then RESTORE Dahill's state (after every
// place AND in finally, even on crash). exports/ is gitignored, so the master backup is
// the only safety net — restore is belt-and-suspenders.
//
// Street-View facades are Dahill-only (the place dirs have none), so we hide root's
// sv_facades during a place export: the exporter then skips facade overlays rather than
// projecting Dahill's photos onto Canyon/Stanton walls.

import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const R = (...p) => path.join(ROOT, ...p);
const BK = R('exports/.reexport_backup');

const PLACES = ['canyon-middle-school', 'stanton-elementary'];

// [rootRelPath, placeFileName] — place file lives at exports/<slug>/<placeFileName>
const SWAP = [
  ['src/assets/scene.json', 'scene.json'],
  ['exports/dem_1m.json', 'dem_1m.json'],
  ['exports/google_aerial.jpg', 'google_aerial.jpg'],
  ['exports/google_aerial.json', 'google_aerial.json'],
  ['exports/map_surfaces_osm.json', 'map_surfaces_osm.json'],
  ['exports/driveways_osm.json', 'driveways_osm.json'],
  ['exports/buildings_color.json', 'buildings_color.json'],
  ['exports/buildings_roof_color.json', 'buildings_roof_color.json'],
  ['exports/parcels.json', 'parcels.json'],
];
// Root files the exporter overwrites / that must be restored to Dahill state afterward.
const RESTORE_EXTRA = ['exports/trees_placed.json', 'exports/1840-dahill-property.glb'];
// Dahill-only facade manifest hidden during a place export (the dir is handled below).
const FACADE_JSON = ['exports/sv_facades.json'];

const allRoot = [...SWAP.map((s) => s[0]), ...RESTORE_EXTRA, ...FACADE_JSON];
const FACE_DIR = R('exports/sv_facades');
const FACE_DIR_BK = path.join(BK, 'sv_facades_dir');
const bkPath = (rel) => path.join(BK, rel.replace(/[/]/g, '__'));

// ---- master backup of the current (Dahill) root state ----
if (existsSync(BK)) rmSync(BK, { recursive: true, force: true });
mkdirSync(BK, { recursive: true });
for (const rel of allRoot) if (existsSync(R(rel))) copyFileSync(R(rel), bkPath(rel));
if (existsSync(FACE_DIR)) cpSync(FACE_DIR, FACE_DIR_BK, { recursive: true });

function restoreDahill() {
  for (const rel of allRoot) {
    const abs = R(rel);
    const bak = bkPath(rel);
    if (existsSync(bak)) copyFileSync(bak, abs);
    else if (existsSync(abs)) rmSync(abs);
  }
  if (existsSync(FACE_DIR_BK)) {
    if (existsSync(FACE_DIR)) rmSync(FACE_DIR, { recursive: true, force: true });
    cpSync(FACE_DIR_BK, FACE_DIR, { recursive: true });
  }
}

try {
  for (const slug of PLACES) {
    const placeDir = R('exports', slug);
    if (!existsSync(placeDir)) { console.log(`SKIP ${slug}: no exports/${slug}`); continue; }
    // swap this place's data into the root paths the exporter reads
    for (const [rootRel, name] of SWAP) {
      const src = path.join(placeDir, name);
      if (existsSync(src)) copyFileSync(src, R(rootRel));
      else console.log(`  (${slug} missing ${name} — exporter fallback)`);
    }
    // hide Dahill's facades so they don't project onto this place's walls
    for (const rel of FACADE_JSON) if (existsSync(R(rel))) rmSync(R(rel));
    if (existsSync(FACE_DIR)) rmSync(FACE_DIR, { recursive: true, force: true });

    console.log(`\n=== re-exporting ${slug} ===`);
    execFileSync('node', ['scripts/export_property_glb.mjs'], { cwd: ROOT, stdio: 'inherit' });
    copyFileSync(R('exports/1840-dahill-property.glb'), R('exports', `${slug}-property.glb`));
    console.log(`  -> exports/${slug}-property.glb`);

    restoreDahill(); // clean Dahill state before the next place
  }
} finally {
  restoreDahill();
  rmSync(BK, { recursive: true, force: true });
}
console.log('\nAll places re-exported. Dahill root state restored.');
