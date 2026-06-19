// Loads the decimated nibbler proxy GLB and hands back the ONE BufferGeometry the
// whole horde renders with (one InstancedMesh, MAX instances). The proxy carries
// POSITION, NORMAL, and a baked float vertex-id attribute (_VERTEXID in the
// current bake) — the VAT material samples the animation texture by that id.
//
// The material's onBeforeCompile reads `aVertexId` (its chosen attribute name), so
// we make sure an `aVertexId` float attribute exists on the geometry: if the proxy
// already baked one (under _VERTEXID or aVertexId), alias it; otherwise synthesize
// [0..vertCount-1]. We also guarantee gl_VertexID can be a fallback by keeping the
// attribute regardless of meta.aVertexId — having it is harmless and robust.

import { useMemo } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { NIBBLER_PROXY_URL } from '../constants.js';

// Pull the first mesh's geometry out of a loaded GLTF scene.
function extractGeometry(scene) {
  let geom = null;
  scene.traverse((o) => {
    if (!geom && o.isMesh && o.geometry) geom = o.geometry;
  });
  return geom;
}

// Guarantee a float `aVertexId` attribute (0..count-1) is present.
function ensureVertexId(geometry) {
  if (geometry.getAttribute('aVertexId')) return;

  // Reuse a baked id attribute if the proxy carries one under another name.
  const baked =
    geometry.getAttribute('_VERTEXID') ||
    geometry.getAttribute('_vertexid') ||
    geometry.getAttribute('VERTEXID');
  if (baked) {
    // Alias to the name the shader expects (same buffer, no copy).
    geometry.setAttribute('aVertexId', baked);
    return;
  }

  const count = geometry.getAttribute('position').count;
  const ids = new Float32Array(count);
  for (let i = 0; i < count; i++) ids[i] = i;
  geometry.setAttribute('aVertexId', new THREE.Float32BufferAttribute(ids, 1));
}

/**
 * Hook: returns the shared proxy geometry (with `aVertexId` guaranteed), or null
 * if the GLTF hasn't produced a mesh yet. Memoized on the loaded scene.
 * @returns {THREE.BufferGeometry|null}
 */
export function useSwarmGeometry() {
  const { scene } = useGLTF(NIBBLER_PROXY_URL);

  return useMemo(() => {
    const geom = extractGeometry(scene);
    if (!geom) return null;
    ensureVertexId(geom);
    return geom;
  }, [scene]);
}

// Warm drei's cache so the first SwarmRenderer mount doesn't stall on the fetch.
useGLTF.preload(NIBBLER_PROXY_URL);
