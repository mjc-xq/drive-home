// <SwarmRenderer/> — mounts FOUR InstancedMeshes (one per family member), each drawing
// that character's decimated proxy geometry + real baseColor texture, animated on the
// GPU via its own Vertex Animation Texture. Wires per-mesh aPhase/aClip buffers into
// swarmGpu.byChar (the sim ↔ render bridge), and otherwise does NOTHING per frame: the
// sim uploads (in updateSwarm's tail). There is deliberately NO useFrame here — that
// would be a second sim loop.
//
// Per character (charIx 0..3 = mike/kelli/cece/drew):
//   geometry = a CLONE of the shared proxy (so per-instance aPhase/aClip live on a
//              private geometry; instanced attrs are geometry-bound).
//   material = makeVatMaterial(charAssets) (VAT vertex displacement + that char's map).
//   <instancedMesh args={[geom, mat, MAX_NIBBLERS]} frustumCulled={false}
//    castShadow={false}/>.
// On mount each instance is collapsed to scale 0 so nothing shows until the sim writes.
//
// Gated on assetsReady(): if the per-character VAT json/textures/proxies haven't loaded
// we render null and the sim gate (updateNibblers) stays closed too, so they never desync.

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { MAX_NIBBLERS, NIBBLER_CHARS, NIBBLER_TINTS } from '../constants.js';
import { useNibblerAssets } from './nibblerAssets.js';
import { useSwarmGeometry } from './swarmGeometry.js';
import { makeVatMaterial } from './vatMaterial.js';
import { swarmGpu } from './swarmGpu.js';

const MAX = MAX_NIBBLERS;

// One character's InstancedMesh. Clones the shared proxy geometry (so its aPhase/aClip
// instanced attrs are private), builds the character's VAT material, publishes the
// bucket into swarmGpu.byChar[charIx] on mount, and nulls it on unmount.
function CharMesh({ charIx, geometry, charAssets }) {
  const meshRef = useRef(/** @type {THREE.InstancedMesh|null} */ (null));

  // Material per character (rebuilt only if this character's assets change). The faint
  // per-character tint is layered over the real baseColor texture for variety.
  const material = useMemo(
    () =>
      charAssets
        ? makeVatMaterial({ ...charAssets, tint: NIBBLER_TINTS[charIx] })
        : null,
    [charAssets, charIx],
  );

  // Private geometry clone + per-instance buffers (stable across the mesh's life).
  // The clone keeps the shared base geometry's attributes (position/normal/uv/aVertexId)
  // but gives THIS mesh its own aPhase/aClip without clobbering the other characters'.
  const { geom, buffers } = useMemo(() => {
    if (!geometry) return { geom: null, buffers: null };
    const g = geometry.clone();
    const phase = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    const clip = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    phase.setUsage(THREE.DynamicDrawUsage);
    clip.setUsage(THREE.DynamicDrawUsage);
    return { geom: g, buffers: { phase, clip } };
  }, [geometry]);

  // Register into the sim ↔ render bridge once the mesh + buffers are mounted.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !geom || !buffers) return undefined;

    // Attach the per-instance attributes to THIS mesh's geometry clone.
    geom.setAttribute('aPhase', buffers.phase);
    geom.setAttribute('aClip', buffers.clip);

    // Start with every slot collapsed; the sim sets mesh.count + real matrices each
    // frame. (Dead/unused slots beyond the per-char count are simply not drawn.)
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) mesh.setMatrixAt(i, zero);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;

    // Publish the bucket for updateSwarm to upload into.
    swarmGpu.byChar[charIx] = {
      mesh,
      aPhase: buffers.phase,
      aClip: buffers.clip,
    };

    return () => {
      swarmGpu.byChar[charIx] = null;
    };
  }, [charIx, geom, buffers]);

  if (!geom || !material) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[geom, material, MAX]}
      frustumCulled={false}
      castShadow={false}
    />
  );
}

export default function SwarmRenderer() {
  const assets = useNibblerAssets();
  const geomByChar = useSwarmGeometry();

  if (!assets || !geomByChar) return null;

  return (
    <>
      {NIBBLER_CHARS.map((key, charIx) => {
        const charAssets = assets.byChar[key];
        const geometry = geomByChar[key];
        if (!charAssets || !geometry) return null;
        return (
          <CharMesh
            key={key}
            charIx={charIx}
            geometry={geometry}
            charAssets={charAssets}
          />
        );
      })}
    </>
  );
}
