// building_layer.mjs — 3D houses/buildings + collision for the single-surface frame.
//
// NEW FRAME vs the legacy export_property_glb.mjs:
//   * ONE terrain already exists; we receive terrainAt(X,Z) (EXACT point-in-triangle height)
//     and seat every wall foot on it (legacy WALL_EMBED logic, unchanged).
//   * NO road/sidewalk/curb/ground ribbons here — those are TEXTURE on the terrain now.
//   * Facades are the wall texture itself (a hero facade ATLAS sub-rect), not floating proud
//     SVFacade_* decals and not proud emitFacadeDetails trim micro-slabs. Both DROPPED.
//   * MISSING-BUILDINGS FIX: legacy dropped any footprint not ENTIRELY in-patch (every(inPatch)),
//     silently losing 37-66% of buildings on school levels. Here we CLIP each footprint to the
//     DEM rect (Sutherland-Hodgman) and emit the clipped part; only fully-outside footprints skip.
//
// Adds to `scene`: House_walls, House_roof, Buildings_walls (per-building material groups),
//   Buildings_roofs, Doors/Doors_trim/Doors_transom/GarageDoors/GarageDoor_trim (owner house
//   only, residential levels), House_windows/House_window_trim (owner cues), and Collision_Buildings.
//
// Wall UVs: for each wall edge of a HERO building (facade.rectByWall['b{idx}_e{edge}'] present),
//   the wall quad's UVs land in that atlas sub-rect (v0=eave..v1=ground) and use the atlas-page
//   material; else a procedural tiled stucco material (facade.stuccoTile) tinted by wallColor(ib).

import * as ShapeUtilsHost from 'three';   // only for ShapeUtils.triangulateShape (caller's THREE preferred)

const TILE = 5.0;            // facade UV tile (m) for procedural stucco walls (sparser windows)
const WALL_EMBED = 0.4;      // wall bottoms drop to per-corner terrain - EMBED so feet touch grade
const EAVE_OVERHANG = 0.4;   // ~0.4 m eave lip on hipped/gabled roofs (spec)
const FASCIA = 0.18;         // vertical fascia band hanging under the eave lip

// ---- small geometry helpers ------------------------------------------------------------
const centroidEN = (p) => p.reduce((a, q) => [a[0] + q[0] / p.length, a[1] + q[1] / p.length], [0, 0]);
function inPoly(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
// Sutherland-Hodgman: clip a CLOSED polygon (world XZ ring) against the axis-aligned demRect.
// Returns the clipped ring (>=3 pts) or null if nothing survives. This is the MISSING-BUILDINGS
// fix: instead of dropping a footprint with any corner off-patch, we emit only the in-rect part.
function clipPolyToRect(ring, r) {
  const { x0, x1, z0, z1 } = r;
  // each clip edge: keep points on the inside half-plane, insert intersection on crossings
  const clip = (poly, inside, intersect) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
      const curIn = inside(cur), prevIn = inside(prev);
      if (curIn) { if (!prevIn) out.push(intersect(prev, cur)); out.push(cur); }
      else if (prevIn) out.push(intersect(prev, cur));
    }
    return out;
  };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  let poly = ring.slice();
  poly = clip(poly, p => p[0] >= x0, (a, b) => lerp(a, b, (x0 - a[0]) / (b[0] - a[0])));   // left
  if (poly.length < 3) return null;
  poly = clip(poly, p => p[0] <= x1, (a, b) => lerp(a, b, (x1 - a[0]) / (b[0] - a[0])));   // right
  if (poly.length < 3) return null;
  poly = clip(poly, p => p[1] >= z0, (a, b) => lerp(a, b, (z0 - a[1]) / (b[1] - a[1])));   // bottom
  if (poly.length < 3) return null;
  poly = clip(poly, p => p[1] <= z1, (a, b) => lerp(a, b, (z1 - a[1]) / (b[1] - a[1])));   // top
  return poly.length >= 3 ? poly : null;
}

