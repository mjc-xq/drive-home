import { describe, it, expect } from 'vitest';
import { createTerrainSampler } from '../src/engine/terrain.js';

// 3×3 grid, half-extent 1 m, centered on orig (0,0); C=[0,0] so world==orig
// (with z negated). Row-major from north (j=0) to south.
const T = {
  n: 3, half: 1,
  h: [
    10, 11, 12,  // n = +1 (north row)
    20, 21, 22,  // n =  0
    30, 31, 32   // n = -1 (south row)
  ]
};
const at = createTerrainSampler(T, [0, 0]);

describe('terrain bilinear sampling', () => {
  it('returns grid values at grid points', () => {
    expect(at(0, 0)).toBeCloseTo(21);    // center (interior point is exact)
    // the sampler clamps to n-1.001 cells, so the far edge/corner samples are
    // a hair inside the grid by design — allow ~0.05 there
    expect(at(-1, -1)).toBeCloseTo(10, 1); // west, north (wz=-1 => n=+1)
    expect(at(1, 1)).toBeCloseTo(32, 1);   // east, south
  });
  it('interpolates between grid points', () => {
    expect(at(0.5, 0)).toBeCloseTo(21.5); // halfway east on the middle row
    expect(at(0, 0.5)).toBeCloseTo(26);   // halfway south on the middle column
  });
  it('clamps outside the grid instead of exploding', () => {
    expect(at(50, 0)).toBeCloseTo(22);
    expect(at(0, -50)).toBeCloseTo(11);
    expect(Number.isFinite(at(-999, 999))).toBe(true);
  });
});
