// Compress an ANIMATED/SKINNED animal GLB by shrinking ONLY its textures (the
// dominant cost) — meshes, skins and animation clips are left untouched so the
// walk cycle and bind pose survive intact. Textures used by a non-OPAQUE
// material keep their alpha (resized PNG); opaque ones become smaller JPEGs.
//   node scripts/compress_animal.mjs <glb> [maxDim=1024] [jpegQ=85]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup } from '@gltf-transform/functions';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, statSync } from 'node:fs';

const glb = process.argv[2];
const maxDim = process.argv[3] ? +process.argv[3] : 1024;
const jpegQ = process.argv[4] ? +process.argv[4] : 85;
if (!glb) { console.error('usage: node scripts/compress_animal.mjs <glb> [maxDim] [jpegQ]'); process.exit(1); }

const before = statSync(glb).size;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(glb);
const root = doc.getRoot();

// Textures bound to a transparent/cutout material must keep their alpha channel.
const needsAlpha = new Set();
for (const m of root.listMaterials()) {
  if (m.getAlphaMode() === 'OPAQUE') continue;
  for (const t of [m.getBaseColorTexture(), m.getEmissiveTexture()]) if (t) needsAlpha.add(t);
}

let i = 0;
for (const tex of root.listTextures()) {
  const img = tex.getImage(); if (!img) continue;
  const keepPng = needsAlpha.has(tex);
  const srcExt = tex.getMimeType() === 'image/png' ? 'png' : 'jpg';
  const inP = `/tmp/animal_${i}.${srcExt}`;
  const outP = `/tmp/animal_${i}_out.${keepPng ? 'png' : 'jpg'}`;
  writeFileSync(inP, Buffer.from(img));
  const fmt = keepPng
    ? ['-Z', String(maxDim), '-s', 'format', 'png']
    : ['-Z', String(maxDim), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(jpegQ)];
  execFileSync('sips', [...fmt, inP, '--out', outP]);
  tex.setImage(new Uint8Array(readFileSync(outP)));
  tex.setMimeType(keepPng ? 'image/png' : 'image/jpeg');
  i++;
}

await doc.transform(dedup());   // merge duplicate accessors/textures; leave skeleton + clips intact
await io.write(glb, doc);
console.log(`${glb}: ${(before / 1e6).toFixed(1)} MB -> ${(statSync(glb).size / 1e6).toFixed(1)} MB`);
