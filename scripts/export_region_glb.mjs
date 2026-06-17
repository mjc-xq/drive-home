// Build the regional terrain GLB: USGS 3DEP elevation over ±5 miles with the
// Mapbox satellite draped on top — terrain ONLY (no buildings/trees). Same
// curvature-correct ENU frame as the property/photoreal models (house at origin,
// x=East, y=Up=orthometric elevation, z=-North), so it overlays them.
//
// Run:  node scripts/export_region_glb.mjs
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

globalThis.self = globalThis;
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(b) { b.arrayBuffer().then(x => { this.result = x; this.onloadend && this.onloadend(); }); }
    readAsDataURL(b) { b.arrayBuffer().then(x => { this.result = `data:${b.type || 'application/octet-stream'};base64,${Buffer.from(x).toString('base64')}`; this.onloadend && this.onloadend(); }); }
  };
}

const THREE = await import('three');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
const { makeGeoENU } = await import('../src/engine/coords.js');
const { NodeIO } = await import('@gltf-transform/core');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const S = JSON.parse(readFileSync(path.join(ROOT, 'src/assets/scene.json'), 'utf8'));
const C = S.center, LAT0 = 37.6835313, LON0 = -122.0686199, COSLAT = Math.cos(LAT0 * Math.PI / 180), D2R = Math.PI / 180;
const houseLat = LAT0 + C[1] / 110540, houseLon = LON0 + C[0] / (COSLAT * 111320);
const ENU = makeGeoENU(houseLat, houseLon);

const D = JSON.parse(readFileSync(path.join(ROOT, 'exports/region_dem.json'), 'utf8'));
const SAT = JSON.parse(readFileSync(path.join(ROOT, 'exports/region_sat.json'), 'utf8'));
const { cols, rows, h } = D;
const dLat = D.latN - D.latS, dLon = D.lonE - D.lonW;
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2));
const sMyN = mercY(SAT.latN), sMyS = mercY(SAT.latS);

// terrain mesh: per-cell lat/lon -> ENU horizontal, Y = orthometric elevation
const pos = new Float32Array(rows * cols * 3), uv = new Float32Array(rows * cols * 2);
for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
  const k = j * cols + i;
  const lat = D.latN - (j + 0.5) / rows * dLat, lon = D.lonW + (i + 0.5) / cols * dLon;
  const [E, N] = ENU.toEN(lat, lon);
  pos[k * 3] = E; pos[k * 3 + 1] = h[k]; pos[k * 3 + 2] = -N;
  uv[k * 2] = (lon - SAT.lonW) / (SAT.lonE - SAT.lonW);
  uv[k * 2 + 1] = (mercY(lat) - sMyS) / (sMyN - sMyS);
}
const idx = new Uint32Array((rows - 1) * (cols - 1) * 6);
let o = 0;
for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
  const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
  idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
}
const g = new THREE.BufferGeometry();
g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
g.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
g.computeVertexNormals();
const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, name: 'RegionTerrain_mat' });
const scene = new THREE.Scene(); scene.name = '1840_Dahill_Region';
const mesh = new THREE.Mesh(g, mat); mesh.name = 'RegionTerrain'; scene.add(mesh);

const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false });
// embed the satellite via gltf-transform (GLTFExporter can't encode images in Node)
const io = new NodeIO();
const doc = await io.readBinary(new Uint8Array(glb));
const tex = doc.createTexture('region_sat').setImage(new Uint8Array(readFileSync(path.join(ROOT, 'exports/region_sat.jpg')))).setMimeType('image/jpeg');
for (const m of doc.getRoot().listMaterials()) {
  m.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(tex);
  m.getBaseColorTextureInfo().setWrapS(33071).setWrapT(33071);  // CLAMP
}
mkdirSync(path.join(ROOT, 'exports'), { recursive: true });
const out = path.join(ROOT, 'exports', '1840-dahill-region.glb');
writeFileSync(out, Buffer.from(await io.writeBinary(doc)));
g.computeBoundingBox();
const bb = g.boundingBox, f = n => n.toFixed(0);
console.log(`region terrain ${cols}x${rows} (${((rows - 1) * (cols - 1) * 2 / 1e6).toFixed(1)}M tris)`);
console.log(`world bbox X[${f(bb.min.x)},${f(bb.max.x)}] Y[${f(bb.min.y)},${f(bb.max.y)}] Z[${f(bb.min.z)},${f(bb.max.z)}] m`);
console.log(`wrote ${out} (${(statSync(out).size / 1048576).toFixed(1)} MB)`);
