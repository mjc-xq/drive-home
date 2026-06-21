// surface_annotation.mjs — SIDE-CHANNEL annotation for the single-textured-terrain export.
//
// The beautiful textured GLB is built elsewhere and does all the up-close visual work via its
// ground texture. This module does NOT touch that GLB. Instead it ANNOTATES the world so a LATER
// Unity step can scatter GPU-instanced foliage (grass clumps/cards, bushes, trees) onto a
// lightweight Unity Terrain laid under the GLB — vegetation near the player for density/realism.
//
// Output is two artifacts (no Unity code here):
//   1. a world-aligned surface-CLASS raster (1 byte class id per texel over the DEM rect), and
//   2. a vegetation.json that tells Unity how to consume it (legend, frame, fence paths, trees).
//
// Classification is from the aerial photo color, with paved/building polygons overriding color.
// A perfect classifier is NOT the goal — a sensible one that says "grass here / dry-grass there /
// dirt / canopy / water / paved" well enough to seed Terrain detail layers.
//
// Coordinate frame (matches export_property_glb.mjs):
//   C = scene.center; world(e,n) = [e-C[0], -(n-C[1])]  (house centroid at origin, +Z = south).
//   DEM rect (texture/world extent) X,Z ∈ [x0..x1],[z0..z1].
//   Aerial JPG is 6400² with bounds {E0,E1,Nt,Nb}; aerialUV(e,n)=[(e-E0)/(E1-E0),(Nt-n)/(Nt-Nb)]
//   (v=0 at north). So a world (X,Z) -> e=X+C[0], n=C[1]-Z -> aerial pixel.

import sharp from 'sharp';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Class ids — the byte stored per texel in the grayscale class raster. Documented in the doc.
export const CLASS_LEGEND = {
  0: 'unknown',
  1: 'paved',        // roads/sidewalks/driveways/crosswalks/built hardscape -> NO detail
  2: 'building',     // footprints -> NO detail
  3: 'grass',        // green lawn/field -> grass detail layer
  4: 'dry-grass',    // yellow/straw grass -> dry-grass detail layer
  5: 'dirt',         // brown bare earth -> sparse/none
  6: 'bush',         // shrub thicket -> bush detail layer
  7: 'tree-canopy',  // tree crowns from aerial (also seeded by trees_placed.json) -> tree prototypes
  8: 'water',        // pool/creek/pond -> NO detail
};
// Human-inspection color key (RGB) per class id — only used for the optional preview PNG.
const CLASS_RGB = {
  0: [0, 0, 0], 1: [110, 110, 115], 2: [200, 60, 60], 3: [60, 170, 60], 4: [200, 190, 90],
  5: [150, 110, 70], 6: [30, 110, 40], 7: [20, 70, 25], 8: [60, 120, 220],
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// sRGB 0..255 -> linear 0..1 (so luma/ratios are perceptually sane, not gamma-skewed).
const srgb2lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

// even-odd point-in-polygon over a ring [[x,z]...] (world XZ). Rings may be CW or CCW.
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// bbox of a ring, padded — lets us skip the per-texel ring test for far-away polys cheaply.
function ringBBox(ring) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return { x0, x1, z0, z1 };
}
// Precompute {ring,bb} so the hot loop can bbox-reject before the O(n) ring test.
const prepPolys = (polys) => polys.map((ring) => ({ ring, bb: ringBBox(ring) }));
const hitsAny = (x, z, prepped) => {
  for (const p of prepped) {
    const b = p.bb;
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
    if (pointInRing(x, z, p.ring)) return true;
  }
  return false;
};

