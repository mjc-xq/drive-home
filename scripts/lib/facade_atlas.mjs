// facade_atlas.mjs — pack REAL Street-View building facades into RGB atlas page(s), phased by a
// px/m quality gate. The caller (building_layer.mjs) draws each packed crop as a TOGGLEABLE
// overlay quad PROUD of an always-present windowed-stucco wall (so photo mode can be turned OFF
// and the windowed wall shows underneath) — this module just selects + packs; it does NOT decide
// the wall texture. SELECTION IS FULLY DETERMINISTIC: buildings scanned by ascending index, walls
// by ascending edge index, equal-size crops tiebroken on the stable wall key — so dahill produces
// the same ~700-wall hero set, identically, every run.
//
// WHY: EVERY in-patch building that carries an SV wall crop clearing `minPxPerM` gets a real photo
// facade overlay (not just the owner house + a few near neighbours) — the crops pack into AS MANY
// 4096 atlas pages as needed. Any wall below the gate, and any building off the terrain patch, gets
// no overlay (the windowed stucco wall is what shows). We never ship a melty photo: the gate -> no
// overlay -> the windowed stucco wall reads instead.
//
// ROOF BLEED (PROBLEM 1): the SV crops claim 'wall-only-ground-to-eave' but fetch_sv_facades.py
// crops the top using the UNRELIABLE OSM wallH, so when wallH is overestimated the crop's TOP
// still contains roof/eave/sky. Since we build our OWN 3D roof, that photo-roof would show on the
// wall (a double roof). FIX: we TRIM the top ROOF_TRIM fraction of every source crop before
// packing, so ONLY pure wall maps onto the wall quad. The built roof + eave overhang covers the
// lost sliver of wall-top. We shift the recorded crop_v[0] down by the same fraction so the band
// the exporter thinks it captured matches the trimmed photo.
//
// HOW: crops are SHELF-PACKED (skyline rows, tall-first) into one or a few RGB atlas pages
// composited with sharp, each resized to a hero texels-per-metre so the wall is crisp. The
// returned rectByWall maps 'b{building}_e{edge}' -> { page, u0,v0,u1,v1 }; building_layer.mjs draws
// a SEPARATE overlay quad for that wall with UVs in the sub-rect (V: eave=v0/top -> ground=v1/bottom,
// matching the crop's own ground-to-eave layout, so NO roof band shows) into node SVFacade_page{N}
// with material FacadeAtlasOverlay_page{N}_mat. heroBuildings (returned) is the set of buildings
// that got >=1 packed crop — the caller only emits an overlay when its building is in that set, so
// it must list every facade'd building.

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const GUTTER = 2;          // px of empty space around each packed rect (anti-bleed)
const HERO_PX_PER_M = 128; // target texels/metre on a hero wall (crisp; clamped per-wall below)
const MAX_RECT = 2048;     // cap a single packed crop's long side so one wall can't blow a page
const ROOF_TRIM = 0.18;    // drop the top 18% of each source crop (roof/eave/sky bleed from the
                           // unreliable OSM wallH); only pure wall is packed onto the wall quad.

// ---- shelf (skyline-row) bin packer ----------------------------------------------------
// Sort rects tall->short, lay them left->right on a shelf; a rect that won't fit the row starts
// a new shelf at the row's max height; when the page runs out of vertical room, open a NEW page.
// Deterministic, no rotation — good enough for facade crops. Mirrors scripts/atlas_facades.mjs.
function packRects(rects, pageSize, gutter) {
  const pages = [];          // each: { placements: [{rect, x, y}] }
  let page = null, shelfX = 0, shelfY = 0, shelfH = 0;
  const newPage = () => { page = { placements: [] }; pages.push(page); shelfX = 0; shelfY = 0; shelfH = 0; };
  newPage();
  for (const rect of rects) {
    const w = rect.w + gutter, h = rect.h + gutter;   // reserve a gutter on right+bottom
    if (shelfX + w > pageSize) { shelfX = 0; shelfY += shelfH; shelfH = 0; }   // next shelf
    if (shelfY + h > pageSize) newPage();                                       // next page
    page.placements.push({ rect, x: shelfX + gutter, y: shelfY + gutter });    // gutter on left+top
    shelfX += w;
    if (h > shelfH) shelfH = h;
  }
  return pages;
}

