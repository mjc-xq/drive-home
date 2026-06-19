// <Zone> — one generic trigger volume. It is a fixed, sensor-only RigidBody with
// a single cuboid sensor collider. When an actor's rigid body overlaps it, the
// collider callbacks enqueue a raw enter/exit event onto the zoneRegistry; the
// simulation drains that queue once per frame (zoneSystem.flushZones) and does
// the real reconciliation. The component itself stays dumb and allocation-light.
//
// `type` is just a string — 'safe' | 'notice' | 'trigger' | 'danger' | … — so a
// single component covers every zone flavor. There are intentionally NO separate
// SafeZone / NoticeZone / TriggerZone wrappers; the def's fields (npcGroup for
// notice, event/label for trigger) carry the per-type data through the registry.

import { useEffect, useMemo } from 'react';
import { RigidBody, CuboidCollider } from '@react-three/rapier';
import * as THREE from 'three';
import { enqueueZoneEvent, registerZone, unregisterZone } from './zoneRegistry.js';
import { registry } from '../state/refs.js';

function ZoneMarker({ type, size }) {
  const material = useMemo(() => {
    const safe = type === 'safe';
    return new THREE.MeshBasicMaterial({
      color: safe ? '#2BE84F' : '#FF5247',
      transparent: true,
      opacity: safe ? 0.24 : 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
  }, [type]);

  const ringMaterial = useMemo(() => {
    const safe = type === 'safe';
    return new THREE.MeshBasicMaterial({
      color: safe ? '#9dffad' : '#ff9a92',
      transparent: true,
      opacity: safe ? 0.48 : 0.58,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }, [type]);

  const radius = Math.max(2, Math.min(size[0], size[2]) * 0.48);
  const floorY = -size[1] / 2 + 0.06;

  return (
    <group position={[0, floorY, 0]} renderOrder={3}>
      <mesh rotation-x={-Math.PI / 2} material={material}>
        <circleGeometry args={[radius, 64]} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.01, 0]} material={ringMaterial}>
        <ringGeometry args={[radius * 0.82, radius, 64]} />
      </mesh>
    </group>
  );
}

/**
 * @param {Object} props
 * @param {string}   props.id        unique zone id (registry key)
 * @param {string}   props.type      'safe'|'notice'|'trigger'|'danger'|... (free string)
 * @param {number[]} props.position  box CENTER in recentered world space [x,y,z]
 * @param {number[]} props.size      FULL extents [w,h,d] (halved for Rapier args)
 * @param {string}  [props.npcGroup] notice zones: which NPC group it activates
 * @param {string}  [props.event]    trigger zones: event name to emit on enter
 * @param {string}  [props.label]    trigger/safe zones: HUD toast text
 * @param {boolean} [props.discover] safe zones: revealed on the minimap on first entry
 * @param {boolean} [props.reveal]   danger zones: remembered on the minimap on first entry
 * @param {boolean} [props.marker]   render a low in-world floor marker
 * @param {boolean} [props.active]   gate behavior without unmounting (default true)
 */
export function Zone({
  id,
  type,
  position,
  size,
  npcGroup,
  event,
  label,
  discover,
  reveal,
  marker,
  active = true,
}) {
  // Register/unregister the def for O(1) hot-path lookup. Re-runs if identity
  // fields change; unregister scrubs the id from every actor's membership set.
  useEffect(() => {
    registerZone({ id, type, npcGroup, event, label, discover, reveal, marker, active });
    return () => unregisterZone(id);
  }, [id, type, npcGroup, event, label, discover, reveal, marker, active]);

  // Only enqueue events for things that are actually registered actors, keyed by
  // the RigidBody's name (we set name === actor.id on each ActorView).
  const handleEnter = ({ other }) => {
    if (!active) return;
    const name = other.rigidBodyObject?.name;
    if (name && registry.has(name)) enqueueZoneEvent('enter', id, name);
  };
  const handleExit = ({ other }) => {
    // Always emit exits (even while inactive) so membership can't get stuck on.
    const name = other.rigidBodyObject?.name;
    if (name && registry.has(name)) enqueueZoneEvent('exit', id, name);
  };

  return (
    <RigidBody type="fixed" colliders={false} position={position}>
      {marker && <ZoneMarker type={type} size={size} />}
      <CuboidCollider
        args={[size[0] / 2, size[1] / 2, size[2] / 2]}
        sensor
        onIntersectionEnter={handleEnter}
        onIntersectionExit={handleExit}
      />
    </RigidBody>
  );
}
