import { describe, it, expect } from 'vitest';
import { TOOLS, toolAfterScoop } from '../src/engine/animals.js';

describe('scoop tool progression', () => {
  it('has three tools with growing radius and capacity', () => {
    expect(TOOLS).toHaveLength(3);
    expect(TOOLS[0].cap).toBeLessThan(TOOLS[1].cap);
    expect(TOOLS[1].cap).toBeLessThan(TOOLS[2].cap);
    expect(TOOLS[0].r).toBeLessThan(TOOLS[1].r);
    expect(TOOLS[1].r).toBeLessThan(TOOLS[2].r);
  });
  it('unlocks Big Scoop at 12 total', () => {
    expect(toolAfterScoop(0, 11)).toBe(0);
    expect(toolAfterScoop(0, 12)).toBe(1);
  });
  it('unlocks MEGA Shovel at 35 total', () => {
    expect(toolAfterScoop(1, 34)).toBe(1);
    expect(toolAfterScoop(1, 35)).toBe(2);
  });
  it('never downgrades or skips', () => {
    expect(toolAfterScoop(2, 9999)).toBe(2);
    expect(toolAfterScoop(0, 35)).toBe(1); // one step at a time
  });
});
