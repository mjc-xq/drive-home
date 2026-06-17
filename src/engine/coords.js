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

// WGS84 geodetic <-> local ENU (East/North metres at an origin). This is the CURVATURE-CORRECT
// version of the flat "(Δlat·110540, Δlon·cos·111320)" approximation: identical within a millimetre
// near the origin, but unlike the flat math it does NOT drift from the real (curved-earth)
// photoreal tiles far away — the flat version is off by ~d²/2R (≈ a lane at 5 km, ~30 m at 20 km),
// which is why nav routes / jumps / the road-snap landed off the actual road far from home.
const D2R = Math.PI / 180, WA = 6378137, WE2 = 0.00669437999014;   // WGS84 semi-major + first eccentricity²
function geoToECEF(lat, lon, h) {
  const sla = Math.sin(lat * D2R), cla = Math.cos(lat * D2R), slo = Math.sin(lon * D2R), clo = Math.cos(lon * D2R);
  const n = WA / Math.sqrt(1 - WE2 * sla * sla);
  return [(n + h) * cla * clo, (n + h) * cla * slo, (n * (1 - WE2) + h) * sla];
}
export function makeGeoENU(originLat, originLon) {
  const e0 = geoToECEF(originLat, originLon, 0);
  const sla = Math.sin(originLat * D2R), cla = Math.cos(originLat * D2R), slo = Math.sin(originLon * D2R), clo = Math.cos(originLon * D2R);
  return {
    toEN(lat, lon) {   // -> [East, North] metres
      const p = geoToECEF(lat, lon, 0), dx = p[0] - e0[0], dy = p[1] - e0[1], dz = p[2] - e0[2];
      return [-slo * dx + clo * dy, -sla * clo * dx - sla * slo * dy + cla * dz];
    },
    toGeo(E, N) {   // ENU metres -> { lat, lon } (Bowring's ECEF->geodetic)
      const X = e0[0] + (-slo) * E + (-sla * clo) * N, Y = e0[1] + clo * E + (-sla * slo) * N, Z = e0[2] + cla * N;
      const b = WA * Math.sqrt(1 - WE2), ep2 = (WA * WA - b * b) / (b * b), pr = Math.hypot(X, Y), th = Math.atan2(Z * WA, pr * b);
      const lat = Math.atan2(Z + ep2 * b * Math.sin(th) ** 3, pr - WE2 * WA * Math.cos(th) ** 3), lon = Math.atan2(Y, X);
      return { lat: lat / D2R, lon: lon / D2R };
    },
  };
}
