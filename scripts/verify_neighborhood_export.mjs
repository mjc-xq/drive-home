#!/usr/bin/env node
// Validate the neighborhood GLB as a game-level source asset.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import {
  buildSidewalkConnectors,
  buildSidewalkEndCaps,
  buildVertHit,
  isCulDeSacRoad,
  roadSpec,
  vkey,
} from './road_prep.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const glb = process.argv[2] || path.join(ROOT, 'exports/1840-dahill-stylized.glb');
const scenePath = path.join(ROOT, 'src/assets/scene.json');
const S = JSON.parse(readFileSync(scenePath, 'utf8'));
const C = S.center;
const w2 = (e, n) => [e - C[0], -(n - C[1])];
const fail = [];
const warn = [];

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
  const hit = buildVertHit(roads, w2);
  const connectors = buildSidewalkConnectors(roads, w2).concat(buildSidewalkEndCaps(roads, w2, { isCourt: isCulDeSacRoad }));
  const endpoints = [];
  for (const run of connectors) {
    if (run.length >= 2) {
      endpoints.push(run[0], run[run.length - 1]);
    }
  }
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
  if (checked && missing / checked > 0.12) fail.push(`sidewalk connector coverage too low: missing ${missing}/${checked} arm-side endpoints`);
}

function checkTreesAgainstRoadsAndBuildings() {
  const p = path.join(ROOT, 'exports/trees_placed.json');
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
for (const [rx, label] of [
  [/^Roads$/, 'Roads layer'],
  [/^Sidewalks$/, 'Sidewalks fallback layer'],
  [/^Driveways_Mapped$/, 'mapped driveway layer'],
  [/^House_windows$/, 'owner house window layer'],
  [/^GarageDoors$/, 'owner garage layer'],
  [/^Creek_Banks$/, 'creek bank layer'],
  [/^Shrubs$/, 'shrub layer'],
  [/^Collision_Terrain$/, 'terrain collision layer'],
  [/^Collision_Roads$/, 'road collision layer'],
  [/^Collision_Buildings$/, 'building collision layer'],
  [/^LOD_Buildings_Low$/, 'low building LOD layer'],
  // clean collection grouping from organize_layers.py (group nodes are empties)
  [/^Neighborhood$/, 'Neighborhood root group'],
  [/^Buildings$/, 'Buildings group'],
  [/^Roads & Paths$/, 'Roads & Paths group'],
  [/^Creek$/, 'Creek group'],
  [/^Vegetation$/, 'Vegetation group'],
  [/^Trees$/, 'Trees group'],
  [/^Grass in the Wind$/, 'Grass in the Wind group'],
  [/^Fences$/, 'Fences group'],
  [/^Helpers$/, 'Helpers group'],
]) requireNode(names, rx, label);

// grass-in-the-wind must be present AND animated (the looping GrassWind clip)
if (!doc.getRoot().listAnimations().some(a => /GrassWind/.test(a.getName() || ''))) {
  fail.push('missing GrassWind animation (grass in the wind)');
}

if (existsSync(path.join(ROOT, 'exports/map_surfaces_osm.json'))) {
  const ms = JSON.parse(readFileSync(path.join(ROOT, 'exports/map_surfaces_osm.json'), 'utf8'));
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
