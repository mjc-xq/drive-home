// SafeZoneBeacons — tall glowing green pillars of light at every safe zone, so the
// player can actually FIND safety from across the neighborhood (the zones are invisible
// Rapier sensors otherwise). A soft ground ring marks the footprint; a vertical beam
// rises high above it; both pulse gently. Recentered world space (same as the player).
//
// Render-only: one slow opacity pulse in a useFrame (NOT the sim loop). Renders only in
// nibblers mode (Scene gates it). Reads the zone defs once.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { levelMeta } from '../../state/refs.js';
import { buildNibblersZones } from '../zones/zoneConfig.nibblers.js';

const SAFE_COLOR = '#39e86a';

export default function SafeZoneBeacons() {
  const groupRef = useRef(null);
  const [ready, setReady] = useState(levelMeta.loaded);

  useEffect(() => {
    if (levelMeta.loaded) {
      setReady(true);
      return undefined;
    }
    let raf = 0;
    const tick = () => {
      if (levelMeta.loaded) {
        setReady(true);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const safeZones = useMemo(
    () => (ready ? buildNibblersZones(levelMeta).filter((z) => z.type === 'safe') : []),
    [ready],
  );

  const beamMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: SAFE_COLOR,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        fog: false,
      }),
    [],
  );
  const ringMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: SAFE_COLOR,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    [],
  );

  // Gentle pulse so the beacons read as "alive" and draw the eye.
  useFrame(({ clock }) => {
    const p = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 1.6);
    beamMat.opacity = 0.14 + 0.16 * p;
    ringMat.opacity = 0.35 + 0.3 * p;
  });

  if (!ready) return null;

  return (
    <group ref={groupRef}>
      {safeZones.map((z) => {
        const [cx, , cz] = z.position;
        const r = Math.min(z.size[0], z.size[2]) * 0.5;
        const isHome = z.id === 'safe_home';
        // Beam base near the ground (~zone floor), rising tall enough to spot from afar.
        const floorY = z.position[1] - z.size[1] / 2;
        const beamH = 60;
        return (
          <group key={z.id} position={[cx, 0, cz]}>
            {/* Vertical beam */}
            {!isHome && (
              <mesh material={beamMat} position={[0, floorY + beamH / 2, 0]} renderOrder={5} frustumCulled={false}>
                <cylinderGeometry args={[r * 0.18, r * 0.34, beamH, 12, 1, true]} />
              </mesh>
            )}
            {/* Ground ring on the footprint */}
            <mesh material={ringMat} position={[0, floorY + 0.15, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={5} frustumCulled={false}>
              <ringGeometry args={[r * 0.82, r, 40]} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
