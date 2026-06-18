// Regression test: assert the Google photoreal layer overlays the property model
// to within a few metres, both AT THE HOUSE (origin) and FAR OUT (~60-150 m ring).
//
// Why this exists: the two GLBs are built by independent scripts with hand-rolled
// ECEF->ENU transforms (export_property_glb.mjs via makeGeoENU; fetch_photoreal.mjs
// via its own W4/YUP2ECEF). A sign, anchor, units, or y-up mistake in either path
// shifts the layers by many metres — and the math/comments kept "proving" alignment
// while the rendered layers were shifted. So this measures the ACTUAL exported
// geometry: it rasterizes a top-down occupancy grid of building mass from each GLB
// and cross-correlates them to read the real horizontal offset in metres.
//
// A constant offset everywhere => registration shift. An offset that GROWS with
// distance from the house => a scale/rotation/frame-mismatch bug (the classic
// flat-110540 drift). We check both.
//
// Run:  node scripts/verify_alignment.mjs
// Exits non-zero if the measured offset exceeds the thresholds below.
import { NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROP = path.join(ROOT, 'exports/1840-dahill-property.glb');
const PHOTO = path.join(ROOT, 'exports/1840-dahill-photoreal.glb');

// --- thresholds (metres) -----------------------------------------------------
const NEAR_TOL = 3.0;   // at the house / global best-fit must be within this
const FAR_TOL = 4.0;    // far ring (60-150 m) must be within this (catches drift)
// --- raster params -----------------------------------------------------------
const GRID = 0.5;       // m per cell
const HALF = 160;       // window half-size (m)
const N = Math.round((2 * HALF) / GRID);
const MAXSHIFT = Math.round(20 / GRID);   // search +-20 m

for (const f of [PROP, PHOTO]) {
  if (!existsSync(f)) { console.error('MISSING export:', f); process.exit(2); }
}

const io = new NodeIO()
  .registerExtensions([KHRMaterialsUnlit, KHRDracoMeshCompression])
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });

function mul(a, b) { const c = new Array(16); for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k]; c[col * 4 + row] = s; } return c; }
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Yield every vertex of (optionally name-filtered) meshes in WORLD space [x,y,z].
function worldVerts(doc, nameOk) {
  const out = [];
  function rec(node, m) {
    const wm = mul(m, node.getMatrix());
    const mesh = node.getMesh();
    if (mesh && (!nameOk || nameOk(node.getName() || ''))) {
      for (const prim of mesh.listPrimitives()) {
        const pa = prim.getAttribute('POSITION'); if (!pa) continue;
        const a = pa.getArray();
        for (let i = 0; i < a.length; i += 3) {
          const x = a[i], y = a[i + 1], z = a[i + 2];
          out.push(wm[0] * x + wm[4] * y + wm[8] * z + wm[12],
                   wm[1] * x + wm[5] * y + wm[9] * z + wm[13],
                   wm[2] * x + wm[6] * y + wm[10] * z + wm[14]);
        }
      }
    }
    for (const ch of node.listChildren()) rec(ch, wm);
  }
  for (const sc of doc.getRoot().listScenes()) for (const n of sc.listChildren()) rec(n, IDENT);
  return out;
}

// Median Y over verts within radius r of origin -> local "ground" datum.
function groundY(v, r) {
  const ys = [];
  for (let i = 0; i < v.length; i += 3) { const x = v[i], z = v[i + 2]; if (x * x + z * z < r * r) ys.push(v[i + 1]); }
  ys.sort((a, b) => a - b);
  return ys.length ? ys[Math.floor(ys.length * 0.1)] : 0;   // 10th pct ~ ground (below building tops)
}

