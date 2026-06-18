import { describe, it, expect } from 'vitest';
import { createRoadGraph } from '../src/engine/nav/road-graph.js';

function makeCtx(extra = {}) {
  return {
    HOME_ROAD_RADIUS: 380,
    roadSegs: [[[-20, 0], [20, 0]]],
    allRoadSegs: [[[-20, 0], [20, 0]]],
    osmRoadSegs: [],
    ROUTE: null,
    ...extra,
  };
}

describe('road graph nearest-road queries', () => {
  it('does not use the home road graph as a global fallback', () => {
    const roads = createRoadGraph(makeCtx());
    const p = roads.nearestRoadPoint(10000, 10000);
    expect(p.d).toBe(Infinity);
    expect(roads.nearestRoadLocation(10000, 10000)).toBeNull();
  });

  it('uses fetched OSM roads for far-away nearest road queries', () => {
    const roads = createRoadGraph(makeCtx({
      osmRoadSegs: [[[990, 1000], [1010, 1000]]],
    }));
    const p = roads.nearestRoadLocation(1000, 1007);
    expect(p).toMatchObject({ x: 1000, z: 1000, source: 'osm' });
    expect(p.d).toBeCloseTo(7);
    expect(p.tx).toBeCloseTo(1);
    expect(p.tz).toBeCloseTo(0);
  });

  it('prefers the live route and returns the same tangent used by reset/follow', () => {
    const roads = createRoadGraph(makeCtx({
      ROUTE: [{ x: 100, z: 0 }, { x: 100, z: 60 }],
      osmRoadSegs: [[[90, 10], [90, 50]]],
    }));
    const p = roads.nearestRoadLocation(103, 30);
    const seg = roads.nearestRoadSeg(103, 30);
    expect(p.source).toBe('route');
    expect(p.x).toBeCloseTo(100);
    expect(p.z).toBeCloseTo(30);
    expect(seg).toMatchObject({ source: 'route' });
    expect(seg.tx).toBeCloseTo(0);
    expect(seg.tz).toBeCloseTo(1);
  });
});
