// One-time asset compressor for src/assets/dad.glb. The Meshy export is ~38.6 MB — almost all of
// it a single 28 MB PNG, plus 220k uncompressed tris. The kids are small because they're
// Draco+webp; dad can't use Draco without the runtime DracoShim, so instead we:
//   - resize/recompress the texture with macOS `sips` (PNG -> 1024 JPEG),
//   - weld + quantize (KHR_mesh_quantization, which the stock GLTFLoader + drew.glb already use)
//     + prune + dedup the geometry.
// Result loads with the plain GLTFLoader (no Draco/meshopt runtime needed). Re-run:
//   node scripts/compress_dad.mjs
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { quantize } from '@gltf-transform/functions';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const glb = path.join(root, 'src/assets/dad.glb');
const before = statSync(glb).size;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(glb);

// Texture: dump the PNG, let sips downsize + transcode to JPEG, fold it back in.
for (const tex of doc.getRoot().listTextures()) {
  const img = tex.getImage();
  if (!img) continue;
  writeFileSync('/tmp/dad_tex_in.png', Buffer.from(img));
  execFileSync('sips', ['-Z', '1024', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '/tmp/dad_tex_in.png', '--out', '/tmp/dad_tex_out.jpg']);
  tex.setImage(new Uint8Array(readFileSync('/tmp/dad_tex_out.jpg')));
  tex.setMimeType('image/jpeg');
}

// quantize ONLY — prune/weld/dedup were stripping the skin and would break dad's animation.
await doc.transform(quantize());
await io.write(glb, doc);

const after = statSync(glb).size;
console.log(`dad.glb: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`);
