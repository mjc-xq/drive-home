// Build a VEGETATION + WATER overlay GLB per level.
//
// The single-surface env GLB (buildings + textured ground + collision) deliberately drops the
// creek water, trees, and grass (it flattens to one surface). Per the vegetation strategy we layer
// those back IN UNITY: extract only the creek/tree/grass nodes from the rich master, GPU-instance
// the repeated tree/grass meshes (1050 tree nodes -> 48 meshes, 522 grass clumps), meshopt-compress,
// and ship as <level>_overlay.glb. DaHilgLevelRuntime loads it on top of the env at the same offset;
// its existing handling animates water (DaHilgWaterAnimator) and tunes trees/grass (TuneVegetationSurface).

import { NodeIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, instance, dedup } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import { statSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXPORT = (...p) => path.join(ROOT, 'exports', ...p);
const OUT = (...p) => path.join(ROOT, 'public', 'da-hilg', ...p);

// level slug -> rich master that still has the named creek/tree/grass meshes
const MASTERS = [
  { out: 'level',   master: '1840-dahill-property-trees.glb' },
  { out: 'canyon',  master: 'canyon-middle-school-property.glb' },
  { out: 'stanton', master: 'stanton-elementary-property.glb' },
  { out: 'meemaw',  master: 'meemaw-property.glb' },
  { out: 'xq',      master: 'xq-property.glb' },
];

const MINIMAP_BY_OUT = {
  level: 'minimap',
  canyon: 'canyon.minimap',
  stanton: 'stanton.minimap',
  meemaw: 'meemaw.minimap',
  xq: 'xq.minimap',
};

// Keep ONLY vegetation + water. Buildings/ground/roads/terrain live in the single-surface env.
const KEEP = /(creek|tree|shrub|grass|clump|reed|foliage|bush|plant|hedge|canopy|trunk|fence|gate|rail|railing|barrier)/i;

function refineStreetSpawnFromRoadGrid(out, meta, sx, sz) {
  const minimapName = MINIMAP_BY_OUT[out];
  if (!minimapName || !meta?.houseCenter || !meta?.offset) return { sx, sz, refined: false };

  const pathName = OUT(`${minimapName}.json`);
  if (!existsSync(pathName)) return { sx, sz, refined: false };

  const minimap = JSON.parse(readFileSync(pathName, 'utf8'));
  const n = Number(minimap.fillN || 0);
  if (!Number.isFinite(n) || n <= 0 || n > 512 || !minimap.fillRoad) return { sx, sz, refined: false };

  const minX = minimap.bounds?.minX ?? minimap.minX;
  const minZ = minimap.bounds?.minZ ?? minimap.minZ;
  const maxX = minimap.bounds?.maxX ?? minimap.maxX;
  const maxZ = minimap.bounds?.maxZ ?? minimap.maxZ;
  if (![minX, minZ, maxX, maxZ].every(Number.isFinite) || maxX <= minX || maxZ <= minZ) {
    return { sx, sz, refined: false };
  }

  const bits = Buffer.from(minimap.fillRoad, 'base64');
  const roadBit = (col, row) => {
    if (col < 0 || col >= n || row < 0 || row >= n) return false;
    const cell = row * n + col;
    const byteIndex = cell >> 3;
    return byteIndex >= 0 && byteIndex < bits.length && (bits[byteIndex] & (1 << (cell & 7))) !== 0;
  };

  const off = meta.offset;
  const houseLocal = [meta.houseCenter[0] - off[0], meta.houseCenter[2] - off[2]];
  const spawnLocal = [sx - off[0], sz - off[2]];
  const existingDistance = Math.hypot(spawnLocal[0] - houseLocal[0], spawnLocal[1] - houseLocal[1]);

  let dx = spawnLocal[0] - houseLocal[0];
  let dz = spawnLocal[1] - houseLocal[1];
  let d = Math.hypot(dx, dz);
  if (d < 1) {
    dx = 0;
    dz = 1;
    d = 1;
  }
  const dirX = dx / d;
  const dirZ = dz / d;
  const targetAlong = Math.min(72, Math.max(54, existingDistance + 12));

  let best = null;
  let bestScore = Infinity;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!roadBit(col, row)) continue;
      const x = minX + (col + 0.5) / n * (maxX - minX);
      const z = minZ + (row + 0.5) / n * (maxZ - minZ);
      const vx = x - houseLocal[0];
      const vz = z - houseLocal[1];
      const along = vx * dirX + vz * dirZ;
      if (along < 42 || along > 78) continue;
      const lateral = Math.abs(-dirZ * vx + dirX * vz);
      if (lateral > 30) continue;
      const radius = Math.hypot(vx, vz);
      if (radius > 90) continue;
      const score = Math.abs(along - targetAlong) + lateral * 0.45;
      if (score < bestScore) {
        bestScore = score;
        best = [x, z, along, lateral];
      }
    }
  }

  if (!best) return { sx, sz, refined: false };
  return { sx: best[0] + off[0], sz: best[1] + off[2], refined: true, along: best[2], lateral: best[3] };
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .setLogger(new Logger(Logger.Verbosity.ERROR))
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });

