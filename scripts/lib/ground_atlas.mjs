// ground_atlas.mjs — bake the ground texture(s) for the single welded terrain.
//
// Two world-planar textures, one per terrain region (the terrain splits its triangles into a
// crisp ±texCoreHalf CORE and a coarse periphery — both opaque, disjoint, coplanar-but-not-
// overlapping, so ONE surface with zero z-fight and no custom shader):
//   CORE  (coreSize, ±texCoreHalf): de-roaded aerial grass/yard BED + asphalt roads + road-edge
//          curbs + sidewalks + crosswalks + inferred lane paint, all PAINTED onto the bed so they
//          align with the ground by construction. ~0.15 m/texel at 4096/600 m -> crisp lines.
//   FAR   (farSize, full DEM rect): the aerial as a coarse backdrop where the player can't walk.
// Plus a paved_mask (grass occlusion + vegetation annotation). Standard PBR: baseColor + ORM
// (roughness/metal/AO). Normal is left flat in v1 (the curb reads from a concrete band + a
// contact-AO line; a tiled detail-normal is wired at runtime for the asphalt feel).

import sharp from 'sharp';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { makeCanvas, makeMapper, fillPolygon, fillPolygons, bandToRing, encodePNG } from './feature_raster.mjs';

// material albedo (sRGB 0..255) + roughness (0..1) for each painted class
const MAT = {
  grassRough: 0.95,
  asphalt: { rgb: [54, 54, 58], rough: 0.93 },
  'asphalt-light': { rgb: [96, 96, 99], rough: 0.92 },   // driveways/parking
  // mid-grey concrete (was ~188 -> blew out to harsh white under sun); reads as concrete, not white
  concrete: { rgb: [156, 154, 148], rough: 0.86 },        // sidewalks
  'concrete-curb': { rgb: [150, 148, 142], rough: 0.84 }, // curb band
  'concrete-light': { rgb: [186, 184, 178], rough: 0.85 },// crosswalk slab (kept a touch lighter)
};
const PAINT = {
  'double-yellow': [236, 200, 30],
  'lane-dash': [236, 200, 30],
  'edge-line': [232, 232, 228],
  'stop-bar': [240, 240, 238],
  'crosswalk-stripe': [232, 232, 228],
};
const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// build a feature_raster canvas whose r/g/b channels are initialised from a raw RGB buffer,
// so features paint straight over the real aerial pixels (correct src-over, no premultiply).
function canvasFromRGB(rgb, W, H) {
  const N = W * H, r = new Float32Array(N), g = new Float32Array(N), b = new Float32Array(N);
  for (let i = 0; i < N; i++) { r[i] = rgb[i * 3]; g[i] = rgb[i * 3 + 1]; b[i] = rgb[i * 3 + 2]; }
  return { W, H, ch: { r, g, b } };
}

// world box -> integer aerial pixel rect {left,top,width,height}, clamped to the image.
function aerialRect(box, bounds, C, W, H) {
  const u = (e) => (e - bounds.E0) / (bounds.E1 - bounds.E0);
  const vN = (n) => (bounds.Nt - n) / (bounds.Nt - bounds.Nb);
  const e0 = box.x0 + C[0], e1 = box.x1 + C[0];
  const n0 = C[1] - box.z0, n1 = C[1] - box.z1;           // z0 -> larger n (north)
  let left = u(Math.min(e0, e1)) * W, right = u(Math.max(e0, e1)) * W;
  let top = vN(Math.max(n0, n1)) * H, bottom = vN(Math.min(n0, n1)) * H;
  left = Math.max(0, Math.min(W - 1, Math.round(left)));
  right = Math.max(left + 1, Math.min(W, Math.round(right)));
  top = Math.max(0, Math.min(H - 1, Math.round(top)));
  bottom = Math.max(top + 1, Math.min(H, Math.round(bottom)));
  return { left, top, width: right - left, height: bottom - top };
}

// Resample the aerial over a world box into a size×size sRGB PNG buffer.
async function aerialCrop(aerialPath, bounds, C, box, size, meta) {
  const r = aerialRect(box, bounds, C, meta.width, meta.height);
  return sharp(aerialPath).extract(r).resize(size, size, { fit: 'fill', kernel: 'lanczos3' }).toBuffer();
}

// collect the world polygon ring(s) for a surface (centerline+width -> band; polygon -> ring+holes)
function surfaceRings(s) {
  if (s.polygon) return s.holes && s.holes.length ? [s.polygon, ...s.holes] : [s.polygon];
  if (s.centerline) { const r = bandToRing(s.centerline, s.width); return r ? [r] : []; }
  return [];
}

// Paint the road network (asphalt -> driveway -> curb -> sidewalk -> crosswalk -> marks) into a
// feature_raster canvas using `map` (world->texel). `fine` adds lane/stop/crosswalk paint marks;
// the far texture paints only the coarse surfaces (lines vanish at distance anyway). Shared by
// BOTH the core and far textures so painted roads are CONSISTENT across the region boundary.
function paintFeatures(canvas, map, network, curbLines, fine) {
  const ss = fine ? 4 : 2;
  const paint = (rings, rgb, a = 1) => fillPolygon(canvas, rings, { r: rgb[0], g: rgb[1], b: rgb[2], a }, map, { ssY: ss });
  const byKind = (k) => network.surfaces.filter((s) => s.kind === k);
  for (const s of byKind('asphalt')) paint(surfaceRings(s), MAT.asphalt.rgb);
  for (const s of byKind('driveway')) paint(surfaceRings(s), MAT['asphalt-light'].rgb);
  for (const cl of curbLines) { const r = bandToRing(cl.line, 0.55); if (r) paint([r], MAT['concrete-curb'].rgb); }
  for (const s of byKind('concrete-sidewalk')) paint(surfaceRings(s), MAT.concrete.rgb);
  for (const s of byKind('crosswalk')) paint(surfaceRings(s), MAT['concrete-light'].rgb);
  if (fine) for (const p of network.paint) {
    const rgb = p.color ? hexToRgb(p.color) : PAINT[p.kind] || [240, 240, 240];
    if (p.rings) for (const r of p.rings) paint([r], rgb);
    if (p.lines) for (const ln of p.lines) { const ring = bandToRing(ln, p.width || 0.12); if (ring) paint([ring], rgb); }
  }
}

