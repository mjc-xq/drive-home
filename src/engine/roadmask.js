// Drivable-surface lookup: a coarse occupancy grid baked from the road
// polylines (road half-width + 1.8 m shoulder). Off-mask driving is allowed
// but slow — see updateDrive's off-road drag.
export function buildRoadMask(roads, W, { N = 164, HALF = 328 } = {}) {
  const CS = (2 * HALF) / N;
  const mask = new Uint8Array(N * N);
  for (const r of roads) {
    if (r.k !== 'residential' && r.k !== 'tertiary' && r.k !== 'service') continue;
    const hw = r.w / 2 + 1.8, rad = Math.ceil(hw / CS);
    for (let k = 0; k < r.p.length - 1; k++) {
      const [ax, az] = W(r.p[k]), [bx, bz] = W(r.p[k + 1]);
      const L = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.round(L / 2));
      for (let s = 0; s <= steps; s++) {
        const x = ax + (bx - ax) * s / steps, z = az + (bz - az) * s / steps;
        const ci = Math.floor((x + HALF) / CS), cj = Math.floor((z + HALF) / CS);
        for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= N || j >= N) continue;
          const ccx = -HALF + (i + 0.5) * CS, ccz = -HALF + (j + 0.5) * CS;
          if (Math.hypot(ccx - x, ccz - z) < hw) mask[j * N + i] = 1;
        }
      }
    }
  }
  function onRoad(x, z) {
    const i = Math.floor((x + HALF) / CS), j = Math.floor((z + HALF) / CS);
    return (i < 0 || j < 0 || i >= N || j >= N) ? false : mask[j * N + i] === 1;
  }
  return { mask, onRoad };
}
