// InstanceCulling — per-instance frustum + distance culling for the level's tree /
// foliage InstancedMeshes. The level loads trees via EXT_mesh_gpu_instancing, which
// becomes a few big THREE.InstancedMesh objects. three only frustum-culls the WHOLE
// instanced mesh (its bounding sphere spans the entire neighborhood, so it's always
// "in view") — every one of the ~1730 tree instances renders every frame, even the
// ones behind the camera or far down the street. Trees are ~85% of the scene's
// triangles, so that is the single biggest GPU cost.
//
// This component keeps a pristine copy of each tree mesh's instance matrices + their
// world positions, and every frame the camera moves it repacks only the VISIBLE
// instances (inside the view frustum AND within a distance cap) to the front of the
// buffer and sets mesh.count. Off-screen / far trees simply aren't drawn (and aren't
// shadow-rendered either). Pure render support: reads the camera (after CameraRig at
// priority 10), writes only instanceMatrix — never game state. No per-frame allocation.

import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { levelMeta } from '../state/refs.js';

const TREE_RE = /tree|leaf|leaves|foliage|trunk|acacia|canopy|bark|shrub/i;

const CULL_DIST = 185;                 // hard distance cap (m); fog hides anything past this
const CULL_DIST2 = CULL_DIST * CULL_DIST;
const MOVE_EPS2 = 1.5 * 1.5;           // recompute when the camera moves > 1.5 m
const ROT_DOT = 1 - 0.025;             // ...or rotates beyond this (quaternion dot)
const SAFETY_FRAMES = 30;              // re-evaluate at least this often regardless

// No-vegetation clear radius (m, XZ) around every player spawn: any tree/leaf instance
// whose center lands inside a spawn bubble is permanently culled. The trees ship as big
// (scale 3-13) opaque leaf canopies whose wide crowns drape over the spawn clearing and
// read as a wall of leaves the moment you spawn; clearing a bubble keeps the spawn open
// sky while leaving the rest of the neighbourhood's trees untouched.
const SPAWN_CLEAR = 22;
const SPAWN_CLEAR2 = SPAWN_CLEAR * SPAWN_CLEAR;

// The level GLB folds its placed trees into EXT_mesh_gpu_instancing "holder" nodes named
// "<mesh>_instances" (the source tree meshes are unnamed, so they land as "Mesh_instances"
// / three's per-primitive "mesh_N"). So the holder/mesh NAME never says "tree" — but the
// leaf/bark materials are reliably named Tree_*_leaf_* / Tree_*_bark_* / Shrubs_mat. Match
// on the InstancedMesh name OR any of its material names so culling actually engages.
function isTreeInstance(o) {
  if (TREE_RE.test(o.name || '')) return true;
  const m = o.material;
  const mats = Array.isArray(m) ? m : [m];
  for (const mat of mats) if (mat && TREE_RE.test(mat.name || '')) return true;
  return false;
}

export function InstanceCulling({ scene }) {
  const camera = useThree((s) => s.camera);

  // Collect the tree InstancedMeshes + a pristine copy of their instance matrices.
  // World positions are filled lazily on the first frame (matrixWorld is only final
  // once the recenter group has been committed + updated by R3F).
  const groups = useMemo(() => {
    if (!scene) return [];
    const out = [];
    scene.traverse((o) => {
      if (!o.isInstancedMesh || !isTreeInstance(o)) return;
      o.geometry.computeBoundingSphere();
      const r = (o.geometry.boundingSphere ? o.geometry.boundingSphere.radius : 4) * 1.2;
      out.push({
        mesh: o,
        orig: new Float32Array(o.instanceMatrix.array), // pristine, never mutated
        world: new Float32Array(o.count * 3),
        cleared: new Uint8Array(o.count),               // 1 = inside a spawn-clear bubble (never drawn)
        count: o.count,
        radius: r,
        ready: false,
      });
    });
    return out;
  }, [scene]);

  const lastPos = useRef(new THREE.Vector3(Infinity, Infinity, Infinity));
  const lastQuat = useRef(new THREE.Quaternion(0, 0, 0, 2));
  const frame = useRef(0);
  const _proj = useRef(new THREE.Matrix4());
  const _frustum = useRef(new THREE.Frustum());
  const _m = useRef(new THREE.Matrix4());
  const _sphere = useRef(new THREE.Sphere());

  useFrame(() => {
    const grps = groups;
    if (grps.length === 0) return;

    // Lazily bake world positions once matrixWorld is valid, and flag any instance whose
    // center lands inside a player-spawn clear bubble (XZ distance) so it's never drawn.
    const spawns = levelMeta.spawns || [];
    for (let g = 0; g < grps.length; g++) {
      const grp = grps[g];
      if (grp.ready) continue;
      grp.mesh.updateWorldMatrix(true, false);
      const mw = grp.mesh.matrixWorld;
      for (let i = 0; i < grp.count; i++) {
        _m.current.fromArray(grp.orig, i * 16).premultiply(mw);
        const wx = _m.current.elements[12];
        const wy = _m.current.elements[13];
        const wz = _m.current.elements[14];
        grp.world[i * 3] = wx;
        grp.world[i * 3 + 1] = wy;
        grp.world[i * 3 + 2] = wz;
        let cleared = 0;
        for (let s = 0; s < spawns.length; s++) {
          const sx = spawns[s][0], sz = spawns[s][2];
          const ddx = wx - sx, ddz = wz - sz;
          if (ddx * ddx + ddz * ddz <= SPAWN_CLEAR2) { cleared = 1; break; }
        }
        grp.cleared[i] = cleared;
      }
      grp.ready = true;
    }

    frame.current++;
    const moved = camera.position.distanceToSquared(lastPos.current) > MOVE_EPS2;
    const rotated = Math.abs(camera.quaternion.dot(lastQuat.current)) < ROT_DOT;
    if (!moved && !rotated && frame.current % SAFETY_FRAMES !== 0) return;
    lastPos.current.copy(camera.position);
    lastQuat.current.copy(camera.quaternion);

    _proj.current.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.current.setFromProjectionMatrix(_proj.current);
    const fr = _frustum.current;
    const sph = _sphere.current;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;

    for (let g = 0; g < grps.length; g++) {
      const grp = grps[g];
      const { mesh, orig, world, cleared, count, radius } = grp;
      const arr = mesh.instanceMatrix.array;
      sph.radius = radius;
      let k = 0;
      for (let i = 0; i < count; i++) {
        if (cleared[i]) continue; // inside a spawn-clear bubble — never draw
        const wx = world[i * 3], wy = world[i * 3 + 1], wz = world[i * 3 + 2];
        const dx = wx - cx, dy = wy - cy, dz = wz - cz;
        if (dx * dx + dy * dy + dz * dz > CULL_DIST2) continue;
        sph.center.set(wx, wy, wz);
        if (!fr.intersectsSphere(sph)) continue;
        const src = i * 16, dst = k * 16;
        for (let j = 0; j < 16; j++) arr[dst + j] = orig[src + j];
        k++;
      }
      if (mesh.count !== k) mesh.count = k;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }, 50);

  return null;
}

export default InstanceCulling;