export async function bakeGroundAtlas({
  aerialPath, aerialBounds, C, demRect, texCoreHalf = 300,
  network, curbLines = [], outDir,
  coreSize = 4096, farSize = 2048, maskSize = 1024, ormSize = 2048,
}) {
  mkdirSync(outDir, { recursive: true });
  const meta = await sharp(aerialPath).metadata();
  // The core ground texture covers the REAL terrain extent (demRect), not a fixed ±texCoreHalf box —
  // otherwise the aerial gets clamped+stretched to fill ±600 on levels whose DEM is only ±230..±360
  // (misaligned ground + wasted texels). Matches terrain_mesh.coreUV which now maps demRect -> [0,1].
  const coreBox = demRect;
  const out = (n) => path.join(outDir, n);

  // ---- FAR albedo: aerial over the whole DEM rect + COARSE painted features ----------
  const farRaw = await sharp(aerialPath).extract(aerialRect(demRect, aerialBounds, C, meta.width, meta.height))
    .resize(farSize, farSize, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
  const farCv = canvasFromRGB(farRaw, farSize, farSize);
  paintFeatures(farCv, makeMapper(demRect, { x: 0, y: 0, w: farSize, h: farSize }), network, curbLines, false);
  const farAlbedo = out('ground_far_albedo.png');
  await encodePNG(farCv, ['r', 'g', 'b'], farAlbedo);

  // ---- CORE albedo: paint features DIRECTLY over the aerial bed (straight src-over) ---
  // Initialising the canvas channels from the aerial pixels (rather than compositing a
  // separate RGBA layer) gives correct edge blending AND de-roads the satellite by over-
  // painting its road pixels with our aligned asphalt.
  const coreBaseRaw = await sharp(aerialPath)
    .extract(aerialRect(coreBox, aerialBounds, C, meta.width, meta.height))
    .resize(coreSize, coreSize, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
  const map = makeMapper(coreBox, { x: 0, y: 0, w: coreSize, h: coreSize });
  const fA = canvasFromRGB(coreBaseRaw, coreSize, coreSize);
  paintFeatures(fA, map, network, curbLines, true);     // fine: full detail + lane/stop/crosswalk paint
  const byKind = (k) => network.surfaces.filter((s) => s.kind === k);   // (re)used by ORM + paved mask below

  const coreAlbedo = out('ground_core_albedo.png');
  await encodePNG(fA, ['r', 'g', 'b'], coreAlbedo);

  // ---- CORE ORM (R=AO, G=roughness, B=metal=0) at ormSize ----------------------------
  // grass-rough bed; paint per-material roughness where features are. AO: thin dark contact
  // line on the road side of curbs (cheap "raised curb" cue). metal stays 0.
  const ormMap = makeMapper(coreBox, { x: 0, y: 0, w: ormSize, h: ormSize });
  const orm = makeCanvas(ormSize, ormSize, { ao: 255, rough: Math.round(MAT.grassRough * 255), metal: 0 });
  const paintOrm = (rings, rough, ao = 255) =>
    fillPolygon(orm, rings, { rough: Math.round(rough * 255), ao, a: 1 }, ormMap);
  for (const s of byKind('asphalt')) paintOrm(surfaceRings(s), MAT.asphalt.rough);
  for (const s of byKind('driveway')) paintOrm(surfaceRings(s), MAT['asphalt-light'].rough);
  for (const cl of curbLines) { const r = bandToRing(cl.line, 0.55); if (r) paintOrm([r], MAT['concrete-curb'].rough); }
  for (const s of byKind('concrete-sidewalk')) paintOrm(surfaceRings(s), MAT.concrete.rough);
  for (const s of byKind('crosswalk')) paintOrm(surfaceRings(s), MAT['concrete-light'].rough);
  // contact-AO: darken a thin line just inside each curb's road side
  for (const cl of curbLines) {
    const inner = cl.line.map((p, k) => p);  // the curb line itself; AO band 0.18 m road-side
    const r = bandToRing(inner, 0.18); if (r) fillPolygon(orm, [r], { ao: 120, a: 0.6 }, ormMap);
  }
  const coreOrm = out('ground_core_orm.png');
  await encodePNG(orm, ['ao', 'rough', 'metal'], coreOrm);

  // ---- paved mask (paved/built coverage) over the DEM rect ----------------------------
  const maskMap = makeMapper(demRect, { x: 0, y: 0, w: maskSize, h: maskSize });
  const mask = makeCanvas(maskSize, maskSize, { m: 0 });
  const pavedPolys = [];
  for (const k of ['asphalt', 'driveway', 'concrete-sidewalk', 'crosswalk']) {
    for (const s of byKind(k)) { const rs = surfaceRings(s); if (rs.length) { fillPolygon(mask, rs, { m: 255, a: 1 }, maskMap); pavedPolys.push(rs[0]); } }
  }
  const pavedMaskPath = out('paved_mask.png');
  await encodePNG(mask, ['m'], pavedMaskPath);

  return {
    core: { albedo: coreAlbedo, orm: coreOrm },
    far: { albedo: farAlbedo },
    pavedMaskPath, pavedPolys,
    coreBox, texCoreHalf,
  };
}
