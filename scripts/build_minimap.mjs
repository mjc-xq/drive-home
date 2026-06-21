// Build the 2D minimap line-art (roads/driveways/sidewalks/curbs/lines) for Da Hilg.
//
// Reads the SOURCE level export (exports/1840-dahill-property-trees.glb — the SAME export
// build_dahilg_assets.mjs bakes the runtime level + level.meta.json from) — NOT public/
// da-hilg/level.glb, whose mesh names are stripped — extracts the named road meshes (all TRIANGLES),
// projects their vertices to RECENTERED XZ (subtract the same offset the asset build computes
// for level.meta.json), runs BOUNDARY-EDGE extraction per mesh (undirected edges used by
// exactly one triangle => crisp silhouette outlines), and emits a compact set of 2D segments
// per layer to public/da-hilg/minimap.json.
//
// Run:  node scripts/build_minimap.mjs   (or: npm run build:minimap)
import { NodeIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import { writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = (...p) => path.join(ROOT, ...p);

// Per-level config keyed by slug (process.argv[2], default 'dahill'). Each entry's `src`
// stays in lockstep with build_dahilg_assets.mjs's LEVELS so the road line-art shares the
// exact geometry (and recenter offset) of the level the game actually loads. dahill keeps
// the legacy minimap.json name; canyon/stanton get slug-prefixed outputs.
const LEVEL_CONFIG = {
  dahill:  { src: '1840-dahill-property.glb',         out: 'minimap.json' },
  canyon:  { src: 'canyon-middle-school-property.glb', out: 'canyon.minimap.json' },
  stanton: { src: 'stanton-elementary-property.glb',  out: 'stanton.minimap.json' },
  meemaw:  { src: 'meemaw-property.glb',               out: 'meemaw.minimap.json' },
  xq:      { src: 'xq-property.glb',                    out: 'xq.minimap.json' },
};
const SLUG = process.argv[2] || 'dahill';
const cfg = LEVEL_CONFIG[SLUG];
if (!cfg) {
  throw new Error(`minimap: unknown level slug "${SLUG}". Expected one of: ${Object.keys(LEVEL_CONFIG).join(', ')}.`);
}
const LEVEL_SRC = SRC('exports', cfg.src);
const OUT = SRC('public', 'da-hilg', cfg.out);

const io = new NodeIO()
  .setLogger(new Logger(Logger.Verbosity.ERROR))
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });

console.log(`\n=== Da Hilg minimap build (${SLUG}) ===`);
const doc = await io.read(LEVEL_SRC);
const root = doc.getRoot();
const nodeByName = (nm) => root.listNodes().find((n) => n.getName() === nm);

// -------------------------------------------------------------------------------------
// offset = [houseCenterX, groundY, houseCenterZ] — IDENTICAL to the asset build's recenter
// (House_walls center for XZ, Collision_Terrain min-Y for ground). Subtract from world coords.
// -------------------------------------------------------------------------------------
const terrain = nodeByName('Collision_Terrain');
const house = nodeByName('House_walls');
if (!terrain) throw new Error('minimap: Collision_Terrain missing — cannot compute offset.');
if (!house) throw new Error('minimap: House_walls missing — cannot compute offset.');
const tB = getBounds(terrain), hB = getBounds(house);
const groundY = tB.min[1];
const houseCenter = [(hB.min[0] + hB.max[0]) / 2, (hB.min[1] + hB.max[1]) / 2, (hB.min[2] + hB.max[2]) / 2];
const offset = [houseCenter[0], groundY, houseCenter[2]];
console.log(`  offset = [${offset.map((v) => v.toFixed(3)).join(', ')}]  (subtract from world coords)`);

// Layer map: mesh name -> output layer key.
const LAYERS = [
  { name: 'Roads',            layer: 'road' },
  { name: 'Driveways',        layer: 'drive' },
  { name: 'Driveways_Mapped', layer: 'drive' },
  { name: 'Sidewalks',        layer: 'walk' },
  { name: 'RoadCurbs',        layer: 'curb' },
  { name: 'RoadLines',        layer: 'line' },
];

