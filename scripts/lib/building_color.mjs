// building_color.mjs — per-building wall + roof colour, ported verbatim-in-spirit from the legacy
// exporter (export_property_glb.mjs:360-442) so the single-surface exporter and building_layer
// share ONE colour source. Wall colour = the building's real Street-View facade colour when it
// reads as plausible paint, else a derived roof tint / deterministic varied warm paint (never
// green/olive). Roof colour = the real satellite-sampled per-roof colour (shadow-lifted).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const STUCCO = [0.82, 0.78, 0.70];
const ROOFP = [[0.58, 0.55, 0.50], [0.60, 0.46, 0.38], [0.50, 0.53, 0.55], [0.60, 0.50, 0.42], [0.62, 0.59, 0.52]];
const WALL_PALETTE = [
  [0.86, 0.82, 0.74], [0.80, 0.72, 0.60], [0.74, 0.78, 0.80], [0.82, 0.79, 0.72],
  [0.70, 0.74, 0.66], [0.86, 0.80, 0.70], [0.66, 0.70, 0.74], [0.82, 0.74, 0.64],
  [0.78, 0.70, 0.62], [0.72, 0.76, 0.74], [0.62, 0.66, 0.70], [0.84, 0.78, 0.66],
];
const ROOF_PALETTE = [
  [0.58, 0.55, 0.50], [0.60, 0.46, 0.38], [0.50, 0.53, 0.55], [0.60, 0.50, 0.42], [0.62, 0.59, 0.52],
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
  const wallColor = (ib) => {
    let src = COL[ib];
    if (!src || !isPlausiblePaint(src)) src = RCOL[ib] ? lighten(RCOL[ib]) : seededColor(WALL_PALETTE, ib);
    const L = Math.max(0.02, luma(src));
    let c = src.map((v) => v * (remapLuma(L) / L));
    c = deGreen(c);
    const m = luma(c);
    c = c.map((v) => m + (v - m) * 1.12);
    return c.map(clamp01);
  };
  const roofColor = (ib) => {
    if (RCOL[ib]) return liftLuma(RCOL[ib], 0.48);
    const src = ROOFP[(Math.imul((ib | 0) + 1, 2654435761) >>> 0) % ROOFP.length];
    return liftLuma(mix3(src, seededColor(ROOF_PALETTE, ib), 0.40), 0.48, seededColor(ROOF_PALETTE, ib));
  };
  return { wallColor, roofColor };
}
