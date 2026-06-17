// Compress a STATIC prop GLB (no skin): resize textures (sips 1024 JPEG) + weld + meshopt-simplify +
// quantize + prune + dedup. Usage: node scripts/compress_prop.mjs <glb> [ratio]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, quantize, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, statSync } from 'node:fs';
const glb = process.argv[2]; const ratio = process.argv[3] ? +process.argv[3] : 0.15;
if (!glb) { console.error('usage: node scripts/compress_prop.mjs <glb> [ratio]'); process.exit(1); }
const before = statSync(glb).size;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(glb);
let i = 0;
for (const tex of doc.getRoot().listTextures()) {
  const img = tex.getImage(); if (!img) continue;
  const ext = tex.getMimeType() === 'image/png' ? 'png' : 'jpg';
  const inP = `/tmp/prop_${i}.${ext}`, outP = `/tmp/prop_${i}_out.jpg`;
  writeFileSync(inP, Buffer.from(img));
  execFileSync('sips', ['-Z', '1024', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', inP, '--out', outP]);
  tex.setImage(new Uint8Array(readFileSync(outP))); tex.setMimeType('image/jpeg'); i++;
}
await MeshoptSimplifier.ready;
await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01 }), quantize(), prune(), dedup());
await io.write(glb, doc);
console.log(`${glb}: ${(before / 1e6).toFixed(1)} MB -> ${(statSync(glb).size / 1e6).toFixed(1)} MB`);
