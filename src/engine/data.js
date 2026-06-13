import S from '../assets/scene.json';
import { createCoords } from './coords.js';
import { createTerrainSampler } from './terrain.js';

export { S };
export const { C, W, uvAt } = createCoords(S);
export const terrainAt = createTerrainSampler(S.terrain, C);

// Dominant lot/roof orientation of the block (the house's gable angle).
export const GRID_ANG = 35.1 * Math.PI / 180;

// Sanctuary placement (orig frame), georeferenced from Mike's annotated
// satellite screenshots via a 3-anchor affine (house, 1832, 1848 centroids).
// Pen is the pig wander center only — intentionally NO fence.
// Shed sits ~1 m off the house's back-yard door toward the creek (per Mike);
// its door, basking step and the iguana/keeper offsets face the open yard.
export const SREC = {
  shed: W([12.9, 40.3]),
  coop: W([4, 47.5]),
  barn: W([7.9, 60.1]),
  pen: W([7.5, 55])
};
