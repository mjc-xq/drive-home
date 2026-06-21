// terrain_mesh.mjs — ONE welded terrain surface from the exact 1 m DEM.
//
// The whole point of the rethink: there is ONE ground surface. Roads/sidewalks/curbs/
// crosswalks are TEXTURES painted onto it (ground_bed + feature compositing), never stacked
// ribbons. This module builds that single welded mesh and the matching sampler/collider so
// visual == collision == foot-placement BY CONSTRUCTION.
//
// Resolution: FULL 1 m posting across the ±CORE_M playable core (no approximation under any
// foot/wheel), error-free 4 m grid in the far periphery, seam-stitched crack-free (a centroid
// fan with the core-facing edge subdivided to the 1 m core verts — shared verts, no T-cracks).
//
// Texturing: the surface is split into TWO DISJOINT opaque triangle sets by the ±TEX_CORE_M
// box — the core triangles sample the high-res core ground texture (de-roaded aerial bed +
// roads/curbs/paint, ~0.15 m/texel), the far triangles sample the coarse aerial bed. Disjoint
// + coplanar-but-non-overlapping + opaque ⇒ one surface, zero z-fighting, standard PBR, no
// custom shader (portable to three.js, Unity glTFast, Quick Look). World-planar UVs per region.
//
// terrainAt(X,Z): point-in-triangle over the ACTUAL emitted triangles (uniform-grid accel), so
// houses/trees seat on the real surface and Collision_Terrain (the same verts/indices) matches
// the visual mesh exactly.

import { readFileSync } from 'node:fs';

// ---- DEM loader + exact world->height sampler --------------------------------------
export function loadDEM(demPath) {
  const D = JSON.parse(readFileSync(demPath, 'utf8'));
  return D;
}

// Build the closures that map world XZ <-> lat/lon <-> DEM grid, in the SAME flat-ENU frame
// as scene.json/road_prep (world(e,n) = [e-C[0], -(n-C[1])]).
export function makeGeo(D, { C, LAT0, LON0, COSLAT }) {
  const dLat = D.latN - D.latS, dLon = D.lonE - D.lonW;
  const { cols, rows, h } = D;
  // bilinear DEM height at world (X,Z)
  const demHeight = (X, Z) => {
    const e = X + C[0], n = C[1] - Z;
    const lat = LAT0 + n / 110540, lon = LON0 + e / (COSLAT * 111320);
    let fi = (lon - D.lonW) / dLon * cols - 0.5, fj = (D.latN - lat) / dLat * rows - 0.5;
    fi = Math.max(0, Math.min(cols - 1.001, fi)); fj = Math.max(0, Math.min(rows - 1.001, fj));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
    const a = h[j * cols + i], b = h[j * cols + i + 1], c = h[(j + 1) * cols + i], d = h[(j + 1) * cols + i + 1];
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  };
  // DEM rect in WORLD coords (the texture/mesh extent — coextensive so no painted texel floats)
  const tXmin = (D.lonW - LON0) * COSLAT * 111320 - C[0];
  const tXmax = (D.lonE - LON0) * COSLAT * 111320 - C[0];
  const za = -((D.latN - LAT0) * 110540 - C[1]);
  const zb = -((D.latS - LAT0) * 110540 - C[1]);
  const tZmin = Math.min(za, zb), tZmax = Math.max(za, zb);
  return { demHeight, demRect: { x0: tXmin, x1: tXmax, z0: tZmin, z1: tZmax } };
}

