// <Zones> — instantiates every zone for the loaded level. It reads the recentered
// zone defs from buildZoneConfig(levelMeta) and spreads each onto a <Zone/>.
//
// Zones depend on the level's recenter offset + house bounds, so we render
// nothing until refs.levelMeta.loaded is true (useLevelMeta has populated it).
// The defs are rebuilt only when loaded flips, since levelMeta is otherwise
// stable after load.

import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { Zone } from './Zone.jsx';
import { buildZoneConfig } from './zoneConfig.js';
import { levelMeta } from '../state/refs.js';
import { gameModeAtom } from '../nibblers/state/nibblerAtoms.js';
import { buildNibblersZones } from '../nibblers/zones/zoneConfig.nibblers.js';

export function Zones() {
  // Pick the mode's zone layout (nibblers = danger + safe; greet = safe/notice/
  // trigger). Built once levelMeta is ready; levelMeta is a plain-mutable ref.
  const mode = useAtomValue(gameModeAtom);
  const defs = useMemo(
    () =>
      !levelMeta.loaded
        ? []
        : mode === 'nibblers'
          ? buildNibblersZones(levelMeta)
          : buildZoneConfig(levelMeta),
    [levelMeta.loaded, mode],
  );

  if (!levelMeta.loaded) return null;

  return (
    <>
      {defs.map((def) => (
        <Zone key={def.id} {...def} />
      ))}
    </>
  );
}

export default Zones;
