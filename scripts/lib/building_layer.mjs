// building_layer.mjs — 3D houses/buildings + collision for the single-surface frame.
//
// NEW FRAME vs the legacy export_property_glb.mjs:
//   * ONE terrain already exists; we receive terrainAt(X,Z) (EXACT point-in-triangle height)
//     and seat every wall foot on it (legacy WALL_EMBED logic, unchanged).
//   * NO road/sidewalk/curb/ground ribbons here — those are TEXTURE on the terrain now.
//   * MISSING-BUILDINGS FIX: legacy dropped any footprint not ENTIRELY in-patch (every(inPatch)),
//     silently losing 37-66% of buildings on school levels. Here we CLIP each footprint to the
//     DEM rect (Sutherland-Hodgman) and emit the clipped part; only fully-outside footprints skip.
//
// FACADE MODEL (matches the proven legacy toggleable-overlay): every wall, in EVERY orientation,
// is ALWAYS procedural windowed stucco tinted by the building's real Street-View wallColor(ib) —
// the window grid is emitted on every wall edge (windows live UNDER the photo). A HERO wall that
// carries a packed SV atlas crop (facade.rectByWall['b{idx}_e{edge}']) additionally gets a SEPARATE
// overlay quad pushed ~0.17 m PROUD of the wall (in front of the window trim at ~0.12 m), grouped by
// atlas page into node 'SVFacade_page{N}' with material 'FacadeAtlasOverlay_page{N}_mat'. The runtime
// toggles every 'SVFacade*' node as a group: photo mode ON => the overlay covers the windows; OFF =>
// the windowed stucco wall shows. The photo is NEVER baked into the wall UV.
//
// Adds to `scene`: House_walls, House_roof, Buildings_walls (per-building stucco material groups),
//   Buildings_roofs, SVFacade_page{N} (toggleable photo overlays), Doors/Doors_trim/Doors_transom/
//   GarageDoors/GarageDoor_trim, House_windows/House_window_trim, and Collision_Buildings.

import * as ShapeUtilsHost from 'three';   // only for ShapeUtils.triangulateShape (caller's THREE preferred)

const TILE = 5.0;            // facade UV tile (m) for procedural stucco walls (sparser windows)
const WALL_EMBED = 0.4;      // wall bottoms drop to per-corner terrain - EMBED so feet touch grade
const MAX_FOUNDATION = 3.0;  // but NEVER plunge more than this below the floor: a footprint that
                             // reaches over the steep creek ravine would otherwise send its wall
                             // straight down into the creekbed. Clamp it to a realistic foundation.
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

