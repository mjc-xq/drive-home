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

import { useEffect } from 'react';
import { RigidBody, CuboidCollider } from '@react-three/rapier';
import { enqueueZoneEvent, registerZone, unregisterZone } from './zoneRegistry.js';
import { registry } from '../state/refs.js';

/**
 * @param {Object} props
 * @param {string}   props.id        unique zone id (registry key)
 * @param {string}   props.type      'safe'|'notice'|'trigger'|'danger'|... (free string)
 * @param {number[]} props.position  box CENTER in recentered world space [x,y,z]
 * @param {number[]} props.size      FULL extents [w,h,d] (halved for Rapier args)
 * @param {string}  [props.npcGroup] notice zones: which NPC group it activates
 * @param {string}  [props.event]    trigger zones: event name to emit on enter
 * @param {string}  [props.label]    trigger zones: HUD toast text
 * @param {boolean} [props.active]   gate behavior without unmounting (default true)
 */
export function Zone({ id, type, position, size, npcGroup, event, label, active = true }) {
  // Register/unregister the def for O(1) hot-path lookup. Re-runs if identity
  // fields change; unregister scrubs the id from every actor's membership set.
  useEffect(() => {
    registerZone({ id, type, npcGroup, event, label, active });
    return () => unregisterZone(id);
  }, [id, type, npcGroup, event, label, active]);

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
      <CuboidCollider
        args={[size[0] / 2, size[1] / 2, size[2] / 2]}
        sensor
        onIntersectionEnter={handleEnter}
        onIntersectionExit={handleExit}
      />
    </RigidBody>
  );
}
