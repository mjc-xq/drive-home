// Bilinear sampler over the square heightfield grid in scene.json
// (n×n samples spanning [-half, +half] meters in the orig frame).
export function createTerrainSampler(T, C) {
  const TN = T.n, TH = T.half, TSTEP = (2 * TH) / (TN - 1), h = T.h;
  return function terrainAt(wx, wz) {
    const e = wx + C[0], n = -wz + C[1];
    let fi = (e + TH) / TSTEP, fj = (TH - n) / TSTEP;
    fi = Math.max(0, Math.min(TN - 1.001, fi));
    fj = Math.max(0, Math.min(TN - 1.001, fj));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
    const a = h[j * TN + i], b = h[j * TN + i + 1], c = h[(j + 1) * TN + i], d = h[(j + 1) * TN + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}
