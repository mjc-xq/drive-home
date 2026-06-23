// fill_missing.mjs — DETECT lots that have a real building in the aerial but NONE in our
// OSM/Overture-derived scene.json, and FILL them with an inferred footprint so the streamed
// world stops missing real houses (notably the house directly across the street from the owner).
//
// Why this exists: scene.buildings comes from OSM/Overture; coverage is incomplete in this
// neighborhood — some real houses are simply absent. Parcel lot lines (exports/parcels.json) plus
// the Google aerial give us two independent signals to recover them:
//   1. a PARCEL with no existing building footprint over it is a candidate empty lot, and
//   2. if that lot's INTERIOR is dominated by a contiguous ROOF-like blob in the aerial, a real
//      building stands there. We fit an oriented rectangle to the roof blob and emit it as a
//      scene-shaped building (p = ENU footprint, r = roofRect, h = residential default), tagged
//      source:'inferred-aerial', so it flows through the existing massing/seating/collision path.
// Optionally also pulls Mapbox mapbox-streets-v8 `building` footprints over the patch and adds any
// not already covered (source:'mapbox'). De-dup against existing + each other; clip to the DEM rect.
//
// Coordinate frames (identical to surface_annotation.mjs / the exporter):
//   C = scene.center; world(e,n) = [e-C[0], -(n-C[1])]  (owner house ~origin, +Z = south).
//   ENU footprint point: e = X + C[0], n = C[1] - Z   (inverse of w2).
//   Aerial JPG 6400² with bounds {E0,E1,Nt,Nb}; worldToAerialPx(X,Z) below (v=0 at north).
//   DEM rect {x0,x1,z0,z1} = world extent of the terrain/texture.

import sharp from 'sharp';

// ---- tunables (commented; conservative so we fill REAL gaps, not spam yards/driveways) ----
const MIN_LOT_AREA = 150;       // m² — below this it's a shed/sliver, not a house lot
const MAX_LOT_AREA = 9000;      // m² — big hill lots DO hold real houses; the absolute roof-BLOB-area
                                //       gate (not lot fraction) rejects open fields, so allow large
                                //       lots (was 2000 → silently dropped ~11 real dahill hill houses)
const ROOF_BLOB_MIN = 40;       // m² — a contiguous roof region must be at least this big to count
const ROOF_FILL_MIN = 0.12;     // ≥12% of the lot interior must read roof-like (was .16); also
                                //       BYPASSED for big lots in detectRoofRect (a house is a small
                                //       fraction of a big lot, so the fraction gate is wrong there)
const SAMPLE_STEP = 0.6;        // m — aerial sample spacing inside a lot (≈0.6 m, finer than a roof)
const INSET = 0.7;              // m — shrink the fitted footprint off the lot line so it never pokes
const DEFAULT_H = 6.0;          // m — residential wall height when no neighbor median is available
const ROOF_INSET_FROM_LOT = 1.2; // m — also keep the roof blob search away from the very lot edge

