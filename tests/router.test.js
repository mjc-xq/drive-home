import { describe, it, expect } from 'vitest';
import { routeFromPath, pathForRoute } from '../src/lib/router.js';

describe('router path ↔ view mapping', () => {
  it('maps the three known paths to views', () => {
    expect(routeFromPath('/')).toBe('menu');
    expect(routeFromPath('/drive')).toBe('drive');
    expect(routeFromPath('/scoop')).toBe('scoop');
  });

  it('ignores trailing slashes', () => {
    expect(routeFromPath('/drive/')).toBe('drive');
    expect(routeFromPath('/scoop//')).toBe('scoop');
    expect(routeFromPath('')).toBe('menu');
  });

  it('falls back unknown paths to the menu', () => {
    expect(routeFromPath('/anything-else')).toBe('menu');
    expect(routeFromPath('/drive/extra')).toBe('menu');
  });

  it('pathForRoute is the inverse of routeFromPath', () => {
    for (const view of ['menu', 'drive', 'scoop']) {
      expect(routeFromPath(pathForRoute(view))).toBe(view);
    }
    expect(pathForRoute('menu')).toBe('/');
    expect(pathForRoute('drive')).toBe('/drive');
    expect(pathForRoute('scoop')).toBe('/scoop');
  });
});
