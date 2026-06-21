#!/usr/bin/env node
// Validate the neighborhood GLB as a game-level source asset.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { getBounds } from '@gltf-transform/functions';
import {
  buildRoadJunctions,
  buildSidewalkConnectors,
  buildSidewalkEndCaps,
  buildVertHit,
  isCulDeSacRoad,
  roadSpec,
  roadSegmentsWorld,
  snapCreekToChannel,
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
const enToLL = (e, n) => [LAT0 + n / 110540, LON0 + e / (COSLAT * 111320)];
const fail = [];
const warn = [];
const dataFile = name => {
  const p = path.join(dataDir, name);
  return existsSync(p) ? p : path.join(ROOT, 'exports', name);
};
let cropHalf = Math.max(1, +(S.terrain?.half ?? S.aerial?.half ?? 0));
let tXmin = -cropHalf, tXmax = cropHalf, tZmin = -cropHalf, tZmax = cropHalf;
const demPath = dataFile('dem_1m.json');
let DEM = null;
let terrainAt = null;
if (existsSync(demPath)) {
  DEM = JSON.parse(readFileSync(demPath, 'utf8'));
  const D = DEM;
  const dLat = D.latN - D.latS;
  const dLon = D.lonE - D.lonW;
  cropHalf = dLat * 110540 / 2 - 4;
  tXmin = (D.lonW - LON0) * COSLAT * 111320 - C[0];
  tXmax = (D.lonE - LON0) * COSLAT * 111320 - C[0];
  const zA = -((D.latN - LAT0) * 110540 - C[1]);
  const zB = -((D.latS - LAT0) * 110540 - C[1]);
  tZmin = Math.min(zA, zB);
  tZmax = Math.max(zA, zB);
  terrainAt = (X, Z) => {
    const [lat, lon] = enToLL(X + C[0], C[1] - Z);
    let fi = (lon - D.lonW) / dLon * D.cols - 0.5;
    let fj = (D.latN - lat) / dLat * D.rows - 0.5;
    fi = Math.max(0, Math.min(D.cols - 1.001, fi));
    fj = Math.max(0, Math.min(D.rows - 1.001, fj));
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const u = fi - i;
    const v = fj - j;
    const a = D.h[j * D.cols + i];
    const b = D.h[j * D.cols + i + 1];
    const c = D.h[(j + 1) * D.cols + i];
    const d = D.h[(j + 1) * D.cols + i + 1];
    return (u + v <= 1)
      ? a * (1 - u - v) + b * u + c * v
      : d * (u + v - 1) + b * (1 - v) + c * (1 - u);
  };
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

function distToRing(x, z, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    best = Math.min(best, distPointSeg(x, z, a[0], a[1], b[0], b[1]));
  }
  return best;
}

function densifyLine(line, step = 1.2) {
  if (!Array.isArray(line) || !line.length) return [];
  const out = [[line[0][0], line[0][1], 0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = L > 1e-6 ? (b[0] - a[0]) / L : 0;
    const uz = L > 1e-6 ? (b[1] - a[1]) / L : 0;
    const n = Math.max(1, Math.ceil(L / step));
    for (let s = 1; s <= n; s++) {
      out.push([
        a[0] + (b[0] - a[0]) * s / n,
        a[1] + (b[1] - a[1]) * s / n,
        L / n,
        ux,
        uz,
      ]);
    }
  }
  return out;
}

function checkCreekClearance() {
  if (!hasCreek) return;
  if (!terrainAt) return warn.push('DEM missing; creek snap clearance QA skipped');
  const rawCreek = S.creek.p
    .map(([e, n]) => w2(e, n))
    .filter(([x, z]) => Math.abs(x) <= cropHalf + 3 && Math.abs(z) <= cropHalf + 3);
  if (rawCreek.length < 2) return;

  const creekWidth = Number.isFinite(+process.env.CREEK_WIDTH_M) ? +process.env.CREEK_WIDTH_M : 7.5;
  const buildingAvoidMargin = creekWidth / 2 + 1.75;
  const requiredBuildingClear = creekWidth / 2 + 0.65;
  const buildingRings = (S.buildings || [])
    .map(b => (b.p || []).map(([e, n]) => w2(e, n)))
    .filter(ring => ring.length >= 3)
    .map(ring => ({
      ring,
      minX: Math.min(...ring.map(p => p[0])) - requiredBuildingClear,
      maxX: Math.max(...ring.map(p => p[0])) + requiredBuildingClear,
      minZ: Math.min(...ring.map(p => p[1])) - requiredBuildingClear,
      maxZ: Math.max(...ring.map(p => p[1])) + requiredBuildingClear,
    }));
  const roadSegments = roadSegmentsWorld(S.roads || [], w2, { includeService: true });
  const snapped = snapCreekToChannel(rawCreek, terrainAt, {
    radius: 18,
    step: 1.5,
    strength: 0.9,
    smoothPasses: 2,
    avoidSegments: roadSegments,
    avoidMargin: 2.0,
    avoidPolygons: buildingRings.map(b => b.ring),
    avoidPolygonMargin: buildingAvoidMargin,
  });
  const samples = densifyLine(snapped, 1.2);
  if (samples.length < 2) return;

  let minBuildingClear = Infinity;
  let buildingIntrusions = 0;
  let totalLen = 0;
  let roadLikeLen = 0;
  let currentRoadLike = 0;
  let longestRoadLike = 0;
  let crossingLen = 0;
  let minRoadClear = Infinity;
  const roadTouchThreshold = 0.35;
  const parallelDot = Math.cos(35 * Math.PI / 180);

  for (const [x, z, ds, ux = 0, uz = 0] of samples) {
    totalLen += ds;
    let sampleBuildingClear = Infinity;
    for (const b of buildingRings) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      const edgeClear = distToRing(x, z, b.ring);
      const signedClear = inPoly(x, z, b.ring) ? -edgeClear : edgeClear;
      sampleBuildingClear = Math.min(sampleBuildingClear, signedClear);
    }
    minBuildingClear = Math.min(minBuildingClear, sampleBuildingClear);
    if (sampleBuildingClear < 0) buildingIntrusions++;

    let roadClear = Infinity;
    let nearestRoad = null;
    for (const rs of roadSegments) {
      const clear = distPointSeg(x, z, rs.a[0], rs.a[1], rs.b[0], rs.b[1]) - rs.spec.width / 2;
      if (clear < roadClear) {
        roadClear = clear;
        nearestRoad = rs;
      }
    }
    minRoadClear = Math.min(minRoadClear, roadClear);
    if (roadClear < roadTouchThreshold) {
      const rdx = nearestRoad && nearestRoad.L > 1e-6 ? (nearestRoad.b[0] - nearestRoad.a[0]) / nearestRoad.L : 0;
      const rdz = nearestRoad && nearestRoad.L > 1e-6 ? (nearestRoad.b[1] - nearestRoad.a[1]) / nearestRoad.L : 0;
      const roadParallel = Math.abs(ux * rdx + uz * rdz) >= parallelDot;
      if (roadParallel) {
        roadLikeLen += ds;
        currentRoadLike += ds;
        longestRoadLike = Math.max(longestRoadLike, currentRoadLike);
      } else {
        crossingLen += ds;
        currentRoadLike = 0;
      }
    } else {
      currentRoadLike = 0;
    }
  }

  if (buildingIntrusions) {
    fail.push(`snapped creek intersects building footprints (${buildingIntrusions} sampled points)`);
  } else if (minBuildingClear < requiredBuildingClear) {
    fail.push(`snapped creek is too close to a building footprint (${minBuildingClear.toFixed(2)} m clear; expected >= ${requiredBuildingClear.toFixed(2)} m)`);
  }
  if (longestRoadLike > 12 || (totalLen > 0 && roadLikeLen / totalLen > 0.04)) {
    fail.push(`snapped creek tracks road asphalt (${longestRoadLike.toFixed(1)} m longest parallel run, ${roadLikeLen.toFixed(1)} m total road-like contact)`);
  } else if (roadLikeLen > 6) {
    warn.push(`snapped creek has ${roadLikeLen.toFixed(1)} m of road-parallel close contact; crossing contact ${crossingLen.toFixed(1)} m`);
  }
  if (!Number.isFinite(minBuildingClear)) warn.push('creek/building clearance QA found no nearby buildings to measure');
  if (!Number.isFinite(minRoadClear)) warn.push('creek/road clearance QA found no roads to measure');
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
];
if (hasCreek) {
  requiredNodes.push([/^Creek_Banks$/, 'creek bank layer']);
  requiredNodes.push([/^Creek_SanLorenzo$/, 'creek water layer']);
}
for (const [rx, label] of requiredNodes) requireNode(names, rx, label);
if (names.some(n => /^Creek_FlowLines$/.test(n))) {
  fail.push('Creek_FlowLines is present; raw GLB should not ship road-marker-like creek stripes');
}

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

checkCreekClearance();
checkSidewalkGraph();
checkTreesAgainstRoadsAndBuildings();

function checkSourceCoverage() {
  const terrainNode = nodes.find(n => n.getName() === 'Collision_Terrain') || nodes.find(n => n.getName() === 'Terrain');
  if (!terrainNode) return;
  const b = getBounds(terrainNode);
  const spanX = b.max[0] - b.min[0];
  const spanZ = b.max[2] - b.min[2];
  const demSpan = existsSync(demPath) ? (JSON.parse(readFileSync(demPath, 'utf8')).latN - JSON.parse(readFileSync(demPath, 'utf8')).latS) * 110540 : 0;
  if (demSpan >= 800) {
    if (spanX < demSpan - 30 || spanZ < demSpan - 30) {
      fail.push(`terrain collision span ${spanX.toFixed(1)}x${spanZ.toFixed(1)} m does not cover DEM span ${demSpan.toFixed(1)} m`);
    }
    const centers = (S.buildings || []).map((building) => {
      const c = building.p.reduce((a, p) => [a[0] + p[0] / building.p.length, a[1] + p[1] / building.p.length], [0, 0]);
      return w2(c[0], c[1]);
    });
    const covered = centers.filter(([x, z]) => x >= b.min[0] - 4 && x <= b.max[0] + 4 && z >= b.min[2] - 4 && z <= b.max[2] + 4).length;
    if (centers.length >= 300 && covered / centers.length < 0.85) {
      fail.push(`only ${covered}/${centers.length} scene building centers fall inside exported terrain`);
    }
  } else if ((S.meta?.kind || '').includes('dahill')) {
    fail.push(`Dahill DEM span is only ${demSpan.toFixed(1)} m; expected a neighborhood-scale patch >= 800 m`);
  }
}
checkSourceCoverage();

if (fail.length) {
  console.error('Neighborhood export QA failed:');
  for (const f of fail) console.error(' - ' + f);
  if (warn.length) for (const w of warn) console.error(' warn: ' + w);
  process.exit(1);
}
console.log(`PASS neighborhood export QA: ${path.relative(ROOT, glb)} (${nodes.length} nodes)`);
for (const w of warn) console.log('WARN ' + w);
