// KTX2 (Basis Universal) texture pass for the Da Hilg asset pipeline.
//
// GPU-compressed textures (KTX2/ETC1S) stay compressed in VRAM and upload fast —
// unlike webp/png, which decode to full RGBA on the GPU. We encode every texture in
// a gltf-transform Document to KTX2 in place (resizing to the per-class cap first),
// tag it image/ktx2, and declare KHR_texture_basisu. The runtime decodes it with a
// LOCAL basis transcoder (public/da-hilg/basis), so this stays offline-safe.
//
// Encoder: the Khronos `basisu` CLI (brew install basis_universal) or `toktx`. If
// NEITHER is on PATH we no-op and the caller keeps its webp textures — the pipeline
// still produces working assets; KTX2 just isn't applied. Per-texture failures also
// fall back to leaving the original image (a mixed webp/ktx2 glTF is valid).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { KHRTextureBasisu } from '@gltf-transform/extensions';

/** Absolute path to `bin` if it's on PATH, else null. */
function which(bin) {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** @returns {'basisu'|'toktx'|null} the first available KTX2 encoder, or null. */
export function ktx2Encoder() {
  if (which('basisu')) return 'basisu';
  if (which('toktx')) return 'toktx';
  return null;
}

/** Encode one PNG file to KTX2 with mipmaps using the chosen encoder. */
function encodeOne(encoder, inPng, outKtx) {
  if (encoder === 'basisu') {
    // ETC1S, mipmaps, max quality 255 (1..255). basisu treats input as sRGB by default.
    // ETC1S keeps disk small while transcoding to GPU-compressed formats (8x less VRAM
    // than RGBA). For near-lossless facades, swap to `-uastc` (see ASSET_PIPELINE.md).
    execFileSync('basisu', ['-ktx2', '-mipmap', '-q', '255', '-output_file', outKtx, inPng], {
      stdio: 'ignore',
    });
  } else {
    // toktx fallback: ETC1S (basis-lz) with mipmaps.
    execFileSync('toktx', ['--genmipmap', '--encode', 'etc1s', '--qlevel', '255', outKtx, inPng], {
      stdio: 'ignore',
    });
  }
}

/**
 * Encode every texture in `doc` to KTX2 in place (resized to `maxSize`). No-ops if no
 * encoder is on PATH. Returns a summary; the caller logs it.
 * @param {import('@gltf-transform/core').Document} doc
 * @param {{ maxSize?: number, label?: string }} [opts]
 * @returns {Promise<{ encoder: string|null, count: number, skipped: number }>}
 */
export async function ktx2CompressDoc(doc, { maxSize = 1024, label = '' } = {}) {
  const encoder = ktx2Encoder();
  if (!encoder) return { encoder: null, count: 0, skipped: 0 };

  // KHR_texture_basisu is a hard requirement to sample image/ktx2 — declare it required.
  const ext = doc.createExtension(KHRTextureBasisu).setRequired(true);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dahilg-ktx2-'));
  let count = 0;
  let skipped = 0;

  try {
    const textures = doc.getRoot().listTextures();
    for (let i = 0; i < textures.length; i++) {
      const tex = textures[i];
      const img = tex.getImage();
      if (!img || tex.getMimeType() === 'image/ktx2') {
        skipped++;
        continue;
      }
      const inPng = path.join(tmp, `t${i}.png`);
      const outKtx = path.join(tmp, `t${i}.ktx2`);
      try {
        // ETC1S/UASTC are 4x4-block formats — dimensions MUST be multiples of four or
        // the GPU rejects the upload. Downscale to fit the cap (never enlarge), then
        // round each side to the nearest multiple of 4 (sub-4px aspect change).
        const meta = await sharp(Buffer.from(img)).metadata();
        const sw = meta.width || maxSize;
        const sh = meta.height || maxSize;
        const scale = Math.min(1, maxSize / Math.max(sw, sh));
        const round4 = (n) => Math.max(4, Math.round((n * scale) / 4) * 4);
        await sharp(Buffer.from(img))
          .resize(round4(sw), round4(sh), { fit: 'fill' })
          .png()
          .toFile(inPng);
        encodeOne(encoder, inPng, outKtx);
        const bytes = readFileSync(outKtx);
        tex.setImage(new Uint8Array(bytes)).setMimeType('image/ktx2');
        count++;
      } catch (err) {
        // Leave the original (webp) image — a mixed glTF is valid.
        skipped++;
        console.warn(`    ! ktx2 skip ${label} tex#${i}: ${err.message}`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // If nothing got encoded, drop the dangling extension declaration.
  if (count === 0) ext.dispose();

  // If every webp texture became KTX2, the EXT_texture_webp declaration is now dead —
  // drop it so a strict viewer doesn't reject the file for an unused required ext.
  for (const e of doc.getRoot().listExtensionsUsed()) {
    if (e.extensionName === 'EXT_texture_webp' && e.listProperties().length === 0) e.dispose();
  }
  return { encoder, count, skipped };
}
