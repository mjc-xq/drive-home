import { describe, it, expect } from 'vitest';
import { createCoords, clamp } from '../src/engine/coords.js';

const env = createCoords({
  center: [21.8, 32.4],
  aerial: { E0: -100, E1: 100, Nb: -50, Nt: 150 }
});

describe('orig->world transform W', () => {
  it('puts the house centroid at the world origin', () => {
    const [x, z] = env.W([21.8, 32.4]);
    expect(x).toBeCloseTo(0);
    expect(z).toBeCloseTo(0); // -0 is fine
  });
  it('maps east to +x and north to -z', () => {
    const [x, z] = env.W([22.8, 33.4]);
    expect(x).toBeCloseTo(1);
    expect(z).toBeCloseTo(-1);
  });
});

describe('aerial uv mapping', () => {
  it('maps the southwest corner to uv (0,0)', () => {
    const [wx, wz] = env.W([-100, -50]);
    const [u, v] = env.uvAt(wx, wz);
    expect(u).toBeCloseTo(0);
    expect(v).toBeCloseTo(0);
  });
  it('maps the northeast corner to uv (1,1)', () => {
    const [wx, wz] = env.W([100, 150]);
    const [u, v] = env.uvAt(wx, wz);
    expect(u).toBeCloseTo(1);
    expect(v).toBeCloseTo(1);
  });
});

describe('clamp', () => {
  it('clamps both ends', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-2, 0, 3)).toBe(0);
    expect(clamp(1.5, 0, 3)).toBe(1.5);
  });
});
