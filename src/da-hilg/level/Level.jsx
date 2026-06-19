// <Level> — loads the neighborhood GLB, recenters it to origin/ground≈0, hides
// the authored Collision_*/LOD_* proxies, and builds ONE fixed trimesh collider
// from the Collision_* meshes. The visual terrain (hundreds of k tris) is NEVER
// collided — we collide the decimated Collision_* proxies instead.
//
// Two subtleties this file handles carefully:
//  • Recenter: the visual scene is wrapped in <group position={-offset}> so world
//    coords match the recentered space spawns/zones/camera assume.
//  • Quantization: the GLB uses KHR_mesh_quantization, so each Collision_* mesh's
//    real-world scale lives in its node matrix, NOT its raw -1..1 positions. We
//    therefore bake the collider from each mesh's FULL matrixWorld (after the
//    recenter group is applied) and place the collider at IDENTITY — so the verts
//    are already recentered real meters and there is exactly one recenter.
//
// We gate everything on levelMeta.loaded so the recenter offset is real before we
// place the visual or bake the collider.

import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import { levelMeta } from '../state/refs.js';
import { LEVEL_URL } from '../constants.js';

const LEVEL_SOURCE = LEVEL_URL;

/** Hide the collision/LOD proxies and tune the visual meshes. Runs once per glb. */
function processScene(scene) {
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.name || '';
    if (name.startsWith('Collision_')) {
      o.visible = false; // physics-only proxy
    } else if (name.startsWith('LOD_')) {
      o.visible = false; // lower-detail duplicate; we ship full-res
    } else {
      o.castShadow = false; // terrain is far too heavy to shadow-cast
      o.receiveShadow = true;
      o.frustumCulled = true;
    }
  });
}

/**
 * Bake every Collision_* mesh into one (vertices, indices) trimesh in recentered
 * world space, using each mesh's full world matrix (which carries the GLB's
 * quantization scale + the recenter group). The resulting collider is mounted at
 * identity.
 * @param {import('three').Object3D} scene already under the recenter group, matrices current
 */
function bakeCollider(scene) {
  scene.updateWorldMatrix(true, true);
  const positions = [];
  const indices = [];
  let base = 0;
  const v = new THREE.Vector3();

  scene.traverse((o) => {
    if (!o.isMesh || !(o.name || '').startsWith('Collision_')) return;
    const pos = o.geometry.attributes.position;
    // IMPORTANT: the GLB positions are int16/normalized (KHR_mesh_quantization),
    // with the real ×scale on the node. Reading via fromBufferAttribute()
    // denormalizes to -1..1, and applyMatrix4(matrixWorld) applies the node scale
    // + recenter into a FRESH float array. (Transforming the geometry in place
    // would write back into the int16 buffer and clamp everything to ±1.)
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      positions.push(v.x, v.y, v.z);
    }
    const idx = o.geometry.index;
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + base);
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(i + base);
    }
    base += pos.count;
  });

  return {
    vertices: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

/**
 * @param {Object} props
 * @param {() => void} [props.onReady] called once the collider is built
 */
export function Level({ onReady }) {
  const { scene } = useGLTF(LEVEL_SOURCE);

  // Gate on the meta load so the recenter offset is real (Actors/Scene gate the
  // same way). levelMeta is a plain ref, so poll it into local state.
  const [ready, setReady] = useState(levelMeta.loaded);
  useEffect(() => {
    if (ready) return;
    const id = setInterval(() => {
      if (levelMeta.loaded) {
        setReady(true);
        clearInterval(id);
      }
    }, 30);
    return () => clearInterval(id);
  }, [ready]);

  // Hide proxies/LOD once.
  useMemo(() => processScene(scene), [scene]);

  const offset = levelMeta.offset || [0, 0, 0];
  const recenter = [-offset[0], -offset[1], -offset[2]];

  // Bake the collider AFTER the visual mounts under the recenter group so each
  // mesh's matrixWorld already includes the recenter + quantization scale.
  const [collider, setCollider] = useState(null);
  useEffect(() => {
    if (!ready) return;
    // Defer one frame so the recenter <group> transform is committed.
    const raf = requestAnimationFrame(() => {
      setCollider(bakeCollider(scene));
      onReady?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [ready, scene]);

  if (!ready) return null;

  return (
    <>
      <group position={recenter}>
        <primitive object={scene} />
      </group>
      {collider && (
        <RigidBody type="fixed" colliders={false}>
          <TrimeshCollider args={[collider.vertices, collider.indices]} />
        </RigidBody>
      )}
    </>
  );
}

useGLTF.preload(LEVEL_SOURCE);

export default Level;