// ---- geometry helpers (self-contained; no imports from the protected modules) -------------
function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(a) / 2; }
function centroid(r) { let x = 0, z = 0; for (const [a, b] of r) { x += a; z += b; } return [x / r.length, z / r.length]; }
function bbox(r) { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const [x, z] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; } return { x0, x1, z0, z1 }; }
function inPoly(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
// Sutherland–Hodgman clip of a CLOSED ring to the axis-aligned demRect (mirrors building_layer).
function clipPolyToRect(ring, r) {
  const { x0, x1, z0, z1 } = r;
  const clip = (poly, inside, intersect) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) { if (!pi) out.push(intersect(prev, cur)); out.push(cur); }
      else if (pi) out.push(intersect(prev, cur));
    }
    return out;
  };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  let poly = ring.slice();
  poly = clip(poly, p => p[0] >= x0, (a, b) => lerp(a, b, (x0 - a[0]) / (b[0] - a[0]))); if (poly.length < 3) return null;
  poly = clip(poly, p => p[0] <= x1, (a, b) => lerp(a, b, (x1 - a[0]) / (b[0] - a[0]))); if (poly.length < 3) return null;
  poly = clip(poly, p => p[1] >= z0, (a, b) => lerp(a, b, (z0 - a[1]) / (b[1] - a[1]))); if (poly.length < 3) return null;
  poly = clip(poly, p => p[1] <= z1, (a, b) => lerp(a, b, (z1 - a[1]) / (b[1] - a[1]))); if (poly.length < 3) return null;
  return poly;
}
// Polygon overlap test (any vertex of A in B, any vertex of B in A, or edge crossing) — used to
// de-dup an inferred footprint against existing buildings and against each other.
function segCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
function polysOverlap(A, B) {
  for (const p of A) if (inPoly(p[0], p[1], B)) return true;
  for (const p of B) if (inPoly(p[0], p[1], A)) return true;
  for (let i = 0; i < A.length; i++) {
    const a = A[i], b = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j++) { const c = B[j], d = B[(j + 1) % B.length]; if (segCross(a, b, c, d)) return true; }
  }
  return false;
}
const srgb2lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

