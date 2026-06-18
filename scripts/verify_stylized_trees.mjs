// Programmatic seating/bounds audit for the stylized neighbourhood GLB.
// For every Tree_* node: compute its world AABB, take the trunk-base world Y
// (AABB Y-min) and the canopy-centre XY, sample the DEM there, and require
//   |trunkBaseY - terrainZ| < 1.5 m  AND  the XY is inside the terrain bounds.
// Reports the worst gap, the count of floaters/sinkers, and out-of-range trees.
//
//   node scripts/verify_stylized_trees.mjs [glb]
import { NodeIO } from '@gltf-transform/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ex = f => path.join(ROOT, 'exports', f);
const GLB = process.argv[2] || ex('1840-dahill-stylized.glb');
const S = JSON.parse(readFileSync(path.join(ROOT, 'src/assets/scene.json'), 'utf8')); const C = S.center;
const D = JSON.parse(readFileSync(ex('dem_1m.json'), 'utf8'));
const LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * Math.PI / 180);
const dLat = D.latN - D.latS, dLon = D.lonE - D.lonW, { cols, rows, h } = D;
const worldToLL = (X, Z) => { const e = X + C[0], n = -Z + C[1]; return [LAT0 + n / 110540, LON0 + e / (COSLAT * 111320)]; };
const terrainAt = (X, Z) => {
  const [lat, lon] = worldToLL(X, Z);
  let fi = (lon - D.lonW) / dLon * cols - 0.5, fj = (D.latN - lat) / dLat * rows - 0.5;
  fi = Math.max(0, Math.min(cols - 1.001, fi)); fj = Math.max(0, Math.min(rows - 1.001, fj));
  const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
  const a = h[j * cols + i], b = h[j * cols + i + 1], c = h[(j + 1) * cols + i], d = h[(j + 1) * cols + i + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
};
const tXmin = (D.lonW - LON0) * COSLAT * 111320 - C[0], tXmax = (D.lonE - LON0) * COSLAT * 111320 - C[0];
const _zA = -((D.latN - LAT0) * 110540 - C[1]), _zB = -((D.latS - LAT0) * 110540 - C[1]);
const tZmin = Math.min(_zA, _zB), tZmax = Math.max(_zA, _zB);

function compose(t, q, s) {
  const [x, y, z, w] = q; const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0, (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0, (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0, t[0], t[1], t[2], 1];
}
const matMul = (a, b) => { const r = new Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j]; r[i * 4 + j] = s; } return r; };
const apply = (M, p) => [p[0] * M[0] + p[1] * M[4] + p[2] * M[8] + M[12], p[0] * M[1] + p[1] * M[5] + p[2] * M[9] + M[13], p[0] * M[2] + p[1] * M[6] + p[2] * M[10] + M[14]];

const io = new NodeIO(); const doc = await io.read(GLB);
const trees = doc.getRoot().listNodes().filter(n => /^Tree_/.test(n.getName() || ''));
let maxGap = 0, nOut = 0, nFloat = 0, worst = null;
for (const t of trees) {
  const M0 = compose(t.getTranslation(), t.getRotation(), t.getScale());
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  (function rec(nd, M) {
    const m = nd.getMesh();
    if (m) for (const pr of m.listPrimitives()) {
      const a = pr.getAttribute('POSITION'); const mn = a.getMin([]), mx = a.getMax([]);
      for (const cx of [mn[0], mx[0]]) for (const cy of [mn[1], mx[1]]) for (const cz of [mn[2], mx[2]]) {
        const w = apply(M, [cx, cy, cz]); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
      }
    }
    nd.listChildren().forEach(c => rec(c, matMul(compose(c.getTranslation(), c.getRotation(), c.getScale()), M)));
  })(t, M0);
  const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2, baseY = lo[1];
  const terr = terrainAt(cx, cz), gap = Math.abs(baseY - terr);
  const inXY = cx >= tXmin && cx <= tXmax && cz >= tZmin && cz <= tZmax;
  if (!inXY) nOut++;
  if (gap >= 1.5) nFloat++;
  if (gap > maxGap) { maxGap = gap; worst = { name: t.getName(), baseY: +baseY.toFixed(2), terr: +terr.toFixed(2), gap: +gap.toFixed(2), cx: +cx.toFixed(1), cz: +cz.toFixed(1), inXY }; }
}
console.log(`GLB: ${GLB}`);
console.log(`trees: ${trees.length}`);
console.log(`out of XY range: ${nOut}`);
console.log(`floating/sunk (gap>=1.5m): ${nFloat}`);
console.log(`max |trunkBaseY - terrainZ|: ${maxGap.toFixed(3)} m`);
if (worst) console.log('largest-gap tree:', JSON.stringify(worst));
console.log(`terrain XY bounds: X[${tXmin.toFixed(1)}, ${tXmax.toFixed(1)}]  Z[${tZmin.toFixed(1)}, ${tZmax.toFixed(1)}]`);
const ok = nOut === 0 && nFloat === 0;
console.log(ok ? 'PASS: all trees seated and in range' : 'FAIL: see counts above');
process.exit(ok ? 0 : 1);
