// Re-source building heights from OSM (height tag, else building:levels x ~3.5m) and write them
// into exports/<level>/scene.json buildings[].h, matched by footprint centroid. Reliable, ODbL.
// Used after the photoreal-massing sampler proved unreliable (caught neighbor towers -> inflated).
// Usage: node scripts/fetch_osm_heights.mjs xq
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SLUG = process.argv[2] || 'xq';
const SCENE = path.join(ROOT, 'exports', SLUG, 'scene.json');
const scene = JSON.parse(readFileSync(SCENE, 'utf8'));
const O = scene.origin, C = scene.center || [0, 0];
const LAT0 = O.lat, LON0 = O.lon, COSLAT = Math.cos(LAT0 * Math.PI / 180);
const ll2world = (lat, lon) => { const e = (lon - LON0) * COSLAT * 111320, n = (lat - LAT0) * 110540; return [e - C[0], -(n - C[1])]; };
// scene footprints are ENU (e,n); w2 -> world XZ
const w2 = (e, n) => [e - C[0], -(n - C[1])];
const cents = scene.buildings.map(b => { const r = (b.p || []).map(([e, n]) => w2(e, n)); if (!r.length) return null; return [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length]; });

// bbox around the building extent (+margin)
let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
for (const c of cents) { if (!c) continue; const lat = LAT0 + (-c[1]) / 110540, lon = LON0 + c[0] / (COSLAT * 111320); if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat; if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon; }
const M = 0.001; const bbox = `${(minLat - M).toFixed(5)},${(minLon - M).toFixed(5)},${(maxLat + M).toFixed(5)},${(maxLon + M).toFixed(5)}`;
const q = `[out:json][timeout:60];way[building](${bbox});out tags center;`;
const EPS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
async function overpass() {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    const ep = EPS[attempt % EPS.length];
    try {
      const res = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
      const txt = await res.text();
      if (res.ok && txt.trim().startsWith('{')) return JSON.parse(txt);
      last = `HTTP ${res.status} from ${ep}: ${txt.slice(0, 100)}`;
    } catch (e) { last = `${ep}: ${e.message}`; }
    await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
  }
  throw new Error('overpass failed: ' + last);
}
const data = await overpass();
const parseH = t => {
  if (!t) return null;
  if (t.height) { const m = parseFloat(String(t.height).replace(/[^0-9.]/g, '')); if (m > 1.5 && m < 400) return m; }
  if (t['building:levels']) { const lv = parseFloat(t['building:levels']); if (lv >= 1 && lv < 120) return +(4.0 + (lv - 1) * 3.4).toFixed(1); } // ground floor taller
  return null;
};
const osm = data.elements.filter(e => e.center).map(e => ({ w: ll2world(e.center.lat, e.center.lon), h: parseH(e.tags) })).filter(o => o.h);
let matched = 0, deflt = 0; const DEFAULT = 9.0; const MAXD = 14;
scene.buildings.forEach((b, i) => {
  const c = cents[i]; if (!c) { return; }
  let best = Infinity, bh = null;
  for (const o of osm) { const d = Math.hypot(o.w[0] - c[0], o.w[1] - c[1]); if (d < best) { best = d; bh = o.h; } }
  if (bh != null && best <= MAXD) { b.h = bh; matched++; }
  else {
    // no OSM height nearby -> estimate storeys from footprint area + a deterministic jitter so the
    // block isn't a flat monolith (kills the inflated sampler values AND the flat-9m sea).
    const r = (b.p || []).map(([e, n]) => w2(e, n));
    let area = 0; for (let k = 0; k < r.length; k++) { const a = r[k], c2 = r[(k + 1) % r.length]; area += a[0] * c2[1] - c2[0] * a[1]; } area = Math.abs(area) / 2;
    const storeys = area < 150 ? 1.5 : area < 400 ? 2.5 : area < 900 ? 3.5 : 5;
    const jit = (((i * 37) % 5) - 2) * 0.3;
    b.h = +(4.0 + (storeys - 1) * 3.4 + jit).toFixed(1);
    deflt++;
  }
});
writeFileSync(SCENE, JSON.stringify(scene));
const hs = scene.buildings.map(b => b.h).sort((a, b) => a - b);
console.log(`[${SLUG}] OSM heights: matched ${matched}, default ${deflt} (of ${scene.buildings.length}); OSM source rows ${osm.length}`);
console.log(`  height range ${hs[0]}..${hs[hs.length - 1]}m  median ${hs[hs.length >> 1]}m  over30 ${hs.filter(h => h > 30).length}`);
