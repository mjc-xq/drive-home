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

// WGS84 geodetic <-> world-planar coordinates at an origin. Near the origin this is the
// same curvature-correct ENU used by the photoreal tiles. The inverse intersects that
// ENU ray back onto the WGS84 ellipsoid instead of assuming the tangent plane's U=0,
// so toGeo(toEN(lat, lon)) still works thousands of km from home. Beyond the visible
// hemisphere, where orthographic ENU is not one-to-one, it switches to a spherical
// azimuthal-equidistant branch with a disjoint radius band. This keeps local tile
// alignment while still letting navigation/geocoding address far-side world locations.
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const WA = 6378137, WE2 = 0.00669437999014;   // WGS84 semi-major + first eccentricity²
const WB = WA * Math.sqrt(1 - WE2);
const AEQD_R = 6371008.8;                     // authalic-ish mean Earth radius for far-side fallback
const ORTHO_SWITCH = 85 * D2R;                // stay on true ENU until near the horizon
const AEQD_MIN_R = AEQD_R * ORTHO_SWITCH * 0.92;  // inverse selector; AEQD outputs start well beyond ENU radius
function geoToECEF(lat, lon, h) {
  const sla = Math.sin(lat * D2R), cla = Math.cos(lat * D2R), slo = Math.sin(lon * D2R), clo = Math.cos(lon * D2R);
  const n = WA / Math.sqrt(1 - WE2 * sla * sla);
  return [(n + h) * cla * clo, (n + h) * cla * slo, (n * (1 - WE2) + h) * sla];
}
function normLonRad(lon) {
  lon = ((lon + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return lon === -Math.PI ? Math.PI : lon;
}
export function makeGeoENU(originLat, originLon) {
  const e0 = geoToECEF(originLat, originLon, 0);
  const sla = Math.sin(originLat * D2R), cla = Math.cos(originLat * D2R), slo = Math.sin(originLon * D2R), clo = Math.cos(originLon * D2R);
  const east = [-slo, clo, 0], north = [-sla * clo, -sla * slo, cla], up = [cla * clo, cla * slo, sla];
  const invA2 = 1 / (WA * WA), invB2 = 1 / (WB * WB);
  const aeqdToEN = (lat, lon) => {
    const p = lat * D2R, l = lon * D2R, sp = Math.sin(p), cp = Math.cos(p);
    const dl = normLonRad(l - originLon * D2R);
    const cosc = clamp(sla * sp + cla * cp * Math.cos(dl), -1, 1);
    const c = Math.acos(cosc), sinc = Math.sin(c);
    if (Math.abs(Math.PI - c) < 1e-10) return [0, AEQD_R * Math.PI];
    const k = Math.abs(sinc) > 1e-12 ? c / sinc : 1;
    return [AEQD_R * k * cp * Math.sin(dl), AEQD_R * k * (cla * sp - sla * cp * Math.cos(dl))];
  };
  const aeqdToGeo = (E, N) => {
    const rho = Math.hypot(E, N);
    if (rho < 1e-9) return { lat: originLat, lon: originLon };
    const c = rho / AEQD_R, sinc = Math.sin(c), cosc = Math.cos(c);
    const lat = Math.asin(clamp(cosc * sla + (N * sinc * cla) / rho, -1, 1));
    const lon = originLon * D2R + Math.atan2(E * sinc, rho * cla * cosc - N * sla * sinc);
    return { lat: lat * R2D, lon: normLonRad(lon) * R2D };
  };
  return {
    toEN(lat, lon) {   // -> [East, North] metres
      const latR = lat * D2R, lonR = lon * D2R;
      const c = Math.acos(clamp(sla * Math.sin(latR) + cla * Math.cos(latR) * Math.cos(normLonRad(lonR - originLon * D2R)), -1, 1));
      if (c > ORTHO_SWITCH) return aeqdToEN(lat, lon);
      const p = geoToECEF(lat, lon, 0), dx = p[0] - e0[0], dy = p[1] - e0[1], dz = p[2] - e0[2];
      return [east[0] * dx + east[1] * dy + east[2] * dz, north[0] * dx + north[1] * dy + north[2] * dz];
    },
    toGeo(E, N) {   // ENU/global metres -> { lat, lon } (Bowring's ECEF->geodetic)
      if (Math.hypot(E, N) >= AEQD_MIN_R) return aeqdToGeo(E, N);
      const qx = e0[0] + east[0] * E + north[0] * N, qy = e0[1] + east[1] * E + north[1] * N, qz = e0[2] + east[2] * E + north[2] * N;
      const A = (up[0] * up[0] + up[1] * up[1]) * invA2 + up[2] * up[2] * invB2;
      const B = 2 * ((qx * up[0] + qy * up[1]) * invA2 + qz * up[2] * invB2);
      const Cq = (qx * qx + qy * qy) * invA2 + qz * qz * invB2 - 1;
      const disc = B * B - 4 * A * Cq;
      if (disc < 0) return aeqdToGeo(E, N);   // arbitrary/far manual coordinate; keep it invertible
      const U = (-B + Math.sqrt(disc)) / (2 * A);
      const X = qx + up[0] * U, Y = qy + up[1] * U, Z = qz + up[2] * U;
      const ep2 = (WA * WA - WB * WB) / (WB * WB), pr = Math.hypot(X, Y), th = Math.atan2(Z * WA, pr * WB);
      const lat = Math.atan2(Z + ep2 * WB * Math.sin(th) ** 3, pr - WE2 * WA * Math.cos(th) ** 3), lon = Math.atan2(Y, X);
      return { lat: lat * R2D, lon: lon * R2D };
    },
  };
}
