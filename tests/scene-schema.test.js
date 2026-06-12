import { describe, it, expect } from 'vitest';
import S from '../src/assets/scene.json';

// Regression contract for scripts/build_scene.py output (and for any original
// scene.json swapped in via scripts/extract_assets.py).
describe('scene.json schema', () => {
  it('has a house-centered origin near the expected centroid', () => {
    expect(Math.hypot(S.center[0] - 21.8, S.center[1] - 32.4)).toBeLessThan(15);
  });

  it('has a complete terrain grid', () => {
    expect(S.terrain.h).toHaveLength(S.terrain.n * S.terrain.n);
    expect(S.terrain.n).toBe(121);
    expect(S.terrain.half).toBe(340);
    for (const v of S.terrain.h) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('has aerial bounds that contain the origin', () => {
    const A = S.aerial;
    expect(A.E0).toBeLessThan(0);
    expect(A.E1).toBeGreaterThan(0);
    expect(A.Nb).toBeLessThan(0);
    expect(A.Nt).toBeGreaterThan(0);
  });

  it('has plenty of buildings and exactly one house', () => {
    expect(S.buildings.length).toBeGreaterThan(120);
    expect(S.buildings.filter(b => b.house).length).toBe(1);
  });

  it('gives the house gabled roof rects in [cx,cy,w,d,deg] form', () => {
    const house = S.buildings.find(b => b.house);
    expect(house.r.length).toBeGreaterThanOrEqual(1);
    for (const r of house.r) expect(r).toHaveLength(5);
  });

  it('mostly gabled roofs', () => {
    const gabled = S.buildings.filter(b => b.r).length;
    expect(gabled / S.buildings.length).toBeGreaterThan(0.6);
  });

  it('includes Dahill Lane with drivable kind and width', () => {
    const dahill = S.roads.filter(r => r.n === 'Dahill Lane');
    expect(dahill.length).toBeGreaterThan(0);
    for (const r of S.roads) {
      expect(['residential', 'tertiary', 'service']).toContain(r.k);
      expect(r.w).toBeGreaterThan(0);
    }
  });

  it('includes San Lorenzo Creek within walking distance of the house', () => {
    expect(S.creek.n).toMatch(/San Lorenzo/);
    let best = 1e9;
    for (const p of S.creek.p) best = Math.min(best, Math.hypot(p[0] - S.center[0], p[1] - S.center[1]));
    expect(best).toBeGreaterThan(15);
    expect(best).toBeLessThan(70);
  });
});
