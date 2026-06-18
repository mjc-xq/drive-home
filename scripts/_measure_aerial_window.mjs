// Render the Mapbox aerial (src/assets/aerial_opt.jpg) over a KNOWN world window
// using the EXACT georeferencing the exporter uses to texture the terrain
// (aerialUVll, derived from scene.json.aerial). Output pixel (i,j) maps to world
//   East  = -HALF + (i+0.5)/PX * 2*HALF
//   North = +HALF - (j+0.5)/PX * 2*HALF      (image top = +North, like the photoreal render)
// so it is pixel-comparable to scripts/_measure_render_photoreal.py over the same HALF.
//
//   node scripts/_measure_aerial_window.mjs <out.png> <half_m> <px> [dEast] [dNorth]
// Optional dEast/dNorth (metres) shift the aerial georef (for sanity-injection /
// to preview a candidate correction): the world->latlon used for UV is offset by
// (dEast,dNorth), i.e. the imagery is treated as if shifted by that vector.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2];
const HALF = Number(process.argv[3] || 90);
const PX = Number(process.argv[4] || 1024);
const DE = Number(process.argv[5] || 0);   // metres east applied to georef
const DN = Number(process.argv[6] || 0);   // metres north applied to georef

const { makeGeoENU } = await import('../src/engine/coords.js');
const S = JSON.parse(readFileSync(path.join(ROOT, 'src/assets/scene.json'), 'utf8'));
const C = S.center, A = S.aerial;
const LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * Math.PI / 180), D2R = Math.PI / 180;
const houseLat = LAT0 + C[1] / 110540, houseLon = LON0 + C[0] / (COSLAT * 111320);
const ENU = makeGeoENU(houseLat, houseLon);

// EXACT copy of exporter's aerial UV mapping (scripts/export_property_glb.mjs)
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2));
const aLatN = LAT0 + A.Nt / 110540, aLatS = LAT0 + A.Nb / 110540;
const aLonW = LON0 + A.E0 / (COSLAT * 111320), aLonE = LON0 + A.E1 / (COSLAT * 111320);
const aMyN = mercY(aLatN), aMyS = mercY(aLatS);
const aerialUVll = (lat, lon) => [(lon - aLonW) / (aLonE - aLonW), (mercY(lat) - aMyS) / (aMyN - aMyS)];

// load aerial JPG into raw RGB
const img = sharp(path.join(ROOT, 'src/assets/aerial_opt.jpg'));
const meta = await img.metadata();
const AW = meta.width, AH = meta.height;
const { data: aRGB } = await img.raw().toBuffer({ resolveWithObject: true });
const sampleAerial = (u, v) => {
  // u in [0,1] left->right (lon W->E); v in [0,1] bottom->top (merc S->N). image row 0 = top.
  let px = Math.round(u * (AW - 1));
  let py = Math.round((1 - v) * (AH - 1));
  px = Math.max(0, Math.min(AW - 1, px));
  py = Math.max(0, Math.min(AH - 1, py));
  const o = (py * AW + px) * 3;
  return [aRGB[o], aRGB[o + 1], aRGB[o + 2]];
};

const out = Buffer.alloc(PX * PX * 3);
for (let j = 0; j < PX; j++) {
  const North = HALF - (j + 0.5) / PX * 2 * HALF;
  for (let i = 0; i < PX; i++) {
    const East = -HALF + (i + 0.5) / PX * 2 * HALF;
    // apply candidate georef offset: imagery sampled as if shifted by (DE,DN)
    const g = ENU.toGeo(East - DE, North - DN);
    const [u, v] = aerialUVll(g.lat, g.lon);
    const [r, gr, b] = sampleAerial(u, v);
    const o = (j * PX + i) * 3;
    out[o] = r; out[o + 1] = gr; out[o + 2] = b;
  }
}
await sharp(out, { raw: { width: PX, height: PX, channels: 3 } }).png().toFile(OUT);
console.log(`[aerial-window] ${OUT}  window=±${HALF} m  ${PX}px  georef-offset dE=${DE} dN=${DN}`);
