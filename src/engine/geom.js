import * as THREE from 'three';

// Deterministic LCG so the neighborhood looks the same on every load.
export const makeRand = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

// Non-indexed pos/normal/color(/uv) merge — three r128 ships no
// BufferGeometryUtils, and per-vertex color lets the whole neighborhood share
// a couple of materials. Pass uvAt to also bake aerial-photo UVs.
export function merge(list, uvAt) {
  let n = 0; for (const { g } of list) n += g.attributes.position.count;
  const P = new Float32Array(n * 3), Nn = new Float32Array(n * 3), Cl = new Float32Array(n * 3);
  const UV = uvAt ? new Float32Array(n * 2) : null;
  let o = 0;
  for (const { g, color } of list) {
    const c = g.attributes.position.count, pa = g.attributes.position.array;
    P.set(pa, o * 3); Nn.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < c; i++) {
      Cl[(o + i) * 3] = color.r; Cl[(o + i) * 3 + 1] = color.g; Cl[(o + i) * 3 + 2] = color.b;
      if (UV) { const t = uvAt(pa[i * 3], pa[i * 3 + 2]); UV[(o + i) * 2] = t[0]; UV[(o + i) * 2 + 1] = t[1]; }
    }
    o += c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(Nn, 3));
  g.setAttribute('color', new THREE.BufferAttribute(Cl, 3));
  if (UV) g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  return g;
}

// Gable roof prism: ridge along local x, eaves overhang ov on every side.
export function gablePrism(L, Sp, wallH, rise, ov) {
  const hw = L / 2 + ov, hd = Sp / 2 + ov, y0 = wallH, y1 = wallH + rise;
  const Aa = [-hw, y0, -hd], B = [hw, y0, -hd], Cc = [hw, y0, hd], D = [-hw, y0, hd], R1 = [-hw, y1, 0], R2 = [hw, y1, 0];
  const v = [].concat(Aa, R1, R2, Aa, R2, B, Cc, R2, R1, Cc, R1, D, B, R2, Cc, Aa, D, R1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

export function footprintGeom(poly, h, W) {
  let pts = poly.map(p => { const [x, z] = W(p); return new THREE.Vector2(x, -z); });
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: h, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

// Split an extruded footprint into roof-ish (up-facing) and wall triangles so
// roofs can take the aerial texture while walls stay vertex-colored.
export function splitTops(g) {
  const P = g.attributes.position.array, n = P.length / 9;
  const top = [], side = [];
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = P[o], ay = P[o + 1], az = P[o + 2], bx = P[o + 3], by = P[o + 4], bz = P[o + 5], cx = P[o + 6], cy = P[o + 7], cz = P[o + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const ny = uz * vx - ux * vz;
    const len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx) || 1;
    const r = ny / len;
    if (r > 0.55) top.push(...P.slice(o, o + 9));
    else if (r > -0.55) side.push(...P.slice(o, o + 9));
  }
  const mk = a => {
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(a, 3));
    gg.computeVertexNormals();
    return gg;
  };
  return { top: mk(top), side: mk(side) };
}

// Stack-of-primitives builder for characters/animals: every part is positioned
// with a full TRS, then merged into one vertex-colored geometry facing +x.
export function critterBuilder() {
  const L = [];
  const add = (g, x, y, z, color, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    g = g.toNonIndexed();
    const m = new THREE.Matrix4();
    m.compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(sx, sy, sz));
    g.applyMatrix4(m);
    L.push({ g, color: new THREE.Color(color) });
  };
  const addBox = (w, h, d, x, y, z, color) => add(new THREE.BoxGeometry(w, h, d), x, y, z, color);
  return { add, addBox, build: () => merge(L) };
}
