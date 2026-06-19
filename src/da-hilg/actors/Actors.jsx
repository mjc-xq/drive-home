// Renders the four family members. Builds the registry once (only after the
// level meta has loaded so spawns are real), then renders an <ActorView/> per
// actor. The registry is a plain ref, so we use a tiny local state flag to
// re-render this component the moment it becomes ready.

import { useEffect, useState } from 'react';
import { levelMeta, registry } from '../state/refs.js';
import { buildRegistry, forEachActor } from './actorRegistry.js';
import ActorView from './ActorView.jsx';

export default function Actors() {
  // Drives a re-render once the registry is populated (registry itself is a
  // plain ref, not reactive).
  const [ready, setReady] = useState(registry.size > 0);

  useEffect(() => {
    if (ready) return;
    if (!levelMeta.loaded) return; // wait for real spawns before building
    buildRegistry(levelMeta);
    setReady(true);
  }, [ready]);

  // Re-check on every render until the meta is loaded (level streams in async).
  useEffect(() => {
    if (ready || levelMeta.loaded) return;
    const id = setInterval(() => {
      if (levelMeta.loaded) {
        buildRegistry(levelMeta);
        setReady(true);
      }
    }, 50);
    return () => clearInterval(id);
  }, [ready]);

  if (!ready) return null;

  const views = [];
  forEachActor((actor) => {
    views.push(<ActorView key={actor.id} actor={actor} />);
  });
  return <>{views}</>;
}
