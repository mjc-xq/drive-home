// <SwarmRenderer/> — mounts the ONE InstancedMesh that draws the entire horde,
// wires the three per-instance buffers into swarmGpu (the sim ↔ render bridge),
// and otherwise does NOTHING per frame: the sim uploads (in updateSwarm's tail).
// There is deliberately NO useFrame here — that would be a second sim loop.
//
// Geometry = the decimated proxy (swarmGeometry, with aVertexId guaranteed).
// Material = makeVatMaterial(assets) (VAT vertex displacement on the GPU).
// We render exactly one <instancedMesh args={[geom, mat, MAX_NIBBLERS]}
// frustumCulled={false} castShadow={false}/>. On mount we attach aPhase/aClip/
// aTint InstancedBufferAttributes and collapse every instance to scale 0 so
// nothing shows until the sim writes real matrices. On unmount we null swarmGpu.
//
// Gated on assetsReady(): if the VAT json/PNGs haven't loaded we render null and
// the sim gate (updateNibblers) stays closed too, so the two never desync.

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { MAX_NIBBLERS } from '../constants.js';
import { useNibblerAssets } from './nibblerAssets.js';
import { useSwarmGeometry } from './swarmGeometry.js';
import { makeVatMaterial } from './vatMaterial.js';
import { swarmGpu } from './swarmGpu.js';

const MAX = MAX_NIBBLERS;

export default function SwarmRenderer() {
  const assets = useNibblerAssets();
  const geometry = useSwarmGeometry();
  const meshRef = useRef(/** @type {THREE.InstancedMesh|null} */ (null));

  // One material per loaded-asset set; rebuilt only if the assets object changes.
  const material = useMemo(
    () => (assets ? makeVatMaterial(assets) : null),
    [assets],
  );

  // Pre-allocate the per-instance buffers once (stable across the component life).
  const buffers = useMemo(() => {
    const phase = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    const clip = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    phase.setUsage(THREE.DynamicDrawUsage);
    clip.setUsage(THREE.DynamicDrawUsage);
    tint.setUsage(THREE.DynamicDrawUsage);
    return { phase, clip, tint };
  }, []);

  // Register into the sim ↔ render bridge once the mesh + buffers are mounted.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !geometry) return undefined;

    // Attach the per-instance attributes to the geometry the mesh draws.
    geometry.setAttribute('aPhase', buffers.phase);
    geometry.setAttribute('aClip', buffers.clip);
    geometry.setAttribute('aTint', buffers.tint);

    // Draw all slots every frame; dead slots ride at scale 0 (degenerate → GPU
    // discards them). The sim writes real matrices over these.
    mesh.count = MAX;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // Collapse every instance to a zero-scale point so NOTHING shows until the sim
    // writes — avoids a one-frame flash of MAX identity-posed nibblers at origin.
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) mesh.setMatrixAt(i, zero);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;

    // Publish the bridge for updateSwarm to upload into.
    swarmGpu.mesh = mesh;
    swarmGpu.aPhase = buffers.phase;
    swarmGpu.aClip = buffers.clip;
    swarmGpu.aTint = buffers.tint;

    return () => {
      swarmGpu.mesh = null;
      swarmGpu.aPhase = null;
      swarmGpu.aClip = null;
      swarmGpu.aTint = null;
    };
  }, [geometry, buffers]);

  if (!assets || !geometry || !material) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, MAX]}
      frustumCulled={false}
      castShadow={false}
    />
  );
}
