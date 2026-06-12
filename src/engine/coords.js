// Coordinate frames:
//  - "orig" frame (scene.json + placement constants): meters east/north of the
//    geocode origin at 1840 Dahill Lane.
//  - world frame (three.js): x = east, z = -north, y = up, centered on the
//    house centroid C so the house sits at the world origin.
export function createCoords({ center, aerial }) {
  const C = center;
  const W = p => [p[0] - C[0], -(p[1] - C[1])];
  const A = aerial;
  function uvAt(wx, wz) {
    const e = wx + C[0], n = -wz + C[1];
    return [(e - A.E0) / (A.E1 - A.E0), (n - A.Nb) / (A.Nt - A.Nb)];
  }
  return { C, W, uvAt };
}

export function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
