#!/usr/bin/env node
// Validate the neighborhood GLB as a game-level source asset.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import {
  buildRoadJunctions,
  buildSidewalkConnectors,
  buildSidewalkEndCaps,
  buildVertHit,
  isCulDeSacRoad,
  roadSpec,
  roadSegmentsWorld,
  vkey,
} from './road_prep.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const glbArg = process.argv[2] || path.join(ROOT, 'exports/1840-dahill-stylized.glb');
const glb = path.isAbsolute(glbArg) ? glbArg : path.resolve(process.cwd(), glbArg);
function inferDataDir(glbPath) {
  const m = path.basename(glbPath).match(/^(.+?)-(?:property(?:-trees)?|stylized)\.glb$/);
  if (m) {
    const dir = path.join(ROOT, 'exports', m[1]);
    if (existsSync(path.join(dir, 'scene.json'))) return dir;
  }
  return path.join(ROOT, 'exports');
}
const dataDir = process.argv[3]
  ? (path.isAbsolute(process.argv[3]) ? process.argv[3] : path.resolve(process.cwd(), process.argv[3]))
  : inferDataDir(glb);
const scenePath = existsSync(path.join(dataDir, 'scene.json'))
  ? path.join(dataDir, 'scene.json')
  : path.join(ROOT, 'src/assets/scene.json');
const S = JSON.parse(readFileSync(scenePath, 'utf8'));
const C = S.center;
const ORIGIN = S.origin || {};
const LAT0 = Number.isFinite(+ORIGIN.lat) ? +ORIGIN.lat : 37.6835313;
const LON0 = Number.isFinite(+ORIGIN.lon) ? +ORIGIN.lon : -122.0686199;
const COSLAT = Math.cos(LAT0 * Math.PI / 180);
const w2 = (e, n) => [e - C[0], -(n - C[1])];
const fail = [];
const warn = [];
const dataFile = name => {
  const p = path.join(dataDir, name);
  return existsSync(p) ? p : path.join(ROOT, 'exports', name);
};
let cropHalf = Math.max(1, +(S.terrain?.half ?? S.aerial?.half ?? 0));
let tXmin = -cropHalf, tXmax = cropHalf, tZmin = -cropHalf, tZmax = cropHalf;
const demPath = dataFile('dem_1m.json');
if (existsSync(demPath)) {
  const D = JSON.parse(readFileSync(demPath, 'utf8'));
  const dLat = D.latN - D.latS;
  cropHalf = dLat * 110540 / 2 - 4;
  tXmin = (D.lonW - LON0) * COSLAT * 111320 - C[0];
  tXmax = (D.lonE - LON0) * COSLAT * 111320 - C[0];
  const zA = -((D.latN - LAT0) * 110540 - C[1]);
  const zB = -((D.latS - LAT0) * 110540 - C[1]);
  tZmin = Math.min(zA, zB);
  tZmax = Math.max(zA, zB);
}
const inTerrain = (x, z, m = 6) => x >= tXmin + m && x <= tXmax - m && z >= tZmin + m && z <= tZmax - m;
const hasCreek = !!(S.creek && Array.isArray(S.creek.p) && S.creek.p
  .map(([e, n]) => w2(e, n))
  .filter(([x, z]) => Math.abs(x) <= cropHalf + 3 && Math.abs(z) <= cropHalf + 3)
  .length > 1);
const expectsDahillFences = !S.slug || /dahill/i.test(String(S.slug));

function requireNode(names, rx, label) {
  if (!names.some(n => rx.test(n))) fail.push(`missing ${label}`);
}

function distPointSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function inPoly(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

function checkSidewalkGraph() {
  const roads = S.roads || [];
  let mapSurfaces = {};
  const mapSurfacesPath = dataFile('map_surfaces_osm.json');
  if (existsSync(mapSurfacesPath)) mapSurfaces = JSON.parse(readFileSync(mapSurfacesPath, 'utf8'));
  const mappedLineSegs = (lines, width) => {
    const segs = [];
    for (const src of lines || []) {
      const pl = src.p || src;
      if (!Array.isArray(pl) || pl.length < 2) continue;
      for (let i = 1; i < pl.length; i++) segs.push({ a: pl[i - 1], b: pl[i], width });
    }
    return segs;
  };
  const mappedWalkSegs = mappedLineSegs(mapSurfaces.sidewalks || [], 2.1);
  const mappedCrossingSegs = mappedLineSegs(mapSurfaces.crossings || [], 2.4);
  const nearSegs = (x, z, segs, margin) => segs.some(s => distPointSeg(x, z, s.a[0], s.a[1], s.b[0], s.b[1]) < s.width / 2 + margin);
  const nearMappedWalk = (x, z) => nearSegs(x, z, mappedWalkSegs, 1.15) || nearSegs(x, z, mappedCrossingSegs, 0.9);
  const hit = buildVertHit(roads, w2);
  const junctions = buildRoadJunctions(roads, w2, { includeService: true });
  const roadSegments = roadSegmentsWorld(roads, w2, { includeService: false });
  const connectorRuns = buildSidewalkConnectors(roads, w2, {
    inPatch: (x, z) => inTerrain(x, z, 6),
    avoid: nearMappedWalk,
    junctions,
    roadSegments,
  });
  const endcapRuns = buildSidewalkEndCaps(roads, w2, {
    inPatch: (x, z) => inTerrain(x, z, 6),
    avoid: nearMappedWalk,
    isCourt: isCulDeSacRoad,
  });
  const connectors = connectorRuns.concat(endcapRuns);
  const endpoints = [];
  let tooLong = 0, roadOverlap = 0;
  const runLen = run => run.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - run[i][0], p[1] - run[i][1]), 0);
  for (const run of connectors) {
    if (run.length >= 2) {
      endpoints.push(run[0], run[run.length - 1]);
      for (const [x, z] of run) {
        if (roadSegments.some(s => distPointSeg(x, z, s.a[0], s.a[1], s.b[0], s.b[1]) < s.spec.width / 2 + 0.85)) {
          roadOverlap++;
          break;
        }
      }
    }
  }
  for (const run of connectorRuns) if (runLen(run) > 22) tooLong++;
  let checked = 0, missing = 0;
  const nearEndpoint = (x, z) => endpoints.some(([px, pz]) => Math.hypot(px - x, pz - z) < 1.35);
  const addArm = (p0, p1, r, junctionOnly) => {
    const p = w2(...p0), q = w2(...p1);
    const key = vkey(p[0], p[1]);
    const touches = hit.get(key) || 0;
    if (junctionOnly ? touches < 2 : touches > 1) return;
    const spec = roadSpec(r);
    if (spec.isService || (isCulDeSacRoad(r) && !junctionOnly)) return;
    let dx = q[0] - p[0], dz = q[1] - p[1];
    const L = Math.hypot(dx, dz);
    if (L < 0.5) return;
    dx /= L; dz /= L;
    const sideDist = spec.width / 2 + 2.2;
    const lead = Math.max(3.0, Math.min(8.0, spec.width / 2 + 1.2));
    for (const side of [1, -1]) {
      const nx = -dz * side, nz = dx * side;
      const x = p[0] + dx * lead + nx * sideDist;
      const z = p[1] + dz * lead + nz * sideDist;
      if (!inTerrain(x, z, 6) || nearMappedWalk(x, z)) continue;
      checked++;
      if (!nearEndpoint(x, z)) missing++;
    }
  };
  for (const r of roads) {
    const pl = r.p || r;
    if (!Array.isArray(pl) || pl.length < 2) continue;
    for (let i = 0; i < pl.length; i++) {
      if (i > 0) addArm(pl[i], pl[i - 1], r, true);
      if (i < pl.length - 1) addArm(pl[i], pl[i + 1], r, true);
    }
    addArm(pl[0], pl[1], r, false);
    addArm(pl[pl.length - 1], pl[pl.length - 2], r, false);
  }
  if (!connectors.length) fail.push('no sidewalk connector/endcap runs generated');
  if (checked && missing / checked > 0.35) warn.push(`sidewalk connector coverage is conservative: missing ${missing}/${checked} arm-side endpoints`);
  if (tooLong) fail.push(`${tooLong} sidewalk connector runs are long enough to form visible loops`);
  if (roadOverlap) fail.push(`${roadOverlap} sidewalk connector/endcap runs overlap road asphalt`);
}

