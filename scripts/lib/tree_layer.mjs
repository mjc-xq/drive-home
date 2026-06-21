// tree_layer.mjs — trees (their OWN layer) + Collision_Trees + a flat creek + creek art + shrubs.
//
// Ports the proven legacy logic (export_property_glb.mjs: loadTreeTemplates, emitTreeLayers,
// flatWaterRibbon, addCreekArtAndShrubs) to the single-surface frame. Trees MUST stay their own
// layer: the runtime instances them by the /tree|leaf|leaves|foliage|trunk|acacia|canopy/ name
// regex, and the downstream build folds the per-tree nodes (sharing geom+material refs) into
// EXT_mesh_gpu_instancing — so we keep per-tree node names 'Tree_NNNN' under one 'Trees' group.
//
// Adds: 'Trees' GROUP (per-placement instanced meshes), 'Collision_Trees' (thin trunk boxes;
// ALWAYS emitted even if empty so the build assert holds), 'Creek_SanLorenzo' (flat glossy-blue
// water via flatWaterRibbon), 'Creek_Banks'/'Creek_Rocks'/'Creek_Reeds', and 'Shrubs'.
//
// terrainAt(X,Z) is the EXACT single-surface sampler; demRect={x0,x1,z0,z1}. Roads are texture on
// the terrain now, so there are no road ribbons to avoid here (legacy used roadLines for spacing);
// we avoid buildings (buildingPolys) and keep the creek's own building-margin snap.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { emitGroundRibbon, fanDisc, offsetLine, snapCreekToChannel } from '../road_prep.mjs';

const CREEK_WIDTH = Number.isFinite(+process.env.CREEK_WIDTH_M) ? +process.env.CREEK_WIDTH_M : 7.5;
const CREEK_DEPTH = Number.isFinite(+process.env.CREEK_DEPTH_M) ? +process.env.CREEK_DEPTH_M : 0.05;

const inPoly = (x, z, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
};