// Classify ONE aerial pixel (linearized) into a vegetation/surface class. Thresholds are tuned
// for a Bay-Area suburban/oblique-noon aerial and COMMENTED; they're deliberately conservative so
// grass (the dominant, useful class) wins ties and we never mislabel ground as paved.
function classifyColor(r8, g8, b8) {
  const r = srgb2lin(r8), g = srgb2lin(g8), b = srgb2lin(b8);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;     // perceived brightness, linear
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx <= 0 ? 0 : (mx - mn) / mx;               // simple HSV-style saturation
  const greenDom = g - Math.max(r, b);                    // how much green leads (linear)

  // WATER: a real cyan/blue signature — blue must lead BOTH others by a clear margin AND the
  // pixel be saturated enough to be a pool/creek, not a cool-gray roof or shadow (those merely
  // have b slightly > r,g). Strict so bluish rooftops/haze fall through to grass, not water.
  if (b > r && b > g && (b - Math.max(r, g)) > 0.10 && sat > 0.20 && luma > 0.05) return 8;

  // TREE-CANOPY: green-ish but DARK (crowns are shadowed deep green, distinct from bright lawn).
  if (greenDom > 0.01 && luma < 0.10) return 7;

  // GRASS: green leads at mid/bright luma — healthy lawn/field. Most common useful class.
  if (greenDom > 0.02 && luma >= 0.10) return 3;

  // BUSH: moderately green, fairly saturated, mid luma but darker/denser than open lawn — shrub
  // thickets. Narrow band so it doesn't steal from grass; Unity can also derive bushes near canopy.
  if (greenDom > 0.0 && sat > 0.25 && luma >= 0.06 && luma < 0.16) return 6;

  // DRY-GRASS: yellow straw — r~g, both above b, low green dominance, mid luma, low-ish sat. CA hills.
  if (r >= b && g >= b && Math.abs(r - g) < 0.06 && (r - b) > 0.02 && luma >= 0.10 && sat < 0.55) return 4;

  // DIRT: brown bare earth — r>g>b ramp at low-mid luma (tilled/trodden ground, paths).
  if (r > g && g > b && luma >= 0.04 && luma < 0.16) return 5;

  // GRAY low-saturation mid-luma that ISN'T already paved (paved is applied by polygon, not color):
  // default to GRASS rather than risk false-paving real ground (concrete-ish lawn shade, haze).
  return 3;
}

// 3×3 majority filter — removes single-texel speckle so detail-density maps aren't noisy.
// Ties keep the center's class (stable). Operates on the flat class-id array in place via a copy.
function majority3x3(src, W, H) {
  const out = new Uint8Array(src.length);
  const cnt = new Uint16Array(9);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      cnt.fill(0);
      const c0 = src[y * W + x];
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          cnt[src[yy * W + xx]]++;
        }
      }
      let best = c0, bestN = cnt[c0];                     // bias to center on ties => stable
      for (let k = 0; k < 9; k++) if (cnt[k] > bestN) { bestN = cnt[k]; best = k; }
      out[y * W + x] = best;
    }
  }
  return out;
}

