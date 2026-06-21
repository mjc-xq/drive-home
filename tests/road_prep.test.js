import { describe, expect, it } from 'vitest';
import {
  buildRoadJunctions,
  buildSidewalkConnectors,
  distPointSeg,
  emitGroundRibbon,
  roadSegmentsWorld,
  snapCreekToChannel,
} from '../scripts/road_prep.mjs';

const w2 = (e, n) => [e, -n];

describe('road prep sidewalk junctions', () => {
  it('detects a geometric road crossing without a shared OSM vertex', () => {
    const roads = [
      { k: 'residential', w: 7.5, p: [[-20, 0], [20, 0]] },
      { k: 'residential', w: 7.5, p: [[0, -20], [0, 20]] },
    ];

    const junctions = buildRoadJunctions(roads, w2);

    expect(junctions).toHaveLength(1);
    expect(junctions[0].x).toBeCloseTo(0);
    expect(junctions[0].z).toBeCloseTo(0);
    expect(junctions[0].arms).toHaveLength(4);
  });

  it('does not turn straight OSM way splits into intersections', () => {
    const roads = [
      { k: 'residential', w: 7.5, p: [[-20, 0], [0, 0]] },
      { k: 'residential', w: 7.5, p: [[0, 0], [20, 0]] },
    ];

    const junctions = buildRoadJunctions(roads, w2);

    expect(junctions).toHaveLength(0);
  });

  it('uses short corner returns instead of broad loops through an intersection', () => {
    const roads = [
      { k: 'residential', w: 7.5, p: [[-20, 0], [20, 0]] },
      { k: 'residential', w: 7.5, p: [[0, -20], [0, 20]] },
    ];
    const junctions = buildRoadJunctions(roads, w2);
    const roadSegments = roadSegmentsWorld(roads, w2, { includeService: false });

    const runs = buildSidewalkConnectors(roads, w2, { junctions, roadSegments });

    expect(runs).toHaveLength(4);
    for (const run of runs) {
      const length = run.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - run[i][0], p[1] - run[i][1]), 0);
      expect(length).toBeLessThan(6);
      for (const [x, z] of run) {
        const clearance = Math.min(
          ...roadSegments.map(s => distPointSeg(x, z, s.a[0], s.a[1], s.b[0], s.b[1]).d - s.spec.width / 2),
        );
        expect(clearance).toBeGreaterThan(0.9);
      }
    }
  });

  it('suppresses generated connector runs where mapped sidewalk geometry already exists', () => {
    const roads = [
      { k: 'residential', w: 7.5, p: [[-20, 0], [20, 0]] },
      { k: 'residential', w: 7.5, p: [[0, -20], [0, 20]] },
    ];
    const junctions = buildRoadJunctions(roads, w2);
    const roadSegments = roadSegmentsWorld(roads, w2, { includeService: false });

    const runs = buildSidewalkConnectors(roads, w2, {
      junctions,
      roadSegments,
      avoid: (x, z) => x > 4 && z > 4,
    });

    expect(runs).toHaveLength(3);
  });

  it('samples paved ribbons across their width so terrain cannot poke through the center', () => {
    const pos = [];
    const idx = [];

    emitGroundRibbon([[0, -5], [0, 5]], 6, 0.22, (x) => Math.abs(x) < 0.01 ? 10 : 0, pos, idx);

    expect(pos.length / 3).toBeGreaterThan(4);
    expect(idx.length).toBeGreaterThan(6);
    expect(pos.filter((_, i) => i % 3 === 1).some(y => y > 10.2)).toBe(true);
  });

  it('keeps creek channel snapping off lower road cuts', () => {
    const creek = [[0, -10], [0, 0], [0, 10]];
    const terrainAt = (x) => {
      if (Math.abs(x - 8) < 0.5) return -5; // lower road trench, should be ignored
      if (Math.abs(x + 4) < 0.5) return -3; // creek channel
      return 0;
    };
    const avoidSegments = [{
      a: [8, -20],
      b: [8, 20],
      width: 7,
    }];

    const snapped = snapCreekToChannel(creek, terrainAt, {
      radius: 10,
      step: 1,
      strength: 1,
      smoothPasses: 0,
      avoidSegments,
      avoidMargin: 0.5,
    });

    expect(snapped[1][0]).toBeCloseTo(-4);
  });

  it('keeps creek channel snapping out of building footprints', () => {
    const creek = [[0, -10], [0, 0], [0, 10]];
    const building = [[2, -20], [6, -20], [6, 20], [2, 20]];
    const terrainAt = (x) => {
      if (Math.abs(x - 4) < 0.5) return -6; // low but inside a house footprint
      if (Math.abs(x + 3) < 0.5) return -3; // actual open channel
      return 0;
    };

    const snapped = snapCreekToChannel(creek, terrainAt, {
      radius: 8,
      step: 1,
      strength: 1,
      smoothPasses: 0,
      avoidPolygons: [building],
      avoidPolygonMargin: 0.5,
    });

    expect(snapped[1][0]).toBeCloseTo(-3);
  });
});