// ============================================================================================
export async function fillMissingBuildings({ S, parcels, aerialPath, aerialBounds, C, demRect, w2, env }) {
  const out = (S.buildings || []).slice();
  const notes = [];
  if (!parcels || !parcels.length) { notes.push('no parcels.json — fill skipped'); return { buildings: out, added: 0, notes: notes.join('; ') }; }

  // ENU footprint -> world XZ ring for the existing buildings (centroids for the empty-lot test,
  // full rings for the de-dup overlap test). w2 maps ENU(e,n) -> world(X,Z).
  const enuToWorldRing = (p) => p.map(([e, n]) => w2(e, n));
  const worldToEnu = (X, Z) => [X + C[0], C[1] - Z];   // inverse of w2
  const existingRings = (S.buildings || []).filter(b => b.p && b.p.length >= 3).map(b => enuToWorldRing(b.p));
  const existingCentroids = existingRings.map(centroid);
  const existingHeights = (S.buildings || []).filter(b => b.h).map(b => b.h);
  const medianH = existingHeights.length
    ? existingHeights.slice().sort((a, b) => a - b)[Math.floor(existingHeights.length / 2)]
    : DEFAULT_H;
  const defH = Math.min(8, Math.max(4, medianH || DEFAULT_H));

  // A parcel is "empty" if no existing building footprint covers it: neither an existing centroid
  // sits inside the parcel ring, nor the parcel centroid inside an existing footprint (handles big
  // lots whose building centroid drifts off the parcel, and tiny parcels under a big building).
  const parcelHasBuilding = (ring, pc) => {
    for (const bc of existingCentroids) if (inPoly(bc[0], bc[1], ring)) return true;
    for (const br of existingRings) if (inPoly(pc[0], pc[1], br)) return true;
    return false;
  };

  // ---- aerial decode + samplers -----------------------------------------------------------
  const { E0, E1, Nt, Nb } = aerialBounds;
  const { data: aer, info } = await sharp(aerialPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const AW = info.width, AH = info.height;
  const worldToAerialPx = (X, Z) => {
    const e = X + C[0], n = C[1] - Z;
    const u = (e - E0) / (E1 - E0), v = (Nt - n) / (Nt - Nb);
    let px = Math.floor(u * AW), py = Math.floor(v * AH);
    if (px < 0) px = 0; else if (px >= AW) px = AW - 1;
    if (py < 0) py = 0; else if (py >= AH) py = AH - 1;
    return [px, py];
  };
  // Classify ONE world point as roof-like. A roof here is a built surface that is NOT vegetation-
  // green, NOT deep shadow/asphalt-dark, NOT pool/water, and — critically — NOT BRIGHT TAN bare
  // earth / dry-grass (the CA-hill straw signature, which otherwise reads as "roof" and spawns
  // phantom houses on open fields). Calibrated against real roofs (neutral-gray composition shingle:
  // sat≈0.08, luma≈0.35; gray-blue/terracotta: red-dominant, luma≤0.35) vs dirt/dry-grass (bright
  // tan r>g>b ramp, luma>0.45, sat>0.3). Light-gray driveways still pass, but the BLOB-area and
  // lot-fraction gates downstream reject lone driveways/patios (no house-sized contiguous blob).
  const isRoofPx = (X, Z) => {
    const [px, py] = worldToAerialPx(X, Z); const o = (py * AW + px) * 3;
    const r = srgb2lin(aer[o]), g = srgb2lin(aer[o + 1]), b = srgb2lin(aer[o + 2]);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx <= 0 ? 0 : (mx - mn) / mx;
    const greenDom = g - Math.max(r, b);
    if (greenDom > 0.015) return false;                 // vegetation (lawn/canopy) — not roof
    if (luma < 0.045) return false;                     // deep shadow / wet asphalt — not roof
    if (b > r && b > g && (b - Math.max(r, g)) > 0.10) return false; // pool/water — not roof
    // BRIGHT TAN bare earth / dry-grass: a monotone r>g>b ramp that is both bright and saturated.
    // Real roofs are either near-neutral (low sat) or not this bright; this rejects open fields.
    if (r > g && g > b && (r - b) > 0.18 && luma > 0.40 && sat > 0.30) return false;
    return true;                                        // gray / muted-tan / terracotta built surface
  };

  // For an empty parcel, rasterize its interior on a regular grid (cells of SAMPLE_STEP m), mark
  // roof-like cells, then find the largest 4-connected roof blob. If that blob is house-sized and
  // covers enough of the lot, fit an oriented rectangle to it.
  function detectRoofRect(ring) {
    const bb = bbox(ring);
    const nx = Math.max(1, Math.ceil((bb.x1 - bb.x0) / SAMPLE_STEP));
    const nz = Math.max(1, Math.ceil((bb.z1 - bb.z0) / SAMPLE_STEP));
    if (nx * nz > 400000) return null;                  // guard pathological huge parcels
    const cell = (i, j) => [bb.x0 + (i + 0.5) * SAMPLE_STEP, bb.z0 + (j + 0.5) * SAMPLE_STEP];
    // 0 = outside lot, 1 = inside-lot non-roof, 2 = inside-lot roof. Keep the roof search a touch
    // inside the lot line so a neighbor's roof bleeding over the boundary doesn't seed a false blob.
    const shrunk = insetRing(ring, ROOF_INSET_FROM_LOT) || ring;
    const grid = new Uint8Array(nx * nz);
    let lotCells = 0, roofCells = 0;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const [X, Z] = cell(i, j);
      if (!inPoly(X, Z, ring)) continue;
      lotCells++;
      if (inPoly(X, Z, shrunk) && isRoofPx(X, Z)) { grid[j * nx + i] = 2; roofCells++; }
      else grid[j * nx + i] = 1;
    }
    if (!lotCells) return null;
    const lotArea = lotCells * SAMPLE_STEP * SAMPLE_STEP;
    // Big lots: a real house is only a small fraction of the lot, so the lot-fraction gate is the
    // wrong test there — rely on the absolute roof-BLOB-area gate below. Small lots keep the
    // fraction gate to reject bare/yard parcels.
    const fillMin = lotArea > 1200 ? 0 : ROOF_FILL_MIN;
    if (roofCells / lotCells < fillMin) return null;             // mostly yard/asphalt — not a house
    // morphological CLOSE: heal 1-cell gaps in the roof mask (tree-canopy limbs split one real roof
    // into sub-blobs) by promoting an in-lot non-roof cell with >=2 roof neighbours to roof. Edge
    // cells have <2 roof neighbours so the outer boundary stays ~intact while interior holes fill.
    const closed = grid.slice();
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i; if (grid[k] !== 1) continue;
      let rn = 0;
      if (i > 0 && grid[k - 1] === 2) rn++; if (i < nx - 1 && grid[k + 1] === 2) rn++;
      if (j > 0 && grid[k - nx] === 2) rn++; if (j < nz - 1 && grid[k + nx] === 2) rn++;
      if (rn >= 2) closed[k] = 2;
    }
    // largest 4-connected component of roof cells (iterative flood fill) on the CLOSED mask
    const seen = new Uint8Array(nx * nz);
    let best = null, bestN = 0;
    const stack = [];
    for (let s = 0; s < grid.length; s++) {
      if (closed[s] !== 2 || seen[s]) continue;
      stack.length = 0; stack.push(s); seen[s] = 1;
      const comp = [];
      while (stack.length) {
        const k = stack.pop(); comp.push(k);
        const ci = k % nx, cj = (k / nx) | 0;
        const nbrs = [k - 1, k + 1, k - nx, k + nx];
        if (ci === 0) nbrs[0] = -1; if (ci === nx - 1) nbrs[1] = -1;
        for (const m of nbrs) { if (m < 0 || m >= closed.length || seen[m] || closed[m] !== 2) continue; seen[m] = 1; stack.push(m); }
      }
      if (comp.length > bestN) { bestN = comp.length; best = comp; }
    }
    if (!best) return null;
    const cellArea = SAMPLE_STEP * SAMPLE_STEP;
    if (bestN * cellArea < ROOF_BLOB_MIN) return null;           // blob too small to be a house
    // fit an oriented bounding rect to the blob, but ORIENT to the lot's long axis (street frontage
    // follows the parcel), and SIZE to the blob extent along that axis, clipped to the lot + inset.
    const pts = best.map(k => cell(k % nx, (k / nx) | 0));
    // prefer the roof blob's OWN axis when it's decisively elongated; else the (edge-weighted) lot axis
    const blob = pcaAxis(pts);
    const ang = blob.ratio > 1.4 ? blob.angle : lotLongAxisAngle(ring);
    return fitOrientedRect(pts, ang, ring);
  }

  // long-axis orientation of the lot (angle of the parcel's dominant edge direction via PCA on
  // the ring vertices) — inferred houses face along this so they parallel the street frontage.
  function lotLongAxisAngle(ring) {
    // length-weighted dominant edge direction (doubled-angle so opposite edges agree). Weighting by
    // EDGE LENGTH (not vertex count) stops a densely-tessellated curved/clipped boundary — common on
    // across-the-street frontages — from hijacking the axis and rotating the house to a weird angle.
    let sx = 0, sy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const dx = ring[i][0] - ring[j][0], dz = ring[i][1] - ring[j][1];
      const len = Math.hypot(dx, dz); if (len < 1e-6) continue;
      const a = Math.atan2(dz, dx);
      sx += len * Math.cos(2 * a); sy += len * Math.sin(2 * a);
    }
    return 0.5 * Math.atan2(sy, sx);
  }
  // principal axis of the roof-blob point cloud -> { angle, ratio = major/minor eigenvalue }. A
  // decisively elongated blob knows its own orientation better than a possibly-irregular parcel ring.
  function pcaAxis(pts) {
    if (!pts || pts.length < 3) return { angle: 0, ratio: 1 };
    let mx = 0, mz = 0; for (const [x, z] of pts) { mx += x; mz += z; } mx /= pts.length; mz /= pts.length;
    let sxx = 0, sxz = 0, szz = 0;
    for (const [x, z] of pts) { const dx = x - mx, dz = z - mz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
    const n = pts.length; sxx /= n; sxz /= n; szz /= n;
    const tr = sxx + szz, disc = Math.sqrt(Math.max(0, tr * tr / 4 - (sxx * szz - sxz * sxz)));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    return { angle: 0.5 * Math.atan2(2 * sxz, sxx - szz), ratio: l2 > 1e-6 ? l1 / l2 : Infinity };
  }
  // fit an axis-aligned (in the rotated frame) rect to point cloud `pts`, rotated by `ang`, then
  // inset and clip to the lot. Returns { ringWorld, rect:[cx,cz,w,d,degCompassFromN] } or null.
  function fitOrientedRect(pts, ang, lotRing) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, ux = 0, uz = 0;
    for (const [x, z] of pts) {
      const u = x * ca + z * sa, v = -x * sa + z * ca;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; ux += x; uz += z;
    }
    let w = (u1 - u0) - 2 * INSET, d = (v1 - v0) - 2 * INSET;
    if (w < 3 || d < 3) return null;                            // degenerate after inset
    if (w * d > 300) return null;                               // reject oversized INFERRED footprints —
                                                                // real houses are <300m², so big blobs are
                                                                // church/parking/shadow phantoms, not buildings.
                                                                // (real OSM buildings bypass this path entirely)
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const cx = cu * ca - cv * sa, cz = cu * sa + cv * ca;        // rect center back in world XZ
    // build the 4 corners in world XZ
    const hw = w / 2, hd = d / 2;
    const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lu, lv]) => {
      const wu = cu + lu, wv = cv + lv;
      return [wu * ca - wv * sa, wu * sa + wv * ca];
    });
    // keep it inside the lot: if a corner pokes out, fall back to clipping the rect to the lot ring
    let ringWorld = corners;
    if (corners.some(([x, z]) => !inPoly(x, z, lotRing))) {
      const clipped = clipConvexToRing(corners, lotRing);
      if (!clipped || clipped.length < 3 || ringArea(clipped) < ROOF_BLOB_MIN * 0.6) return null;
      ringWorld = clipped;
    }
    // roofRect in ENU for building_layer's pitched-roof shell: [cx_enu, cy_enu, w, d, deg].
    // deg is the rect's heading; building_layer rotates by deg*π/180 in ENU. ENU axes are e=+X,
    // n=-Z, so a world-XZ angle `ang` (from +X toward +Z) maps to ENU heading -ang.
    const [ecx, ecy] = worldToEnu(cx, cz);
    const deg = (-ang) * 180 / Math.PI;
    const rect = [ecx, ecy, w, d, deg];
    return { ringWorld, rect };
  }

  // clip a convex polygon to the (possibly non-convex) lot ring by Sutherland–Hodgman against the
  // lot's bbox is too coarse; instead intersect by sampling — but simplest robust approach: clip
  // corners to lot via per-edge nudging. Here we just clip to the lot's bbox-inset rectangle, which
  // keeps the footprint on the lot in practice (lots are near-rectangular). Returns a ring.
  function clipConvexToRing(poly, lotRing) {
    const bb = bbox(lotRing);
    const rect = { x0: bb.x0 + INSET, x1: bb.x1 - INSET, z0: bb.z0 + INSET, z1: bb.z1 - INSET };
    return clipPolyToRect(poly, rect);
  }

  // inset a ring toward its centroid by `d` meters (cheap scale-toward-centroid; fine for ~convex
  // residential lots). Used only to keep the roof search off the lot line.
  function insetRing(ring, d) {
    const c = centroid(ring);
    const out = ring.map(([x, z]) => {
      const dx = x - c[0], dz = z - c[1], L = Math.hypot(dx, dz) || 1;
      const k = Math.max(0, (L - d) / L);
      return [c[0] + dx * k, c[1] + dz * k];
    });
    return ringArea(out) > 1 ? out : null;
  }

  // road centerlines (world XZ polylines + half-width) for a "don't sit in the road" guard: an
  // inferred footprint whose centroid lands within a road's half-width is on the carriageway (flag-
  // lot driveway or a parcel abutting a narrow alley) — drop it so no house spawns in the street.
  const roadLines = (S.roads || []).map(rd => ({ pts: (rd.p || []).map(([e, n]) => w2(e, n)), hw: Math.max(1.2, (rd.w || 6) / 2) }))
    .filter(r => r.pts.length >= 2);
  const distToSeg = (p, a, b) => {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy || 1)));
    return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
  };
  const centroidOnRoad = (ring) => {
    const c = centroid(ring);
    for (const rl of roadLines) for (let i = 0; i + 1 < rl.pts.length; i++) if (distToSeg(c, rl.pts[i], rl.pts[i + 1]) < rl.hw) return true;
    return false;
  };

  // ---- 1) + 2) aerial-driven fill over empty parcels --------------------------------------
  const inRect = (pc) => pc[0] >= demRect.x0 && pc[0] <= demRect.x1 && pc[1] >= demRect.z0 && pc[1] <= demRect.z1;
  const inferredRings = [];       // world-XZ rings already added (for inter-fill de-dup)
  let emptyLots = 0, addedAerial = 0;
  for (const par of parcels) {
    if (!par.ring || par.ring.length < 3) continue;
    const ring = par.ring;
    const area = ringArea(ring);
    if (area < MIN_LOT_AREA || area > MAX_LOT_AREA) continue;
    const pc = centroid(ring);
    if (!inRect(pc)) continue;
    if (parcelHasBuilding(ring, pc)) continue;
    emptyLots++;
    let fit; try { fit = detectRoofRect(ring); } catch { fit = null; }
    if (!fit) continue;
    // de-dup vs existing + already-inferred
    if (existingRings.some(br => polysOverlap(fit.ringWorld, br))) continue;
    if (inferredRings.some(ir => polysOverlap(fit.ringWorld, ir))) continue;
    if (centroidOnRoad(fit.ringWorld)) continue;        // never spawn a house in the carriageway
    // clip to DEM rect (so a lot straddling the edge still contributes its in-rect part)
    const clipped = clipPolyToRect(fit.ringWorld, demRect);
    if (!clipped || clipped.length < 3 || ringArea(clipped) < ROOF_BLOB_MIN * 0.5) continue;
    inferredRings.push(clipped);
    out.push({
      p: clipped.map(([X, Z]) => worldToEnu(X, Z)),  // ENU footprint, scene-building shape
      h: defH,
      r: [fit.rect],                                  // single oriented roofRect -> pitched roof
      source: 'inferred-aerial',
    });
    addedAerial++;
  }
  notes.push(`aerial: ${emptyLots} empty lots, ${addedAerial} filled`);

  // ---- 3) optional Mapbox building footprints over the patch ------------------------------
  let addedMapbox = 0;
  const token = (env && (env.NEXT_PUBLIC_MAPBOX_TOKEN || env.VITE_MAPBOX_TOKEN || env.MAPBOX_TOKEN)) || '';
  if (token) {
    try {
      const mres = await fillFromMapbox({ token, S, C, demRect, w2, worldToEnu, existingRings, inferredRings, defH });
      for (const b of mres.buildings) { out.push(b); inferredRings.push(enuToWorldRing(b.p)); }
      addedMapbox = mres.buildings.length;
      notes.push(`mapbox: +${addedMapbox} (${mres.note})`);
    } catch (e) {
      notes.push(`mapbox skipped: ${e.message}`);
    }
  } else {
    notes.push('mapbox skipped: no NEXT_PUBLIC_MAPBOX_TOKEN');
  }

  return { buildings: out, added: addedAerial + addedMapbox, notes: notes.join('; ') };
}

