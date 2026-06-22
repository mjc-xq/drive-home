// building_color.mjs — per-building wall + roof colour, ported verbatim-in-spirit from the legacy
// exporter (export_property_glb.mjs:360-442) so the single-surface exporter and building_layer
// share ONE colour source. Wall colour = the building's real Street-View facade colour when it
// reads as plausible paint, else a derived roof tint / deterministic varied warm paint (never
// green/olive). Roof colour = the real satellite-sampled per-roof colour (shadow-lifted).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const STUCCO = [0.82, 0.78, 0.70];
const ROOFP = [[0.58, 0.55, 0.50], [0.60, 0.46, 0.38], [0.50, 0.53, 0.55], [0.60, 0.50, 0.42], [0.62, 0.59, 0.52]];
// Wider, more saturated real-house paints so the stucco-fallback block reads as a varied
// neighbourhood (warm tans/buffs, sage + olive greens, slate + steel blues, taupe, warm browns,
// warm white) rather than a wash of pale tan.
const WALL_PALETTE = [
  [0.87, 0.83, 0.74], [0.79, 0.68, 0.54], [0.66, 0.72, 0.62], [0.83, 0.79, 0.70],
  [0.58, 0.66, 0.72], [0.86, 0.77, 0.63], [0.52, 0.60, 0.66], [0.80, 0.69, 0.56],
  [0.73, 0.61, 0.52], [0.62, 0.69, 0.64], [0.49, 0.55, 0.61], [0.85, 0.75, 0.60],
  [0.70, 0.53, 0.45], [0.57, 0.63, 0.55], [0.90, 0.87, 0.81], [0.64, 0.58, 0.52],
];
const ROOF_PALETTE = [
  [0.46, 0.43, 0.40], [0.56, 0.40, 0.32], [0.42, 0.45, 0.49], [0.52, 0.43, 0.36],
  [0.48, 0.47, 0.43], [0.36, 0.38, 0.40], [0.60, 0.44, 0.34], [0.40, 0.34, 0.30],
];
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix3 = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
const luma = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const liftLuma = (c, minL, target = STUCCO) => {
  const L = luma(c);
  if (L >= minL) return c.map(clamp01);
  const denom = Math.max(0.001, luma(target) - L);
  return mix3(c, target, Math.min(1, (minL - L) / denom)).map(clamp01);
};
const seededColor = (palette, ib) => palette[(Math.imul((ib | 0) + 17, 1103515245) >>> 0) % palette.length];
const lighten = (c) => liftLuma(mix3(c, STUCCO, 0.52), 0.62);
const remapLuma = (L) => {
  if (L < 0.55) return 0.55 - (0.55 - L) * 0.25;
  if (L > 0.84) return 0.84 + (L - 0.84) * 0.60;
  return L;
};
const deGreen = (c) => {
  let [r, g, b] = c;
  if (g > b + 0.035 && g >= r - 0.03) { const avg = (r + b) / 2; g = avg + (g - avg) * 0.30; }
  return [r, g, b];
};
const isPlausiblePaint = (c) => {
  const [r, g, b] = c;
  if (luma(c) < 0.24) return false;
  if (g > r + 0.02 && g > b + 0.02) return false;
  return true;
};

// Build the wallColor/roofColor closures for a level, reading its colour sidecars (root or
// per-level dir). pick(name) resolves the sidecar path.
export function makeBuildingColor(pick) {
  const COL = existsSync(pick('buildings_color.json')) ? JSON.parse(readFileSync(pick('buildings_color.json'), 'utf8')) : {};
  const RCOL = existsSync(pick('buildings_roof_color.json')) ? JSON.parse(readFileSync(pick('buildings_roof_color.json'), 'utf8')) : {};
  // provenance per building: 'sv' (real Street-View facade) | 'aerial' | 'knn' | undefined (none).
  const SRC = existsSync(pick('buildings_color_src.json')) ? JSON.parse(readFileSync(pick('buildings_color_src.json'), 'utf8')) : {};
  const wallColor = (ib) => {
    let src = COL[ib];
    const prov = SRC[ib];
    // WALL colour and ROOF colour are SEPARATE measurements from SEPARATE sources and are often
    // different (a gray-shingle roof over a tan house). So:
    //  - 'sv'/'knn' = a true Street-View FACADE sample -> the real wall colour: PRESERVE its value
    //    (skip the low-luma lift that washes dark paints toward stucco) and push chroma harder.
    //  - 'aerial' = the footprint sampled TOP-DOWN = essentially the roof tint, NOT a wall colour;
    //    keep it only as a weak hint with gentle normalization, never high-chroma "real".
    //  - none/implausible = an INDEPENDENT warm paint palette (NEVER derived from the roof colour,
    //    since walls and roofs do not match).
    const real = !!src && isPlausiblePaint(src) && (prov === 'sv' || prov === 'knn');
    if (!src || !isPlausiblePaint(src)) src = seededColor(WALL_PALETTE, ib);
    const L = Math.max(0.02, luma(src));
    let c = real ? src.slice() : src.map((v) => v * (remapLuma(L) / L));
    c = deGreen(c);
    const m = luma(c);
    c = c.map((v) => m + (v - m) * (real ? 1.45 : 1.24));   // stronger chroma so paint reads as colour, not pale wash
    return c.map(clamp01);
  };
  const roofColor = (ib) => {
    if (RCOL[ib]) return liftLuma(RCOL[ib], 0.48);
    const src = ROOFP[(Math.imul((ib | 0) + 1, 2654435761) >>> 0) % ROOFP.length];
    return liftLuma(mix3(src, seededColor(ROOF_PALETTE, ib), 0.40), 0.48, seededColor(ROOF_PALETTE, ib));
  };
  return { wallColor, roofColor };
}
