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
  { out: 'level',   master: '1840-dahill-property.glb' },
  { out: 'canyon',  master: 'canyon-middle-school-property.glb' },
  { out: 'stanton', master: 'stanton-elementary-property.glb' },
  { out: 'meemaw',  master: 'meemaw-property.glb' },
  { out: 'xq',      master: 'xq-property.glb' },
];

// Keep ONLY vegetation + water. Buildings/ground/roads/terrain live in the single-surface env.
const KEEP = /(creek|tree|shrub|grass|clump|reed|foliage|bush|plant|hedge|canopy|trunk)/i;

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
  // house onto the shoulder, and store recentered-local streetSpawn + a yaw facing the house. The
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
        const wallClear = (x, z) => { let m = Infinity; for (const p of house) { const d = Math.hypot(p[0]-x, p[1]-z); if (d < m) m = d; } return m; };

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
          const lr = [sx-off[0], sz-off[2]];                 // recentered-local x,z
          const lh = [hc[0]-off[0], hc[2]-off[2]];
          const dx = lh[0]-lr[0], dz = lh[1]-lr[1];          // face the house from out front
          const r2 = n => Math.round(n*100)/100;
          meta.streetSpawn = [r2(lr[0]), 0.05, r2(lr[1])];
          let yaw = Math.atan2(dx, dz) * 180 / Math.PI; if (yaw < 0) yaw += 360;
          meta.facing = Math.round(yaw*10)/10;
          writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
          console.log(`${out}: streetSpawn=[${meta.streetSpawn}] facing=${meta.facing} clear=${wallClear(sx,sz).toFixed(1)}m (${viaFront ? 'front-clear' : 'fallback'})`);
        } else {
          console.log(`${out}: no street spawn (road too far) — keeps front-yard spawn`);
        }
      }
    }
  } catch (e) { console.warn(`${out}: streetSpawn skipped — ${e.message}`); }

  // Strip the mesh off every node whose name is NOT vegetation/water (keeps the hierarchy intact so
  // we never orphan a kept child). prune() then drops the now-unused meshes/materials/textures.
  let kept = 0, stripped = 0;
  for (const node of root.listNodes()) {
    const name = node.getName() || '';
    if (node.getMesh()) {
      if (KEEP.test(name)) kept++;
      else { node.setMesh(null); stripped++; }
    }
  }

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
