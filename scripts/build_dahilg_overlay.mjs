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
        let best = null, bestD = Infinity; const v = [0, 0, 0];
        for (const node of root.listNodes()) {
          if (!/^roads?$/i.test(node.getName() || '') || !node.getMesh()) continue;
          const wm = node.getWorldMatrix();
          for (const prim of node.getMesh().listPrimitives()) {
            const pos = prim.getAttribute('POSITION'); if (!pos) continue;
            const cnt = pos.getCount(), step = Math.max(1, Math.floor(cnt / 8000));
            for (let i = 0; i < cnt; i += step) {
              pos.getElement(i, v);
              const wx = wm[0] * v[0] + wm[4] * v[1] + wm[8] * v[2] + wm[12];
              const wz = wm[2] * v[0] + wm[6] * v[1] + wm[10] * v[2] + wm[14];
              const dx = wx - hc[0], dz = wz - hc[2], d = dx * dx + dz * dz;
              if (d < bestD) { bestD = d; best = [wx, wm[1] * v[0] + wm[5] * v[1] + wm[9] * v[2] + wm[13], wz]; }
            }
          }
        }
        const horiz = best ? Math.hypot(best[0] - hc[0], best[2] - hc[2]) : Infinity;
        if (best && horiz <= 70) {
          const lr = [best[0] - off[0], best[2] - off[2]];     // recentered-local x,z
          const lh = [hc[0] - off[0], hc[2] - off[2]];
          const dx = lh[0] - lr[0], dz = lh[1] - lr[1], L = Math.hypot(dx, dz) || 1;
          // Stand BACK from the nearest-road point, AWAY from the house, onto the street (the road point
          // can sit at the driveway/curb right by the wall) — still facing the house.
          const PUSH = 5, r2 = n => Math.round(n * 100) / 100;
          meta.streetSpawn = [r2(lr[0] - dx / L * PUSH), 0.05, r2(lr[1] - dz / L * PUSH)];
          let yaw = Math.atan2(dx, dz) * 180 / Math.PI; if (yaw < 0) yaw += 360;
          meta.facing = Math.round(yaw * 10) / 10;
          writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
          console.log(`${out}: streetSpawn=[${meta.streetSpawn}] facing=${meta.facing} (road ${horiz.toFixed(1)}m from house)`);
        } else {
          console.log(`${out}: no street spawn (nearest road ${Number.isFinite(horiz) ? horiz.toFixed(1) : '∞'}m > 70m) — keeps front-yard spawn`);
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
