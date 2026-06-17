// Extract Google Photorealistic 3D Tiles over the property into a single textured
// GLB layer (exports/1840-dahill-photoreal.glb), in the SAME curvature-correct ENU
// world frame as 1840-dahill-property.glb (house at origin, x=East, y=Up, z=-North).
//
// NOTE (ToS): Google's Photorealistic 3D Tiles terms allow live streaming via
// approved renderers, not caching tiles into a stored asset. This bakes them to a
// file for a personal model of your own property — keep that in mind.
//
// Run:  node scripts/fetch_photoreal.mjs [radius_m] [geomErrorTarget]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const R_PR = Number(process.argv[2] || 150);          // half-box around the house (m)
const TARGET = Number(process.argv[3] || 4);          // geometric-error LOD target
const CAP = 900;                                      // max leaf tiles

const env = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const KEY = (env.match(/NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=(.*)/) || [])[1]?.trim().replace(/^["']|["']$/g, '');
if (!KEY) throw new Error('no NEXT_PUBLIC_GOOGLE_MAPS_API_KEY in .env.local');
const HOST = 'https://tile.googleapis.com';

// ---- house origin + ECEF->ENU(world) (matches scripts/geo.py / coords.js) -----
const S = JSON.parse(readFileSync(path.join(ROOT, 'src/assets/scene.json'), 'utf8'));
const C = S.center, LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * Math.PI / 180), D2R = Math.PI / 180;
const HLAT = LAT0 + C[1] / 110540, HLON = LON0 + C[0] / (COSLAT * 111320);
const WA = 6378137, WE2 = 0.00669437999014;
function ecef(latDeg, lonDeg, h = 0) {
  const la = latDeg * D2R, lo = lonDeg * D2R, sla = Math.sin(la), cla = Math.cos(la), slo = Math.sin(lo), clo = Math.cos(lo);
  const n = WA / Math.sqrt(1 - WE2 * sla * sla);
  return [(n + h) * cla * clo, (n + h) * cla * slo, (n * (1 - WE2) + h) * sla];
}
// anchor at the geoid (GEOID18 N≈-32.3 m here) so world Y ≈ NAVD88 orthometric
// elevation, matching the property model's DEM heights for vertical overlay.
const GEOID_N = -32.3;
const E0 = ecef(HLAT, HLON, GEOID_N), sla = Math.sin(HLAT * D2R), cla = Math.cos(HLAT * D2R), slo = Math.sin(HLON * D2R), clo = Math.cos(HLON * D2R);
// rows of R: world = (East, Up, -North)
const Rx = [-slo, clo, 0], Ry = [cla * clo, cla * slo, sla], Rz = [sla * clo, sla * slo, -cla];
const dot = (r, p) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2];
// column-major 4x4 mapping ECEF -> world
const W4 = [Rx[0], Ry[0], Rz[0], 0, Rx[1], Ry[1], Rz[1], 0, Rx[2], Ry[2], Rz[2], 0, -dot(Rx, E0), -dot(Ry, E0), -dot(Rz, E0), 1];
// Google's glb node matrices are y-up: their output is (ecefX, ecefZ, -ecefY).
// This rotates that y-up frame back to true ECEF before W4.
const YUP2ECEF = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) { const c = new Array(16); for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k]; c[col * 4 + row] = s; } return c; }
function tp(m, x, y, z) { return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]; }

// ---- region box around the house (radians) ------------------------------
const dLat = R_PR / 110990, dLon = R_PR / (111320 * Math.cos(HLAT * D2R));
const RBOX = [(HLON - dLon) * D2R, (HLAT - dLat) * D2R, (HLON + dLon) * D2R, (HLAT + dLat) * D2R];
// Google uses OBB `box` volumes (ECEF, since tile transforms are identity); also
// handles `region` (lat/lon radians). Keep tiles whose volume is within R_PR of the house.
function hit(bv) {
  if (bv?.box) {
    const b = bv.box, dx = E0[0] - b[0], dy = E0[1] - b[1], dz = E0[2] - b[2];
    for (let a = 0; a < 3; a++) {
      const ox = b[3 + a * 3], oy = b[4 + a * 3], oz = b[5 + a * 3], len = Math.hypot(ox, oy, oz) || 1;
      if (Math.abs((dx * ox + dy * oy + dz * oz) / len) > len + R_PR) return false;
    }
    return true;
  }
  if (bv?.region) { const r = bv.region; return r[0] <= RBOX[2] && RBOX[0] <= r[2] && r[1] <= RBOX[3] && RBOX[1] <= r[3]; }
  return true;
}

