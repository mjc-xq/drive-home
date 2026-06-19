// Loads the FOUR decimated nibbler proxy GLBs — one per family character
// (mike/kelli/cece/drew) — and hands back a per-character map of BufferGeometries the
// swarm renders with (one InstancedMesh PER character, MAX instances each). Each proxy
// carries POSITION, NORMAL, UV, and a baked float vertex-id attribute (_VERTEXID): the
// VAT material samples its character's animation texture by that id and the REAL
// baseColor texture by the UV.
//
// The material's onBeforeCompile reads `aVertexId` (its chosen attribute name), so we
// guarantee an `aVertexId` float attribute exists on each geometry: if the proxy baked
// one (under _VERTEXID or aVertexId), alias it; otherwise synthesize [0..vertCount-1].

import { useMemo } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { NIBBLER_CHARS, NIBBLER_PROXY_URL } from '../constants.js';

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
 * Hook: returns a per-character map of shared proxy geometries (each with `aVertexId`
 * guaranteed), or null until all four GLTFs have produced a mesh. The renderer CLONES
 * each per InstancedMesh so per-instance attributes (aPhase/aClip) live on a private
 * geometry without clobbering the shared base.
 * @returns {Object.<string,THREE.BufferGeometry>|null}
 */
export function useSwarmGeometry() {
  // useGLTF accepts an array of urls and returns an array of gltfs (one per url),
  // preserving order — so we map back to NIBBLER_CHARS by index.
  const urls = NIBBLER_CHARS.map((k) => NIBBLER_PROXY_URL(k));
  const gltfs = useGLTF(urls);

  return useMemo(() => {
    const arr = Array.isArray(gltfs) ? gltfs : [gltfs];
    const byChar = {};
    for (let i = 0; i < NIBBLER_CHARS.length; i++) {
      const scene = arr[i] && arr[i].scene;
      const geom = scene ? extractGeometry(scene) : null;
      if (!geom) return null;
      ensureVertexId(geom);
      byChar[NIBBLER_CHARS[i]] = geom;
    }
    return byChar;
  }, [gltfs]);
}

// Warm drei's cache so the first SwarmRenderer mount doesn't stall on the fetches.
for (const k of NIBBLER_CHARS) useGLTF.preload(NIBBLER_PROXY_URL(k));