// ---- Mapbox mapbox-streets-v8 `building` layer over the DEM patch --------------------------
// Decodes vector tiles (pattern from src/engine/nav/mapbox-roads.js), reprojects footprints to the
// flat-ENU frame, de-dups against existing + aerial-inferred, and returns scene-shaped buildings.
async function fillFromMapbox({ token, S, C, demRect, w2, worldToEnu, existingRings, inferredRings, defH }) {
  const { VectorTile } = await import('@mapbox/vector-tile');
  const Pbf = (await import('pbf')).default || (await import('pbf')).PbfReader;
  const ORIGIN = S.origin || {};
  const LAT0 = Number.isFinite(+ORIGIN.lat) ? +ORIGIN.lat : 37.6835313;
  const LON0 = Number.isFinite(+ORIGIN.lon) ? +ORIGIN.lon : -122.0686199;
  const COSLAT = Math.cos(LAT0 * Math.PI / 180);
  // flat-ENU forward (lon/lat -> e/n), then ENU -> world XZ via w2.
  const lonLatToWorld = (lon, lat) => {
    const e = (lon - LON0) * COSLAT * 111320;
    const n = (lat - LAT0) * 110540;
    return w2(e, n);
  };
  // DEM rect corners -> lon/lat to find the tile range. Inverse of lonLatToWorld via ENU.
  const worldToLonLat = (X, Z) => {
    const e = X + C[0], n = C[1] - Z;
    return [LON0 + e / (COSLAT * 111320), LAT0 + n / 110540];
  };
  const corners = [[demRect.x0, demRect.z0], [demRect.x1, demRect.z0], [demRect.x1, demRect.z1], [demRect.x0, demRect.z1]].map(([X, Z]) => worldToLonLat(X, Z));
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const [lon, lat] of corners) { if (lon < west) west = lon; if (lon > east) east = lon; if (lat < south) south = lat; if (lat > north) north = lat; }
  const Z = 16;
  const lon2tx = (lon) => Math.floor((lon + 180) / 360 * 2 ** Z);
  const lat2ty = (lat) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** Z); };
  const tx0 = lon2tx(west), tx1 = lon2tx(east), ty0 = lat2ty(north), ty1 = lat2ty(south);
  const tiles = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) tiles.push({ x: tx, y: ty, z: Z });
  if (tiles.length > 24) tiles.length = 24;             // patch is small; cap fetches

  const inRect = (X, Z2) => X >= demRect.x0 && X <= demRect.x1 && Z2 >= demRect.z0 && Z2 <= demRect.z1;
  const centroidOf = (r) => { let x = 0, z = 0; for (const [a, b] of r) { x += a; z += b; } return [x / r.length, z / r.length]; };
  const buildings = [];
  let fetched = 0;
  for (const t of tiles) {
    const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/${t.z}/${t.x}/${t.y}.mvt?access_token=${encodeURIComponent(token)}`;
    let buf;
    try {
      const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 8000);
      const resp = await fetch(url, { signal: ac.signal }).finally(() => clearTimeout(to));
      if (resp.status === 404) continue;
      if (!resp.ok) throw new Error(`tile ${resp.status}`);
      buf = new Uint8Array(await resp.arrayBuffer());
    } catch (e) { if (!fetched) throw e; else continue; }
    fetched++;
    const vt = new VectorTile(new Pbf(buf));
    const layer = vt.layers.building;
    if (!layer) continue;
    const extent = layer.extent || 4096;
    const n = 2 ** t.z;
    const tilePtToWorld = (px, py) => {
      const lon = ((t.x + px / extent) / n) * 360 - 180;
      const my = (t.y + py / extent) / n;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180 / Math.PI;
      return lonLatToWorld(lon, lat);
    };
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== 3) continue;                       // polygons only
      for (const ringPx of f.loadGeometry()) {
        const ringW = ringPx.map(p => tilePtToWorld(p.x, p.y));
        if (ringW.length < 3) continue;
        const c = centroidOf(ringW);
        if (!inRect(c[0], c[1])) continue;
        if (existingRings.some(br => polysOverlap(ringW, br))) continue;
        if (inferredRings.some(ir => polysOverlap(ringW, ir))) continue;
        if (buildings.some(b => polysOverlap(ringW, b.p.map(([e, nn]) => w2(e, nn))))) continue;
        const a = ringArea(ringW);
        if (a < 30 || a > 4000) continue;
        buildings.push({ p: ringW.map(([X, Z2]) => worldToEnu(X, Z2)), h: defH, source: 'mapbox' });
      }
    }
  }
  return { buildings, note: `${fetched}/${tiles.length} tiles` };
}
