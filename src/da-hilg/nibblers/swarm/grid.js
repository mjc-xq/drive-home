// Uniform spatial hash over the swarm's XZ plane. Rebuilt each frame from the live
// nibbler slots (scale>0) so the O(N) build + O(N·k) neighbor queries stay linear —
// the only "interaction" cost in the sim. Cell size = SEP_RADIUS so separation only
// ever touches the 3×3 cell block around a nibbler. Plain typed arrays, allocated
// once at first build, mutated in place — NO per-frame allocation.
//
// Layout: a counting-sort bucket structure. `cellStart[c]` is the offset into the
// `order` array where cell c's members begin; `order` is the nibbler indices sorted
// by cell. This is allocation-light and cache-friendly (no per-cell arrays/maps).

import { MAX_NIBBLERS, SEP_RADIUS } from '../constants.js';
import { px, pz, scale } from './swarmState.js';

const CELL = SEP_RADIUS;
const INV_CELL = 1 / CELL;

// Hash grid dimensions. The neighborhood is ±200 m; with CELL=0.6 a full grid would
// be ~670² cells. We instead hash into a fixed table sized to the swarm capacity
// (the swarm is always clustered near one player, so collisions are rare and a
// modest table keeps memory flat). Power-of-two table → mask instead of modulo.
const TABLE_BITS = 12; // 4096 buckets — comfortably > MAX_NIBBLERS
const TABLE_SIZE = 1 << TABLE_BITS;
const TABLE_MASK = TABLE_SIZE - 1;

// Bucket structure (counting sort).
const cellCount = new Int32Array(TABLE_SIZE); // members per bucket (scratch)
const cellStart = new Int32Array(TABLE_SIZE + 1); // prefix-sum offsets
const order = new Int32Array(MAX_NIBBLERS); // nibbler indices, sorted by bucket

// Per-nibbler cached cell hash + integer cell coords (filled during build, read by
// the neighbor walk so we don't recompute the cell of `i`).
const cellHashOf = new Int32Array(MAX_NIBBLERS);
const cellGX = new Int32Array(MAX_NIBBLERS);
const cellGZ = new Int32Array(MAX_NIBBLERS);

let liveN = 0; // number of live indices placed in `order`

/** Integer cell coordinate along one axis. */
function cellCoord(v) {
  return Math.floor(v * INV_CELL);
}

/** Hash an integer cell (gx,gz) into the fixed bucket table. */
function hashCell(gx, gz) {
  // Two large primes; xor-fold then mask. Works fine for negative coords (ints).
  let h = (gx * 73856093) ^ (gz * 19349663);
  return (h & TABLE_MASK) >>> 0;
}

/**
 * Rebuild the grid from the current live slots. Counting sort:
 *   1) count members per bucket, 2) prefix-sum into cellStart, 3) scatter indices.
 * @param {number} maxLive upper bound on slots to scan (pass MAX_NIBBLERS to scan all)
 */
export function buildGrid(maxLive) {
  const n = maxLive < MAX_NIBBLERS ? maxLive : MAX_NIBBLERS;

  // Reset bucket counts.
  cellCount.fill(0);

  // Pass 1 — assign each live nibbler a cell hash and count buckets.
  liveN = 0;
  for (let i = 0; i < n; i++) {
    if (scale[i] <= 0) continue;
    const gx = cellCoord(px[i]);
    const gz = cellCoord(pz[i]);
    const h = hashCell(gx, gz);
    cellGX[i] = gx;
    cellGZ[i] = gz;
    cellHashOf[i] = h;
    cellCount[h]++;
    liveN++;
  }

  // Pass 2 — prefix sum to get each bucket's start offset.
  let acc = 0;
  for (let c = 0; c < TABLE_SIZE; c++) {
    cellStart[c] = acc;
    acc += cellCount[c];
  }
  cellStart[TABLE_SIZE] = acc;

  // Pass 3 — scatter indices into `order` using a moving cursor per bucket.
  // Reuse cellCount as the per-bucket write cursor (reset to start offsets).
  for (let c = 0; c < TABLE_SIZE; c++) cellCount[c] = cellStart[c];
  for (let i = 0; i < n; i++) {
    if (scale[i] <= 0) continue;
    const h = cellHashOf[i];
    order[cellCount[h]++] = i;
  }
}

/**
 * Visit every live nibbler in the 3×3 cell block around nibbler `i` (including `i`
 * itself — the caller must skip the self index). `fn(j)` is called per neighbor.
 * @param {number} i nibbler index
 * @param {(j:number)=>void} fn
 */
export function forNeighbors(i, fn) {
  const gx = cellGX[i];
  const gz = cellGZ[i];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const h = hashCell(gx + dx, gz + dz);
      const start = cellStart[h];
      const end = cellStart[h + 1];
      for (let k = start; k < end; k++) {
        const j = order[k];
        // Buckets can collide (distinct cells hashing equal); guard by exact cell.
        if (cellGX[j] === gx + dx && cellGZ[j] === gz + dz) fn(j);
      }
    }
  }
}

/**
 * Visit every live nibbler whose XZ is within radius `r` of (x,z). Used by the stomp
 * query. Scans the cell block covering the radius and distance-tests each candidate.
 * @param {number} x
 * @param {number} z
 * @param {number} r
 * @param {(j:number, d2:number)=>void} fn called with index + squared XZ distance
 */
export function forNibblersNear(x, z, r, fn) {
  const r2 = r * r;
  const gx = cellCoord(x);
  const gz = cellCoord(z);
  const span = Math.max(1, Math.ceil(r * INV_CELL));
  for (let dx = -span; dx <= span; dx++) {
    for (let dz = -span; dz <= span; dz++) {
      const cx = gx + dx;
      const cz = gz + dz;
      const h = hashCell(cx, cz);
      const start = cellStart[h];
      const end = cellStart[h + 1];
      for (let k = start; k < end; k++) {
        const j = order[k];
        if (cellGX[j] !== cx || cellGZ[j] !== cz) continue; // hash-collision guard
        const ddx = px[j] - x;
        const ddz = pz[j] - z;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 <= r2) fn(j, d2);
      }
    }
  }
}
