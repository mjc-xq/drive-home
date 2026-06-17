// Node sanity-check of the house-interior GLB structure + the floor-recenter math, with NO
// three.js (the GLB has JPEG textures that a headless three.js can't decode). It reads the GLB
// JSON chunk directly: names live on NODES (every mesh.name is undefined), and POSITION accessors
// carry min/max so we can verify bounds + the floor-top height without decoding geometry.
//   node scripts/verify_interior_node.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buf = readFileSync(path.join(root, 'src/assets/house-interior.glb'));
const jsonLen = buf.readUInt32LE(12);                       // chunk0 (JSON) length; data starts at byte 20
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));

const acc = json.accessors, meshes = json.meshes, nodes = json.nodes;
const meshNodes = nodes.filter(n => n.mesh != null);
const posAccessors = mi => meshes[mi].primitives.map(p => acc[p.attributes.POSITION]);
const cat = n => { const x = n.name || ''; return /^floor_/.test(x) ? 'floor' : /^(wall_|joint_)/.test(x) ? 'wall' : /^door_/.test(x) ? 'door' : /^window_/.test(x) ? 'window' : 'furniture'; };

const counts = {};
for (const n of meshNodes) counts[cat(n)] = (counts[cat(n)] || 0) + 1;

const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (const n of meshNodes) for (const a of posAccessors(n.mesh)) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], a.min[i]); hi[i] = Math.max(hi[i], a.max[i]); }
let floorTop = -Infinity;
for (const n of meshNodes) if (/^floor_/.test(n.name || '')) for (const a of posAccessors(n.mesh)) floorTop = Math.max(floorTop, a.max[1]);

console.log('meshes:', meshes.length, '| images:', (json.images || []).length, '| animations:', (json.animations || []).length, '| extensionsUsed:', (json.extensionsUsed || []).join(', ') || '(none)');
console.log('node categories:', JSON.stringify(counts));
console.log('bounds  min:', lo.map(v => +v.toFixed(2)), ' max:', hi.map(v => +v.toFixed(2)), ' size:', hi.map((v, i) => +(v - lo[i]).toFixed(2)));
console.log('floor top y:', +floorTop.toFixed(3), '  -> recenter lift so floor TOP = 0:', +(-floorTop).toFixed(3), '  ceiling height:', +(hi[1] - floorTop).toFixed(2));

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail++; } };
// Generic checks — the loader is name-driven, so a re-scan with more/fewer rooms must still pass.
ok(meshes.length >= 50, `expected a substantial mesh count, got ${meshes.length}`);
ok((json.animations || []).length === 0, 'expected 0 animations (plain interior scan)');
ok(!(json.extensionsUsed || []).includes('KHR_draco_mesh_compression'), 'interior must be plain (no Draco) for the stock GLTFLoader path');
ok(counts.floor >= 5, `expected >=5 floor_* nodes, got ${counts.floor}`);
ok(counts.wall >= 10, `expected wall_*/joint_* nodes, got ${counts.wall}`);
ok(counts.door >= 1, `expected door_* nodes, got ${counts.door}`);
ok(counts.window >= 1, `expected window_* nodes, got ${counts.window}`);
ok(meshNodes.some(n => /^sofa/.test(n.name || '')), 'expected a sofa_* node for the couch swap');
ok(isFinite(floorTop), 'floor top y computed from floor_* nodes');
ok(hi[1] - floorTop > 2 && hi[1] - floorTop < 6, `ceiling height should be ~2-6 m, got ${(hi[1] - floorTop).toFixed(2)}`);

if (fail) { console.error(`\n${fail} check(s) FAILED`); process.exit(1); }
console.log('\nOK: interior GLB structure + recenter math verified');
