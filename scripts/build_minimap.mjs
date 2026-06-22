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
const layers = { road: [], drive: [], walk: [], curb: [], line: [], creek: [] };
const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
const fillTris = [];
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
  if (layer === 'road' || layer === 'drive') {
    for (const tri of tris) fillTris.push(tri);
  }
  const raw = boundaryEdges(tris);
  // 0.5 m dedup grid: the minimap renders at a few hundred px across ~414 m, so sub-0.5 m
  // detail is invisible. This merges the dense co-located ribbon edges and roughly halves
  // the JSON without degrading the visible outline.
  const segs = dedupeSegments(raw, 0.5);
  // Grow bounds from every road feature, but DON'T store the boundary segments: the solid road FILL
  // (rasterised below) now renders the streets. Storing 112k stipple segments bloated the JSON to
  // 2.5MB and is what read as "dots, not streets". Only the creek stays as a stroke (blue water).
  for (const s of segs) { grow(s[0], s[1]); grow(s[2], s[3]); }
  console.log(`  ${name.padEnd(18)} -> ${layer.padEnd(6)}  ${tris.length} tris -> ${raw.length} boundary -> ${segs.length} segs (fill)`);
}

// Round bounds out a touch and derive a square worldHalfExtent (so a square minimap fits all).
const r2 = (n) => Math.round(n * 100) / 100;
const half = Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX), Math.abs(bounds.minZ), Math.abs(bounds.maxZ));
const worldHalfExtent = Math.ceil(half);

// Creek line-art (blue water). The creek runs well past the property, so growing the map bounds to
// fit it would zoom the whole neighborhood out — instead CLIP creek segments to the road-derived
// worldHalfExtent and never grow bounds from them. Boundary edges of the riverbed = the water silhouette.
const creekNode = nodeByName('Creek_SanLorenzo') || nodeByName('Creek_Banks');
if (creekNode && creekNode.getMesh()) {
  const cseg = dedupeSegments(boundaryEdges(readWorldTris(creekNode)), 0.8);
  const inB = (x, z) => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
  const cclip = cseg.filter((s) => inB(s[0], s[1]) && inB(s[2], s[3]));
  layers.creek.push(...cclip);
  console.log(`  Creek_SanLorenzo   -> creek   ${cclip.length} segs (clipped to ±${worldHalfExtent} m)`);
} else {
  console.warn('  ! Creek mesh not found — no creek on this minimap');
}

// -------------------------------------------------------------------------------------
// FILLED road mass (Google-Maps style solid streets). Boundary-edge strokes alone render as a
// dotted stipple; instead rasterise every road/driveway triangle into an N x N occupancy grid
// over the map extent, dilate so thin roads stay continuous, and ship a packed 1-bit bitmap
// the HUD bakes into a single road texture (one draw, no per-segment stipple).
const FILL_N = 256;
const fillGrid = new Uint8Array(FILL_N * FILL_N);
{
  // Map cells over the SAME bounds the HUD's WorldToMap uses (col<-x in [minX,maxX], row<-z in
  // [minZ,maxZ]) so the baked road texture lines up exactly with the creek strokes + actor dots.
  const bw = Math.max(1e-3, bounds.maxX - bounds.minX), bh = Math.max(1e-3, bounds.maxZ - bounds.minZ);
  const toGrid = (x, z) => [
    (x - bounds.minX) / bw * FILL_N,
    (z - bounds.minZ) / bh * FILL_N,
  ];
  const edge = (ax, ay, bx, by, px, py) => (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  const mark = (cx, cz) => {
    if (cx >= 0 && cx < FILL_N && cz >= 0 && cz < FILL_N) fillGrid[cz * FILL_N + cx] = 1;
  };
  for (const t of fillTris) {
    const [ax, ay] = toGrid(t[0], t[1]);
    const [bx, by] = toGrid(t[2], t[3]);
    const [cx, cy] = toGrid(t[4], t[5]);
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - 1);
    const maxX = Math.min(FILL_N - 1, Math.ceil(Math.max(ax, bx, cx)) + 1);
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)) - 1);
    const maxY = Math.min(FILL_N - 1, Math.ceil(Math.max(ay, by, cy)) + 1);
    const area = edge(ax, ay, bx, by, cx, cy);
    if (Math.abs(area) < 1e-6) continue;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = edge(bx, by, cx, cy, px, py);
        const w1 = edge(cx, cy, ax, ay, px, py);
        const w2 = edge(ax, ay, bx, by, px, py);
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) mark(x, y);
      }
    }
  }
  // Dilate by 1 cell so 1-cell-wide roads read as continuous ribbons, not a dotted line.
  const src = fillGrid.slice();
  for (let z = 0; z < FILL_N; z++) for (let x = 0; x < FILL_N; x++) {
    if (!src[z * FILL_N + x]) continue;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, nz = z + dz;
      if (nx >= 0 && nx < FILL_N && nz >= 0 && nz < FILL_N) fillGrid[nz * FILL_N + nx] = 1;
    }
  }
}
const packed = new Uint8Array(Math.ceil(FILL_N * FILL_N / 8));
let fillCells = 0;
for (let i = 0; i < fillGrid.length; i++) if (fillGrid[i]) { packed[i >> 3] |= (1 << (i & 7)); fillCells++; }
const fillRoadB64 = Buffer.from(packed).toString('base64');
console.log(`  road fill: ${fillCells} / ${FILL_N * FILL_N} cells set (${FILL_N}x${FILL_N} grid)`);

const minimap = {
  source: cfg.src,
  note: 'Recentered XZ line-art for the minimap. Coords = world XZ minus offset[0]/offset[2]. ' +
        'Boundary-edge outlines (edges used by exactly one triangle). Segments are [x1,z1,x2,z2]. ' +
        'fillRoad = base64 of a fillN x fillN 1-bit road occupancy grid (row-major, bit i = cell i), ' +
        'cell (col,row) spans world [-worldHalfExtent..+worldHalfExtent] in X (col) and Z (row).',
  worldHalfExtent,
  bounds: { minX: r2(bounds.minX), minZ: r2(bounds.minZ), maxX: r2(bounds.maxX), maxZ: r2(bounds.maxZ) },
  offset: offset.map(r2),
  fillN: FILL_N,
  fillRoad: fillRoadB64,
  layers,
};
writeFileSync(OUT, JSON.stringify(minimap) + '\n');

// -------------------------------------------------------------------------------------
// ASSERTIONS
// -------------------------------------------------------------------------------------
console.log('\n=== ASSERTIONS ===');
let totalSegs = 0;
for (const [k, v] of Object.entries(layers)) totalSegs += v.length;
if (totalSegs === 0 && fillCells === 0) throw new Error('minimap: no road fill AND no segments produced.');
console.log(`  [pass] ${totalSegs} segments + ${fillCells} road-fill cells`);

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

if (!(worldHalfExtent > 50 && worldHalfExtent < 1200)) {
  throw new Error(`minimap: worldHalfExtent ${worldHalfExtent} is implausible (expected 50..1200 m).`);
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