// distance from (x,z) to the nearest segment of a set of world-XZ polylines (legacy port).
function distToLines(x, z, lines, max) {
  let best = max;
  for (const lw of lines) for (let k = 1; k < lw.length; k++) {
    const [ax, az] = lw[k - 1], [bx, bz] = lw[k]; let dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz || 1; let t = ((x - ax) * dx + (z - az) * dz) / L2; t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return best;
}

// proud-quad helper (legacy pushWallRect): pushes one quad `off` metres proud of a wall edge.
// (ax,az) = edge start; (ex,ez) = unit edge dir; (nx,nz) = outward unit normal; s0..s1 = along-edge
// span (measured from ax); y0..y1 = vertical span. Default `off` 0.09 m.
function pushWallRect(pos, ax, az, ex, ez, nx, nz, s0, s1, y0, y1, off = 0.09) {
  const A = [ax + ex * s0 + nx * off, y0, az + ez * s0 + nz * off];
  const B = [ax + ex * s1 + nx * off, y0, az + ez * s1 + nz * off];
  const Cc = [ax + ex * s1 + nx * off, y1, az + ez * s1 + nz * off];
  const Dd = [ax + ex * s0 + nx * off, y1, az + ez * s0 + nz * off];
  for (const v of [A, B, Cc, A, Cc, Dd]) pos.push(v[0], v[1], v[2]);
}

export function buildBuildingLayer({
  THREE, scene, S, w2, terrainAt, demRect, isSchool,
  wallColor, roofColor, facade, ROOT, roadLines = [], dropOffPatch = false,
  photorealFootprints = new Set(),
}) {
  // dropOffPatch: REMOVE any building whose footprint isn't fully inside the terrain patch instead
  // of clipping it to the edge. Off by default (suburban levels keep the missing-buildings clip so
  // edge houses aren't lost); on for dense downtown levels (xq) where a half-clipped building reads
  // as a sliced box hanging off the terrain edge.
  // photorealFootprints: Set of building indices (ib) whose massing is COVERED by a Google-photoreal
  // mesh added separately as 'Buildings_photoreal' (xq high-rise towers). For these we SKIP the
  // extruded visual walls/roofs/facade overlay (the photoreal mesh is the visual) but STILL emit the
  // Collision_Buildings prism so the player can't walk through the tower. Empty for every other level.
  const ShapeUtils = (THREE && THREE.ShapeUtils) || ShapeUtilsHost.ShapeUtils;
  const rectByWall = (facade && facade.rectByWall) || {};
  const openingsByWall = (facade && facade.openingsByWall) || {};
  const heroSet = (facade && facade.heroBuildings) || new Set();
  const isHero = (ib) => (heroSet.has ? heroSet.has(ib) : (Array.isArray(heroSet) && heroSet.includes(ib)));
  const isPhotoreal = (ib) => (photorealFootprints.has ? photorealFootprints.has(ib)
    : (Array.isArray(photorealFootprints) && photorealFootprints.includes(ib)));

  // ---- per-page OVERLAY material (one removable photo layer per atlas page) --------------
  // The photo is NOT the wall texture — it is a SEPARATE quad proud of the (always-present)
  // windowed-stucco wall, grouped per atlas page into node 'SVFacade_page{N}' with material
  // 'FacadeAtlasOverlay_page{N}_mat' (the exporter attaches facade.pages[N] JPEG by that name).
  // The runtime toggles every 'SVFacade*' node to turn photo mode on/off.
  const overlayPageMaterials = new Map();   // page -> material name (for the exporter)
  const overlayMatCache = new Map();
  const overlayMaterial = (page) => {
    let m = overlayMatCache.get(page);
    if (m) return m;
    const name = `FacadeAtlasOverlay_page${page}_mat`;
    m = new THREE.MeshStandardMaterial({ name, color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    overlayMatCache.set(page, m);
    overlayPageMaterials.set(page, name);
    return m;
  };
  // OVERLAY-quad accumulator: page -> {pos, uv} of all hero-wall photo quads on that page. One
  // SVFacade_page{N} mesh per page (so the runtime toggles them as a group). PROUD_OVERLAY sits
  // in FRONT of the window trim (which pushes out to ~0.12 m) so the photo covers the windows when
  // ON and the windowed stucco shows when the overlay is hidden.
  // BAKED facade: the photo is the wall's OWN surface, flush (offset 0), not a quad floating in
  // front. emitRing SKIPS the stucco face under a photo'd edge and suppresses the procedural
  // grid/trim there, so the Street-View crop IS the baked wall texture — no float, no z-fight, no
  // panel hanging past a corner. (Photo mode is no longer a runtime toggle; it's baked in.)
  const PROUD_OVERLAY = 0.0;
  const overlayByPage = new Map();
  const overlayBucket = (page) => {
    let b = overlayByPage.get(page);
    if (!b) { b = { pos: [], uv: [] }; overlayByPage.set(page, b); }
    return b;
  };
  // Emit one hero wall's photo overlay quad PROUD of its wall edge into its page bucket. The quad
  // spans the wall foot..eave (matching pushWallFace), UVs map U left->right across the edge and V
  // eave(top=v0)..ground(bottom=v1) into the atlas sub-rect (no roof band — facade_atlas trimmed it).
  function emitOverlayQuad(xi, zi, xj, zj, yt, base, cen, rect) {
    const yMin = base - MAX_FOUNDATION;
    const ybi = Math.max(yMin, Math.min(yt - 0.1, terrainAt(xi, zi) - WALL_EMBED));
    const ybj = Math.max(yMin, Math.min(yt - 0.1, terrainAt(xj, zj) - WALL_EMBED));
    const L = Math.max(0.001, Math.hypot(xj - xi, zj - zi));
    let nx = -(zj - zi) / L, nz = (xj - xi) / L;
    if (((xi + xj) * 0.5 - cen[0]) * nx + ((zi + zj) * 0.5 - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
    const o = PROUD_OVERLAY;
    // crop_v = the wall V-band [cv0 (top of photo, near eave) .. cv1 (ground)] the photo actually
    // covers after ROOF_TRIM. Cap the quad TOP at that band so a roof-trimmed photo isn't stretched
    // up to the eave (M3) — the wall above the photo shows the windowed stucco underneath.
    // The crop is ROOF-TRIMMED to pure wall (ground->eave), so map it across the FULL wall quad
    // (foot..eave): the photo IS the wall now (no stucco underneath), so there must be no gap.
    const ytTop = yt;
    const A = [xi + nx * o, ybi, zi + nz * o], B = [xj + nx * o, ybj, zj + nz * o];
    const Cc = [xj + nx * o, ytTop, zj + nz * o], Dd = [xi + nx * o, ytTop, zi + nz * o];
    const { u0, v0, u1, v1 } = rect;
    const bucket = overlayBucket(rect.page | 0);
    for (const v of [A, B, Cc, A, Cc, Dd]) bucket.pos.push(v[0], v[1], v[2]);
    // A/B = wall foot (ground=v1); Cc/Dd = eave (v0). U: A,Dd=left(u0); B,Cc=right(u1).
    bucket.uv.push(u0, v1, u1, v1, u1, v0, u0, v1, u1, v0, u0, v0);
  }
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
  // Footprint EDGE grade samples (corners + edge midpoints only) — the perimeter where the
  // house actually meets the ground/street. Used to clamp the floor so an incised channel
  // sample *inside* the footprint (creek bank) can't drag it down (the "houses sink into the
  // creek" bug: a creek-straddling footprint's 10th-pct low grade is the channel bottom, ~7 m
  // below the street pad).
  function footprintEdgeSamples(ringW) {
    const ys = [];
    for (const [x, z] of ringW) ys.push(terrainAt(x, z));
    for (let i = 0; i < ringW.length; i++) {
      const [ax, az] = ringW[i], [bx, bz] = ringW[(i + 1) % ringW.length];
      ys.push(terrainAt((ax + bx) / 2, (az + bz) / 2));
    }
    return ys;
  }
  const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
  // Seat the floor AT/just-below the LOW grade (10th-pct, spike-robust) so houses sit ON the lot,
  // BUT never more than BASE_CLAMP below the footprint's EDGE-median grade — so a creek-channel
  // (or any steep grade break crossed by the footprint) can't sink the house off its pad.
  const BASE_CLAMP = 1.0;
  const buildingBase = (ringW) => {
    const ys = footprintTerrainSamples(ringW).sort((a, b) => a - b);
    const lo = ys[Math.min(ys.length - 1, Math.floor(0.10 * (ys.length - 1)))];
    const edgeMed = median(footprintEdgeSamples(ringW));
    return Math.max(lo, edgeMed - BASE_CLAMP) - 0.12;
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
  function pushWallFace(W, xi, zi, xj, zj, yt, base, dist0, dist1, cen, uvRect) {
    // wall foot drops to per-corner terrain - EMBED, BUT clamped so it never sinks more than
    // MAX_FOUNDATION below the floor — ravine-edge footprints otherwise plunge into the creekbed.
    const yMin = base - MAX_FOUNDATION;
    const ybi = Math.max(yMin, Math.min(yt - 0.1, terrainAt(xi, zi) - WALL_EMBED));
    const ybj = Math.max(yMin, Math.min(yt - 0.1, terrainAt(xj, zj) - WALL_EMBED));
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

  // ---- SV-DETECTED door/window/garage geometry (real 3D openings) -----------------------
  // emitDetectedOpenings — for an edge whose detector returned `openings` (in openingsByWall keyed
  // 'b{ib}_e{edge}'), emit REAL recessed/proud 3D openings onto the wall quad so a photo'd hero wall
  // has DEPTH (recessed glass, a door slab, a garage panel) instead of a flat baked photo. Each
  // opening rect is normalised on the crop: x in [0,1] along the edge from corner A (ring[edge]) to
  // corner B; y in [0,1] from the EAVE (y=0, height base+wallH) to the GROUND (y=1, per-corner
  // terrain foot). We map that band onto the wall and emit a few cheap quads per opening into the
  // shared detail buckets (`out.glass`/`out.trim` = Buildings_windows/Buildings_window_trim;
  // `out.door`/`out.doorTrim` = Doors/Doors_trim; `out.garage`/`out.garageTrim` = GarageDoors/
  // GarageDoor_trim). Openings are clamped to the wall interior (inset from corners/eave/ground).
  // No-op when the edge has no detected openings -> backward-safe.
  function emitDetectedOpenings(ring, base, wallH, ib, edge, out) {
    if (!out) return;
    const ops = openingsByWall[`b${ib}_e${edge}`];
    if (!Array.isArray(ops) || !ops.length) return;
    const n = ring.length;
    const [ax, az] = ring[edge], [bx, bz] = ring[(edge + 1) % n];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1.2) return;
    const ex = (bx - ax) / L, ez = (bz - az) / L;
    const cen = ring.reduce((a, [x, z]) => [a[0] + x / n, a[1] + z / n], [0, 0]);
    let nx = -ez, nz = ex;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if ((mx - cen[0]) * nx + (mz - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
    const yt = base + wallH;                                   // eave (y normalised = 0)
    // per-corner ground feet (matches pushWallFace/emitOverlayQuad foot placement)
    const yMin = base - MAX_FOUNDATION;
    const footA = Math.max(yMin, Math.min(yt - 0.1, terrainAt(ax, az) - WALL_EMBED));
    const footB = Math.max(yMin, Math.min(yt - 0.1, terrainAt(bx, bz) - WALL_EMBED));
    // height of the wall band at along-edge fraction f (lerp the two corner feet to the eave)
    const yAtV = (f, v) => { const foot = footA + (footB - footA) * f; return yt + (foot - yt) * v; };
    const EDGE_INSET = 0.18;                                   // keep openings off the corners
    for (const op of ops) {
      const kind = op.kind || 'window';
      // along-edge span [s0,s1] (m from corner A); clamp inside the wall interior
      let s0 = Math.min(op.x0, op.x1) * L, s1 = Math.max(op.x0, op.x1) * L;
      s0 = Math.max(EDGE_INSET, Math.min(L - EDGE_INSET, s0));
      s1 = Math.max(EDGE_INSET, Math.min(L - EDGE_INSET, s1));
      if (s1 - s0 < 0.25) continue;
      const fMid = ((s0 + s1) / 2) / L;
      // vertical band: v0=top (toward eave), v1=bottom (toward ground); clamp inside foot..eave
      let v0 = Math.min(op.y0, op.y1), v1 = Math.max(op.y0, op.y1);
      v0 = Math.max(0.04, Math.min(0.96, v0));
      v1 = Math.max(0.04, Math.min(0.99, v1));
      if (kind === 'door' || kind === 'garage') v1 = 0.998;   // doors/garages reach the ground
      if (v1 - v0 < 0.06) continue;
      const yTop = yAtV(fMid, v0), yBot = yAtV(fMid, v1);
      if (yTop - yBot < 0.2) continue;
      if (kind === 'door') {
        // dark door slab + a proud jamb/lintel frame
        const jw = 0.10;
        pushWallRect(out.doorTrim, ax, az, ex, ez, nx, nz, s0 - jw, s0, yBot, yTop + 0.08, 0.10);
        pushWallRect(out.doorTrim, ax, az, ex, ez, nx, nz, s1, s1 + jw, yBot, yTop + 0.08, 0.10);
        pushWallRect(out.doorTrim, ax, az, ex, ez, nx, nz, s0 - jw, s1 + jw, yTop, yTop + 0.08, 0.10);
        pushWallRect(out.door, ax, az, ex, ez, nx, nz, s0, s1, yBot, yTop, 0.04);   // slab, slightly proud
      } else if (kind === 'garage') {
        // wide panel + frame + a few horizontal panel reveals
        const jw = 0.12;
        pushWallRect(out.garageTrim, ax, az, ex, ez, nx, nz, s0 - jw, s1 + jw, yBot - 0.03, yTop + 0.10, 0.095);
        pushWallRect(out.garage, ax, az, ex, ez, nx, nz, s0, s1, yBot, yTop, 0.12);
        const panels = 3;
        for (let p = 1; p <= panels; p++) {
          const y = yBot + (yTop - yBot) * p / (panels + 1);
          pushWallRect(out.garageTrim, ax, az, ex, ez, nx, nz, s0 + 0.05, s1 - 0.05, y - 0.025, y + 0.025, 0.135);
        }
      } else {
        // window: recessed glass (pushed ~0.06 m IN from the wall) + a thin proud trim surround
        pushWallRect(out.trim, ax, az, ex, ez, nx, nz, s0 - 0.10, s1 + 0.10, yBot - 0.10, yTop + 0.10, 0.08);
        pushWallRect(out.glass, ax, az, ex, ez, nx, nz, s0, s1, yBot, yTop, -0.06);   // recessed glass
        pushWallRect(out.trim, ax, az, ex, ez, nx, nz, (s0 + s1) / 2 - 0.025, (s0 + s1) / 2 + 0.025, yBot + 0.05, yTop - 0.05, 0.10); // mullion
      }
    }
  }
  // does this edge of building ib carry detected openings? (procedural grid skips it)
  const hasDetectedOpenings = (ib, edge) => {
    const ops = openingsByWall[`b${ib}_e${edge}`];
    return Array.isArray(ops) && ops.length > 0;
  };

  // ---- emit one ring (walls + flat eave cap + overhang + roof shells) -------------------
  // W = { stucco: {pos,uv} } — EVERY wall in EVERY orientation is procedural windowed stucco
  // (tinted by wallColor(ib)); the photo is NOT the wall texture. Rf = { pos } roof triangles.
  // ib = building index. A HERO wall that has a packed atlas crop ALSO emits a SEPARATE photo
  // overlay quad (into overlayByPage) proud of the stucco wall — toggled at runtime, windows under.
  function emitRing(ring, base, wallH, roofRects, ib, W, Rf, allRings, D) {
    if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
    const yt = base + wallH;
    const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
    const hero = isHero(ib);
    let dist = 0;
    for (let i = 0; i < ring.length; i++) {              // walls
      const [xi, zi] = ring[i], [xj, zj] = ring[(i + 1) % ring.length];
      const seg = Math.hypot(xj - xi, zj - zi);
      // HERO wall with a packed atlas crop -> BAKE the photo as this wall's surface (flush, opaque)
      // and emit NO stucco underneath (the photo is the wall). Other edges get windowed stucco.
      const rect = hero ? rectByWall[`b${ib}_e${i}`] : null;
      if (rect) emitOverlayQuad(xi, zi, xj, zj, yt, base, cen, rect);
      else pushWallFace(W.stucco, xi, zi, xj, zj, yt, base, dist, dist + seg, cen, null);
      // REAL detected openings (recessed glass / door slab / garage panel) sit ON/just-in-front of
      // the wall — emitted on ANY edge that has them (hero or not), giving photo'd walls depth.
      emitDetectedOpenings(ring, base, wallH, ib, i, D);
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

  // ---- facade DETAIL emitters (ported from legacy export_property_glb.mjs) --------------
  // Restore the proud-quad window/door/trim detail dropped in the single-surface rewrite. These
  // accumulate into bucket objects D = {glass, trim, siding}; the caller emits one mesh per bucket.
  //
  // emitFacadeShellDetails — corner/edge trim, header/sill bands, and faint siding course lines.
  // Perf gate: skips short/low walls (L<1.4 || wallH<2.1) so ~1600 buildings + sheds stay sane.
  function emitFacadeShellDetails(ring, base, wallH, D, isHeroEdge) {
    if (!D) return;
    const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
    const yBase = base + 0.12, yTop = base + wallH - 0.16;
    for (let i = 0; i < ring.length; i++) {
      if (isHeroEdge && isHeroEdge(i)) continue;   // baked-photo wall: no proud trim over the photo
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1.4 || wallH < 2.1) continue;
      let ex = (bx - ax) / L, ez = (bz - az) / L;
      let nx = -ez, nz = ex;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if ((mx - cen[0]) * nx + (mz - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
      if (D.trim) {
        pushWallRect(D.trim, ax, az, ex, ez, nx, nz, 0.02, Math.min(0.14, L), yBase, yTop, 0.116);
        pushWallRect(D.trim, ax, az, ex, ez, nx, nz, Math.max(0, L - 0.14), L - 0.02, yBase, yTop, 0.116);
        pushWallRect(D.trim, ax, az, ex, ez, nx, nz, 0.08, L - 0.08, base + wallH - 0.24, base + wallH - 0.08, 0.118);
        pushWallRect(D.trim, ax, az, ex, ez, nx, nz, 0.08, L - 0.08, base + 0.16, base + 0.30, 0.118);
        for (let y = base + 2.65; y < base + wallH - 0.55; y += 2.55) {
          pushWallRect(D.trim, ax, az, ex, ez, nx, nz, 0.18, L - 0.18, y - 0.035, y + 0.035, 0.121);
        }
      }
      if (D.siding) {
        for (let y = base + 0.82; y < base + wallH - 0.65; y += 0.92) {
          pushWallRect(D.siding, ax, az, ex, ez, nx, nz, 0.22, L - 0.22, y - 0.006, y + 0.006, 0.124);
        }
      }
    }
  }
  // emitFacadeDetails — the WINDOW GRID (glass panes + trim surrounds + mullions, floor/bay spacing)
  // plus the SCHOOL commercial storefront branch. Internally calls emitFacadeShellDetails.
  // opts: { house, autoWindows:false (skip the grid) }.
  // Windows are emitted on EVERY wall edge of EVERY orientation — they live UNDER the photo overlay,
  // so a hero (photo) wall keeps its window grid (visible when photo mode is OFF). Perf gate only:
  // window grid skips L<2.4 || wallH<2.7.
  function emitFacadeDetails(ring, base, wallH, D, opts = {}) {
    if (!D) return;
    // A photo'd (hero) edge gets NO procedural trim/grid — the baked Street-View photo is the wall.
    const isHeroEdge = (opts.ib != null) ? (i) => !!rectByWall[`b${opts.ib}_e${i}`] : null;
    emitFacadeShellDetails(ring, base, wallH, D, isHeroEdge);
    if (opts.autoWindows === false) return;
    const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
    const yt = base + wallH;
    for (let i = 0; i < ring.length; i++) {
      if (isHeroEdge && isHeroEdge(i)) continue;   // baked-photo wall: skip the procedural window grid
      // an edge with REAL detected openings gets its 3D door/window/garage geometry instead of the
      // generic procedural grid — skip the grid here so they don't overlap (fallback only otherwise).
      if (opts.ib != null && hasDetectedOpenings(opts.ib, i)) continue;
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 2.4 || wallH < 2.7) continue;
      let ex = (bx - ax) / L, ez = (bz - az) / L;
      let nx = -ez, nz = ex;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if ((mx - cen[0]) * nx + (mz - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
      const bay = opts.house ? 3.0 : 3.35 + (((i * 97 + Math.round(L * 10)) % 5) - 2) * 0.10;
      // windows scale with wall AREA: long walls get many bays (cap 40, was 12 -> warehouses/
      // long apartments were blank), tall walls get many floors (cap 50, was 3 -> downtown towers
      // were blank above the 3rd floor). The y-clamp below stops the grid at the real wall top.
      const count = Math.max(1, Math.min(40, Math.floor((L - 1.0) / bay)));
      const floors = Math.max(1, Math.min(50, Math.floor((wallH - 1.15) / 2.55)));
      // commercial storefront: a long, tall, non-residential wall gets a CONTINUOUS ground-floor
      // glass band + mullions. Now fires on ANY large non-house wall (was isSchool-only -> xq/canyon
      // commercial blocks stayed blank); the upper floors still get the punched window grid above it.
      // Storefront glass band is for genuinely COMMERCIAL/civic walls — schools, the downtown (xq)
      // patch, or tall (3+ storey) blocks. A 1-2 storey residential house with a long wall must NOT
      // get a continuous glass curtain wall (it read as a glass office block on meemaw/dahill).
      const commercial = !opts.house && L >= 12 && wallH >= 4.5 && (isSchool || dropOffPatch || wallH >= 8.0);
      if (commercial) {
        const gy0 = base + 0.85, gy1 = base + Math.min(3.2, wallH - 1.4);   // ground-floor band
        if (gy1 - gy0 > 0.6) {
          pushWallRect(D.trim, ax, az, ex, ez, nx, nz, 0.45, L - 0.45, gy0 - 0.18, gy0, 0.10);          // sill
          pushWallRect(D.trim, ax, az, ex, ez, nx, nz, 0.45, L - 0.45, gy1, gy1 + 0.16, 0.10);          // head
          pushWallRect(D.glass, ax, az, ex, ez, nx, nz, 0.5, L - 0.5, gy0, gy1, 0.085);                 // continuous glass band
          const mull = Math.max(2, Math.round((L - 1.0) / 2.0));
          for (let mI = 0; mI <= mull; mI++) {
            const ms = 0.5 + (L - 1.0) * mI / mull;
            pushWallRect(D.trim, ax, az, ex, ez, nx, nz, ms - 0.05, ms + 0.05, gy0, gy1, 0.10);         // vertical mullion
          }
        }
      }
      for (let f = 0; f < floors; f++) {
        if (commercial && f === 0) continue;     // ground floor is the storefront band above
        const y0 = base + 1.10 + f * 2.45;
        const y1 = Math.min(y0 + 1.02, yt - 0.42);
        if (y1 - y0 < 0.45) continue;
        for (let wI = 0; wI < count; wI++) {
          if (!opts.house && count > 3 && ((wI + i + f) % 7) === 5) continue;
          const jitter = (((i + 3) * 37 + (wI + 11) * 19 + f * 13) % 17 - 8) / 100;
          const s = (wI + 1 + jitter) * L / (count + 1);
          if (s < 0.85 || L - s < 0.85) continue;
          const hw = Math.min(0.64, Math.max(0.34, L / (count + 1) * (0.18 + ((wI + i) % 3) * 0.025)));
          pushWallRect(D.trim, ax, az, ex, ez, nx, nz, s - hw - 0.12, s + hw + 0.12, y0 - 0.10, y1 + 0.10, 0.082);
          pushWallRect(D.glass, ax, az, ex, ez, nx, nz, s - hw, s + hw, y0, y1, 0.105);
          pushWallRect(D.trim, ax, az, ex, ez, nx, nz, s - 0.025, s + 0.025, y0 + 0.05, y1 - 0.05, 0.118);
          pushWallRect(D.trim, ax, az, ex, ez, nx, nz, s - hw - 0.18, s + hw + 0.18, y0 - 0.20, y0 - 0.12, 0.115);
        }
      }
    }
  }
  // emitOwnerHouseFacadeCues — owner front-door/window cues. The owner house uses these instead of
  // the auto window grid (autoWindows:false) so the front reads as a residence with a real door.
  function emitOwnerHouseFacadeCues(ring, wallH, out) {
    if (!ring || ring.length < 3 || !out) return;
    const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
    const edges = ring.map(([ax, az], i) => {
      const [bx, bz] = ring[(i + 1) % ring.length];
      const L = Math.hypot(bx - ax, bz - az);
      let ex = (bx - ax) / (L || 1), ez = (bz - az) / (L || 1);
      let nx = -ez, nz = ex;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if ((mx - cen[0]) * nx + (mz - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
      return { i, ax, az, bx, bz, L, ex, ez, nx, nz, mx, mz, roadD: distToLines(mx, mz, roadLines, 1e9) };
    }).filter(e => e.L >= 2.2);
    if (!edges.length) return;
    const front = edges.reduce((a, b) => b.roadD < a.roadD ? b : a);
    const back = edges.reduce((a, b) => {
      const da = (a.nx * front.nx + a.nz * front.nz);
      const db = (b.nx * front.nx + b.nz * front.nz);
      return db < da ? b : a;
    }, front);
    const addWindow = (e, t, halfW = 0.48, y0 = 1.08, h = 0.92, wide = false) => {
      if (!e || e.L < 2.4) return;
      const s = Math.max(halfW + 0.18, Math.min(e.L - halfW - 0.18, e.L * t));
      const base = terrainAt(e.mx, e.mz) - 0.10;
      const yA = base + y0, yB = Math.min(base + y0 + h, base + wallH - 0.45);
      if (yB - yA < 0.35) return;
      pushWallRect(out.trim, e.ax, e.az, e.ex, e.ez, e.nx, e.nz, s - halfW - 0.12, s + halfW + 0.12, yA - 0.10, yB + 0.10, 0.086);
      pushWallRect(out.glass, e.ax, e.az, e.ex, e.ez, e.nx, e.nz, s - halfW, s + halfW, yA, yB, 0.118);
      pushWallRect(out.trim, e.ax, e.az, e.ex, e.ez, e.nx, e.nz, s - 0.025, s + 0.025, yA + 0.04, yB - 0.04, 0.13);
      if (wide) pushWallRect(out.trim, e.ax, e.az, e.ex, e.ez, e.nx, e.nz, s - halfW - 0.18, s + halfW + 0.18, yA - 0.20, yA - 0.12, 0.13);
    };
    const addDoorGlass = (e, t, halfW = 0.62) => {
      const s = Math.max(halfW + 0.22, Math.min(e.L - halfW - 0.22, e.L * t));
      const base = terrainAt(e.mx, e.mz) - 0.10;
      pushWallRect(out.trim, e.ax, e.az, e.ex, e.ez, e.nx, e.nz, s - halfW - 0.12, s + halfW + 0.12, base + 0.02, base + 2.16, 0.088);
      pushWallRect(out.glass, e.ax, e.az, e.ex, e.ez, e.nx, e.nz, s - halfW, s + halfW, base + 0.12, base + 2.04, 0.122);
    };
    const garageT = front.ax > front.bx ? 0.20 : 0.80;
    const doorT = front.ax > front.bx ? 0.72 : 0.28;
    addWindow(front, (doorT + garageT) / 2, 0.42, 1.18, 0.82);
    for (const e of edges) {
      if (e === front) continue;
      if (e === back) {
        addDoorGlass(e, 0.48, 0.82);
        if (e.L > 6.0) { addWindow(e, 0.23, 0.42); addWindow(e, 0.75, 0.42); }
      } else if (e.L > 5.5) {
        addWindow(e, 0.32, 0.46);
        addWindow(e, 0.68, 0.46);
      } else {
        addWindow(e, 0.50, 0.42);
      }
    }
  }

  // ====================================================================================
  // assemble
  // ====================================================================================
  const houseIdx = S.buildings.findIndex(b => b.house);
  const buildingPolys = [];            // emitted world rings (overhang clamp + later layers)
  const buildingCollision = [];        // [{ring, base, h}]
  const ringToIb = new Map();          // emitted ring -> building index (so the door loop can tell
                                       // if an entrance edge already carries a baked photo)
  let houseRing = null, houseWallH = 0;
  let emitted = 0, skipped = 0, clipped = 0;

  // ---- owner house (its own walls/roof meshes; hero by definition) ----------------------
  // Walls are ALWAYS windowed stucco; hero photo overlays accumulate into overlayByPage (emitted
  // once as SVFacade_page{N} meshes after every building, so they toggle as one group).
  const hW = { stucco: { pos: [], uv: [], material: null } };
  const hRf = { pos: [] };
  // owner-house facade detail bucket (its own meshes): the shell trim/siding from emitFacadeDetails
  // PLUS the front-door/window cues. The grid itself is suppressed (autoWindows:false) — the cues
  // place a door + real windows facing the street instead of a generic punched grid.
  // door/doorTrim/garage/garageTrim carry the SV-detected 3D openings (feed Doors/Doors_trim/
  // GarageDoors/GarageDoor_trim meshes, same nodes as the per-building Doors loop).
  const hD = { glass: [], trim: [], siding: [], door: [], doorTrim: [], garage: [], garageTrim: [] };
  if (houseIdx >= 0) {
    const houseB = S.buildings[houseIdx];
    let ring = houseB.p.map(([e, n]) => w2(e, n));
    const cr = clipPolyToRect(ring, demRect);
    if (cr) { if (cr.length !== ring.length) clipped++; ring = cr; }
    houseWallH = wallHeight(houseB);
    const base = buildingBase(ring);
    const houseIsPhotoreal = isPhotoreal(houseIdx);   // covered by Buildings_photoreal -> collision only
    houseRing = emitRing(ring, base, houseWallH, houseIsPhotoreal ? null : houseB.r,
      houseIdx, houseIsPhotoreal ? { stucco: { pos: [], uv: [] } } : hW, houseIsPhotoreal ? { pos: [] } : hRf,
      buildingPolys, houseIsPhotoreal ? null : hD);
    buildingPolys.push(houseRing); ringToIb.set(houseRing, houseIdx);
    buildingCollision.push({ ring: houseRing, base, h: houseWallH });
    emitted++;
    if (!houseIsPhotoreal) {
      // facade detail: shell trim/siding only (no auto grid); the cues add the street-facing windows.
      emitFacadeDetails(houseRing, base, houseWallH, hD, { house: true, autoWindows: false, ib: houseIdx });
      if (!isSchool) emitOwnerHouseFacadeCues(houseRing, houseWallH, hD);
      // house walls: a single stucco bucket (the photo, if any, is a separate SVFacade overlay).
      hW.stucco.material = stuccoMaterial(houseIdx);
      const hwMesh = wallMeshFromBuckets([hW.stucco], 'House_walls');
      if (hwMesh) scene.add(hwMesh);
      const hrMesh = roofMeshFromGroups(hRf.pos, [[0, hRf.pos.length / 3, roofColor(houseIdx)]], 'House_roof');
      if (hrMesh) scene.add(hrMesh);
      // owner-house facade detail meshes (legacy node names + colours)
      const addH = (m) => { if (m) scene.add(m); };
      addH(simpleMesh(hD.siding, 0xbcb4a4, 'House_siding_lines'));
      addH(simpleMesh(hD.trim, 0xd8d0bd, 'House_window_trim'));
      addH(simpleMesh(hD.glass, 0x223647, 'House_windows'));
    }
  }

  // ---- other buildings -----------------------------------------------------------------
  const bRf = { pos: [] };
  // SHARED facade detail bucket for every non-owner building — one mesh per kind at the end.
  // door/doorTrim/garage/garageTrim carry the SV-detected 3D openings (Doors/GarageDoors meshes).
  const bD = { glass: [], trim: [], siding: [], door: [], doorTrim: [], garage: [], garageTrim: [] };
  // per-building wall groups: each building gets its own stucco material slot (its real paint).
  const stuccoBuckets = [];   // [{pos, uv, material}] one per building (always-present stucco walls)
  const roofGroups = [];      // [start, count, col]

  S.buildings.forEach((b, ib) => {
    if (b.house) return;
    if (!b.p || b.p.length < 3) return;
    let ring = b.p.map(([e, n]) => w2(e, n));
    const cr = clipPolyToRect(ring, demRect);
    if (!cr) { skipped++; return; }            // fully outside the DEM rect -> skip
    if (cr.length !== ring.length) {           // footprint crosses the patch edge
      if (dropOffPatch) { skipped++; return; } // downtown: remove it entirely (no sliced edge boxes)
      clipped++;                               // suburban: keep the in-patch part (missing-buildings fix)
    }
    ring = cr;
    const base = buildingBase(ring);
    const h = wallHeight(b);
    // PHOTOREAL tower: its massing is the separately-added Buildings_photoreal mesh — emit NO extruded
    // walls/roof/facade for it, but DO record collision so the player can't walk through the tower.
    // We still need a watertight ring + base/h for the Collision_Buildings prism below.
    if (isPhotoreal(ib)) {
      let pr = ring.slice();
      if (pr.length > 1 && pr[0][0] === pr.at(-1)[0] && pr[0][1] === pr.at(-1)[1]) pr.pop();
      buildingPolys.push(pr); ringToIb.set(pr, ib);
      buildingCollision.push({ ring: pr, base, h });
      emitted++;
      return;
    }
    // emit this building's walls into a FRESH per-building stucco bucket so each keeps its own paint
    const localW = { stucco: { pos: [], uv: [], material: stuccoMaterial(ib) } };
    const rs = bRf.pos.length / 3;
    const emittedRing = emitRing(ring, base, h, b.r, ib, localW, bRf, buildingPolys, bD);
    buildingPolys.push(emittedRing); ringToIb.set(emittedRing, ib);
    buildingCollision.push({ ring: emittedRing, base, h });
    // facade detail: window grid on EVERY wall edge (+ shell trim). Windows live UNDER the photo
    // overlay, so a hero wall keeps its grid (shown when photo mode is OFF). No per-edge skip.
    emitFacadeDetails(emittedRing, base, h, bD, { ib });
    if (localW.stucco.pos.length) stuccoBuckets.push(localW.stucco);
    roofGroups.push([rs, bRf.pos.length / 3 - rs, roofColor(ib)]);
    emitted++;
  });

  if (stuccoBuckets.length) {
    const wallsMesh = wallMeshFromBuckets(stuccoBuckets, 'Buildings_walls');
    if (wallsMesh) scene.add(wallsMesh);
  }
  if (bRf.pos.length) {
    const roofsMesh = roofMeshFromGroups(bRf.pos, roofGroups, 'Buildings_roofs');
    if (roofsMesh) scene.add(roofsMesh);
  }
  // shared building facade detail meshes (legacy node names + colours)
  const addB = (m) => { if (m) scene.add(m); };
  addB(simpleMesh(bD.siding, 0xb6ad9f, 'Buildings_siding_lines'));
  addB(simpleMesh(bD.trim, 0xd2c9b8, 'Buildings_window_trim'));
  addB(simpleMesh(bD.glass, 0x203342, 'Buildings_windows'));

  // ---- BAKED Street-View photo walls (one mesh per atlas page) --------------------------
  // All hero-wall photo quads for atlas page N go into ONE node 'Buildings_facade_page{N}' with
  // material 'FacadeAtlasOverlay_page{N}_mat' (the exporter attaches facade.pages[N] JPEG by name).
  // The quads sit FLUSH on the wall (stucco skipped underneath, grid/trim suppressed) so the photo
  // IS the baked wall texture — always shown, not a runtime toggle.
  for (const [page, b] of [...overlayByPage.entries()].sort((a, c) => a[0] - c[0])) {
    if (!b.pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, overlayMaterial(page));
    mesh.name = `Buildings_facade_page${page}`;
    mesh.userData = { source: 'Google Street View Static', baked: true, page };
    scene.add(mesh);
  }

  // ---- Doors + Garage (ported full per-building loop) ----------------------------------
  // Per building: a road-facing door (slab + jamb/lintel trim + transom glass) on the footprint
  // edge whose midpoint is nearest a road (falls back to the longest edge if no roadLines). The
  // OWNER HOUSE additionally gets a GARAGE (panel + trim + mullions) on the road/higher-X end of
  // that wall. Doors are added REGARDLESS of any photo facade — they read as real entrances.
  {
    const dwPos = [], garagePos = [], garageTrim = [], doorTrim = [], doorGlass = [];
    const DOORCOL = new THREE.Color(0.26, 0.18, 0.12);
    buildingPolys.forEach((ring) => {
      if (!ring || ring.length < 2) return;
      const isOwner = ring === houseRing;
      const cen = ring.reduce((a, [x, z]) => [a[0] + x / ring.length, a[1] + z / ring.length], [0, 0]);
      // edge whose midpoint is nearest a road (or longest edge when no roadLines)
      let best = null, bestD = Infinity, bestL = 0, bestI = -1;
      for (let i = 0; i < ring.length; i++) {
        const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
        const eL = Math.hypot(bx - ax, bz - az);
        if (eL < 1.6) continue;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const d = roadLines.length ? distToLines(mx, mz, roadLines, 1e9) : -eL;   // no roads -> prefer longest
        if (d < bestD) { bestD = d; best = [ax, az, bx, bz]; bestL = eL; bestI = i; }
      }
      if (!best || bestL < 2.4) return;
      // If this entrance edge already carries a BAKED Street-View photo, the photo shows the real
      // door/garage — don't float a procedural door slab (and garage) over it.
      const dib = ringToIb.get(ring);
      if (dib != null && rectByWall[`b${dib}_e${bestI}`]) return;
      const [ax, az, bx, bz] = best;
      let ex = bx - ax, ez = bz - az; const L = Math.hypot(ex, ez) || 1; ex /= L; ez /= L;
      let nx = -ez, nz = ex;                                    // outward normal (away from centroid)
      const m0x = (ax + bx) / 2, m0z = (az + bz) / 2;
      if ((m0x - cen[0]) * nx + (m0z - cen[1]) * nz < 0) { nx = -nx; nz = -nz; }
      // owner house: door on the SW (lower-X) half so the garage gets the road/NE (higher-X) end.
      let t = 0.5;
      if (isOwner) t = (ax > bx) ? 0.72 : 0.28;
      const dcx = ax + (bx - ax) * t, dcz = az + (bz - az) * t;
      const hw = 0.5, H = 2.1, base = terrainAt(dcx, dcz) - 0.1, cx = dcx + nx * 0.07, cz = dcz + nz * 0.07;
      const P = (s, y) => [cx + ex * s, base + y, cz + ez * s];
      const A = P(-hw, 0), B = P(hw, 0), Cc = P(hw, H), D = P(-hw, H);
      for (const tri of [[A, B, Cc], [A, Cc, D]]) for (const v of tri) dwPos.push(v[0], v[1], v[2]);
      // door FRAME (jambs + lintel) just proud of the slab + a glass TRANSOM panel above the head.
      const sd = t * L, jw = 0.10, head = 0.10;
      pushWallRect(doorTrim, ax, az, ex, ez, nx, nz, sd - hw - jw, sd - hw, base, base + H + head, 0.10);          // left jamb
      pushWallRect(doorTrim, ax, az, ex, ez, nx, nz, sd + hw, sd + hw + jw, base, base + H + head, 0.10);          // right jamb
      pushWallRect(doorTrim, ax, az, ex, ez, nx, nz, sd - hw - jw, sd + hw + jw, base + H, base + H + head, 0.10); // head lintel
      pushWallRect(doorGlass, ax, az, ex, ez, nx, nz, sd - hw + 0.04, sd + hw - 0.04, base + H + head, base + H + head + 0.42, 0.112); // transom
      if (isOwner && !isSchool) {     // owner-house garage; never on a SCHOOL export
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
    });
    const add = (m) => { if (m) scene.add(m); };
    // SV-DETECTED openings (from emitDetectedOpenings, both house hD + buildings bD) feed the SAME
    // door/garage nodes so they share materials with the procedural entrances. Concatenated here.
    add(simpleMesh(dwPos.concat(hD.door, bD.door), DOORCOL, 'Doors'));
    add(simpleMesh(doorTrim.concat(hD.doorTrim, bD.doorTrim), 0xd2c9b8, 'Doors_trim'));
    add(simpleMesh(doorGlass, 0x203342, 'Doors_transom'));
    add(simpleMesh(garageTrim.concat(hD.garageTrim, bD.garageTrim), 0xd8d0bd, 'GarageDoor_trim'));
    add(simpleMesh(garagePos.concat(hD.garage, bD.garage), 0x5e6266, 'GarageDoors'));
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

  // hero-wall count = total photo overlay quads emitted (6 verts per quad) across all pages.
  let heroWalls = 0;
  for (const b of overlayByPage.values()) heroWalls += (b.pos.length / 3 / 6) | 0;
  const counts = { emitted, skipped, clipped, heroWalls };
  const total = emitted + skipped;
  const dropRatio = total ? skipped / total : 0;
  console.log(`buildings: emitted=${emitted} skipped=${skipped} clipped=${clipped} (drop ratio ${(dropRatio * 100).toFixed(1)}%)`);
  console.log(`facade overlays: ${heroWalls} hero walls across ${overlayByPage.size} SVFacade page node(s)`);
  if (dropRatio > 0.10) console.warn(`  ***** WARNING: building drop ratio ${(dropRatio * 100).toFixed(1)}% > 10% — many buildings outside the DEM rect *****`);

  return {
    houseRing, houseWallH, buildingCollision, buildingPolys, counts,
    overlayPageMaterials,  // page -> overlay material name (exporter attaches facade.pages[page] by name)
  };
}