// -------------------------------------------------------------------------------------
// Read a node's world-space vertices + triangle indices. The road nodes carry identity
// transforms (verified: T=0 R=identity S=1, no parent), and POSITION is FLOAT in this source
// export, so accessor values are already world coords. We still go through getWorldMatrix()
// + a per-vertex transform so the script stays correct if a future export adds a transform
// or int16-quantizes positions (gltf-transform dequantizes on read; we never mutate the
// int16 buffer in place — we read each component and transform a fresh vector).
// -------------------------------------------------------------------------------------
function readWorldTris(node) {
  const mesh = node.getMesh();
  const wm = node.getWorldMatrix();   // column-major 4x4
  const tris = [];                    // flat [ax,az, bx,bz, cx,cz] per triangle (projected XZ, recentered)
  const apply = (x, y, z) => {
    const wx = wm[0] * x + wm[4] * y + wm[8] * z + wm[12];
    const wz = wm[2] * x + wm[6] * y + wm[10] * z + wm[14];
    return [wx - offset[0], wz - offset[2]];   // recentered XZ
  };
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) {   // 4 = TRIANGLES; the spec guarantees all road meshes are tris
      console.warn(`  ! ${node.getName()} primitive mode ${prim.getMode()} != TRIANGLES — skipping`);
      continue;
    }
    const pos = prim.getAttribute('POSITION');
    const idxAcc = prim.getIndices();
    const count = idxAcc ? idxAcc.getCount() : pos.getCount();
    const getIdx = idxAcc ? (i) => idxAcc.getScalar(i) : (i) => i;
    const p = [0, 0, 0];
    const xz = (vi) => { pos.getElement(vi, p); return apply(p[0], p[1], p[2]); };
    for (let i = 0; i + 2 < count; i += 3) {
      const a = xz(getIdx(i)), b = xz(getIdx(i + 1)), c = xz(getIdx(i + 2));
      tris.push([a[0], a[1], b[0], b[1], c[0], c[1]]);
    }
  }
  return tris;
}

// -------------------------------------------------------------------------------------
// BOUNDARY-EDGE extraction: hash each undirected triangle edge by its two QUANTIZED
// endpoints (so coincident verts that differ by float noise still match), count uses, and
// keep edges used by exactly ONE triangle -> the silhouette outline of the surface. This
// yields crisp outlines instead of a dense triangle-soup wireframe.
// -------------------------------------------------------------------------------------
const QUANT = 100;   // 1 cm grid for endpoint matching (level spans ~440 m)
const qkey = (x, z) => `${Math.round(x * QUANT)},${Math.round(z * QUANT)}`;

function boundaryEdges(tris) {
  const edgeUse = new Map();   // undirected edge key -> { count, seg:[x1,z1,x2,z2] }
  const addEdge = (x1, z1, x2, z2) => {
    const ka = qkey(x1, z1), kb = qkey(x2, z2);
    if (ka === kb) return;     // degenerate
    const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    const e = edgeUse.get(key);
    if (e) e.count++;
    else edgeUse.set(key, { count: 1, seg: [x1, z1, x2, z2] });
  };
  for (const t of tris) {
    addEdge(t[0], t[1], t[2], t[3]);
    addEdge(t[2], t[3], t[4], t[5]);
    addEdge(t[4], t[5], t[0], t[1]);
  }
  const out = [];
  for (const e of edgeUse.values()) if (e.count === 1) out.push(e.seg);
  return out;
}

// -------------------------------------------------------------------------------------
// Decimate near-duplicate / co-linear-chain noise: round endpoints to a coarser grid and
// drop exact-duplicate segments. Keeps the JSON small without visibly degrading the outline.
// -------------------------------------------------------------------------------------
function dedupeSegments(segs, grid = 0.25) {
  const seen = new Set();
  const out = [];
  const q = (v) => Math.round(v / grid) * grid;
  for (const s of segs) {
    let x1 = q(s[0]), z1 = q(s[1]), x2 = q(s[2]), z2 = q(s[3]);
    if (x1 === x2 && z1 === z2) continue;
    // canonical order so (a,b) and (b,a) dedupe
    const fwd = `${x1},${z1},${x2},${z2}`, rev = `${x2},${z2},${x1},${z1}`;
    if (seen.has(fwd) || seen.has(rev)) continue;
    seen.add(fwd);
    out.push([+x1.toFixed(2), +z1.toFixed(2), +x2.toFixed(2), +z2.toFixed(2)]);
  }
  return out;
}

// -------------------------------------------------------------------------------------
// Extract each layer, accumulate global XZ bounds.
// -------------------------------------------------------------------------------------
const layers = { road: [], drive: [], walk: [], curb: [], line: [] };
const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
const grow = (x, z) => {
  bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
  bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
};
const missing = [];

