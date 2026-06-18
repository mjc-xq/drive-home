import { describe, it, expect } from 'vitest';
import { _test } from '../src/engine/nav/mapbox-roads.js';

function makeCtx(lat = 40.7, lon = -73.95) {
  return {
    geo: {
      worldToGeo(x, z) {
        const mPerDegLat = 111320;
        const mPerDegLon = 111320 * Math.cos(lat * Math.PI / 180);
        return { lat: lat - z / mPerDegLat, lon: lon + x / mPerDegLon };
      },
    },
  };
}

describe('mapbox road tile planning', () => {
  it('keeps a 7 km road box under the fetch fan-out cap', () => {
    const plan = _test.planRoadTiles(makeCtx(), 0, 0, 3500);
    expect(plan.tiles.length).toBeGreaterThan(0);
    expect(plan.tiles.length).toBeLessThanOrEqual(42);
    expect(plan.zoom).toBeGreaterThanOrEqual(11);
    expect(plan.zoom).toBeLessThanOrEqual(14);
  });

  it('splits longitude bounds at the antimeridian instead of spanning the planet', () => {
    const intervals = _test.lonIntervalsFor([179.99, -179.99, 179.98, -179.98]);
    expect(intervals).toHaveLength(2);
    expect(intervals[0].west360).toBeGreaterThan(359);
    expect(intervals[0].east360).toBe(360);
    expect(intervals[1].west360).toBe(0);
    expect(intervals[1].east360).toBeLessThan(1);
  });

  it('accepts drivable road classes and rejects paths/rails/ferries', () => {
    expect(_test.isDrivableRoad({ class: 'motorway' })).toBe(true);
    expect(_test.isDrivableRoad({ class: 'street' })).toBe(true);
    expect(_test.isDrivableRoad({ class: 'service' })).toBe(true);
    expect(_test.isDrivableRoad({ class: 'path' })).toBe(false);
    expect(_test.isDrivableRoad({ class: 'major_rail' })).toBe(false);
    expect(_test.isDrivableRoad({ class: 'ferry' })).toBe(false);
  });
});
