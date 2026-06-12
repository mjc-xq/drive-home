import { describe, it, expect } from 'vitest';
import { buildRoadMask } from '../src/engine/roadmask.js';

const W = p => [p[0], -p[1]]; // center at origin
const roads = [
  { k: 'residential', w: 7.5, p: [[-50, 0], [50, 0]] }, // east-west street
  { k: 'footway', w: 2, p: [[0, -50], [0, 50]] }        // ignored kind
];
const { onRoad } = buildRoadMask(roads, W);

describe('road mask', () => {
  it('marks cells on the street', () => {
    expect(onRoad(0, 0)).toBe(true);
    expect(onRoad(30, 0)).toBe(true);
    expect(onRoad(-30, 0)).toBe(true);
  });
  it('is clear far from any street', () => {
    expect(onRoad(0, 40)).toBe(false);
    expect(onRoad(0, -40)).toBe(false);
  });
  it('ignores non-drivable kinds', () => {
    // the footway runs north-south through (0, ±z) but isn't drivable;
    // sample beyond the residential road's half-width + shoulder + cell slack
    expect(onRoad(0, 30)).toBe(false);
  });
  it('is clear outside the grid', () => {
    expect(onRoad(9999, 0)).toBe(false);
  });
});