export function buildBuildingLayer({
  THREE, scene, S, w2, terrainAt, demRect, isSchool,
  wallColor, roofColor, facade, ROOT,
}) {
  const ShapeUtils = (THREE && THREE.ShapeUtils) || ShapeUtilsHost.ShapeUtils;
  const rectByWall = (facade && facade.rectByWall) || {};
  const heroSet = (facade && facade.heroBuildings) || new Set();
  const isHero = (ib) => (heroSet.has ? heroSet.has(ib) : (Array.isArray(heroSet) && heroSet.includes(ib)));
  const nPages = (facade && facade.pages && facade.pages.length) || 0;

  // ---- per-page atlas material (shared across all hero walls on that page) --------------
  // Named 'FacadeAtlas_page{N}_mat' so the exporter can attach facade.pages[N] PNG by name.
  const facadePageMaterials = new Map();   // page -> material name (for the exporter)
  const pageMatCache = new Map();
  const pageMaterial = (page) => {
    let m = pageMatCache.get(page);
    if (m) return m;
    const name = `FacadeAtlas_page${page}_mat`;
    m = new THREE.MeshStandardMaterial({ name, color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    pageMatCache.set(page, m);
    facadePageMaterials.set(page, name);
    return m;
  };
  // procedural tiled stucco (facade.stuccoTile PNG) tinted by the building's wallColor. One
  // material per building so each house keeps its own paint; the exporter attaches the stucco
  // PNG to every /stucco/i material by name (REPEAT wrap over the TILE-scaled wall UVs).
  const stuccoMaterial = (ib) => {
    const [r, g, b] = wallColor(ib);
    return new THREE.MeshStandardMaterial({
      name: `Stucco_b${ib}_mat`, color: new THREE.Color(r, g, b), roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
    });
  };

  // ---- wall height / base (ported, unchanged) -----------------------------------------
  // Overture/OSM height (or sane default) + 0.5; never LiDAR (noisy). Ringed (has roof rects)
  // footprints get the 0.8x lower-bound so big-box roofs don't tower.
  const wallHeight = (b) => { const H = b.h || 4.5; return ((b.r && b.r.length) ? Math.max(2.4, H * 0.8) : H) + 0.5; };
  // Footprint terrain samples: corners + edge midpoints + a 5x5 interior grid (point-in-poly).
  function footprintTerrainSamples(ringW) {
    const ys = [];
    const xs = ringW.map(p => p[0]), zs = ringW.map(p => p[1]);
    for (const [x, z] of ringW) ys.push(terrainAt(x, z));
    for (let i = 0; i < ringW.length; i++) {
      const [ax, az] = ringW[i], [bx, bz] = ringW[(i + 1) % ringW.length];
      ys.push(terrainAt((ax + bx) / 2, (az + bz) / 2));
    }
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    const N = 4;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const x = x0 + (x1 - x0) * i / N, z = z0 + (z1 - z0) * j / N;
      if (inPoly(x, z, ringW)) ys.push(terrainAt(x, z));
    }
    return ys;
  }
  // Seat the floor AT/just-below the LOW grade (10th-pct, spike-robust) so houses sit ON the lot.
  const buildingBase = (ringW) => {
    const ys = footprintTerrainSamples(ringW).sort((a, b) => a - b);
    const lo = ys[Math.min(ys.length - 1, Math.floor(0.10 * (ys.length - 1)))];
    return lo - 0.12;
  };

  // ---- roof generators -----------------------------------------------------------------
  // Gabled open shell for one roof rect (legacy gableTris, with the configurable overhang).
  function gableTris(rect, base, wallH) {
    let [rcx, rcy, w, d, deg] = rect;
    let L = w, Sp = d, ang = deg * Math.PI / 180;
    if (d > w) { L = d; Sp = w; ang += Math.PI / 2; }
    const rise = Math.min(2.6, Math.max(0.85, Sp * 0.30));
    const ov = EAVE_OVERHANG, hw = L / 2 + ov, hd = Sp / 2 + ov, y0 = wallH - 0.04, y1 = wallH - 0.04 + rise;
    const A = [-hw, y0, -hd], B = [hw, y0, -hd], Cc = [hw, y0, hd], D = [-hw, y0, hd], R1 = [-hw, y1, 0], R2 = [hw, y1, 0];
    const seq = [A, R1, R2, A, R2, B, Cc, R2, R1, Cc, R1, D, B, R2, Cc, A, D, R1];
    const ca = Math.cos(ang), sa = Math.sin(ang), [tx, tz] = w2(rcx, rcy), out = [];
    for (const [x, y, z] of seq) out.push(x * ca + z * sa + tx, y + base, -x * sa + z * ca + tz);
    return out;
  }
  // HIPPED roof for a near-square roof rect (aspect < 1.6): four sloped faces meeting at a short
  // ridge, with the same eave overhang. Two trapezoid side faces + two triangular hip ends.
  function hipTris(rect, base, wallH) {
    let [rcx, rcy, w, d, deg] = rect;
    let L = w, Sp = d, ang = deg * Math.PI / 180;
    if (d > w) { L = d; Sp = w; ang += Math.PI / 2; }
    const rise = Math.min(2.4, Math.max(0.8, Sp * 0.28));
    const ov = EAVE_OVERHANG, hw = L / 2 + ov, hd = Sp / 2 + ov;
    const y0 = wallH - 0.04, y1 = y0 + rise;
    const ridgeHalf = Math.max(0.4, (L - Sp) / 2);            // ridge runs along L, hips pull in by ~hd
    const A = [-hw, y0, -hd], B = [hw, y0, -hd], Cc = [hw, y0, hd], D = [-hw, y0, hd];   // eave corners
    const R1 = [-ridgeHalf, y1, 0], R2 = [ridgeHalf, y1, 0];                              // ridge ends
    const seq = [
      A, R1, R2, A, R2, B,        // front slope (trapezoid: A-B eave, R1-R2 ridge)
      Cc, R2, R1, Cc, R1, D,      // back slope
      B, R2, Cc,                  // right hip triangle
      D, R1, A,                   // left hip triangle
    ];
    const ca = Math.cos(ang), sa = Math.sin(ang), [tx, tz] = w2(rcx, rcy), out = [];
    for (const [x, y, z] of seq) out.push(x * ca + z * sa + tx, y + base, -x * sa + z * ca + tz);
    return out;
  }
  // choose hip when the rect aspect (long/short) < 1.6, else gable
  function roofShellTris(rect, base, wallH) {
    const w = rect[2], d = rect[3], aspect = Math.max(w, d) / Math.max(1e-3, Math.min(w, d));
    return aspect < 1.6 ? hipTris(rect, base, wallH) : gableTris(rect, base, wallH);
  }

  // ---- per-vertex roof shading (legacy pushUpTri, but NO aerial sampler in this frame) ---
  // Solid roof colour; upward winding by signed area. (Aerial roof tint dropped — the new frame
  // has no decoded aerial here; roofColor(ib) already carries the sampled satellite tint.)
  function pushUpTri(Rf, a, b, c) {
    const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
    const tri = (uz * vx - ux * vz) < 0 ? [a, c, b] : [a, b, c];
    for (const v of tri) Rf.pos.push(v[0], v[1], v[2]);
  }

  // ---- wall face (legacy pushWallFace, + atlas-UV variant) ------------------------------
  // Wall TOP flat at yt (= base + wallH); each BOTTOM corner drops to its own terrain - EMBED so a
  // facade on a slope is watertight. When uvRect is given, V maps eave(v0)->ground(v1) into the
  // atlas sub-rect (no roof band); else procedural stucco UVs (u = perimeter/TILE, v = height/TILE).
  function pushWallFace(W, xi, zi, xj, zj, yt, dist0, dist1, cen, uvRect) {
    const ybi = Math.min(yt - 0.1, terrainAt(xi, zi) - WALL_EMBED);
    const ybj = Math.min(yt - 0.1, terrainAt(xj, zj) - WALL_EMBED);
    const A = [xi, ybi, zi], B = [xj, ybj, zj], Cc = [xj, yt, zj], Dd = [xi, yt, zi];
    const L = Math.max(0.001, Math.hypot(xj - xi, zj - zi));
    const nx = -(zj - zi) / L, nz = (xj - xi) / L;
    const out = (((xi + xj) * 0.5 - cen[0]) * nx + ((zi + zj) * 0.5 - cen[1]) * nz) >= 0;
    const verts = out ? [A, B, Cc, A, Cc, Dd] : [A, Cc, B, A, Dd, Cc];
    let uvs;
    if (uvRect) {
      // atlas sub-rect: U left->right across this wall edge, V eave(top=v0)->ground(bottom=v1).
      const { u0, v0, u1, v1 } = uvRect;
      // bottom rows -> v1 (ground); top rows -> v0 (eave). per-corner bottoms differ but both map
      // to ground (V clamps in [u0,u1]x[v0,v1] regardless); keep it simple: bottom=v1, top=v0.
      uvs = out
        ? [u0, v1, u1, v1, u1, v0, u0, v1, u1, v0, u0, v0]
        : [u0, v1, u1, v0, u1, v1, u0, v1, u0, v0, u1, v0];
    } else {
      const u0 = dist0 / TILE, u1 = dist1 / TILE;
      const vi = (yt - ybi) / TILE, vj = (yt - ybj) / TILE;
      uvs = out
        ? [u0, 0, u1, 0, u1, vj, u0, 0, u1, vj, u0, vi]
        : [u0, 0, u1, vj, u1, 0, u0, 0, u0, vi, u1, vj];
    }
    for (const v of verts) W.pos.push(v[0], v[1], v[2]);
    W.uv.push(...uvs);
  }

  // ---- emit one ring (walls + flat eave cap + overhang + roof shells) -------------------
  // W = { stucco: {pos,uv}, atlasByPage: Map(page -> {pos,uv}) }  (walls split by material)
  // Rf = { pos } roof triangles for this building.  ib = building index (for hero/atlas lookup).
  function emitRing(ring, base, wallH, roofRects, ib, W, Rf, allRings) {
    if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
    const yt = base + wallH;
    const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
    const hero = isHero(ib);
    let dist = 0;
    for (let i = 0; i < ring.length; i++) {              // walls
      const [xi, zi] = ring[i], [xj, zj] = ring[(i + 1) % ring.length];
      const seg = Math.hypot(xj - xi, zj - zi);
      // HERO wall with a packed atlas crop for this edge -> use the atlas sub-rect + page material.
      const rect = hero ? rectByWall[`b${ib}_e${i}`] : null;
      if (rect) {
        const page = rect.page | 0;
        let bucket = W.atlasByPage.get(page);
        if (!bucket) { bucket = { pos: [], uv: [] }; W.atlasByPage.set(page, bucket); }
        pushWallFace(bucket, xi, zi, xj, zj, yt, dist, dist + seg, cen, rect);
      } else {
        pushWallFace(W.stucco, xi, zi, xj, zj, yt, dist, dist + seg, cen, null);
      }
      dist += seg;
    }
    // flat eave cap (triangulated footprint at the eave height)
    const v2 = ring.map(([x, z]) => new THREE.Vector2(x, z));
    const capTris = ShapeUtils.triangulateShape(v2, []);
    for (const [a, c, d] of capTris)
      pushUpTri(Rf, [ring[a][0], yt, ring[a][1]], [ring[c][0], yt, ring[c][1]], [ring[d][0], yt, ring[d][1]]);
    // EAVE OVERHANG: a flat lip ring pushed ~EAVE_OVERHANG outward + a vertical fascia band under
    // it, so the roof reads as an overhanging eave. Per-edge clamp: if the lip midpoint lands
    // inside ANOTHER building ring, drop this edge's lip (no poking through a neighbour).
    {
      const yf = yt - FASCIA;
      for (let i = 0; i < ring.length; i++) {
        const [xi, zi] = ring[i], [xj, zj] = ring[(i + 1) % ring.length];
        const L = Math.hypot(xj - xi, zj - zi); if (L < 1e-4) continue;
        let nx = -(zj - zi) / L, nz = (xj - xi) / L;
        if (((xi + xj) * 0.5 - cen[0]) * nx + ((zi + zj) * 0.5 - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
        const mxe = (xi + xj) * 0.5, mze = (zi + zj) * 0.5;
        let OVER = EAVE_OVERHANG;
        if (allRings.some(r => r !== ring && inPoly(mxe + nx * EAVE_OVERHANG, mze + nz * EAVE_OVERHANG, r))) OVER = 0;
        if (OVER < 1e-4) continue;
        const oi = [xi + nx * OVER, zi + nz * OVER], oj = [xj + nx * OVER, zj + nz * OVER];
        pushUpTri(Rf, [xi, yt, zi], [xj, yt, zj], [oj[0], yt, oj[1]]);
        pushUpTri(Rf, [xi, yt, zi], [oj[0], yt, oj[1]], [oi[0], yt, oi[1]]);
        pushUpTri(Rf, [oi[0], yt, oi[1]], [oj[0], yt, oj[1]], [oj[0], yf, oj[1]]);
        pushUpTri(Rf, [oi[0], yt, oi[1]], [oj[0], yf, oj[1]], [oi[0], yf, oi[1]]);
      }
    }
    // pitched roof shells (gable or hip per rect aspect)
    if (roofRects) for (const r of roofRects) {
      const g = roofShellTris(r, base, wallH);
      for (let k = 0; k < g.length; k += 9)
        pushUpTri(Rf, [g[k], g[k + 1], g[k + 2]], [g[k + 3], g[k + 4], g[k + 5]], [g[k + 6], g[k + 7], g[k + 8]]);
    }
    return ring;
  }

  // ---- build a grouped/merged mesh -----------------------------------------------------
  // walls: one geometry, a material GROUP per (building, page/stucco) bucket so each building keeps
  // its own paint/atlas-page material. roofs: one geometry, a material group per building (solid).
  function wallMeshFromBuckets(buckets, name) {
    // buckets: [{pos, uv, material}]
    const pos = [], uv = [];
    const g = new THREE.BufferGeometry();
    const mats = [];
    for (const b of buckets) {
      if (!b.pos.length) continue;
      const start = pos.length / 3;
      for (let i = 0; i < b.pos.length; i++) pos.push(b.pos[i]);
      for (let i = 0; i < b.uv.length; i++) uv.push(b.uv[i]);
      g.addGroup(start, b.pos.length / 3, mats.length);
      mats.push(b.material);
    }
    if (!pos.length) return null;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, mats); mesh.name = name; return mesh;
  }
  function roofMeshFromGroups(pos, groups, name, planarUV = 1.6) {
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const uv = [];
    for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] / planarUV, pos[i + 2] / planarUV);
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    const mats = groups.map(([start, count, col], i) => {
      g.addGroup(start, count, i);
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(col[0], col[1], col[2]), roughness: 0.85, metalness: 0, name: `${name}_${i}`, side: THREE.DoubleSide });
      return m;
    });
    const mesh = new THREE.Mesh(g, mats); mesh.name = name; return mesh;
  }
  function simpleMesh(pos, color, name, opts = {}) {
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.95, metalness: 0, name: name + '_mat', side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, m); mesh.name = name; return mesh;
  }

  // ====================================================================================
  // assemble
  // ====================================================================================
  const houseIdx = S.buildings.findIndex(b => b.house);
  const buildingPolys = [];            // emitted world rings (overhang clamp + later layers)
  const buildingCollision = [];        // [{ring, base, h}]
  let houseRing = null, houseWallH = 0;
  let emitted = 0, skipped = 0, clipped = 0;

  // ---- owner house (its own walls/roof meshes; hero by definition) ----------------------
  const hW = { stucco: { pos: [], uv: [], material: null }, atlasByPage: new Map() };
  const hRf = { pos: [] };
  if (houseIdx >= 0) {
    const houseB = S.buildings[houseIdx];
    let ring = houseB.p.map(([e, n]) => w2(e, n));
    const cr = clipPolyToRect(ring, demRect);
    if (cr) { if (cr.length !== ring.length) clipped++; ring = cr; }
    houseWallH = wallHeight(houseB);
    const base = buildingBase(ring);
    houseRing = emitRing(ring, base, houseWallH, houseB.r, houseIdx, hW, hRf, buildingPolys);
    buildingPolys.push(houseRing);
    buildingCollision.push({ ring: houseRing, base, h: houseWallH });
    emitted++;
    // house walls: stucco bucket + atlas page buckets, each its own material
    const hBuckets = [];
    hW.stucco.material = stuccoMaterial(houseIdx);
    hBuckets.push(hW.stucco);
    for (const [page, b] of hW.atlasByPage) hBuckets.push({ ...b, material: pageMaterial(page) });
    const hwMesh = wallMeshFromBuckets(hBuckets, 'House_walls');
    if (hwMesh) scene.add(hwMesh);
    const hrMesh = roofMeshFromGroups(hRf.pos, [[0, hRf.pos.length / 3, roofColor(houseIdx)]], 'House_roof');
    if (hrMesh) scene.add(hrMesh);
  }

  // ---- other buildings -----------------------------------------------------------------
  const bW = { stucco: { pos: [], uv: [], material: null }, atlasByPage: new Map() };
  const bRf = { pos: [] };
  // per-building wall groups: each building gets its own stucco material slot; atlas pages are
  // shared. We accumulate stucco per building into separate buckets so each keeps its paint.
  const stuccoBuckets = [];   // [{pos, uv, material}] one per building (with stucco walls)
  const roofGroups = [];      // [start, count, col]

  S.buildings.forEach((b, ib) => {
    if (b.house) return;
    if (!b.p || b.p.length < 3) return;
    let ring = b.p.map(([e, n]) => w2(e, n));
    const cr = clipPolyToRect(ring, demRect);
    if (!cr) { skipped++; return; }            // fully outside the DEM rect -> skip (only these)
    if (cr.length !== ring.length) clipped++;  // partially clipped (the missing-buildings fix)
    ring = cr;
    const base = buildingBase(ring);
    const h = wallHeight(b);
    // emit this building's walls into a FRESH per-building bucket set so each keeps its own paint
    const localW = { stucco: { pos: [], uv: [], material: stuccoMaterial(ib) }, atlasByPage: new Map() };
    const rs = bRf.pos.length / 3;
    const emittedRing = emitRing(ring, base, h, b.r, ib, localW, bRf, buildingPolys);
    buildingPolys.push(emittedRing);
    buildingCollision.push({ ring: emittedRing, base, h });
    // merge local stucco -> its own bucket; local atlas pages -> shared atlasByPage buckets
    if (localW.stucco.pos.length) stuccoBuckets.push(localW.stucco);
    for (const [page, lb] of localW.atlasByPage) {
      let shared = bW.atlasByPage.get(page);
      if (!shared) { shared = { pos: [], uv: [] }; bW.atlasByPage.set(page, shared); }
      for (const v of lb.pos) shared.pos.push(v);
      for (const v of lb.uv) shared.uv.push(v);
    }
    roofGroups.push([rs, bRf.pos.length / 3 - rs, roofColor(ib)]);
    emitted++;
  });

  if (stuccoBuckets.length || bW.atlasByPage.size) {
    const buckets = [...stuccoBuckets];
    for (const [page, b] of bW.atlasByPage) buckets.push({ ...b, material: pageMaterial(page) });
    const wallsMesh = wallMeshFromBuckets(buckets, 'Buildings_walls');
    if (wallsMesh) scene.add(wallsMesh);
  }
  if (bRf.pos.length) {
    const roofsMesh = roofMeshFromGroups(bRf.pos, roofGroups, 'Buildings_roofs');
    if (roofsMesh) scene.add(roofsMesh);
  }

  // ---- owner-house residential cues: front door / garage (skip on school) --------------
  // Ported from the legacy door/garage pass, but ONLY for the owner house (no per-building door
  // spam in this frame). Needs road lines for front-edge detection; we approximate "front" as the
  // footprint edge nearest the demRect-projected road side is unavailable here, so use the legacy
  // owner heuristic: garage on the higher-X end of the longest near-square front wall.
  if (houseRing && houseRing.length >= 3 && !isSchool) {
    const dwPos = [], doorTrim = [], doorGlass = [], garagePos = [], garageTrim = [];
    const DOORCOL = new THREE.Color(0.26, 0.18, 0.12);
    const cen = houseRing.reduce((a, [x, z]) => [a[0] + x / houseRing.length, a[1] + z / houseRing.length], [0, 0]);
    // pushWallRect proud of the wall (small offset) — owner cues only, allowed (not the dropped
    // per-building proud facade trim). off ~0.07-0.14 m, consistent with legacy door framing.
    const pushWallRect = (arr, ax, az, ex, ez, nx, nz, s0, s1, y0, y1, off) => {
      const A = [ax + ex * s0 + nx * off, y0, az + ez * s0 + nz * off];
      const B = [ax + ex * s1 + nx * off, y0, az + ez * s1 + nz * off];
      const Cc = [ax + ex * s1 + nx * off, y1, az + ez * s1 + nz * off];
      const Dd = [ax + ex * s0 + nx * off, y1, az + ez * s0 + nz * off];
      for (const v of [A, B, Cc, A, Cc, Dd]) arr.push(v[0], v[1], v[2]);
    };
    // pick the longest edge as the front wall (no road network here)
    let best = null, bestL = 0;
    for (let i = 0; i < houseRing.length; i++) {
      const [ax, az] = houseRing[i], [bx, bz] = houseRing[(i + 1) % houseRing.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L > bestL) { bestL = L; best = [ax, az, bx, bz]; }
    }
    if (best && bestL >= 2.4) {
      const [ax, az, bx, bz] = best;
      let ex = bx - ax, ez = bz - az; const L = Math.hypot(ex, ez) || 1; ex /= L; ez /= L;
      let nx = -ez, nz = ex;
      const m0x = (ax + bx) / 2, m0z = (az + bz) / 2;
      if ((m0x - cen[0]) * nx + (m0z - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
      // door on the SW (lower-X) half, garage on the higher-X end (legacy owner-house layout)
      const t = (ax > bx) ? 0.72 : 0.28;
      const dcx = ax + (bx - ax) * t, dcz = az + (bz - az) * t;
      const hw = 0.5, H = 2.1, dbase = terrainAt(dcx, dcz) - 0.1, cx = dcx + nx * 0.07, cz = dcz + nz * 0.07;
      const P = (s, y) => [cx + ex * s, dbase + y, cz + ez * s];
      const A = P(-hw, 0), B = P(hw, 0), Cc = P(hw, H), D = P(-hw, H);
      for (const tri of [[A, B, Cc], [A, Cc, D]]) for (const v of tri) dwPos.push(v[0], v[1], v[2]);
      const sd = t * L, jw = 0.10, head = 0.10;
      pushWallRect(doorTrim, ax, az, ex, ez, nx, nz, sd - hw - jw, sd - hw, dbase, dbase + H + head, 0.10);
      pushWallRect(doorTrim, ax, az, ex, ez, nx, nz, sd + hw, sd + hw + jw, dbase, dbase + H + head, 0.10);
      pushWallRect(doorTrim, ax, az, ex, ez, nx, nz, sd - hw - jw, sd + hw + jw, dbase + H, dbase + H + head, 0.10);
      pushWallRect(doorGlass, ax, az, ex, ez, nx, nz, sd - hw + 0.04, sd + hw - 0.04, dbase + H + head, dbase + H + head + 0.42, 0.112);
      // garage door on the road/higher-X end
      const gt = (ax > bx) ? 0.20 : 0.80;
      const gs = L * gt, ghw = Math.min(1.65, Math.max(1.25, L * 0.16));
      const gx = ax + ex * gs, gz = az + ez * gs, gb = terrainAt(gx, gz) - 0.08;
      pushWallRect(garageTrim, ax, az, ex, ez, nx, nz, gs - ghw - 0.16, gs + ghw + 0.16, gb - 0.03, gb + 2.35, 0.095);
      pushWallRect(garagePos, ax, az, ex, ez, nx, nz, gs - ghw, gs + ghw, gb + 0.06, gb + 2.18, 0.125);
      for (let p = 1; p <= 3; p++) {
        const y = gb + 0.06 + p * (2.12 / 4);
        pushWallRect(garageTrim, ax, az, ex, ez, nx, nz, gs - ghw + 0.05, gs + ghw - 0.05, y - 0.025, y + 0.025, 0.145);
      }
      pushWallRect(garageTrim, ax, az, ex, ez, nx, nz, gs - 0.025, gs + 0.025, gb + 0.12, gb + 2.08, 0.145);
    }
    const add = (m) => { if (m) scene.add(m); };
    add(simpleMesh(dwPos, DOORCOL, 'Doors'));
    add(simpleMesh(doorTrim, 0xd2c9b8, 'Doors_trim'));
    add(simpleMesh(doorGlass, 0x203342, 'Doors_transom'));
    add(simpleMesh(garageTrim, 0xd8d0bd, 'GarageDoor_trim'));
    add(simpleMesh(garagePos, 0x5e6266, 'GarageDoors'));
  }

  // ---- Collision_Buildings (extruded footprint prisms, per-corner terrain feet) ---------
  const cPos = [], cIdx = [];
  const pushExtrudedRing = (ring, base, h) => {
    if (!ring || ring.length < 3) return;
    const off = cPos.length / 3;
    for (const [x, z] of ring) cPos.push(x, Math.min(base + h - 0.1, terrainAt(x, z) - WALL_EMBED), z);
    for (const [x, z] of ring) cPos.push(x, base + h, z);
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      cIdx.push(off + i, off + j, off + n + j, off + i, off + n + j, off + n + i);
    }
    const tris = ShapeUtils.triangulateShape(ring.map(([x, z]) => new THREE.Vector2(x, z)), []);
    for (const [a, b, c] of tris) cIdx.push(off + n + a, off + n + b, off + n + c);
  };
  for (const b of buildingCollision) pushExtrudedRing(b.ring, b.base, b.h);
  if (cIdx.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cPos, 3));
    g.setIndex(cIdx);
    g.computeVertexNormals();
    // invisible alpha-mask proxy (runtime bakes a collider + hides it by name)
    const m = new THREE.MeshStandardMaterial({ name: 'Collision_Buildings_mat', color: 0xff00ff, transparent: false, alphaTest: 0.5, opacity: 0, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, m); mesh.name = 'Collision_Buildings'; scene.add(mesh);
  }

  const counts = { emitted, skipped, clipped };
  const total = emitted + skipped;
  const dropRatio = total ? skipped / total : 0;
  console.log(`buildings: emitted=${emitted} skipped=${skipped} clipped=${clipped} (drop ratio ${(dropRatio * 100).toFixed(1)}%)`);
  if (dropRatio > 0.10) console.warn(`  ***** WARNING: building drop ratio ${(dropRatio * 100).toFixed(1)}% > 10% — many buildings outside the DEM rect *****`);

  return {
    houseRing, houseWallH, buildingCollision, buildingPolys, counts,
    facadePageMaterials,   // page -> material name (exporter attaches facade.pages[page] by name)
  };
}