for (const { name, layer } of LAYERS) {
  const node = nodeByName(name);
  if (!node || !node.getMesh()) {
    console.warn(`  ! mesh "${name}" not found — layer "${layer}" will be missing its contribution`);
    missing.push(name);
    continue;
  }
  const tris = readWorldTris(node);
  const raw = boundaryEdges(tris);
  // 0.5 m dedup grid: the minimap renders at a few hundred px across ~414 m, so sub-0.5 m
  // detail is invisible. This merges the dense co-located ribbon edges and roughly halves
  // the JSON without degrading the visible outline.
  const segs = dedupeSegments(raw, 0.5);
  for (const s of segs) { grow(s[0], s[1]); grow(s[2], s[3]); }
  layers[layer].push(...segs);
  console.log(`  ${name.padEnd(18)} -> ${layer.padEnd(6)}  ${tris.length} tris -> ${raw.length} boundary -> ${segs.length} segs`);
}

// Round bounds out a touch and derive a square worldHalfExtent (so a square minimap fits all).
const r2 = (n) => Math.round(n * 100) / 100;
const half = Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX), Math.abs(bounds.minZ), Math.abs(bounds.maxZ));
const worldHalfExtent = Math.ceil(half);

const minimap = {
  source: cfg.src,
  note: 'Recentered XZ line-art for the minimap. Coords = world XZ minus offset[0]/offset[2]. ' +
        'Boundary-edge outlines (edges used by exactly one triangle). Segments are [x1,z1,x2,z2].',
  worldHalfExtent,
  bounds: { minX: r2(bounds.minX), minZ: r2(bounds.minZ), maxX: r2(bounds.maxX), maxZ: r2(bounds.maxZ) },
  offset: offset.map(r2),
  layers,
};
writeFileSync(OUT, JSON.stringify(minimap) + '\n');

// -------------------------------------------------------------------------------------
// ASSERTIONS
// -------------------------------------------------------------------------------------
console.log('\n=== ASSERTIONS ===');
let totalSegs = 0;
for (const [k, v] of Object.entries(layers)) totalSegs += v.length;
if (totalSegs === 0) throw new Error('minimap: no segments produced from any layer.');
console.log(`  [pass] ${totalSegs} total segments across layers`);

// every named mesh found (warn-not-fail if one is missing, per spec).
if (missing.length) console.warn(`  ! WARNING: missing meshes (non-fatal): ${missing.join(', ')}`);
else console.log('  [pass] all 6 named road meshes found');

// bounds contain every point.
let outOfBounds = 0;
for (const segs of Object.values(layers)) for (const s of segs) {
  if (s[0] < bounds.minX - 1e-6 || s[0] > bounds.maxX + 1e-6 || s[2] < bounds.minX - 1e-6 || s[2] > bounds.maxX + 1e-6 ||
      s[1] < bounds.minZ - 1e-6 || s[1] > bounds.maxZ + 1e-6 || s[3] < bounds.minZ - 1e-6 || s[3] > bounds.maxZ + 1e-6) outOfBounds++;
}
if (outOfBounds) throw new Error(`minimap: ${outOfBounds} segment endpoints outside computed bounds.`);
console.log('  [pass] bounds contain all segment endpoints');

if (!(worldHalfExtent > 50 && worldHalfExtent < 600)) {
  throw new Error(`minimap: worldHalfExtent ${worldHalfExtent} is implausible (expected ~220).`);
}
console.log(`  [pass] worldHalfExtent = ${worldHalfExtent} (plausible)`);

// -------------------------------------------------------------------------------------
// SUMMARY
// -------------------------------------------------------------------------------------
console.log('\n=== SUMMARY ===');
for (const [k, v] of Object.entries(layers)) console.log(`  layer ${k.padEnd(6)} ${String(v.length).padStart(5)} segments`);
console.log(`  bounds  minX=${minimap.bounds.minX} minZ=${minimap.bounds.minZ} maxX=${minimap.bounds.maxX} maxZ=${minimap.bounds.maxZ}`);
console.log(`  worldHalfExtent=${worldHalfExtent}  offset=[${minimap.offset.join(', ')}]`);
console.log(`  wrote ${path.relative(ROOT, OUT)}  ${(statSync(OUT).size / 1024).toFixed(1)} KB`);
console.log('\nALL ASSERTIONS PASSED');
