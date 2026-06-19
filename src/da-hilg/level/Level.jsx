// <Level> — loads the neighborhood GLB, recenters it to origin/ground≈0, hides the
// authored Collision_*/LOD_* proxies, tunes the visual materials (so facades aren't
// washed out), builds ONE fixed trimesh collider from the Collision_* proxies, and
// mounts the flowing creek water + wind-swept grass inside the recenter group.
//
// Subtleties: the GLB uses KHR_mesh_quantization (real scale on node matrices), so
// the collider is baked from each Collision_* mesh's full matrixWorld (denormalized
// via fromBufferAttribute) and mounted at identity. Everything gates on
// levelMeta.loaded so the recenter offset is real first.

import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import { useDaHilgGLTF } from '../loaders.js';
import { levelMeta } from '../state/refs.js';
import { LEVEL_URL } from '../constants.js';
import { CreekWater, computeCreekBounds, hideCreekClutter } from './CreekWater.jsx';
import { WindGrass } from './WindGrass.jsx';

const LEVEL_SOURCE = LEVEL_URL;

/** Tune one mesh's material(s) so the neighborhood reads crisp + sunlit, not pale. */
function tuneMaterial(o) {
  const name = o.name || '';
  const isWindow = name.toLowerCase().includes('window');
  const isGlass = name.includes('windows') || isWindow;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  for (const m of mats) {
    if (!m) continue;
    if (m.map) m.map.colorSpace = THREE.SRGBColorSpace; // photo/colour maps are sRGB
    if ('roughness' in m) m.roughness = isGlass ? 0.2 : 0.92;
    if ('metalness' in m) m.metalness = isGlass ? 0.45 : 0.0;
    if (m.emissive) m.emissive.setScalar(0); // kill any baked-in glow that washes it out
    m.needsUpdate = true;
  }
}

/** Hide the collision/LOD proxies, tune visual materials, set shadow flags. */
function processScene(scene) {
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.name || '';
    if (name.startsWith('Collision_') || name.startsWith('LOD_')) {
      o.visible = false; // physics-only / duplicate
      return;
    }
    o.frustumCulled = true;
    o.receiveShadow = true;
    // Buildings + the house cast shadows for form; the heavy terrain/roads don't.
    o.castShadow = name.startsWith('House') || name.startsWith('Buildings');
    tuneMaterial(o);
  });
}

/**
 * Bake the Collision_* proxies into one (vertices, indices) trimesh in recentered
 * world space. Collision_Trees is EXCLUDED so the player can walk past street trees
 * (an invisible-tree-barrier along the sidewalks). Reads via fromBufferAttribute +
 * matrixWorld so the int16/quantized positions denormalize + scale correctly.
 */
function bakeCollider(scene) {
  scene.updateWorldMatrix(true, true);
  const positions = [];
  const indices = [];
  let base = 0;
  const v = new THREE.Vector3();

  scene.traverse((o) => {
    const name = o.name || '';
    if (!o.isMesh || !name.startsWith('Collision_')) return;
    if (name === 'Collision_Trees') return; // walk past trees — don't wall the sidewalks
    const pos = o.geometry.attributes.position;
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

  return { vertices: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * @param {Object} props
 * @param {() => void} [props.onReady] called once the collider is built
 */
export function Level({ onReady }) {
  const { scene } = useDaHilgGLTF(LEVEL_SOURCE);

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

  // Hide proxies/LOD + tune materials once.
  useMemo(() => processScene(scene), [scene]);

  const offset = levelMeta.offset || [0, 0, 0];
  const recenter = [-offset[0], -offset[1], -offset[2]];

  // After the visual mounts under the recenter group: bake the collider, compute
  // the creek footprint, and hide the road-line clutter overlapping the creek.
  const [collider, setCollider] = useState(null);
  const [creekBounds, setCreekBounds] = useState(null);
  useEffect(() => {
    if (!ready) return;
    const raf = requestAnimationFrame(() => {
      setCollider(bakeCollider(scene));
      const b = computeCreekBounds(scene);
      setCreekBounds(b);
      if (b) hideCreekClutter(scene, b);
      onReady?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [ready, scene]);

  if (!ready) return null;

  return (
    <>
      <group position={recenter}>
        <primitive object={scene} />
        {/* Flat flowing water at the low creek elevation (never climbs the hill). */}
        <CreekWater scene={scene} bounds={creekBounds} />
        {/* Wind-swept grass on the yard around the house (recentered origin). */}
        <WindGrass radius={90} count={14000} groundY={levelMeta.groundY ?? 0} />
      </group>
      {collider && (
        <RigidBody type="fixed" colliders={false}>
          <TrimeshCollider args={[collider.vertices, collider.indices]} />
        </RigidBody>
      )}
    </>
  );
}

// (Preloading happens in <DaHilgPreloader/> inside the Canvas — KTX2 needs the live
// renderer, which a module-scope useGLTF.preload wouldn't have.)

export default Level;
