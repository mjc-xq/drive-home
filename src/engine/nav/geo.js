import { makeGeoENU } from '../coords.js';
import { C } from '../data.js';

// geo <-> world, anchored at 1840 Dahill Lane. Near home this is the same curvature-correct
// ENU frame as the photoreal tiles; far away it remains invertible so routes, OSM road fetches,
// jumps, follow mode, and road snaps can all address world-scale locations. Axis convention:
// world x = East, world z = -North, centred on C.
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
