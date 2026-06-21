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

/**
 * Encode one PNG file to KTX2 with mipmaps using the chosen encoder.
 * @param {'basisu'|'toktx'} encoder
 * @param {string} inPng
 * @param {string} outKtx
 * @param {boolean} [hq=false] high-quality (no RDO): keeps fine painted detail (lane/curb on the
 *   ground albedo, facade text) crisp at the cost of a larger file. RDO trades a little fidelity
 *   for size, which smears the painted road lines — so the big ground/facade textures opt out.
 */
function encodeOne(encoder, inPng, outKtx, hq = false) {
  if (encoder === 'basisu') {
    // UASTC (near-lossless 4x4) + KTX2 zstd supercompression. ETC1S badly desaturated /
    // washed out the photographic content (Street View facades + aerial ground); UASTC keeps the
    // colour. RDO (-uastc_rdo_l) trades fidelity for disk size — fine for most maps but it smears
    // the crisp painted lane/curb lines, so `hq` textures skip RDO entirely. sRGB by default.
    const args = ['-ktx2', '-uastc'];
    if (!hq) args.push('-uastc_rdo_l', '1.0');
    args.push('-mipmap', '-output_file', outKtx, inPng);
    execFileSync('basisu', args, { stdio: 'ignore' });
  } else {
    // toktx fallback: UASTC + zstd supercompression.
    execFileSync('toktx', ['--genmipmap', '--encode', 'uastc', '--zcmp', '18', outKtx, inPng], {
      stdio: 'ignore',
    });
  }
}

/**
 * Encode every texture in `doc` to KTX2 in place (resized to a per-texture cap). No-ops if
 * no encoder is on PATH. Returns a summary; the caller logs it.
 *
 * `maxSize` is the DEFAULT per-texture pixel cap. `capFor(tex, i)` (optional) overrides it
 * per texture: return a number (a custom cap) or `{ maxSize, hq }` ({ hq:true } => no-RDO,
 * high-quality encode for textures whose fine painted/photographic detail must stay crisp —
 * the large ground albedo + facade atlas pages). Returning a falsy value keeps the default.
 *
 * @param {import('@gltf-transform/core').Document} doc
 * @param {{ maxSize?: number, label?: string, capFor?: (tex: import('@gltf-transform/core').Texture, i: number) => (number | { maxSize?: number, hq?: boolean } | null | undefined) }} [opts]
 * @returns {Promise<{ encoder: string|null, count: number, skipped: number }>}
 */
export async function ktx2CompressDoc(doc, { maxSize = 1024, label = '', capFor = null } = {}) {
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
        // Resolve the per-texture cap + quality. capFor() may return a bare number (cap) or
        // { maxSize, hq }; anything falsy falls back to the document-wide default.
        let cap = maxSize;
        let hq = false;
        const override = capFor ? capFor(tex, i) : null;
        if (typeof override === 'number') cap = override;
        else if (override && typeof override === 'object') {
          if (typeof override.maxSize === 'number') cap = override.maxSize;
          if (override.hq) hq = true;
        }
        // ETC1S/UASTC are 4x4-block formats — dimensions MUST be multiples of four or
        // the GPU rejects the upload. Downscale to fit the cap (never enlarge), then
        // round each side to the nearest multiple of 4 (sub-4px aspect change).
        const meta = await sharp(Buffer.from(img)).metadata();
        const sw = meta.width || cap;
        const sh = meta.height || cap;
        const scale = Math.min(1, cap / Math.max(sw, sh));
        const round4 = (n) => Math.max(4, Math.round((n * scale) / 4) * 4);
        await sharp(Buffer.from(img))
          .resize(round4(sw), round4(sh), { fit: 'fill' })
          .png()
          .toFile(inPng);
        encodeOne(encoder, inPng, outKtx, hq);
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
