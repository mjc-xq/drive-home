// dem_road_grade.mjs — flatten the RAW 1 m DEM heightfield UNDER road corridors BEFORE the
// terrain mesh is built, so undulations under a road no longer read as bumps the player
// walks/drives over.
//
// The single-surface pipeline paints roads as TEXTURES onto the terrain (terrain_mesh.mjs).
// The terrain itself is the raw 1 m DEM, so any high-frequency chatter in the DEM under a
// road is a real bump in the geometry/collision. This module GRADES (smooths) the DEM along
// each road centreline: it low-passes the longitudinal height profile to kill 1–2 m chatter
// while PRESERVING the slow real grade (canyon climbs ~118 m across the patch — we never
// flatten to a mean, never create a cliff at the corridor edge), then blends each affected
// DEM cell toward that smoothed profile with a shoulder falloff that ties cleanly into the
// surrounding terrain (full effect in the lane, zero at the shoulder edge).
//
// Because buildTerrainMesh reads D.h via makeGeo's demHeight to build BOTH the visual verts
// and the collision/foot-placement, mutating D.h here (before makeGeo/buildTerrainMesh) keeps
// visual == collision == foot-placement BY CONSTRUCTION.
//
// Frame note: we mirror terrain_mesh.mjs makeGeo's EXACT world<->lat/lon<->grid math so the
// sampler/writer agree with the mesh the exporter will build:
//   e = X + C[0]; n = C[1] - Z; lat = LAT0 + n/110540; lon = LON0 + e/(COSLAT*111320);
//   fi = (lon - D.lonW)/(D.lonE - D.lonW)*cols - 0.5; fj = (D.latN - lat)/(D.latN - D.latS)*rows - 0.5;

import { clipPolylineToBox, smoothLine, roadSpec } from '../road_prep.mjs';

const smoothstep = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