mkdirSync(OUT(), { recursive: true });

for (const { out, master } of MASTERS) {
  const src = EXPORT(master);
  if (!existsSync(src)) { console.warn(`skip ${out}: no master ${path.relative(ROOT, src)}`); continue; }

  const doc = await io.read(src);
  const root = doc.getRoot();

  // --- street-front spawn: nearest Roads point to the house, written into the level meta ----------
  // Roads geometry lives only in this property master; the meta (offset/houseCenter, world coords)
  // shares its world space. We find the nearest road vertex to the house, push ~3.5m toward the
  // house onto the shoulder, and store recentered-local streetSpawn + a yaw facing out to the street. The
  // builder reads streetSpawn as PlayerSpawns[0]; canyon's road is too far (>70m) -> front-yard.
  // Done BEFORE the mesh-strip loop so the Roads mesh is still present.
  try {
    const metaPath = OUT(`${out}.meta.json`);
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      const hc = meta.houseCenter, off = meta.offset;
      if (hc && off) {
        // World-XZ vertex sampler for nodes matching a name regex -> array of [x, z].
        const gather = (re) => {
          const pts = []; const v = [0, 0, 0];
          for (const node of root.listNodes()) {
            if (!re.test(node.getName() || '') || !node.getMesh()) continue;
            const wm = node.getWorldMatrix();
            for (const prim of node.getMesh().listPrimitives()) {
              const pos = prim.getAttribute('POSITION'); if (!pos) continue;
              const cnt = pos.getCount(), step = Math.max(1, Math.floor(cnt / 4000));
              for (let i = 0; i < cnt; i += step) {
                pos.getElement(i, v);
                pts.push([wm[0]*v[0]+wm[4]*v[1]+wm[8]*v[2]+wm[12], wm[2]*v[0]+wm[6]*v[1]+wm[10]*v[2]+wm[14]]);
              }
            }
          }
          return pts;
        };
        const house = gather(/house_walls|^house$/i);
        const roads = gather(/^roads?$/i);
        const walls = gather(/wall/i);   // master building walls (often just the target house)
        // The MASTER usually lacks the neighbour buildings, so a "clear" spawn can still land in a gap
        // beside a neighbour that boxes the 3rd-person camera. The single-surface ENV (public/da-hilg/
        // <out>.glb) HAS every Buildings_walls; fold them in (env is re-centered: master = env + offset)
        // so the spawn keeps real clearance from EVERY building, not just the address.
        try {
          const envPath = OUT(`${out}.glb`);
          if (existsSync(envPath)) {
            const envDoc = await io.read(envPath);
            const ev = [0, 0, 0];
            for (const node of envDoc.getRoot().listNodes()) {
              if (!/buildings?_walls|house_walls/i.test(node.getName() || '') || !node.getMesh()) continue;
              const wm = node.getWorldMatrix();
              for (const prim of node.getMesh().listPrimitives()) {
                const pos = prim.getAttribute('POSITION'); if (!pos) continue;
                const cnt = pos.getCount(), step = Math.max(1, Math.floor(cnt / 2500));
                for (let i = 0; i < cnt; i += step) {
                  pos.getElement(i, ev);
                  const ex = wm[0]*ev[0]+wm[4]*ev[1]+wm[8]*ev[2]+wm[12];
                  const ez = wm[2]*ev[0]+wm[6]*ev[1]+wm[10]*ev[2]+wm[14];
                  walls.push([ex + off[0], ez + off[2]]);   // env-local -> master world
                }
              }
            }
            console.log(`${out}: folded ${walls.length} wall pts (master + env neighbours) into spawn clearance`);
          }
        } catch (e) { console.warn(`${out}: env walls skipped — ${e.message}`); }
        // PCA of the house footprint (XZ): the long axis runs along the facade; the FRONT faces
        // perpendicular to it. Score each perpendicular side by road mass in a 60deg cone and pick the
        // side with the real street (so a side/back road never wins).
        let cx = hc[0] - 0, cz = hc[2];
        if (house.length) { cx = 0; cz = 0; for (const p of house) { cx += p[0]; cz += p[1]; } cx /= house.length; cz /= house.length; }
        let sxx = 0, szz = 0, sxz = 0;
        for (const p of house) { const dx = p[0]-cx, dz = p[1]-cz; sxx += dx*dx; szz += dz*dz; sxz += dx*dz; }
        const m = Math.max(1, house.length); sxx/=m; szz/=m; sxz/=m;
        const tr = sxx+szz, l1 = tr/2 + Math.sqrt(Math.max(0, (sxx-szz)*(sxx-szz)/4 + sxz*sxz));
        let ax, az; if (Math.abs(sxz) > 1e-6) { ax = l1-szz; az = sxz; } else { ax = sxx>=szz?1:0; az = sxx>=szz?0:1; }
        const al = Math.hypot(ax,az)||1; ax/=al; az/=al;
        const normals = [[-az, ax],[az,-ax]]; // the two facade-front directions

        // How far the house walls reach along a front direction, and the open clearance from any point
        // to the nearest wall vertex. The OLD code picked the NEAREST road point in the cone, which on
        // 1840 Dahill hugs the long side wall (~3 m) -> you spawn facing a wall. Instead we want a point
        // at real clearance, out in front of the facade.
        const CLEAR = 11;                                   // metres of open ground wanted in front
        const wallReach = (nx, nz) => { let mx = 0; for (const p of house) { const pr = (p[0]-cx)*nx + (p[1]-cz)*nz; if (pr > mx) mx = pr; } return mx; };
        // Clearance to the NEAREST of ANY building wall (not just the target house) — keeps the spawn out
        // of narrow gaps beside a neighbour, so the 3rd-person camera behind the player isn't walled in.
        const clearPts = walls.length ? walls : house;
        const wallClear = (x, z) => { let m = Infinity; for (const p of clearPts) { const d = Math.hypot(p[0]-x, p[1]-z); if (d < m) m = d; } return m; };

        let chosen = null, chosenN = null, viaFront = false, bestScore = -1;
        for (const [nx,nz] of normals) {
          const reach = wallReach(nx, nz), target = reach + CLEAR;
          let score = 0, best = null, bestErr = Infinity;
          for (const r of roads) {
            const dx = r[0]-cx, dz = r[1]-cz, d = Math.hypot(dx,dz);
            if (d < 1 || d > 140) continue;
            const dot = (dx*nx + dz*nz)/d;
            if (dot < 0.5) continue;                        // within ~60deg of this front direction
            score += dot/d;
            const along = dx*nx + dz*nz;                    // signed distance out along the normal
            if (along < reach + 4) continue;                // reject points hugging / inside the wall line
            if (wallClear(r[0], r[1]) < 7) continue;        // reject side-yard roads close to ANY wall
            const err = Math.abs(along - target);
            if (err < bestErr) { bestErr = err; best = r; }
          }
          if (best && score > bestScore) { bestScore = score; chosen = best; chosenN = [nx,nz]; viaFront = true; }
        }
        if (!chosen) { // road mass exists in front but no clear point -> synthesise one on the best normal
          let bn = null, bs = -1;
          for (const [nx,nz] of normals) { let s=0; for (const r of roads){ const dx=r[0]-cx,dz=r[1]-cz,d=Math.hypot(dx,dz); if(d<1||d>140)continue; const dot=(dx*nx+dz*nz)/d; if(dot>=0.5)s+=dot/d; } if(s>bs){bs=s;bn=[nx,nz];} }
          if (bn && bs > 0) { const reach = wallReach(bn[0],bn[1]); chosen = [cx + bn[0]*(reach+CLEAR), cz + bn[1]*(reach+CLEAR)]; chosenN = bn; viaFront = true; }
        }
        if (!chosen) { // fallback: overall-nearest road <=70m (rural levels stay null -> front-yard)
          let bd = Infinity; for (const r of roads) { const d = Math.hypot(r[0]-hc[0], r[1]-hc[2]); if (d < bd) { bd = d; chosen = d <= 70 ? r : null; } }
        }
        if (chosen) {
          // Guarantee clearance: if still close to a wall, walk out along the front normal until clear.
          let sx = chosen[0], sz = chosen[1];
          if (chosenN) { let g = 0; while (wallClear(sx, sz) < CLEAR - 1 && g++ < 40) { sx += chosenN[0]; sz += chosenN[1]; } }
          const roadGridRefine = refineStreetSpawnFromRoadGrid(out, meta, sx, sz);
          const roadGridClear = roadGridRefine.refined ? wallClear(roadGridRefine.sx, roadGridRefine.sz) : 0;
          const currentClear = wallClear(sx, sz);
          if (roadGridRefine.refined && (roadGridClear >= CLEAR - 2 || roadGridClear > currentClear + 2)) {
            sx = roadGridRefine.sx;
            sz = roadGridRefine.sz;
          }
          // dahill's address sits in a deep side-gap, so the auto front-clear point ([17.29,16.29])
          // lands between the buildings rather than on the street. Nudge the spawn the rest of the way
          // out along the front normal onto the road (verified: walking forward from there reaches it).
          if (out === 'level' && chosenN) { sx += chosenN[0] * 14; sz += chosenN[1] * 14; }
          const lr = [sx-off[0], sz-off[2]];                 // recentered-local x,z
          const lh = [hc[0]-off[0], hc[2]-off[2]];
          const dx = lr[0]-lh[0], dz = lr[1]-lh[1];          // face out from the house toward the street
          const r2 = n => Math.round(n*100)/100;
          meta.streetSpawn = [r2(lr[0]), 0.05, r2(lr[1])];
          let yaw = Math.atan2(dx, dz) * 180 / Math.PI; if (yaw < 0) yaw += 360;
          meta.facing = Math.round(yaw*10)/10;
          writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
          const source = roadGridRefine.refined && roadGridClear >= CLEAR - 2
            ? `road-grid along=${roadGridRefine.along.toFixed(1)} lateral=${roadGridRefine.lateral.toFixed(1)}`
            : (viaFront ? 'front-clear' : 'fallback');
          console.log(`${out}: streetSpawn=[${meta.streetSpawn}] facing=${meta.facing} clear=${wallClear(sx,sz).toFixed(1)}m (${source})`);
        } else {
          console.log(`${out}: no street spawn (road too far) — keeps front-yard spawn`);
        }
      }
    }
  } catch (e) { console.warn(`${out}: streetSpawn skipped — ${e.message}`); }

  // Strip the mesh off every node whose name is NOT vegetation/water (keeps the hierarchy intact so
  // we never orphan a kept child). prune() then drops the now-unused meshes/materials/textures.
  let kept = 0, stripped = 0;
  // FIX 1 — acacia "blob" trees. The acacia canopy primitive uses an OPAQUE texture with no alpha
  // channel (Acacia_BaseColor is RGB), so no runtime alpha-cutout can ever cut it — it renders as a
  // solid green blob. Each acacia mesh has prim[0]=Acacia_Mat (OPAQUE blob) + prim[1]=NormalTree_Leaves
  // (MASK cut-out leaves). Drop the OPAQUE acacia canopy prim and keep the MASK leaf prim so the acacia
  // renders as a normal cut-out leaf tree. Acacia meshes are shared across ~14 Tree_NNNN nodes, so
  // de-dupe by mesh to avoid removing a primitive twice. Scoped strictly to meshes matching /acacia/i.
  const acaciaFixed = new Set();
  const debladeAcacia = (mesh) => {
    if (!mesh || acaciaFixed.has(mesh)) return;
    acaciaFixed.add(mesh);
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (!mat) continue;
      const isOpaqueCanopy = mat.getAlphaMode() === 'OPAQUE' || /acacia/i.test(mat.getName() || '');
      if (isOpaqueCanopy) mesh.removePrimitive(prim);
    }
  };
  for (const node of root.listNodes()) {
    const name = node.getName() || '';
    const mesh = node.getMesh();
    if (mesh) {
      if (KEEP.test(name)) {
        if (/acacia/i.test(mesh.getName() || '')) debladeAcacia(mesh);
        kept++;
      } else { node.setMesh(null); stripped++; }
    }
  }

  // FIX 2 — trees/grass standing IN the creek/water. Cull kept vegetation nodes that sit on water cells.
  // dahill has ~1805 water cells; the other 4 levels have 0, so this is a no-op for them. We mirror the
  // runtime water-bitmask decode (DaHilgLevelRuntime.cs RoadBit / BuildPavedOverlay): cell = row*n + col,
  // byteIndex = cell>>3, bit = 1<<(cell&7); cell center maps to env-space x=lerp(minX,maxX,(col+0.5)/n),
  // z=lerp(minZ,maxZ,(row+0.5)/n). Node env-space XZ = world translation MINUS the meta offset the runtime
  // applies (master = env + offset). A node is culled when its OWN cell is water; the ~3.15m cell size is
  // the ~1-cell (~3.15m) tolerance, so a tree on/just-into the water is culled while bank-framing trees one
  // cell out survive (DILATE bumps the halo a further cell — kept at 0 here, which over-prunes ~2x at 1).
  // Cull Tree_NNNN / GrassClump / bare grass / Shrubs — but NOT reeds, creek, banks, rocks, fence/gate/rail.
  const CULL_VEG = /^Tree_|grassclump|^grass|^shrubs?/i;
  try {
    const minimapName = MINIMAP_BY_OUT[out];
    const metaPath = OUT(`${out}.meta.json`);
    const minimapPath = minimapName ? OUT(`${minimapName}.json`) : null;
    if (minimapPath && existsSync(minimapPath) && existsSync(metaPath)) {
      const minimap = JSON.parse(readFileSync(minimapPath, 'utf8'));
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      const n = Number(minimap.fillN || 0);
      const minX = minimap.bounds?.minX ?? minimap.minX;
      const minZ = minimap.bounds?.minZ ?? minimap.minZ;
      const maxX = minimap.bounds?.maxX ?? minimap.maxX;
      const maxZ = minimap.bounds?.maxZ ?? minimap.maxZ;
      const off = meta?.offset;
      const okBounds = [minX, minZ, maxX, maxZ].every(Number.isFinite) && maxX > minX && maxZ > minZ;
      if (Number.isFinite(n) && n > 0 && n <= 512 && minimap.fillWater && okBounds && off) {
        const bits = Buffer.from(minimap.fillWater, 'base64');
        const waterBit = (col, row) => {
          if (col < 0 || col >= n || row < 0 || row >= n) return false;
          const cell = row * n + col;
          const byteIndex = cell >> 3;
          return byteIndex >= 0 && byteIndex < bits.length && (bits[byteIndex] & (1 << (cell & 7))) !== 0;
        };
        // total set water cells — short-circuits the (already no-op) other-level case and gives a useful log.
        let waterCells = 0;
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (waterBit(c, r)) waterCells++;
        let culled = 0;
        if (waterCells > 0) {
          const DILATE = 0; // own-cell test; the 3.15m cell IS the ~1-cell tolerance (1 over-prunes ~2x)
          for (const node of root.listNodes()) {
            if (!node.getMesh()) continue;
            if (!CULL_VEG.test(node.getName() || '')) continue;
            const wm = node.getWorldMatrix();
            const ex = wm[12] - off[0]; // env-space X = world X - offset X
            const ez = wm[14] - off[2]; // env-space Z = world Z - offset Z
            const col = Math.floor((ex - minX) / (maxX - minX) * n);
            const row = Math.floor((ez - minZ) / (maxZ - minZ) * n);
            let onWater = false;
            for (let dr = -DILATE; dr <= DILATE && !onWater; dr++)
              for (let dc = -DILATE; dc <= DILATE && !onWater; dc++)
                if (waterBit(col + dc, row + dr)) onWater = true;
            if (onWater) { node.setMesh(null); culled++; }
          }
        }
        console.log(`${out}: water-cull removed ${culled} on-water veg nodes (${waterCells} water cells)`);
      }
    }
  } catch (e) { console.warn(`${out}: water-cull skipped — ${e.message}`); }

  await doc.transform(
    prune(),                                   // drop orphaned meshes/mats/textures from stripped nodes
    dedup(),                                   // merge identical meshes/materials/accessors
    instance({ min: 2 }),                      // GPU-instance repeated tree/grass meshes (EXT_mesh_gpu_instancing)
    prune(),
  );

  const dest = OUT(`${out}_overlay.glb`);
  await io.write(dest, doc);
  const mb = (statSync(dest).size / 1e6).toFixed(1);
  const meshes = doc.getRoot().listMeshes().length;
  console.log(`${out}_overlay.glb  ${mb} MB  (kept ${kept} veg/water nodes, ${stripped} stripped, ${meshes} meshes)  <- ${master}`);
}
