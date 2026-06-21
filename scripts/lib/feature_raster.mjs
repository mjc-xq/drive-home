// feature_raster.mjs — pure-JS, memory-light, multi-channel anti-aliased 2D rasterizer.
//
// The single-textured-terrain pipeline paints roads/sidewalks/curbs/crosswalks/lane-lines
// (the FEATURE atlas, UV2) and the de-roaded aerial bed (UV0) as flat 2D art that the ONE
// terrain mesh samples — so surfaces are textures on the single surface, not stacked ribbons.
// This module is the shared painter for both. No canvas dependency (none is installed); sharp
// only encodes the final PNGs.
//
// A "canvas" is a set of named Float32 channel buffers (values in 0..255) over a W×H texel
// grid. Painting a polygon blends a style's per-channel values by the polygon's anti-aliased
// coverage (src-over): ch = ch*(1-a*cov) + val*a*cov. AA = `ssY` sub-scanlines per row for
// vertical coverage + exact analytic horizontal span coverage — so no giant supersampled
// buffer is needed (a 4096² page stays affordable).

import sharp from 'sharp';

// Allocate a canvas. `clears` maps channel name -> initial value (0..255), e.g.
// { r: 60, g: 60, b: 62, a: 0 } for an albedo page that starts as transparent dark asphalt.
export function makeCanvas(W, H, clears = {}) {
  const ch = {};
  for (const [name, v] of Object.entries(clears)) {
    const buf = new Float32Array(W * H);
    if (v) buf.fill(v);
    ch[name] = buf;
  }
  return { W, H, ch };
}

// World XZ -> texel mapper. `worldBox` {x0,x1,z0,z1} is the world region; `packRect`
// {x,y,w,h} is its texel sub-rect in the atlas page (lets us pack many features). Texel v
// (=Z) increases downward, matching glTF UV with v=0 at the box's z0 edge.
export function makeMapper(worldBox, packRect) {
  const { x0, x1, z0, z1 } = worldBox;
  const { x: rx, y: ry, w: rw, h: rh } = packRect;
  const sx = rw / (x1 - x0), sz = rh / (z1 - z0);
  return (X, Z) => [rx + (X - x0) * sx, ry + (Z - z0) * sz];
}

// AA scanline fill of ONE polygon (outer ring + optional hole rings, even-odd) into the
// canvas channels named in `style` (0..255 each, plus optional `a` 0..1 master alpha).
// `ringsWorld` = [outerRing, hole1, ...], each ring = [[X,Z]...] in WORLD coords; `toTexel`
// maps world->texel. Call once PER polygon (even-odd across rings = holes, not separate shapes).
export function fillPolygon(canvas, ringsWorld, style, toTexel, opts = {}) {
  const ssY = opts.ssY ?? 4;
  const rings = ringsWorld.map((r) => r.map(([X, Z]) => toTexel(X, Z)));
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const r of rings) for (const [px, py] of r) {
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
  }
  const { W, H } = canvas;
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.ceil(maxY));
  const x0c = Math.max(0, Math.floor(minX)), x1c = Math.min(W - 1, Math.ceil(maxX));
  if (y1 < y0 || x1c < x0c) return;
  const styleEntries = Object.entries(style).filter(([k]) => k !== 'a');
  const masterA = style.a != null ? style.a : 1;
  const cov = new Float32Array(W);
  const xs = [];
  for (let y = y0; y <= y1; y++) {
    cov.fill(0, x0c, x1c + 1);
    for (let s = 0; s < ssY; s++) {
      const sy = y + (s + 0.5) / ssY;
      xs.length = 0;
      for (const r of rings) {
        const n = r.length;
        for (let i = 0; i < n; i++) {
          const a = r[i], b = r[(i + 1) % n];
          const ay = a[1], by = b[1];
          if (ay === by) continue;
          if ((sy >= ay && sy < by) || (sy >= by && sy < ay)) {
            const t = (sy - ay) / (by - ay);
            xs.push(a[0] + t * (b[0] - a[0]));
          }
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = xs[i], xb = xs[i + 1];
        if (xb <= xa) continue;
        const ixa = Math.max(x0c, Math.floor(xa)), ixb = Math.min(x1c, Math.ceil(xb) - 1);
        for (let px = ixa; px <= ixb; px++) {
          const c = Math.min(px + 1, xb) - Math.max(px, xa);
          if (c > 0) cov[px] += c / ssY;
        }
      }
    }
    const row = y * W;
    for (let px = x0c; px <= x1c; px++) {
      let c = cov[px]; if (c <= 0) continue; if (c > 1) c = 1;
      const a = masterA * c; if (a <= 0) continue;
      const idx = row + px;
      for (const [name, val] of styleEntries) {
        const buf = canvas.ch[name]; if (!buf) continue;
        buf[idx] = buf[idx] * (1 - a) + val * a;
      }
    }
  }
}

// Convenience: paint many polygons with one style (each is its own even-odd shape).
export function fillPolygons(canvas, polysWorld, style, toTexel, opts = {}) {
  for (const poly of polysWorld) {
    const rings = Array.isArray(poly[0][0]) ? poly : [poly];   // [ring] or [[X,Z]...]
    fillPolygon(canvas, rings, style, toTexel, opts);
  }
}

// Expand a centreline + width into a closed polygon ring (offset both sides, square caps).
// Used to paint road/sidewalk/driveway BANDS as filled polygons (so the rasterizer only
// ever needs fillPolygon). Mitre is not clamped here (paint bands tolerate slight overlap).
export function bandToRing(centerline, width) {
  const hw = width / 2, n = centerline.length;
  if (n < 2) return null;
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const p = centerline[i], a = centerline[Math.max(0, i - 1)], b = centerline[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const nx = -dz, nz = dx;
    left.push([p[0] + nx * hw, p[1] + nz * hw]);
    right.push([p[0] - nx * hw, p[1] - nz * hw]);
  }
  return left.concat(right.reverse());
}

// Box-downsample one channel by integer factor f (supersample resolve, if a caller chose to
// author at f× then shrink). Rarely needed since fill() is already AA; provided for parity.
export function downsampleChannel(buf, W, H, f) {
  const w = (W / f) | 0, h = (H / f) | 0, out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) acc += buf[(y * f + j) * W + (x * f + i)];
    out[y * w + x] = acc / (f * f);
  }
  return out;
}

// Encode named channels into an N-channel PNG (chMap = e.g. ['r','g','b'] or ['r','g','b','a']).
// Values are clamped to 0..255. Returns outPath.
export async function encodePNG(canvas, chMap, outPath) {
  const { W, H } = canvas;
  const channels = chMap.length;
  const buf = Buffer.alloc(W * H * channels);
  const srcs = chMap.map((n) => canvas.ch[n]);
  for (let i = 0; i < W * H; i++) {
    const o = i * channels;
    for (let c = 0; c < channels; c++) {
      const s = srcs[c];
      buf[o + c] = s ? Math.max(0, Math.min(255, Math.round(s[i]))) : 0;
    }
  }
  await sharp(buf, { raw: { width: W, height: H, channels } }).png({ compressionLevel: 9 }).toFile(outPath);
  return outPath;
}

// Pack a normal vector (unit, +Y up in tangent space / OpenGL green) into 0..255 RGB.
export const packNormal = (nx, ny, nz) => [(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255];