// ---- tree-library loader (ported, adapted for numeric manifest ids) ---------------------
// Reads the exports/tree_lib/tree_0N.glb templates with a gltf-transform NodeIO (meshopt + draco)
// and converts EACH template ONCE into a shared geom + variant material arrays. Per-instance
// (leaf hue x bark hue) variant arrays are REUSED across instances so the build folds (geom,
// variantArray) into one GPU-instanced batch each. Acacia trunk is split off geometrically.
async function loadTreeTemplates(THREE, libDir) {
  const manifestPath = path.join(libDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  const { NodeIO, Logger } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder } = await import('meshoptimizer');
  const { default: draco3d } = await import('draco3dgltf');
  const tio = new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.ERROR))
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'meshopt.decoder': MeshoptDecoder,
    });
  await MeshoptDecoder.ready;
  // role of a template material by name: 'leaf' (foliage) vs 'bark' (trunk).
  const nameRole = (n) => /leaf|leaves|acacia|foliage|canopy/i.test(n) ? 'leaf'
    : /bark|trunk|wood|stem/i.test(n) ? 'bark' : 'leaf';
  // per-instance VARIETY palettes (no per-vertex COLOR_0): ~4 leaf hues + ~3 bark hues.
  const LEAF_HUES = [
    new THREE.Color(0.20, 0.42, 0.12), new THREE.Color(0.42, 0.46, 0.16),
    new THREE.Color(0.50, 0.58, 0.18), new THREE.Color(0.28, 0.50, 0.17),
  ];
  const BARK_HUES = [
    new THREE.Color(0.32, 0.20, 0.13), new THREE.Color(0.42, 0.30, 0.20), new THREE.Color(0.24, 0.16, 0.11),
  ];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const templates = [];
  for (const entry of manifest.trees) {
    const f = path.join(libDir, entry.file);
    if (!existsSync(f)) continue;
    // stable string id ('tree_05' etc.) from numeric or string manifest id (for the acacia split)
    const sid = (typeof entry.id === 'number') ? `tree_0${entry.id}` : String(entry.id);
    const doc = await tio.read(f);
    const pos = [], nor = [], uv = [], idx = [];
    const groups = [];
    let vbase = 0, ymin = Infinity, ymax = -Infinity;
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const P = prim.getAttribute('POSITION'); if (!P) continue;
        const N = prim.getAttribute('NORMAL'), U = prim.getAttribute('TEXCOORD_0'), I = prim.getIndices();
        const role = nameRole(prim.getMaterial()?.getName() || '');
        const n = P.getCount(), e = [];
        const gStart = idx.length;
        for (let k = 0; k < n; k++) {
          P.getElement(k, e); pos.push(e[0], e[1], e[2]);
          if (e[1] < ymin) ymin = e[1]; if (e[1] > ymax) ymax = e[1];
          if (N) { N.getElement(k, e); nor.push(e[0], e[1], e[2]); }
          if (U) { U.getElement(k, e); uv.push(e[0], e[1]); }
        }
        if (I) { const ia = I.getArray(); for (let k = 0; k < ia.length; k++) idx.push(vbase + ia[k]); }
        else { for (let k = 0; k < n; k++) idx.push(vbase + k); }
        groups.push({ start: gStart, count: idx.length - gStart, role });
        vbase += n;
      }
    }
    if (!pos.length) continue;
    // ACACIA SPLIT: a single all-'leaf' material covering trunk + canopy -> re-tag the lowest
    // ~20% of leaf-group TRIANGLES (by centroid height) as 'bark' so the trunk reads brown.
    const needsSplit = sid === 'tree_05' || /acacia/i.test(entry.file || '') || groups.every(g => g.role === 'leaf');
    let finalGroups = groups;
    if (needsSplit && ymax > ymin) {
      const cut = ymin + 0.20 * (ymax - ymin);
      const triY = (t) => (pos[idx[t] * 3 + 1] + pos[idx[t + 1] * 3 + 1] + pos[idx[t + 2] * 3 + 1]) / 3;
      finalGroups = [];
      for (const gr of groups) {
        if (gr.role !== 'leaf') { finalGroups.push(gr); continue; }
        let runStart = gr.start, runRole = null;
        for (let t = gr.start; t < gr.start + gr.count; t += 3) {
          const sub = triY(t) < cut ? 'bark' : 'leaf';
          if (runRole === null) runRole = sub;
          else if (sub !== runRole) { finalGroups.push({ start: runStart, count: t - runStart, role: runRole }); runStart = t; runRole = sub; }
        }
        if (runRole !== null) finalGroups.push({ start: runStart, count: gr.start + gr.count - runStart, role: runRole });
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (nor.length === pos.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    if (uv.length === (pos.length / 3) * 2) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    if (nor.length !== pos.length) g.computeVertexNormals();
    const SLOT = { leaf: 0, bark: 1 };
    for (const gr of finalGroups) g.addGroup(gr.start, gr.count, SLOT[gr.role]);
    const variants = [];
    for (let li = 0; li < LEAF_HUES.length; li++) for (let bi = 0; bi < BARK_HUES.length; bi++) {
      variants.push([
        new THREE.MeshStandardMaterial({ name: `Tree_${sid}_leaf_${li}`, color: LEAF_HUES[li].clone(), roughness: 0.92, metalness: 0, side: THREE.DoubleSide }),
        new THREE.MeshStandardMaterial({ name: `Tree_${sid}_bark_${bi}`, color: BARK_HUES[bi].clone(), roughness: 0.95, metalness: 0, side: THREE.DoubleSide }),
      ]);
    }
    templates.push({ id: sid, geom: g, variants, mat: variants[0], height_m: entry.height_m || 6, feature: !!entry.feature });
  }
  return templates.length ? templates : null;
}

// ---- flat water ribbon (ported, unchanged) ---------------------------------------------
// Real creeks don't climb hills: densify the centreline, split into short elevation-bounded runs,
// each gets ONE flat water surface at its local channel floor (level pools/steps, not a road ramp).
function flatWaterRibbon(lineW, width, lift, terrainAt, posArr, idxArr) {
  const hw = width / 2;
  const dense = [lineW[0]];
  for (let k = 1; k < lineW.length; k++) {
    const a = lineW[k - 1], b = lineW[k], seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(seg / 2.0));
    for (let s = 1; s <= steps; s++) dense.push([a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps]);
  }
  const elev = dense.map(([x, z]) => terrainAt(x, z));
  const MAX_RUN_ELEV_RANGE = 0.9;
  const runs = [];
  let cur = [0], lo = elev[0], hi = elev[0];
  for (let k = 1; k < dense.length; k++) {
    const nlo = Math.min(lo, elev[k]), nhi = Math.max(hi, elev[k]);
    if (cur.length >= 2 && nhi - nlo > MAX_RUN_ELEV_RANGE) {
      runs.push(cur); cur = [k - 1, k];
      lo = Math.min(elev[k - 1], elev[k]); hi = Math.max(elev[k - 1], elev[k]);
    } else { cur.push(k); lo = nlo; hi = nhi; }
  }
  if (cur.length) runs.push(cur);
  for (const run of runs) {
    if (run.length < 2) continue;
    const ys = run.map(k => elev[k]).sort((a, b) => a - b);
    const runFloor = ys[Math.floor(0.15 * (ys.length - 1))];
    const surfaceY = runFloor - lift;
    let prevOff = null;
    for (const k of run) {
      const [x, z] = dense[k], p = dense[Math.max(0, k - 1)], q = dense[Math.min(dense.length - 1, k + 1)];
      let dx = q[0] - p[0], dz = q[1] - p[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const nx = -dz, nz = dx, lx = x + nx * hw, lz = z + nz * hw, rx = x - nx * hw, rz = z - nz * hw;
      const off = posArr.length / 3;
      posArr.push(lx, surfaceY, lz, rx, surfaceY, rz);
      if (prevOff !== null) { const a = prevOff, b = a + 1, c = off, d = off + 1; idxArr.push(a, c, b, b, c, d); }
      prevOff = off;
    }
  }
}

export async function buildTreeLayer({
  THREE, scene, w2, terrainAt, demRect, ROOT, dir,
  treesPlacedPath, creek, buildingPolys,
}) {
  const rng = (() => { let a = 1840; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();
  const { x0, x1, z0, z1 } = demRect;
  const inRect = (x, z, m = 0) => x >= x0 + m && x <= x1 - m && z >= z0 + m && z <= z1 - m;
  const onBuilding = (x, z) => (buildingPolys || []).some(r => inPoly(x, z, r));
  const polys = buildingPolys || [];

  const mkMesh = (pos, idx, color, name, opts = {}) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (idx) g.setIndex(idx);
    g.computeVertexNormals();
    const opacity = opts.opacity ?? 1;
    const m = new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.95, metalness: opts.metal ?? 0, name: name + '_mat', transparent: opacity < 1, opacity });
    if (opacity === 0) { m.transparent = false; m.alphaTest = 0.5; m.depthWrite = true; }
    m.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(g, m); mesh.name = name; return mesh;
  };

  // ---- CREEK (flat water) + banks/rocks/reeds (ported addCreekArtAndShrubs water half) ---
  let creekW = null;
  let hasCreek = false;
  if (creek && creek.p) {
    creekW = creek.p.map(([e, n]) => w2(e, n)).filter(([x, z]) => x >= x0 - 3 && x <= x1 + 3 && z >= z0 - 3 && z <= z1 + 3);
    if (creekW.length >= 2) {
      // SNAP the creek toward the real DEM channel AND away from buildings — the raw OSM
      // centreline runs through houses otherwise (the "river through the house" bug). Margin =
      // full water half-width + bank slack so the whole ribbon clears building footprints.
      creekW = snapCreekToChannel(creekW, terrainAt, {
        radius: 18, step: 1.5, strength: 0.9, smoothPasses: 2,
        avoidPolygons: polys, avoidPolygonMargin: CREEK_WIDTH / 2 + 1.75,
      });
    }
    if (creekW.length >= 2) {
      const cPos = [], cIdx = [];
      flatWaterRibbon(creekW, CREEK_WIDTH, CREEK_DEPTH, terrainAt, cPos, cIdx);
      if (cIdx.length) {
        // bright glossy slightly-reflective water (reads WET in every viewer), not matte navy.
        const cr = mkMesh(cPos, cIdx, 0x2f8fd8, 'Creek_SanLorenzo', { rough: 0.18, metal: 0.15 });
        cr.material.name = 'Creek_mat'; scene.add(cr); hasCreek = true;
      }
      // banks: thin vegetated lip snug to the water edge
      const bankPos = [], bankIdx = [], rockPos = [], rockIdx = [], reedPos = [];
      emitGroundRibbon(offsetLine(creekW, CREEK_WIDTH / 2 + 0.35), 0.45, 0.055, terrainAt, bankPos, bankIdx);
      emitGroundRibbon(offsetLine(creekW, -(CREEK_WIDTH / 2 + 0.35)), 0.45, 0.055, terrainAt, bankPos, bankIdx);
      const emitRock = (x, z) => { const o = rockPos.length / 3; rockPos.push(x, terrainAt(x, z) + 0.26, z); return o; };
      for (let k = 1; k < creekW.length; k++) {
        const a = creekW[k - 1], b = creekW[k];
        let dx = b[0] - a[0], dz = b[1] - a[1];
        const seg = Math.hypot(dx, dz) || 1; dx /= seg; dz /= seg;
        const nx = -dz, nz = dx;
        for (let s = 0; s < seg; s += 8) for (const side of [1, -1]) if (rng() < 0.38) {
          const x = a[0] + dx * s + nx * side * (CREEK_WIDTH / 2 + 0.9 + rng() * 1.5);
          const z = a[1] + dz * s + nz * side * (CREEK_WIDTH / 2 + 0.9 + rng() * 1.5);
          if (inRect(x, z, 2)) fanDisc(x, z, 0.18 + rng() * 0.42, 8, emitRock, rockIdx);
        }
        for (let s = 0; s < seg; s += 5) for (const side of [1, -1]) if (rng() < 0.55) {
          const x = a[0] + dx * s + nx * side * (CREEK_WIDTH / 2 + 1.4);
          const z = a[1] + dz * s + nz * side * (CREEK_WIDTH / 2 + 1.4);
          if (!inRect(x, z, 2)) continue;
          const y = terrainAt(x, z) + 0.18, h = 0.45 + rng() * 0.55, ww = 0.035;
          reedPos.push(x - nx * ww, y, z - nz * ww, x + nx * ww, y, z + nz * ww, x + dx * 0.08, y + h, z + dz * 0.08);
        }
      }
      if (bankIdx.length) scene.add(mkMesh(bankPos, bankIdx, 0x5a6b46, 'Creek_Banks', { rough: 1.0 }));
      if (rockIdx.length) scene.add(mkMesh(rockPos, rockIdx, 0x77786f, 'Creek_Rocks'));
      if (reedPos.length) scene.add(mkMesh(reedPos, null, 0x607a3d, 'Creek_Reeds'));
    }
  }

  // ---- SHRUBS (ported addCreekArtAndShrubs shrub half; road avoidance dropped) ----------
  const shrubPos = [], shrubIdx = [];
  const pushShrub = (x, z, r, h) => {
    const sides = 9, base = shrubPos.length / 3, y = terrainAt(x, z) + 0.08;
    for (let k = 0; k < sides; k++) {
      const a = k / sides * Math.PI * 2;
      shrubPos.push(x + Math.cos(a) * r * (0.75 + rng() * 0.35), y, z + Math.sin(a) * r * (0.75 + rng() * 0.35));
    }
    shrubPos.push(x, y + h, z);
    const top = base + sides;
    for (let k = 0; k < sides; k++) shrubIdx.push(base + k, base + ((k + 1) % sides), top);
  };
  const shrubOK = (x, z) => inRect(x, z, 3) && !onBuilding(x, z);
  let nShrubs = 0;
  for (let i = 0; i < 420 && shrubIdx.length / 3 < 180; i++) {
    let x, z;
    if (creekW && creekW.length >= 2 && rng() < 0.55) {
      const seg = creekW[Math.floor(rng() * Math.max(1, creekW.length - 1))];
      x = seg[0] + (rng() - 0.5) * 22; z = seg[1] + (rng() - 0.5) * 22;
    } else {
      x = x0 + rng() * (x1 - x0); z = z0 + rng() * (z1 - z0);
    }
    if (shrubOK(x, z)) { pushShrub(x, z, 0.45 + rng() * 0.75, 0.45 + rng() * 0.75); nShrubs++; }
  }
  if (shrubIdx.length) scene.add(mkMesh(shrubPos, shrubIdx, 0x4d7437, 'Shrubs'));

  // ---- TREES (own layer) + Collision_Trees (ported emitTreeLayers) ----------------------
  const placedPath = treesPlacedPath && existsSync(treesPlacedPath)
    ? treesPlacedPath
    : path.join(ROOT, 'exports/trees_placed.json');
  const trPos = [], trIdx = [];
  const pushTrunkBox = (x, z, half = 0.175, h = 2.2) => {
    const base = trPos.length / 3, y0 = terrainAt(x, z), y1 = y0 + h;
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [sx, sz] of c) trPos.push(x + sx * half, y0, z + sz * half, x + sx * half, y1, z + sz * half);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      trIdx.push(base + k * 2, base + j * 2, base + j * 2 + 1, base + k * 2, base + j * 2 + 1, base + k * 2 + 1);
    }
    trIdx.push(base + 1, base + 3, base + 5, base + 1, base + 5, base + 7);
  };

  let nTrees = 0;
  if (existsSync(placedPath)) {
    const placed = (JSON.parse(readFileSync(placedPath, 'utf8')).trees) || [];
    const libDir = (dir && existsSync(path.join(dir, 'tree_lib', 'manifest.json')))
      ? path.join(dir, 'tree_lib')
      : path.join(ROOT, 'exports/tree_lib');
    const templates = await loadTreeTemplates(THREE, libDir);
    if (templates && templates.length && placed.length) {
      const treesGroup = new THREE.Group(); treesGroup.name = 'Trees';
      const hashOf = (i) => Math.imul((i | 0) + 0x9e3779b9, 2654435761) >>> 0;
      const yawOf = (i) => (hashOf(i) / 4294967296) * Math.PI * 2;
      const normalTpls = templates.filter(t => !t.feature);
      const featureTpls = templates.filter(t => t.feature);
      const pool = normalTpls.length ? normalTpls : templates;
      const pickTemplate = (height, h) => {
        if (featureTpls.length && (h % 9) === 0) return featureTpls[(h >>> 8) % featureTpls.length];
        const ranked = [...pool].sort((a, b) => Math.abs((a.height_m || 6) - height) - Math.abs((b.height_m || 6) - height));
        const k = Math.min(3, ranked.length);
        return ranked[(h >>> 4) % k];
      };
      for (const t of placed) {
        const x = +t.x, z = +t.z, height = +t.height || 7;
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        // re-seat on the NEW single-surface terrain (placement json's base was baked on the legacy
        // DEM; this frame's terrainAt is the authoritative surface, so sample it here).
        const base = terrainAt(x, z);
        if (!Number.isFinite(base)) continue;
        const idxKey = t.i ?? nTrees;
        const h = hashOf(idxKey);
        const tmpl = pickTemplate(height, h);
        const s = Math.max(0.1, height / (tmpl.height_m || 6));
        const variantArr = tmpl.variants[(h >>> 12) % tmpl.variants.length];
        const m = new THREE.Mesh(tmpl.geom, variantArr);   // SHARE geom + variant array by reference
        m.position.set(x, base, z);
        m.scale.setScalar(s);
        m.rotation.y = yawOf(idxKey);
        m.name = 'Tree_' + idxKey;
        treesGroup.add(m);
        pushTrunkBox(x, z);
        nTrees++;
      }
      scene.add(treesGroup);
    }
  }
  // ALWAYS emit Collision_Trees (the build asserts the node exists). Empty -> one tiny throwaway
  // box at the patch corner so the node carries valid, non-degenerate geometry.
  if (!trIdx.length) pushTrunkBox(x0 + 1, z0 + 1, 0.05, 0.1);
  scene.add(mkMesh(trPos, trIdx, 0x00ff00, 'Collision_Trees', { opacity: 0 }));

  console.log(`trees: ${nTrees} instances -> 'Trees' group + 'Collision_Trees'; shrubs: ${nShrubs}; creek: ${hasCreek ? 'yes' : 'no'}`);
  return { nTrees, nShrubs, hasCreek };
}