function checkTreesAgainstRoadsAndBuildings() {
  const p = dataFile('trees_placed.json');
  if (!existsSync(p)) return warn.push('trees_placed.json missing; tree collision QA skipped');
  const trees = JSON.parse(readFileSync(p, 'utf8')).trees || [];
  const roadSegs = [];
  for (const r of S.roads || []) {
    if (roadSpec(r).isService) continue;
    const pl = r.p || r;
    for (let i = 1; i < pl.length; i++) roadSegs.push([w2(...pl[i - 1]), w2(...pl[i])]);
  }
  const buildings = (S.buildings || []).map(b => b.p.map(([e, n]) => w2(e, n)));
  let roadHits = 0, buildingHits = 0;
  for (const t of trees) {
    if (roadSegs.some(([a, b]) => distPointSeg(t.x, t.z, a[0], a[1], b[0], b[1]) < 3.0)) roadHits++;
    if (buildings.some(r => inPoly(t.x, t.z, r))) buildingHits++;
  }
  if (buildingHits) fail.push(`${buildingHits} placed trees intersect building footprints`);
  if (roadHits > Math.max(3, trees.length * 0.02)) fail.push(`${roadHits} placed trees are too close to street centrelines`);
}

const io = new NodeIO();
const doc = await io.read(glb);
const nodes = doc.getRoot().listNodes();
const names = nodes.map(n => n.getName() || '');
const requiredNodes = [
  [/^Roads$/, 'Roads layer'],
  [/^Sidewalks$/, 'Sidewalks fallback layer'],
  [/^Driveways_Mapped$/, 'mapped driveway layer'],
  [/^House_windows$/, 'owner house window layer'],
  [/^GarageDoors$/, 'owner garage layer'],
  [/^Shrubs$/, 'shrub layer'],
  [/^Collision_Terrain$/, 'terrain collision layer'],
  [/^Collision_Roads$/, 'road collision layer'],
  [/^Collision_Buildings$/, 'building collision layer'],
  [/^LOD_Buildings_Low$/, 'low building LOD layer'],
  // clean collection grouping from organize_layers.py (group nodes are empties)
  [/^Neighborhood$/, 'Neighborhood root group'],
  [/^Buildings$/, 'Buildings group'],
  [/^Roads & Paths$/, 'Roads & Paths group'],
  [/^Vegetation$/, 'Vegetation group'],
  [/^Trees$/, 'Trees group'],
  [/^Grass in the Wind$/, 'Grass in the Wind group'],
  [/^Helpers$/, 'Helpers group'],
];
if (expectsDahillFences) requiredNodes.push([/^Fences$/, 'Fences group']);
if (hasCreek) {
  requiredNodes.push([/^Creek_Banks$/, 'creek bank layer']);
  requiredNodes.push([/^Creek$/, 'Creek group']);
}
for (const [rx, label] of requiredNodes) requireNode(names, rx, label);

// grass-in-the-wind must be present AND animated (the looping GrassWind clip)
if (!doc.getRoot().listAnimations().some(a => /GrassWind/.test(a.getName() || ''))) {
  fail.push('missing GrassWind animation (grass in the wind)');
}

const mapSurfacesPath = dataFile('map_surfaces_osm.json');
if (existsSync(mapSurfacesPath)) {
  const ms = JSON.parse(readFileSync(mapSurfacesPath, 'utf8'));
  if ((ms.drivewayPolygons || []).length < 10) fail.push('mapped driveway polygon source unexpectedly sparse');
  if (!(ms.sidewalks || []).length) warn.push('no mapped sidewalk source features; using generated sidewalks only');
}

for (const node of nodes) {
  const name = node.getName() || '';
  if (!/^Collision_/.test(name) && name !== 'LOD_Buildings_Low') continue;
  const mesh = node.getMesh();
  if (!mesh) continue;
  for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial();
    const alpha = mat?.getBaseColorFactor()?.[3] ?? 1;
    if (alpha > 0.05) fail.push(`${name} material is visible (alpha ${alpha})`);
  }
}

checkSidewalkGraph();
checkTreesAgainstRoadsAndBuildings();

if (fail.length) {
  console.error('Neighborhood export QA failed:');
  for (const f of fail) console.error(' - ' + f);
  if (warn.length) for (const w of warn) console.error(' warn: ' + w);
  process.exit(1);
}
console.log(`PASS neighborhood export QA: ${path.relative(ROOT, glb)} (${nodes.length} nodes)`);
for (const w of warn) console.log('WARN ' + w);
