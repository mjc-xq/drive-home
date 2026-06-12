import dracoSrc from '../vendor/draco_decoder.js?raw';

// The r128 asm.js decoder runs as a classic SLOPPY-MODE script — exactly how
// the original artifact inlined it. The ?raw import keeps the decoder bytes
// untransformed/unminified by the bundler (minifying the asm.js body would
// break its validation fast-path), and ESM-wrapping it breaks the Emscripten
// preamble under Node (strict mode + its CJS __dirname branch).
// This is an inline script injection, NOT eval — the artifact webview allows
// inline scripts (the whole artifact is one) while blocking eval and Workers.
export function installDracoDecoder() {
  if (globalThis.DracoDecoderModule) return;
  const s = document.createElement('script');
  s.textContent = dracoSrc;
  document.head.appendChild(s);
}
