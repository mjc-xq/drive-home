import { describe, expect, it } from 'vitest';
import {
  buildRoadJunctions,
  buildSidewalkConnectors,
  distPointSeg,
  emitGroundRibbon,
  roadSegmentsWorld,
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
      expect(length).toBeLessThan(2.5);
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
});