// ---- tileset traversal with session + transform accumulation ------------
let session = null;
const absu = u => u.startsWith('http') ? u : HOST + u;
function url(u) { let s = absu(u); const q = []; if (!/[?&]key=/.test(s)) q.push('key=' + KEY); if (session && !/[?&]session=/.test(s)) q.push('session=' + session); return s + (q.length ? (s.includes('?') ? '&' : '?') + q.join('&') : ''); }
function grab(obj) { const m = JSON.stringify(obj).match(/[?&]session=([^&"]+)/); if (m) session = m[1]; }
async function gj(u) { const r = await fetch(url(u)); if (!r.ok) throw new Error(r.status + ' ' + u.slice(0, 70)); const j = await r.json(); grab(j); return j; }

const leaves = [];
async function walk(tile, mat) {
  if (leaves.length >= CAP) return;
  const m = tile.transform ? mul(mat, tile.transform) : mat;
  const uri = tile.content?.uri;
  if (uri && /\.json/i.test(uri)) { const sub = await gj(uri); await walk(sub.root, m); return; }
  const kids = (tile.children || []).filter(k => hit(k.boundingVolume));
  const take = uri && /\.glb/i.test(uri) && (kids.length === 0 || (tile.geometricError || 0) <= TARGET);
  if (take) { leaves.push({ uri: absu(uri), mat: m }); return; }
  for (const k of kids) await walk(k, m);
}

console.log(`[photoreal] box ±${R_PR} m, geomError<=${TARGET}, anchor ${HLAT.toFixed(6)},${HLON.toFixed(6)}`);
const root = await gj('/v1/3dtiles/root.json');
await walk(root.root, IDENT);
console.log(`[photoreal] ${leaves.length} leaf tiles${leaves.length >= CAP ? ' (capped)' : ''}`);
if (!leaves.length) throw new Error('no tiles in region — check key/quota');

// ---- merge tiles into one textured GLB ----------------------------------
const { NodeIO } = await import('@gltf-transform/core');
const { KHRMaterialsUnlit, KHRDracoMeshCompression } = await import('@gltf-transform/extensions');
const draco3d = (await import('draco3dgltf')).default;
const io = new NodeIO().registerExtensions([KHRMaterialsUnlit, KHRDracoMeshCompression])
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });

const out = new (await import('@gltf-transform/core')).Document();
const buffer = out.createBuffer();
const unlit = out.createExtension(KHRMaterialsUnlit);
const scene = out.createScene('Photoreal');
const node = out.createNode('Photoreal').setMesh(out.createMesh('Photoreal'));
scene.addChild(node);
const mesh = node.getMesh();
let prims = 0, lo = [1e9, 1e9, 1e9], hiB = [-1e9, -1e9, -1e9];

for (let t = 0; t < leaves.length; t++) {
  const { uri, mat } = leaves[t];
  let bytes;
  try { bytes = new Uint8Array(await (await fetch(url(uri))).arrayBuffer()); }
  catch (e) { continue; }
  let doc;
  try { doc = await io.readBinary(bytes); } catch (e) { continue; }
  for (const n of doc.getRoot().listNodes()) {
    const m = n.getMesh(); if (!m) continue;
    const fm = mul(W4, mul(YUP2ECEF, mul(mat, n.getMatrix())));   // mesh-local(y-up) -> ECEF -> world
    for (const prim of m.listPrimitives()) {
      const pa = prim.getAttribute('POSITION'); if (!pa) continue;
      const src = pa.getArray(), pos = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        const w = tp(fm, src[i], src[i + 1], src[i + 2]);
        pos[i] = w[0]; pos[i + 1] = w[1]; pos[i + 2] = w[2];
        for (let k = 0; k < 3; k++) { if (w[k] < lo[k]) lo[k] = w[k]; if (w[k] > hiB[k]) hiB[k] = w[k]; }
      }
      const mp = out.createAccessor().setBuffer(buffer).setType('VEC3').setArray(pos);
      const np = out.createPrimitive().setAttribute('POSITION', mp);
      const uv = prim.getAttribute('TEXCOORD_0');
      if (uv) np.setAttribute('TEXCOORD_0', out.createAccessor().setBuffer(buffer).setType('VEC2').setArray(uv.getArray().slice()));
      const idx = prim.getIndices();
      if (idx) np.setIndices(out.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(idx.getArray().slice()));
      const mat2 = out.createMaterial().setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(1).setMetallicFactor(0);
      mat2.setExtension('KHR_materials_unlit', unlit.createUnlit());
      const tex = prim.getMaterial()?.getBaseColorTexture();
      if (tex) { mat2.setBaseColorTexture(out.createTexture().setImage(tex.getImage()).setMimeType(tex.getMimeType() || 'image/jpeg')); }
      np.setMaterial(mat2);
      mesh.addPrimitive(np); prims++;
    }
  }
  if (t % 100 === 99) console.log(`  ...${t + 1}/${leaves.length} tiles`);
}

mkdirSync(path.join(ROOT, 'exports'), { recursive: true });
const dst = path.join(ROOT, 'exports', '1840-dahill-photoreal.glb');
writeFileSync(dst, Buffer.from(await io.writeBinary(out)));
const f = n => n.toFixed(1);
console.log(`[photoreal] ${prims} primitives  world bbox X[${f(lo[0])},${f(hiB[0])}] Y[${f(lo[1])},${f(hiB[1])}] Z[${f(lo[2])},${f(hiB[2])}]`);
console.log(`[photoreal] wrote ${dst} (${(Buffer.from(readFileSync(dst)).length / 1048576).toFixed(1)} MB)`);