// Grade the DEM under every non-service road. Mutates D.h in place. Returns stats.
//   D       : loadDEM result (D.h flat rows*cols, D.cols, D.rows, D.lonW/E, D.latN/S)
//   C       : scene.center [e0, n0]
//   LAT0/LON0/COSLAT : the exporter's flat-ENU origin (same values passed to makeGeo)
//   roads   : scene.roads (raw ENU [e,n] polylines + class r.k / subtype r.s)
//   w2      : ENU->world (e,n)->[X,Z], identical to the exporter's w2
//   opts    : { shoulder, crownDrop, smoothPasses, stationStep, maxCutFill }  (all overridable)
export function gradeDemUnderRoads({ D, C, LAT0, LON0, COSLAT, roads, w2, opts = {} }) {
  const SHOULDER = opts.shoulder ?? 2.5;        // m of blend margin beyond the carriageway edge
  const CROWN_DROP = opts.crownDrop ?? 0.12;    // m the carriageway crowns down at the lane edge
  const SMOOTH_PASSES = opts.smoothPasses ?? 10;// longitudinal low-pass iterations (kills chatter)
  const STATION_STEP = opts.stationStep ?? 2.0; // m between centreline stations
  const MAX_CUTFILL = opts.maxCutFill ?? 2.5;   // clamp |target - rawH| so a bad sample can't gouge

  const { cols, rows, h } = D;
  const dLat = D.latN - D.latS, dLon = D.lonE - D.lonW;
  if (!Array.isArray(roads) || !cols || !rows || !Array.isArray(h)) {
    return { cellsModified: 0, maxCut: 0, maxFill: 0, corridors: 0 };
  }

  // --- world<->DEM mappings (mirror makeGeo) -----------------------------------------
  // bilinear DEM height at world (X,Z) on the RAW field (clamped indices).
  const demHeight = (X, Z) => {
    const e = X + C[0], n = C[1] - Z;
    const lat = LAT0 + n / 110540, lon = LON0 + e / (COSLAT * 111320);
    let fi = (lon - D.lonW) / dLon * cols - 0.5, fj = (D.latN - lat) / dLat * rows - 0.5;
    fi = Math.max(0, Math.min(cols - 1.001, fi)); fj = Math.max(0, Math.min(rows - 1.001, fj));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
    const a = h[j * cols + i], b = h[j * cols + i + 1], c = h[(j + 1) * cols + i], d = h[(j + 1) * cols + i + 1];
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  };
  // world XZ of DEM cell centre (i,j) — the exact inverse used to address each cell we write.
  const cellWorld = (i, j) => {
    const lon = D.lonW + (i + 0.5) / cols * dLon;
    const lat = D.latN - (j + 0.5) / rows * dLat;
    const e = (lon - LON0) * COSLAT * 111320, n = (lat - LAT0) * 110540;
    return [e - C[0], -(n - C[1])];
  };

  // DEM world rect + a comfortable clip half (square) so centrelines are trimmed to the field.
  const cMin = cellWorld(0, 0), cMax = cellWorld(cols - 1, rows - 1);
  const Xmin = Math.min(cMin[0], cMax[0]), Xmax = Math.max(cMin[0], cMax[0]);
  const Zmin = Math.min(cMin[1], cMax[1]), Zmax = Math.max(cMin[1], cMax[1]);
  const clipHalf = Math.max(Math.abs(Xmin), Math.abs(Xmax), Math.abs(Zmin), Math.abs(Zmax)) + 5;

  // --- 1) build smoothed, graded corridors -------------------------------------------
  // Each corridor: { stations:[{x,z,s,grade}], halfWidth, reach } where grade(s) is the
  // low-passed longitudinal height. We also collect every station segment into a spatial
  // grid keyed by world cell so the per-DEM-cell nearest-segment search is local, not O(N).
  const corridors = [];
  const segments = [];   // { ci, x0,z0,x1,z1, s0,s1, g0,g1 }  (ci -> corridor index)

  for (const r of roads) {
    const spec = roadSpec(r);
    if (spec.isService) continue;                          // skip service/driveway/parking_aisle/alley
    const pl = r.p || r;
    if (!Array.isArray(pl) || pl.length < 2) continue;

    const lw = pl.map(([e, n]) => w2(e, n));               // ENU -> world XZ
    const pieces = clipPolylineToBox(lw, clipHalf);        // trim to DEM rect
    const halfWidth = spec.width / 2;
    const reach = halfWidth + SHOULDER;

    for (let piece of pieces) {
      piece = smoothLine(piece, { lo: 6, hi: 135 });        // de-jitter (same gate as the paint network)
      if (piece.length < 2) continue;

      // resample to ~STATION_STEP stations along the smoothed centreline
      const stations = [];
      let s = 0;
      stations.push({ x: piece[0][0], z: piece[0][1], s: 0 });
      for (let k = 1; k < piece.length; k++) {
        const a = piece[k - 1], b = piece[k];
        const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (segLen < 1e-6) continue;
        const n = Math.max(1, Math.ceil(segLen / STATION_STEP));
        for (let q = 1; q <= n; q++) {
          const t = q / n;
          s += segLen / n;
          stations.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, s });
        }
      }
      if (stations.length < 2) continue;

      // sample the RAW DEM at each station, then LOW-PASS that 1-D profile.
      const prof = stations.map(st => demHeight(st.x, st.z));
      // Iterative Laplacian moving-average (interior only) — endpoints pinned so the corridor
      // ties into the un-graded terrain beyond its ends. This removes 1–2 m chatter but, being a
      // local average, leaves the SLOW trend (e.g. a steady canyon climb) essentially intact.
      for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
        const next = prof.slice();
        for (let k = 1; k < prof.length - 1; k++) next[k] = (prof[k - 1] + 2 * prof[k] + prof[k + 1]) / 4;
        for (let k = 1; k < prof.length - 1; k++) prof[k] = next[k];
      }
      for (let k = 0; k < stations.length; k++) stations[k].grade = prof[k];

      const ci = corridors.length;
      corridors.push({ stations, halfWidth, reach });
      for (let k = 1; k < stations.length; k++) {
        const a = stations[k - 1], b = stations[k];
        segments.push({ ci, x0: a.x, z0: a.z, x1: b.x, z1: b.z, s0: a.s, s1: b.s, g0: a.grade, g1: b.grade });
      }
    }
  }

  if (!segments.length) return { cellsModified: 0, maxCut: 0, maxFill: 0, corridors: 0 };

  // --- 2) spatial grid (uniform buckets) of corridor segments ------------------------
  // Bucket size = a generous corridor reach so a cell only tests segments in its own + the 8
  // neighbouring buckets. Keeps the per-cell search local (≈O(cells), not O(cells*segments)).
  const maxReach = corridors.reduce((m, c) => Math.max(m, c.reach), 0);
  const GRID = Math.max(8, maxReach + STATION_STEP);
  const gw = Math.max(1, Math.ceil((Xmax - Xmin) / GRID) + 1);
  const gh = Math.max(1, Math.ceil((Zmax - Zmin) / GRID) + 1);
  const buckets = new Array(gw * gh);
  const bIdx = (cx, cz) => cz * gw + cx;
  const cellOf = (x, z) => [
    Math.max(0, Math.min(gw - 1, Math.floor((x - Xmin) / GRID))),
    Math.max(0, Math.min(gh - 1, Math.floor((z - Zmin) / GRID))),
  ];
  for (let si = 0; si < segments.length; si++) {
    const sg = segments[si];
    const [ax, az] = cellOf(Math.min(sg.x0, sg.x1), Math.min(sg.z0, sg.z1));
    const [bx, bz] = cellOf(Math.max(sg.x0, sg.x1), Math.max(sg.z0, sg.z1));
    for (let cz = az; cz <= bz; cz++) for (let cx = ax; cx <= bx; cx++) {
      const k = bIdx(cx, cz); (buckets[k] || (buckets[k] = [])).push(si);
    }
  }

  // nearest corridor segment to a world point: returns { dperp, ci, target } or null.
  // target = grade(station) interpolated along the segment + crown(dperp).
  const nearest = (x, z) => {
    const [cx, cz] = cellOf(x, z);
    let best = null;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= gw || nz >= gh) continue;
      const bs = buckets[bIdx(nx, nz)];
      if (!bs) continue;
      for (const si of bs) {
        const sg = segments[si];
        const ex = sg.x1 - sg.x0, ez = sg.z1 - sg.z0;
        const L2 = ex * ex + ez * ez || 1;
        let t = ((x - sg.x0) * ex + (z - sg.z0) * ez) / L2;
        t = Math.max(0, Math.min(1, t));
        const px = sg.x0 + t * ex, pz = sg.z0 + t * ez;
        const dperp = Math.hypot(x - px, z - pz);
        const reach = corridors[sg.ci].reach;
        if (dperp > reach) continue;
        if (!best || dperp < best.dperp) {
          const grade = sg.g0 + (sg.g1 - sg.g0) * t;
          best = { dperp, ci: sg.ci, grade };
        }
      }
    }
    return best;
  };

  // --- 3) write each DEM cell toward grade(s) with a shoulder-falloff blend -----------
  let cellsModified = 0, maxCut = 0, maxFill = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const [x, z] = cellWorld(i, j);
      const near = nearest(x, z);
      if (!near) continue;
      const { dperp, ci } = near;
      const { halfWidth, reach } = corridors[ci];

      // crown: carriageway dips slightly toward its edges (water-shedding crown). Zero at the
      // centreline, -CROWN_DROP at the lane edge; capped at the lane so the shoulder doesn't dip.
      const inLane = Math.min(dperp, halfWidth) / halfWidth;
      const crown = -CROWN_DROP * inLane * inLane;
      let target = near.grade + crown;

      const idx = j * cols + i;
      const rawH = h[idx];
      // clamp the cut/fill so a single bad sample can't gouge a trench/ridge.
      const delta = Math.max(-MAX_CUTFILL, Math.min(MAX_CUTFILL, target - rawH));
      target = rawH + delta;

      // weight: 1 inside the carriageway, smoothstep down to 0 at the shoulder edge -> the graded
      // profile fully owns the lane and feathers to ZERO at reach, so there is NO cliff at the edge.
      let w;
      if (dperp <= halfWidth) w = 1;
      else w = 1 - smoothstep((dperp - halfWidth) / (reach - halfWidth));
      if (w <= 0) continue;

      const newH = rawH * (1 - w) + target * w;
      if (newH === rawH) continue;
      h[idx] = newH;
      cellsModified++;
      const d = newH - rawH;
      if (d < 0) { if (-d > maxCut) maxCut = -d; }
      else if (d > maxFill) maxFill = d;
    }
  }

  return { cellsModified, maxCut, maxFill, corridors: corridors.length };
}