// ---- the mesh builder --------------------------------------------------------------
// opts: { coreHalf=200 (1 m posting box), step=1, farStep=4, texCoreHalf=300 (high-res ground
//         texture box) }. Returns disjoint 'core' and 'far' primitives + terrainAt + collision.
export function buildTerrainMesh({ D, geo, opts = {} }) {
  const coreHalf = opts.coreHalf ?? 200;
  const farStep = opts.farStep ?? 4;
  const texCoreHalf = opts.texCoreHalf ?? 300;
  const { demHeight, demRect } = geo;
  const { x0: X0, x1: X1, z0: Z0, z1: Z1 } = demRect;
  // snap the patch extent to the far grid so cells tile cleanly
  const gx0 = Math.ceil(X0 / farStep) * farStep, gx1 = Math.floor(X1 / farStep) * farStep;
  const gz0 = Math.ceil(Z0 / farStep) * farStep, gz1 = Math.floor(Z1 / farStep) * farStep;

  // shared vertex pool, memoized by integer-cm key so core(1 m) and far(4 m) share boundary verts
  const pos = [];                       // flat x,y,z
  const vmap = new Map();
  const keyOf = (x, z) => `${Math.round(x * 100)},${Math.round(z * 100)}`;
  const getVert = (x, z) => {
    const k = keyOf(x, z);
    let i = vmap.get(k);
    if (i !== undefined) return i;
    i = pos.length / 3;
    pos.push(x, demHeight(x, z), z);
    vmap.set(k, i);
    return i;
  };

  // triangles split by texture region (core box decides which texture a triangle samples)
  const coreIdx = [], farIdx = [];
  const inTexCore = (cx, cz) => Math.abs(cx) <= texCoreHalf && Math.abs(cz) <= texCoreHalf;
  const pushTri = (a, b, c) => {
    const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3;
    const cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
    (inTexCore(cx, cz) ? coreIdx : farIdx).push(a, b, c);
  };

  // UNIFORM option: ONE resolution everywhere -> NO 1 m/4 m resolution seam. The seam's normal
  // discontinuity + the coarse 4 m triangles read as faint bright lines at grazing angle (the
  // "white diamond"). A single regular grid removes it; the surface is still the exact DEM,
  // sampled at uniformStep m, and collision==visual==placement is preserved (same emitted tris).
  if (opts.uniformStep) {
    const s = opts.uniformStep;
    const ux1 = Math.floor(X1 / s) * s, uz1 = Math.floor(Z1 / s) * s;
    for (let z = Math.ceil(Z0 / s) * s; z < uz1; z += s)
      for (let x = Math.ceil(X0 / s) * s; x < ux1; x += s) {
        const a = getVert(x, z), b = getVert(x + s, z), c = getVert(x, z + s), d = getVert(x + s, z + s);
        pushTri(a, c, b); pushTri(b, c, d);
      }
  } else {
  // 1) CORE: full 1 m grid over [-coreHalf, coreHalf]
  for (let z = -coreHalf; z < coreHalf; z++) {
    for (let x = -coreHalf; x < coreHalf; x++) {
      const a = getVert(x, z), b = getVert(x + 1, z), c = getVert(x, z + 1), d = getVert(x + 1, z + 1);
      pushTri(a, c, b); pushTri(b, c, d);
    }
  }

  // 2) FAR: 4 m grid over the patch, skipping cells fully inside the core; the ring of cells
  //    whose edge lies on the core boundary subdivides that edge into 1 m sub-verts (shared with
  //    the core) and triangulates as a centroid fan — crack-free against the 1 m core.
  const onCoreLineX = (x) => (x === -coreHalf || x === coreHalf);
  const onCoreLineZ = (z) => (z === -coreHalf || z === coreHalf);
  const within = (a, b) => a >= -coreHalf && b <= coreHalf;
  for (let z = gz0; z < gz1; z += farStep) {
    for (let x = gx0; x < gx1; x += farStep) {
      const xe = x + farStep, ze = z + farStep;
      // skip cells fully inside the 1 m core (core already paved them)
      if (x >= -coreHalf && xe <= coreHalf && z >= -coreHalf && ze <= coreHalf) continue;
      // does any edge sit on the core boundary AND span only the core extent? -> subdivide it
      const subLeft   = onCoreLineX(x)  && within(z, ze);   // edge x=const, z in [z,ze]
      const subRight  = onCoreLineX(xe) && within(z, ze);
      const subBottom = onCoreLineZ(z)  && within(x, xe);   // edge z=const, x in [x,xe]
      const subTop    = onCoreLineZ(ze) && within(x, xe);
      if (!subLeft && !subRight && !subBottom && !subTop) {
        const a = getVert(x, z), b = getVert(xe, z), c = getVert(x, ze), d = getVert(xe, ze);
        pushTri(a, c, b); pushTri(b, c, d);
        continue;
      }
      // build the ordered boundary loop (CCW: bottom -> right -> top -> left), subdividing
      // the core-facing edges into 1 m steps so they reuse the core's verts
      const loop = [];
      const edge = (fromX, fromZ, toX, toZ, sub) => {
        const n = sub ? farStep : 1;
        for (let s = 0; s < n; s++) {
          const t = s / n;
          loop.push(getVert(fromX + (toX - fromX) * t, fromZ + (toZ - fromZ) * t));
        }
      };
      edge(x, z, xe, z, subBottom);     // bottom  (z const)
      edge(xe, z, xe, ze, subRight);    // right   (x const)
      edge(xe, ze, x, ze, subTop);      // top
      edge(x, ze, x, z, subLeft);       // left
      const ctr = getVert(x + farStep / 2, z + farStep / 2);
      for (let i = 0; i < loop.length; i++) pushTri(ctr, loop[i], loop[(i + 1) % loop.length]);
    }
  }
  }   // end else (adaptive 1 m core + 4 m far)

  // ---- normals (area-weighted) + tangents (world +X = U) -----------------------------
  const nVerts = pos.length / 3;
  const nrm = new Float32Array(nVerts * 3);
  const accum = (ix, nx, ny, nz) => { nrm[ix * 3] += nx; nrm[ix * 3 + 1] += ny; nrm[ix * 3 + 2] += nz; };
  const allIdx = [coreIdx, farIdx];
  for (const idx of allIdx) for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
    const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;  // not normalized -> area weight
    accum(a, nx, ny, nz); accum(b, nx, ny, nz); accum(c, nx, ny, nz);
  }
  for (let i = 0; i < nVerts; i++) {
    let nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }   // terrain faces up
    nrm[i * 3] = nx; nrm[i * 3 + 1] = ny; nrm[i * 3 + 2] = nz;
  }
  // per-vertex TANGENT (glTF VEC4): T = world +X orthogonalized to N, w = +1 (bitangent ~ +Z).
  // Baked explicitly so glTFast/three/QuickLook don't generate divergent tangents -> seams.
  const tan = new Float32Array(nVerts * 4);
  for (let i = 0; i < nVerts; i++) {
    const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
    let tx = 1 - nx * nx, ty = -nx * ny, tz = -nx * nz;      // (1,0,0) - N*(N·(1,0,0))
    const L = Math.hypot(tx, ty, tz) || 1; tx /= L; ty /= L; tz /= L;
    tan[i * 4] = tx; tan[i * 4 + 1] = ty; tan[i * 4 + 2] = tz; tan[i * 4 + 3] = 1;
  }

  // ---- world-planar UVs per region ---------------------------------------------------
  // core triangles -> ±texCoreHalf box; far triangles -> full DEM rect (aerial bed).
  // BOTH map the REAL DEM rect -> [0,1] so the ground texture covers the actual terrain extent on
  // EVERY level (the old ±texCoreHalf core UV stretched/misaligned the aerial on the smaller school
  // levels whose DEM rect is ±230..±360, not ±600). The ground bake uses coreBox = demRect to match.
  const coreUV = (x, z) => [(x - X0) / (X1 - X0), (z - Z0) / (Z1 - Z0)];
  const farUV = (x, z) => [(x - X0) / (X1 - X0), (z - Z0) / (Z1 - Z0)];

  // ---- terrainAt: point-in-triangle over the EMITTED triangles (uniform-grid accel) ---
  // visual == placement == collision, exactly, because this reads back the very triangles
  // we emit (and Collision_Terrain below is these same verts/indices).
  const CELL = 4;
  const gw = Math.ceil((X1 - X0) / CELL) + 1, gh = Math.ceil((Z1 - Z0) / CELL) + 1;
  const buckets = new Array(gw * gh);
  const bAdd = (cx, cz, tri) => { const k = cz * gw + cx; (buckets[k] || (buckets[k] = [])).push(tri); };
  const allTris = [];
  for (const idx of allIdx) for (let t = 0; t < idx.length; t += 3) allTris.push([idx[t], idx[t + 1], idx[t + 2]]);
  for (let ti = 0; ti < allTris.length; ti++) {
    const [a, b, c] = allTris[ti];
    const minx = Math.min(pos[a * 3], pos[b * 3], pos[c * 3]), maxx = Math.max(pos[a * 3], pos[b * 3], pos[c * 3]);
    const minz = Math.min(pos[a * 3 + 2], pos[b * 3 + 2], pos[c * 3 + 2]), maxz = Math.max(pos[a * 3 + 2], pos[b * 3 + 2], pos[c * 3 + 2]);
    const ci0 = Math.max(0, Math.floor((minx - X0) / CELL)), ci1 = Math.min(gw - 1, Math.floor((maxx - X0) / CELL));
    const cj0 = Math.max(0, Math.floor((minz - Z0) / CELL)), cj1 = Math.min(gh - 1, Math.floor((maxz - Z0) / CELL));
    for (let cj = cj0; cj <= cj1; cj++) for (let ci = ci0; ci <= ci1; ci++) bAdd(ci, cj, ti);
  }
  const terrainAt = (X, Z) => {
    const ci = Math.max(0, Math.min(gw - 1, Math.floor((X - X0) / CELL)));
    const cj = Math.max(0, Math.min(gh - 1, Math.floor((Z - Z0) / CELL)));
    const bs = buckets[cj * gw + ci];
    if (bs) for (const ti of bs) {
      const [a, b, c] = allTris[ti];
      const ax = pos[a * 3], az = pos[a * 3 + 2], bx = pos[b * 3], bz = pos[b * 3 + 2], cx = pos[c * 3], cz = pos[c * 3 + 2];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((bz - cz) * (X - cx) + (cx - bx) * (Z - cz)) / d;
      const l2 = ((cz - az) * (X - cx) + (ax - cx) * (Z - cz)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 >= -1e-4 && l2 >= -1e-4 && l3 >= -1e-4)
        return l1 * pos[a * 3 + 1] + l2 * pos[b * 3 + 1] + l3 * pos[c * 3 + 1];
    }
    return demHeight(X, Z);   // fallback (just outside the meshed extent)
  };

  // assemble per-region primitive arrays (positions/normals/tangents are shared; we copy the
  // referenced verts into compact per-primitive buffers so each primitive is self-contained).
  const buildPrim = (idx, uvFn) => {
    const remap = new Map(); const p = [], no = [], uv = [], tg = [], ix = [];
    for (const vi of idx) {
      let ni = remap.get(vi);
      if (ni === undefined) {
        ni = p.length / 3; remap.set(vi, ni);
        p.push(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
        no.push(nrm[vi * 3], nrm[vi * 3 + 1], nrm[vi * 3 + 2]);
        const [u, v] = uvFn(pos[vi * 3], pos[vi * 3 + 2]); uv.push(u, v);
        tg.push(tan[vi * 4], tan[vi * 4 + 1], tan[vi * 4 + 2], tan[vi * 4 + 3]);
      }
      ix.push(ni);
    }
    return { pos: p, nrm: no, uv, tan: tg, idx: ix };
  };

  const corePrim = buildPrim(coreIdx, coreUV);
  const farPrim = buildPrim(farIdx, farUV);

  // collision = ALL emitted verts/indices (the SAME surface incl. both regions)
  const collision = { pos: Array.from(pos), idx: [...coreIdx, ...farIdx] };

  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < pos.length; i += 3) { if (pos[i] < minY) minY = pos[i]; if (pos[i] > maxY) maxY = pos[i]; }

  return {
    corePrim, farPrim, collision, terrainAt, demRect,
    texCoreHalf,
    stats: { verts: nVerts, tris: allTris.length, coreTris: coreIdx.length / 3, farTris: farIdx.length / 3, minY, maxY },
  };
}