// Build the surface annotation. See module header + docs/dahilg-vegetation-annotation.md.
export async function buildSurfaceAnnotation({
  aerialPath,                         // exports/google_aerial.jpg
  aerialBounds,                       // {E0,E1,Nt,Nb}
  C,                                  // [e,n] scene center
  demRect,                            // {x0,x1,z0,z1} world extent of the texture/terrain
  rasterSize = 1024,                  // class raster is rasterSize × rasterSize over demRect
  pavedPolys = [],                    // WORLD-XZ rings -> class 'paved' (override color)
  buildingFootprintsWorld = [],       // WORLD-XZ rings -> class 'building' (override color)
  parcels = [],                       // parcels.json parcels -> fence-path polylines
  treesPlaced = [],                   // trees_placed.json trees -> canopy mask + reference count
  outDir,                             // exports/_ground/ (class raster lives here)
  level,                              // 'level' | 'canyon' | ...
  smooth = true,                      // apply the 3×3 majority despeckle
  writePreview = true,                // also write a colorized *_key.png for human inspection
}) {
  const { E0, E1, Nt, Nb } = aerialBounds;
  const { x0, x1, z0, z1 } = demRect;
  const N = rasterSize;
  const groundDir = outDir;
  const vegDir = path.dirname(path.join(outDir, '..', `${level}.vegetation.json`)); // = exports/
  await mkdir(groundDir, { recursive: true });

  // Decode the aerial to a flat RGB byte buffer once (6400² × 3 ≈ 117 MB — fine for a build step).
  const { data: aer, info } = await sharp(aerialPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const AW = info.width, AH = info.height;                // expected 6400 × 6400

  // world(X,Z) -> aerial pixel (px,py) via e/n then aerialUV*size. v=0 at north (Nt).
  const worldToAerialPx = (X, Z) => {
    const e = X + C[0], n = C[1] - Z;
    const u = (e - E0) / (E1 - E0);
    const v = (Nt - n) / (Nt - Nb);
    let px = Math.floor(u * AW), py = Math.floor(v * AH);
    if (px < 0) px = 0; else if (px >= AW) px = AW - 1;
    if (py < 0) py = 0; else if (py >= AH) py = AH - 1;
    return [px, py];
  };

  const pavedP = prepPolys(pavedPolys);
  const buildP = prepPolys(buildingFootprintsWorld);

  // Tree-canopy mask from trees_placed.json: stamp each canopy disc into the raster (overrides
  // color so crowns the aerial blurred are still flagged). Disc radius = canopyR (world meters).
  const treeDiscs = treesPlaced
    .filter((t) => Number.isFinite(t.x) && Number.isFinite(t.z) && t.canopyR > 0)
    .map((t) => ({ x: t.x, z: t.z, r: Math.max(t.canopyR, 0.5) }));
  const inTreeDisc = (X, Z) => {
    for (const d of treeDiscs) { const dx = X - d.x, dz = Z - d.z; if (dx * dx + dz * dz <= d.r * d.r) return true; }
    return false;
  };

  // texel -> world-center. Texel (i,j): i across X (x0..x1), j down Z (z0..z1) (v=0 at z0 = north).
  const dx = (x1 - x0) / N, dz = (z1 - z0) / N;
  const wAt = (i, j) => [x0 + (i + 0.5) * dx, z0 + (j + 0.5) * dz];

  const cls = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const [X, Z] = wAt(i, j);
      let c;
      if (hitsAny(X, Z, buildP)) c = 2;                   // building overrides everything
      else if (hitsAny(X, Z, pavedP)) c = 1;              // then paved
      else if (inTreeDisc(X, Z)) c = 7;                   // then known tree crowns
      else {
        const [px, py] = worldToAerialPx(X, Z);           // else classify aerial color
        const o = (py * AW + px) * 3;
        c = classifyColor(aer[o], aer[o + 1], aer[o + 2]);
      }
      cls[j * N + i] = c;
    }
  }

  const finalCls = smooth ? majority3x3(cls, N, N) : cls;

  // Per-class texel counts + coverage %. Sums to N² by construction (every texel gets one class).
  const counts = {};
  for (const id of Object.keys(CLASS_LEGEND)) counts[id] = 0;
  for (let k = 0; k < finalCls.length; k++) counts[finalCls[k]]++;

  // Write the class raster as a TRUE 1-channel grayscale PNG: stored byte == class id (0..8).
  // ('b-w' colourspace keeps it single-channel; raw readback in Unity/anywhere gives the id back.)
  const classRasterName = `${level}.surface_class.png`;
  const classRasterPath = path.join(groundDir, classRasterName);
  await sharp(Buffer.from(finalCls.buffer), { raw: { width: N, height: N, channels: 1 } })
    .toColourspace('b-w').png({ compressionLevel: 9 }).toFile(classRasterPath);

  // Optional colorized preview so a human can eyeball the classification (NOT consumed by Unity).
  if (writePreview) {
    const rgb = Buffer.alloc(N * N * 3);
    for (let k = 0; k < finalCls.length; k++) {
      const col = CLASS_RGB[finalCls[k]] || CLASS_RGB[0];
      rgb[k * 3] = col[0]; rgb[k * 3 + 1] = col[1]; rgb[k * 3 + 2] = col[2];
    }
    await sharp(rgb, { raw: { width: N, height: N, channels: 3 } })
      .png({ compressionLevel: 9 }).toFile(path.join(groundDir, `${level}.surface_class_key.png`));
  }

  // Fence paths = the real-world parcel/lot lines (Unity instances fence posts/rails along these).
  const fencePaths = parcels
    .filter((p) => Array.isArray(p.ring) && p.ring.length >= 2)
    .map((p) => ({ ring: p.ring, mine: !!p.mine, apn: p.apn ?? null }));

  // vegetation.json — the contract Unity reads. Positions for trees already exist in
  // trees_placed.json (referenced, not duplicated here). worldPerTexel lets Unity map the class
  // raster onto its Terrain detail/density grid 1:1.
  const veg = {
    frame: { center: C, demRect, rasterSize: N, worldPerTexel: { x: dx, z: dz } },
    classRaster: classRasterName,
    legend: CLASS_LEGEND,
    fencePaths,
    trees: { source: 'trees_placed.json', count: treesPlaced.length },
    notes: 'See docs/dahilg-vegetation-annotation.md. Class raster is a 1-channel PNG, one byte = '
      + 'class id (see legend). Map ids -> Unity Terrain detail layers (grass/dry-grass/bush); '
      + 'paved/building/water get no detail. Trees from trees_placed.json; fences along fencePaths.',
  };
  const vegetationJsonPath = path.join(vegDir, `${level}.vegetation.json`);
  await writeFile(vegetationJsonPath, JSON.stringify(veg, null, 2));

  return {
    classRasterPath,
    classLegend: CLASS_LEGEND,
    vegetationJsonPath,
    counts,
  };
}
