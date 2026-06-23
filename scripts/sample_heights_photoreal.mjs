// Override building heights (scene.json buildings[].h) from the Google photoreal massing.
// The OSM heights are badly short for xq (79% < 8m), so 2-story facades render squished and
// buildings look sunk. The photoreal 3D-tiles mesh (exports/<slug>-photoreal.glb) has the REAL
// massing for every building; sample per-footprint roof height (p90 of vertex Y minus the base)
// and write it back as b.h so the extruded buildings get correct height.
//
// Usage: node scripts/sample_heights_photoreal.mjs xq
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder } from 'meshoptimizer';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SLUG = process.argv[2] || 'xq';
const PHOTOREAL = path.join(ROOT, 'exports', `${SLUG}-photoreal.glb`);
const SCENE = path.join(ROOT, 'exports', SLUG, 'scene.json');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(), 'meshopt.decoder': MeshoptDecoder });

const scene = JSON.parse(readFileSync(SCENE, 'utf8'));
const C = scene.center;
const w2 = (e, n) => [e - C[0], -(n - C[1])]; // ENU -> world XZ (matches exporter)

// ---- load photoreal world-space vertices (sampled) ----
function mul(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o; }
function trs(t, q, s) { const [x, y, z, w] = q, x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2, [sx, sy, sz] = s; return [(1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0, (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0, (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0, t[0], t[1], t[2], 1]; }
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const doc = await io.read(PHOTOREAL);
const root = doc.getRoot();
const pts = []; // [x, y, z] world, sampled
const wmOf = new Map();
const walk = (n, parent) => { const m = mul(parent, trs(n.getTranslation(), n.getRotation(), n.getScale())); wmOf.set(n, m); for (const c of n.listChildren()) walk(c, m); };
for (const n of root.listScenes()[0].listChildren()) walk(n, I);
for (const n of root.listNodes()) {
  const mesh = n.getMesh(); if (!mesh) continue; const wm = wmOf.get(n) || I;
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION'); if (!pos) continue; const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i += 3) { // sample every 3rd vert
      pos.getElement(i, v);
      const x = wm[0] * v[0] + wm[4] * v[1] + wm[8] * v[2] + wm[12];
      const y = wm[1] * v[0] + wm[5] * v[1] + wm[9] * v[2] + wm[13];
      const z = wm[2] * v[0] + wm[6] * v[1] + wm[10] * v[2] + wm[14];
      pts.push(x, y, z);
    }
  }
}
console.log(`photoreal: ${pts.length / 3} sampled verts`);

// ---- spatial grid for fast per-footprint queries ----
const CELL = 8; // m
const grid = new Map();
const key = (cx, cz) => cx + ',' + cz;
for (let i = 0; i < pts.length; i += 3) { const cx = Math.floor(pts[i] / CELL), cz = Math.floor(pts[i + 2] / CELL); const k = key(cx, cz); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i); }

function inPoly(x, z, ring) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1]; if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside; } return inside; }
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };

let updated = 0, kept = 0;
const changes = [];
for (const b of scene.buildings) {
  if (!b.p || b.p.length < 3) { kept++; continue; }
  const ring = b.p.map(([e, n]) => w2(e, n));
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const [x, z] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
  const ys = [];
  for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++)
    for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
      const a = grid.get(key(cx, cz)); if (!a) continue;
      for (const i of a) { const x = pts[i], z = pts[i + 2]; if (x >= minX && x <= maxX && z >= minZ && z <= maxZ && inPoly(x, z, ring)) ys.push(pts[i + 1]); }
    }
  if (ys.length < 8) { kept++; continue; } // not enough photoreal coverage -> keep OSM h
  const roof = pct(ys, 0.90), base = pct(ys, 0.08);
  const h = roof - base;
  const old = b.h || 4.5;
  // only override when the photoreal height is plausible and meaningfully taller (don't shrink towers)
  if (h > 3 && h < 200 && h > old + 0.5) { changes.push({ ib: scene.buildings.indexOf(b), old: +old.toFixed(1), new: +h.toFixed(1) }); b.h = +h.toFixed(2); updated++; }
  else kept++;
}
writeFileSync(SCENE, JSON.stringify(scene));
console.log(`heights: updated ${updated}, kept ${kept} (of ${scene.buildings.length})`);
console.log('sample changes:', changes.slice(0, 8).map(c => `b${c.ib} ${c.old}->${c.new}m`).join('  '));