// Binary top-down occupancy of verts in height band [yLo,yHi], optional radial ring.
function raster(v, yLo, yHi, ringLo = 0, ringHi = 1e9) {
  const r = new Uint8Array(N * N);
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    if (y < yLo || y > yHi) continue;
    const rad = Math.hypot(x, z); if (rad < ringLo || rad > ringHi) continue;
    const ci = ((x + HALF) / GRID) | 0, cj = ((z + HALF) / GRID) | 0;
    if (ci < 0 || ci >= N || cj < 0 || cj >= N) continue;
    r[cj * N + ci] = 1;
  }
  return r;
}

// Best integer (di,dj) shift of A onto B maximizing overlap, within +-MAXSHIFT.
function bestShift(A, B) {
  let best = { s: -1, di: 0, dj: 0 };
  for (let di = -MAXSHIFT; di <= MAXSHIFT; di++) {
    for (let dj = -MAXSHIFT; dj <= MAXSHIFT; dj++) {
      let s = 0;
      for (let j = 0; j < N; j++) { const jj = j + dj; if (jj < 0 || jj >= N) continue;
        const rowA = j * N, rowB = jj * N;
        for (let i = 0; i < N; i++) { const ii = i + di; if (ii < 0 || ii >= N) continue; s += A[rowA + i] & B[rowB + ii]; }
      }
      if (s > best.s) best = { s, di, dj };
    }
  }
  // image col = +East (x), row = +(-North) (z). Shifting A by (di,dj) to match B means
  // A must move +dj in x and +di in z to land on B. Offset of A relative to B:
  return { dEast: best.dj * GRID, dSouth: best.di * GRID, overlap: best.s };
}

console.log('[verify] loading exports...');
const propDoc = await io.read(PROP);
const phDoc = await io.read(PHOTO);

const propBld = worldVerts(propDoc, (n) => /house|building/i.test(n));   // clean footprints
const phAll = worldVerts(phDoc, null);                                   // whole photoreal mesh

if (propBld.length < 30 || phAll.length < 30) { console.error('[verify] too few verts — bad export'); process.exit(2); }

// Building mass = geometry 4..14 m above the local ground datum (walls/roofs of both).
const gP = groundY(propBld, 40), gH = groundY(phAll, 40);
const propR = raster(propBld, gP + 3, gP + 14);
const phR = raster(phAll, gH + 4, gH + 16);

const near = bestShift(propR, phR);
const nearMag = Math.hypot(near.dEast, near.dSouth);

// Far ring 60..150 m — sensitive to scale/rotation drift that's ~0 at the house.
const propRF = raster(propBld, gP + 3, gP + 14, 60, 150);
const phRF = raster(phAll, gH + 4, gH + 16, 60, 150);
const far = bestShift(propRF, phRF);
const farMag = Math.hypot(far.dEast, far.dSouth);

const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
console.log('\n=== photoreal vs property horizontal offset (metres) ===');
console.log(`ground datum: property=${gP.toFixed(2)} m, photoreal=${gH.toFixed(2)} m`);
console.log(`NEAR (full window, global best-fit): dEast=${f(near.dEast)} dSouth=${f(near.dSouth)}  |offset|=${nearMag.toFixed(2)} m  (overlap px=${near.overlap})`);
console.log(`FAR  (60-150 m ring)              : dEast=${f(far.dEast)} dSouth=${f(far.dSouth)}  |offset|=${farMag.toFixed(2)} m  (overlap px=${far.overlap})`);
console.log(`thresholds: NEAR<=${NEAR_TOL} m, FAR<=${FAR_TOL} m\n`);

let ok = true;
if (nearMag > NEAR_TOL) { console.error(`FAIL: near offset ${nearMag.toFixed(2)} m exceeds ${NEAR_TOL} m`); ok = false; }
if (farMag > FAR_TOL) { console.error(`FAIL: far offset ${farMag.toFixed(2)} m exceeds ${FAR_TOL} m`); ok = false; }
if (far.overlap < 50) { console.error(`FAIL: far-ring overlap too low (${far.overlap}px) — layers don't even share that region`); ok = false; }

if (ok) { console.log('PASS: photoreal overlays property within tolerance at the house and far out.'); process.exit(0); }
process.exit(1);
