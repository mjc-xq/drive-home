// Regression test: assert the draped Mapbox satellite TEXTURE on the terrain is
// registered to the TRUE ground to within ~1.5 m — i.e. the extruded building
// footprints sit on the satellite roofs, not several metres off.
//
// Why this exists (and why it is NOT circular): a prior round of comment-driven
// "it aligns" claims kept asserting alignment from the exporter's own UV math,
// which trivially round-trips to 0. That proves self-consistency, NOT that the
// imagery actually sits on the ground. This test instead measures the BAKED
// texture image against an INDEPENDENT ground truth — Google's Photorealistic 3D
// Tiles (exports/1840-dahill-photoreal.glb), whose real-world positions the
// building geometry already matches to ~0.5 m (scripts/verify_alignment.mjs).
//
// Method (no trust in comments — pixels only):
//   1. Render the aerial AS THE EXPORTER BAKES IT over a known ±HALF m world
//      window, North-up, using export_property_glb.mjs's exact aerialUVll formula
//      and the curvature-correct ENU the geometry lives in. Each pixel maps to a
//      known (East, North). (scripts/_measure_aerial_window.mjs)
//   2. Render the photoreal straight-down over the SAME window via Blender.
//      (scripts/_measure_render_photoreal.py)
//   3. FFT phase-correlate the two ground images -> the (dEast, dNorth) shift of
//      the Mapbox imagery vs Google truth, in metres. (scripts/_measure_xcorr_fft.py)
//   Checked at TWO scales (±90 m and ±150 m): a constant small offset = good
//   registration; an offset that grows with the window = a scale/rotation bug.
//
// Run:  node scripts/verify_texture_alignment.mjs
// Exits non-zero if the measured texture-vs-truth offset exceeds the threshold.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BLENDER = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
const PY = path.join(ROOT, 'scripts/.venv/bin/python');
const PHOTO = path.join(ROOT, 'exports/1840-dahill-photoreal.glb');

const TOL = 1.5;          // metres — texture must register to the truth within this
const PX = 1024;
const WINDOWS = [90, 150];  // half-window sizes (m); the offset must be stable across both

for (const f of [PHOTO, PY, BLENDER]) {
  if (!existsSync(f)) { console.error('[verify-tex] MISSING dependency:', f); process.exit(2); }
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

let worst = 0;
const rows = [];
for (const HALF of WINDOWS) {
  const aerial = path.join(ROOT, `exports/_vtex_aerial_${HALF}.png`);
  const photo = path.join(ROOT, `exports/_vtex_photo_${HALF}.png`);
  // 1) exporter's exact baked texture over the window (North-up)
  run('node', ['scripts/_measure_aerial_window.mjs', aerial, String(HALF), String(PX), '0', '0']);
  // 2) photoreal straight-down over the same window
  run(BLENDER, ['--background', '--python', 'scripts/_measure_render_photoreal.py', '--', PHOTO, photo, String(HALF), String(PX)]);
  // 3) FFT phase-correlation -> dEast,dNorth in metres
  const out = run(PY, ['scripts/_measure_xcorr_fft.py', aerial, photo, String(HALF)]);
  const m = out.match(/dEast=([-+\d.]+) dNorth=([-+\d.]+) \|([-+\d.]+)\| peak=([-+\d.]+)/);
  if (!m) { console.error('[verify-tex] could not parse correlation output:\n' + out); process.exit(2); }
  const dE = +m[1], dN = +m[2], mag = +m[3], peak = +m[4];
  rows.push({ HALF, dE, dN, mag, peak });
  worst = Math.max(worst, mag);
}

console.log('\n=== aerial TEXTURE vs Google-photoreal ground truth (metres) ===');
for (const r of rows) {
  console.log(`±${r.HALF} m window: dEast=${r.dE >= 0 ? '+' : ''}${r.dE.toFixed(2)} dNorth=${r.dN >= 0 ? '+' : ''}${r.dN.toFixed(2)}  |offset|=${r.mag.toFixed(2)} m  (corr peak=${r.peak.toFixed(3)})`);
}
console.log(`threshold: |offset| <= ${TOL} m at every scale\n`);

if (rows.some(r => r.peak < 0.03)) {
  console.error('FAIL: cross-correlation peak too weak — renders did not lock; measurement unreliable');
  process.exit(1);
}
if (worst > TOL) {
  console.error(`FAIL: texture-vs-truth offset ${worst.toFixed(2)} m exceeds ${TOL} m — the satellite imagery is mis-registered to the geometry`);
  process.exit(1);
}
console.log(`PASS: the satellite texture sits on the true ground (max offset ${worst.toFixed(2)} m); buildings sit on their satellite roofs.`);
process.exit(0);
