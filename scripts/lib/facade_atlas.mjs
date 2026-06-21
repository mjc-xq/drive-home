// facade_atlas.mjs — project REAL Street-View building facades INTO the wall texture
// (coplanar, the wall IS the photo), phased by a px/m quality gate.
//
// WHY: the old exporter floated SVFacade_* overlay quads 0.16 m PROUD of each wall (they
// z-fight + read as decals) and shipped 967 crops as small as 522x163 px — far/low-res walls
// turned to melty 64px mush. Here a wall gets a real SV crop ONLY when it belongs to a HERO
// building (owner house + the handful of on-patch neighbours the player can walk up to) AND
// the crop clears `minPxPerM`. Everyone else, and any wall below the gate, falls back to the
// procedural tiled stucco (exports/facade.png) tinted by the caller's per-building wallColor.
// We never ship a melty photo: the gate -> procedural stucco instead.
//
// HOW: hero crops are SHELF-PACKED (skyline rows, tall-first) into one or a few RGB atlas
// pages composited with sharp, each resized to a hero texels-per-metre so the wall is crisp.
// The returned rectByWall maps 'b{building}_e{edge}' -> { page, u0,v0,u1,v1 }; the exporter
// sets that wall's UVs to the sub-rect (V: eave=v0/top -> ground=v1/bottom, matching the
// crop's own ground-to-eave layout, so NO roof band shows) and uses the atlas page material.
// Walls not in rectByWall get the stucco tile. crop_v (sub-band of the wall) is respected:
// the sub-rect is the crop, but we record only the captured V-band so the exporter knows
// which slice of the wall it covers (the exporter clamps wall UVs to [0,1] regardless).

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const GUTTER = 2;          // px of empty space around each packed rect (anti-bleed)
const HERO_PX_PER_M = 128; // target texels/metre on a hero wall (crisp; clamped per-wall below)
const MAX_RECT = 2048;     // cap a single packed crop's long side so one wall can't blow a page

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
 * Bake hero Street-View facade crops into RGB atlas page(s). See file header for the contract.
 * Walls that aren't hero, or whose px/m < minPxPerM, are intentionally absent from rectByWall
 * (the caller applies procedural stucco there).
 */
export async function bakeFacadeAtlas({
  buildings, svWalls, svDir, houseIndex, demRect, w2,
  minPxPerM = 40, heroRadius = 90, heroCap = 16, pageSize = 4096, outDir,
}) {
  mkdirSync(outDir, { recursive: true });

  // 1) HERO SELECTION: owner house always; plus buildings whose footprint centroid is inside
  //    demRect AND within heroRadius of the house centroid AND that carry >=1 SV wall crop.
  //    Sort the neighbours by distance, cap the total at heroCap (house counts toward the cap).
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
  const houseC = worldCentroid(houseIndex);
  const cands = [];
  for (const ib of wallsByB.keys()) {
    if (ib === houseIndex) continue;
    const c = worldCentroid(ib);
    if (!c || !houseC) continue;
    if (!inRect(c[0], c[1], demRect)) continue;            // off the terrain patch -> not walkable
    const d = Math.hypot(c[0] - houseC[0], c[1] - houseC[1]);
    if (d > heroRadius) continue;                          // too far to walk up to
    cands.push({ ib, d });
  }
  cands.sort((a, b) => a.d - b.d);
  const heroBuildings = [houseIndex, ...cands.map((c) => c.ib)].slice(0, heroCap);
  const heroSet = new Set(heroBuildings);

  // 2) MEASURE + RESIZE hero crops past the px/m gate. px/m = crop width / wall width (the crop
  //    spans the wall left->right). Below minPxPerM the SV photo is too coarse -> SKIP (fallback).
  //    Otherwise resize toward HERO_PX_PER_M (never UP-scale past the source; clamp the long side
  //    to MAX_RECT and to the page) so the wall is crisp without blowing the atlas.
  const rects = [];                                        // packable resized crops
  const pxPerM = [];                                       // hero-wall px/m distribution (for the report)
  let rejected = 0;
  for (const ib of heroBuildings) {
    for (const wall of wallsByB.get(ib) || []) {
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
      // Target size: HERO_PX_PER_M texels/metre, clamped so we never enlarge past the source and
      // the long side stays <= MAX_RECT and <= page. Keep the source aspect (it already matches
      // the wall's W:H from the ground-to-eave crop).
      let tw = Math.min(srcW, Math.round(wallW * HERO_PX_PER_M));
      const cap = Math.min(MAX_RECT, pageSize - GUTTER * 2);
      if (tw > cap) tw = cap;
      tw = Math.max(8, tw);
      const th = Math.max(8, Math.round(tw * srcH / srcW));
      const buf = await sharp(imgPath).resize(tw, th, { fit: 'fill' }).removeAlpha().raw()
        .toBuffer({ resolveWithObject: true });
      rects.push({
        key: `b${wall.building}_e${wall.edge}`,
        w: tw, h: th, raw: buf.data, channels: buf.info.channels,
        cv0: Array.isArray(wall.crop_v) ? wall.crop_v[0] : 0,
        cv1: Array.isArray(wall.crop_v) ? wall.crop_v[1] : 1,
      });
    }
  }
  rects.sort((a, b) => b.h - a.h || b.w - a.w);            // tall-first -> better shelf occupancy

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
