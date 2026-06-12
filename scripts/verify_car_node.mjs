// Node verification of the Ferrari pipeline: GLTFLoader.parse + DracoShim +
// the asm.js decoder run as a classic sloppy-mode script via vm — the same
// execution context the browser injection uses. Run:
//   node scripts/verify_car_node.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// minimal browser-ish globals some three.js paths touch
globalThis.self = globalThis;

// Node-only accommodation: the Emscripten preamble sees `process` and takes
// its CJS branch (__dirname/require), which don't exist under ESM/vm. A real
// browser has no `process` and never enters that branch.
import { createRequire } from 'node:module';
globalThis.require = createRequire(import.meta.url);
globalThis.__dirname = root;
globalThis.__filename = path.join(root, 'src/vendor/draco_decoder.js');

// install the decoder exactly like draco-install.js does in the browser:
// classic script, sloppy mode, untransformed bytes
vm.runInThisContext(readFileSync(path.join(root, 'src/vendor/draco_decoder.js'), 'utf8'),
  { filename: 'draco_decoder.js' });

const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { DracoShim } = await import(path.join(root, 'src/engine/draco-shim.js'));

const glb = readFileSync(path.join(root, 'src/assets/ferrari.glb'));
const buf = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);

const t0 = Date.now();
let failed = setTimeout(() => {
  console.error('FAIL: decode did not complete within 60s');
  process.exit(1);
}, 60000);

DracoShim.onError = e => {
  clearTimeout(failed);
  console.error('FAIL: DracoShim error:', e);
  process.exit(1);
};

const loader = new GLTFLoader();
loader.setDRACOLoader(DracoShim);
loader.parse(buf, '', g => {
  clearTimeout(failed);
  const names = ['body', 'glass', 'wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
  const found = names.filter(n => g.scene.getObjectByName(n));
  let verts = 0;
  g.scene.traverse(o => { if (o.isMesh) verts += o.geometry.attributes.position.count; });
  console.log(`OK: decoded in ${Date.now() - t0}ms`);
  console.log(`nodes found: ${found.join(', ')}`);
  console.log(`total vertices: ${verts}`);
  if (found.length !== names.length) {
    console.error('FAIL: missing nodes:', names.filter(n => !found.includes(n)));
    process.exit(1);
  }
  process.exit(0);
}, err => {
  clearTimeout(failed);
  console.error('FAIL: GLTFLoader error:', err);
  process.exit(1);
});