const centroidEN = (p) => p.reduce((a, q) => [a[0] + q[0] / p.length, a[1] + q[1] / p.length], [0, 0]);
const inRect = (x, z, r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;

/**
 * Bake Street-View facade crops into RGB atlas page(s). See file header for the contract.
 * EVERY in-demRect building with an SV crop that clears the px/m gate gets a real photo facade;
 * walls below the gate, and buildings off the patch, are intentionally absent from rectByWall
 * (the caller applies procedural stucco there). heroBuildings (returned) lists exactly the
 * buildings that ended up with >=1 packed crop, so the caller knows which buildings to facade.
 *
 * `heroRadius`/`heroCap` are accepted for back-compat but no longer restrict coverage to near the
 * house — they're ignored. The owner house is always eligible; everything else just needs to be
 * inside demRect with a usable crop.
 */
export async function bakeFacadeAtlas({
  buildings, svWalls, svDir, houseIndex, demRect, w2,
  minPxPerM = 40, heroRadius = 90, heroCap = 16, pageSize = 4096, outDir,
}) {
  mkdirSync(outDir, { recursive: true });

  // 1) COVERAGE: facade EVERY building that carries >=1 SV wall crop AND whose footprint centroid
  //    is inside demRect (off-patch buildings aren't reachable/visible — leave them stucco). No
  //    near-house radius or cap: we want as many real photo facades as the crops + gate allow.
  const wallsByB = new Map();                               // building index -> [wall,...]
  for (const wall of svWalls) {
    if (!wallsByB.has(wall.building)) wallsByB.set(wall.building, []);
    wallsByB.get(wall.building).push(wall);
  }
  const worldCentroid = (ib) => {
    const b = buildings[ib];
    if (!b || !b.p || !b.p.length) return null;
    const [e, n] = centroidEN(b.p);
    return w2(e, n);                                        // -> [x, z]
  };
  // DETERMINISM: iterate buildings by ASCENDING building index (a stable key), never Map
  // iteration order, so the candidate set + crop order is identical every run regardless of how
  // svWalls happened to be ordered. (Map insertion order is input-dependent; sorting pins it.)
  const candBuildings = [];                                // every in-patch building with SV walls
  for (const ib of [...wallsByB.keys()].sort((a, b) => a - b)) {
    if (ib === houseIndex) { candBuildings.push(ib); continue; }   // house always eligible
    const c = worldCentroid(ib);
    if (!c) continue;
    if (!inRect(c[0], c[1], demRect)) continue;            // off the terrain patch -> stucco
    candBuildings.push(ib);
  }

  // 2) MEASURE + TRIM + RESIZE crops past the px/m gate. px/m = crop width / wall width (the crop
  //    spans the wall left->right). Below minPxPerM the SV photo is too coarse -> SKIP (fallback).
  //    TRIM the top ROOF_TRIM of every crop first (roof/eave/sky bleed), then resize toward
  //    HERO_PX_PER_M (never UP-scale past the source; clamp the long side to MAX_RECT and the
  //    page) so the wall is crisp without blowing the atlas.
  const rects = [];                                        // packable trimmed+resized crops
  const pxPerM = [];                                       // wall px/m distribution (for the report)
  const facadedSet = new Set();                            // buildings that actually got a packed crop
  let rejected = 0;
  for (const ib of candBuildings) {
    // DETERMINISM: walls in ASCENDING edge index, a stable per-building key (the source array
    // order is input-dependent; sorting pins both the eligibility scan and the pack order).
    const wallsForB = [...(wallsByB.get(ib) || [])].sort((a, b) => (a.edge | 0) - (b.edge | 0));
    for (const wall of wallsForB) {
      const wallW = +wall.wallW || 0, wallH = +wall.wallH || 0;
      if (wallW <= 0 || wallH <= 0 || !wall.image) continue;
      const imgPath = path.join(svDir, wall.image);
      let meta;
      try { meta = await sharp(imgPath).metadata(); } catch { continue; }   // missing/corrupt crop
      const srcW = meta.width || 0, srcH = meta.height || 0;
      if (!srcW || !srcH) continue;
      const ppm = srcW / wallW;
      pxPerM.push(ppm);
      if (ppm < minPxPerM) { rejected++; continue; }       // too melty -> procedural stucco instead
      // ROOF TRIM: drop the top ROOF_TRIM band of the SOURCE crop (it's roof/eave/sky bleed from
      // the overestimated OSM wallH). Pack only the remaining lower wall portion.
      const trimTop = Math.min(srcH - 2, Math.max(0, Math.round(srcH * ROOF_TRIM)));
      const keptH = srcH - trimTop;
      if (keptH < 2) continue;
      // Target size: HERO_PX_PER_M texels/metre, clamped so we never enlarge past the kept source
      // and the long side stays <= MAX_RECT and <= page. Aspect follows the trimmed crop (wall
      // width : remaining wall height).
      let tw = Math.min(srcW, Math.round(wallW * HERO_PX_PER_M));
      const cap = Math.min(MAX_RECT, pageSize - GUTTER * 2);
      if (tw > cap) tw = cap;
      tw = Math.max(8, tw);
      const th = Math.max(8, Math.round(tw * keptH / srcW));
      const buf = await sharp(imgPath)
        .extract({ left: 0, top: trimTop, width: srcW, height: keptH })   // cut the roof band off
        .resize(tw, th, { fit: 'fill' }).removeAlpha().raw()
        .toBuffer({ resolveWithObject: true });
      // crop_v is the wall V-band this photo covers (eave=0 .. ground=1). Trimming the top of the
      // crop removes that fraction of the captured WALL height, so push cv0 down accordingly.
      const cv0src = Array.isArray(wall.crop_v) ? wall.crop_v[0] : 0;
      const cv1src = Array.isArray(wall.crop_v) ? wall.crop_v[1] : 1;
      const cv0 = cv0src + (cv1src - cv0src) * (trimTop / srcH);
      rects.push({
        key: `b${wall.building}_e${wall.edge}`,
        w: tw, h: th, raw: buf.data, channels: buf.info.channels,
        cv0, cv1: cv1src,
      });
      facadedSet.add(ib);
    }
  }
  // heroBuildings = exactly the buildings that got a packed crop (the caller's hero gate keys off
  // this; a building absent here stays stucco even if a stray rect exists).
  const heroBuildings = [...facadedSet].sort((a, b) => a - b);
  // tall-first -> better shelf occupancy. Final tiebreak on the stable wall KEY so equal-size
  // crops always pack in the same slot every run (deterministic atlas + UVs).
  rects.sort((a, b) => b.h - a.h || b.w - a.w || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // 3) PACK + COMPOSITE pages, build rectByWall. UV sub-rect insets a half-texel so bilinear taps
  //    never reach into the 2 px gutter (neighbour bleed). v0=top=eave, v1=bottom=ground — the
  //    crop's own layout, so the exporter's eave->ground wall UVs land with NO roof band.
  const pages = rects.length ? packRects(rects, pageSize, GUTTER) : [];
  const rectByWall = {};
  const pagePaths = [];
  for (let p = 0; p < pages.length; p++) {
    const { placements } = pages[p];
    let usedW = 0, usedH = 0;
    for (const { rect, x, y } of placements) {
      usedW = Math.max(usedW, x + rect.w + GUTTER);
      usedH = Math.max(usedH, y + rect.h + GUTTER);
    }
    const pageW = Math.min(pageSize, usedW), pageH = Math.min(pageSize, usedH);
    const composites = placements.map(({ rect, x, y }) => ({
      input: rect.raw, raw: { width: rect.w, height: rect.h, channels: rect.channels }, left: x, top: y,
    }));
    const outPath = path.join(outDir, `facade_atlas_${p}.png`);
    await sharp({ create: { width: pageW, height: pageH, channels: 3, background: { r: 16, g: 16, b: 18 } } })
      .composite(composites).png().toFile(outPath);
    pagePaths.push(outPath);
    for (const { rect, x, y } of placements) {
      rectByWall[rect.key] = {
        page: p,
        u0: (x + 0.5) / pageW,
        v0: (y + 0.5) / pageH,
        u1: (x + rect.w - 0.5) / pageW,
        v1: (y + rect.h - 0.5) / pageH,
        crop_v: [rect.cv0, rect.cv1],
      };
    }
  }

  return {
    pages: pagePaths,
    rectByWall,
    heroBuildings,
    stuccoTile: path.join(svDir, 'facade.png'),
    // diagnostics (the exporter logs these; not part of the consumed contract)
    _stats: { heroCount: heroBuildings.length, packed: Object.keys(rectByWall).length, rejected, pxPerM },
  };
}
