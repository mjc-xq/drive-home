import { describe, it, expect } from 'vitest';
import { makeGeoENU } from '../src/engine/coords.js';

// 1840 Dahill Lane (the world anchor).
const GEO0 = { lat: 37.6835313, lon: -122.0686199 };
const enu = makeGeoENU(GEO0.lat, GEO0.lon);

// The OLD flat-tangent approximation the engine used to use, for comparison.
const M_LAT = 110540, M_LON = Math.cos(GEO0.lat * Math.PI / 180) * 111320;
const flat = (lat, lon) => [(lon - GEO0.lon) * M_LON, (lat - GEO0.lat) * M_LAT];

describe('curvature-correct geo<->ENU projection', () => {
  it('agrees with the flat approximation near home to within ~1 m (right axes, no gross error)', () => {
    // Within ~300 m of the house, the curvature-correct ENU and the old flat math agree to within
    // ~1 m (the small constant gap is the old code's rounded 110540 m/deg vs the true ~110992).
    // This pins the AXIS CONVENTION (east is +E, north is +N — no sign flip / 90° error).
    for (const [dLat, dLon] of [[0.0025, 0], [0, 0.0025], [-0.0015, 0.0012], [0.0008, -0.0009]]) {
      const lat = GEO0.lat + dLat, lon = GEO0.lon + dLon;
      const [e, n] = enu.toEN(lat, lon);
      const [fe, fn] = flat(lat, lon);
      expect(Math.hypot(e - fe, n - fn)).toBeLessThan(1.5);   // same direction, ~sub-metre gap near home
    }
  });

  it('round-trips geo -> ENU -> geo: sub-cm near home, sub-metre far (tangent-plane U=0 error)', () => {
    // near home: essentially exact
    {
      const lat = GEO0.lat + 0.001, lon = GEO0.lon - 0.001;
      const { lat: rl, lon: ro } = enu.toGeo(...enu.toEN(lat, lon));
      expect(Math.abs(rl - lat)).toBeLessThan(2e-7);   // < ~2 cm
      expect(Math.abs(ro - lon)).toBeLessThan(2e-7);
    }
    // 22 km out: the flat tangent plane's U=0 reconstruction is off by ~cm — way under a lane, fine
    // for routing (Google snaps to roads). Just confirm it's bounded.
    {
      const lat = 37.8044, lon = -122.2740;
      const { lat: rl, lon: ro } = enu.toGeo(...enu.toEN(lat, lon));
      expect(Math.abs(rl - lat)).toBeLessThan(5e-6);   // < ~55 cm
      expect(Math.abs(ro - lon)).toBeLessThan(5e-6);
    }
  });

  it('diverges from the flat approximation far away (the curvature the tiles have)', () => {
    // Oakland, ~22 km from the house: the flat version is off by tens of metres.
    const oak = [37.8004778, -122.2739559];
    const [e, n] = enu.toEN(oak[0], oak[1]);
    const [fe, fn] = flat(oak[0], oak[1]);
    const drift = Math.hypot(e - fe, n - fn);
    expect(drift).toBeGreaterThan(10);    // meaningfully off (was putting routes off the road)
    expect(drift).toBeLessThan(120);      // but sane (sanity bound)
  });

  it('origin maps to (0,0)', () => {
    const [e, n] = enu.toEN(GEO0.lat, GEO0.lon);
    expect(Math.hypot(e, n)).toBeLessThan(1e-6);
  });
});
