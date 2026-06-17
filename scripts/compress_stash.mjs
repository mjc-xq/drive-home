// One-time compressor for src/assets/stash.glb (the bearded-dragon cage). The Meshy export is ~28 MB
// (636k tris + 9 MB of JPEGs). It's a STATIC mesh (no skin), so unlike the characters we can also
// SIMPLIFY it. Pipeline: resize textures via macOS `sips` (1024 JPEG) + weld + meshopt-simplify +
// quantize (KHR_mesh_quantization, stock-loadable) + prune + dedup. Re-run:
//   node scripts/compress_stash.mjs
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, quantize, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const glb = path.join(root, 'src/assets/stash.glb');
const before = statSync(glb).size;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(glb);

let i = 0;
for (const tex of doc.getRoot().listTextures()) {
  const img = tex.getImage();
  if (!img) continue;
  const inP = `/tmp/stash_${i}.jpg`, outP = `/tmp/stash_${i}_out.jpg`;
  writeFileSync(inP, Buffer.from(img));
  execFileSync('sips', ['-Z', '1024', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', inP, '--out', outP]);
  tex.setImage(new Uint8Array(readFileSync(outP)));
  tex.setMimeType('image/jpeg');
  i++;
}

await MeshoptSimplifier.ready;
await doc.transform(
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: 0.3, error: 0.008 }),   // 636k -> ~190k tris, edges preserved
  quantize(),
  prune(),
  dedup(),
);
await io.write(glb, doc);
console.log(`stash.glb: ${(before / 1e6).toFixed(1)} MB -> ${(statSync(glb).size / 1e6).toFixed(1)} MB`);
