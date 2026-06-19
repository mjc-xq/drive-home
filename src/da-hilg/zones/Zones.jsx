// <Zones> — instantiates every zone for the loaded level. It reads the recentered
// zone defs from buildZoneConfig(levelMeta) and spreads each onto a <Zone/>.
//
// Zones depend on the level's recenter offset + house bounds, so we render
// nothing until refs.levelMeta.loaded is true (useLevelMeta has populated it).
// The defs are rebuilt only when loaded flips, since levelMeta is otherwise
// stable after load.

import { useMemo } from 'react';
import { Zone } from './Zone.jsx';
import { buildZoneConfig } from './zoneConfig.js';
import { levelMeta } from '../state/refs.js';

export function Zones() {
  // Build once levelMeta is ready. levelMeta.loaded is the gate; we read the
  // singleton directly (it's plain-mutable, not React state).
  const defs = useMemo(
    () => (levelMeta.loaded ? buildZoneConfig(levelMeta) : []),
    [levelMeta.loaded],
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
