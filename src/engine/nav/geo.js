import { makeGeoENU } from '../coords.js';
import { C } from '../data.js';

// geo <-> world, anchored at 1840 Dahill Lane. CURVATURE-CORRECT local ENU (East/North metres) so
// routes / jumps / the road-snap line up with the real photoreal-tile roads even far from home —
// the old flat-tangent version drifted ~d²/2R from the (curved-earth) tiles (~a lane at 5 km,
// ~30 m at 20 km). Identical to the flat math within a millimetre near home, so nothing local
// changes. Axis convention: world x = East, world z = -North, centred on C.
export function createGeo() {
  const GEO0 = { lat: 37.6835313, lon: -122.0686199 };
  const _enu = makeGeoENU(GEO0.lat, GEO0.lon);
  function geoToWorld(lat, lon) {
    const en = _enu.toEN(lat, lon);
    return [en[0] - C[0], -(en[1] - C[1])];
  }
  function worldToGeo(x, z) {
    return _enu.toGeo(x + C[0], C[1] - z);
  }
  return { geoToWorld, worldToGeo };
}
