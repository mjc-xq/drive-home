// SceneEnv — the dusk atmosphere for Da Hilg: sky-tint background, distance fog,
// hemisphere + key directional light (soft shadows), and ACES filmic tone
// mapping. Pure declarative R3F; no per-frame work. Mounted directly inside the
// <Canvas> (outside Suspense) so the world has color/fog even while assets load.

import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import * as THREE from 'three';

// Dusk palette — a muted blue-grey horizon so the neighborhood reads at golden
// hour. Fog color matches the background so distant geometry dissolves cleanly.
const SKY_TINT = '#aab6c6';
const FOG_COLOR = '#9fb0c4';
const FOG_NEAR = 40;
const FOG_FAR = 220;

export default function SceneEnv() {
  const gl = useThree((s) => s.gl);

  // ACES filmic tone mapping + exposure on the renderer (one-time).
  useEffect(() => {
    const prevTone = gl.toneMapping;
    const prevExp = gl.toneMappingExposure;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.0;
    return () => {
      gl.toneMapping = prevTone;
      gl.toneMappingExposure = prevExp;
    };
  }, [gl]);

  return (
    <>
      {/* Sky tint as the clear color + matching distance fog. */}
      <color attach="background" args={[SKY_TINT]} />
      <fog attach="fog" args={[FOG_COLOR, FOG_NEAR, FOG_FAR]} />

      {/* Soft sky/ground bounce. */}
      <hemisphereLight
        args={['#cfe0f2', '#3a3530', 0.65]}
      />

      {/* Warm low key light from the west, casts the dusk shadows. */}
      <directionalLight
        position={[60, 80, 30]}
        intensity={1.7}
        color="#ffe6c2"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={300}
        shadow-camera-left={-120}
        shadow-camera-right={120}
        shadow-camera-top={120}
        shadow-camera-bottom={-120}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
      />

      {/* A touch of ambient so deep shadows aren't crushed to black. */}
      <ambientLight intensity={0.18} />
    </>
  );
}
