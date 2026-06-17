// Compress a SKINNED character GLB: resize textures via macOS `sips` (1024 JPEG) + quantize geometry
// (KHR_mesh_quantization, stock-loadable). NO simplify/weld/prune/dedup — those strip the skin or
// mangle skin weights (verified on dad). Usage:
//   node scripts/compress_character.mjs src/assets/mom.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { quantize } from '@gltf-transform/functions';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, statSync } from 'node:fs';

const glb = process.argv[2];
if (!glb) { console.error('usage: node scripts/compress_character.mjs <glb>'); process.exit(1); }
const before = statSync(glb).size;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(glb);

let i = 0;
for (const tex of doc.getRoot().listTextures()) {
  const img = tex.getImage();
  if (!img) continue;
  const ext = tex.getMimeType() === 'image/png' ? 'png' : 'jpg';
  const inP = `/tmp/char_${i}.${ext}`, outP = `/tmp/char_${i}_out.jpg`;
  writeFileSync(inP, Buffer.from(img));
  execFileSync('sips', ['-Z', '1024', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', inP, '--out', outP]);
  tex.setImage(new Uint8Array(readFileSync(outP)));
  tex.setMimeType('image/jpeg');
  i++;
}
await doc.transform(quantize());
await io.write(glb, doc);
console.log(`${glb}: ${(before / 1e6).toFixed(1)} MB -> ${(statSync(glb).size / 1e6).toFixed(1)} MB`);
