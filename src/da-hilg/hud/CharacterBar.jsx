// Bottom-center: four family tiles (Mike / Kelli / Cece / Drew). The controlled
// member gets a jump-violet ring + lift; clicking a tile switches control to it
// (the desktop Tab equivalent). Greeted members show a go corner check; NPC tiles
// show a tiny state glyph so you can read the family at a glance.

import { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { CHARACTERS, CHARACTER_LABELS } from '../constants.js';
import {
  activePlayerIdAtom,
  greetedAtom,
  npcStatesAtom,
  nearbyGreetableAtom,
} from '../state/atoms.js';
import { daHilgStore } from '../state/store.js';
import { registry, cameraRig, clock } from '../state/refs.js';
import { switchTo } from '../systems/switchSystem.js';

// Compact glyphs for the NPC fsm/anim state shown on inactive tiles.
const NPC_GLYPH = {
  idle: '·',
  wander: '→',
  walk: '→',
  chase: '!',
  touch: '!',
  retreat: '↩',
  cooldown: '~', // settling
  controlled: '',
};

/**
 * Build the light ctx switchSystem needs. The real per-frame ctx is assembled in
 * GameSystems, but a HUD-initiated switch only needs the shared store + the three
 * mutable singletons + a timestamp; switchSystem reassigns controllers and writes
 * activePlayerIdAtom from there.
 */
function makeSwitchCtx() {
  return {
    store: daHilgStore,
    registry,
    cameraRig,
    now: clock.now || performance.now(),
  };
}

export default function CharacterBar() {
  const activeId = useAtomValue(activePlayerIdAtom);
  const greeted = useAtomValue(greetedAtom);
  const npcStates = useAtomValue(npcStatesAtom);
  const nearby = useAtomValue(nearbyGreetableAtom);

  // Show the "TAB" hint for the first 8s of the session, then only on hover.
  const [showHint, setShowHint] = useState(true);
  const [hovered, setHovered] = useState(false);
  const mounted = useRef(0);
  useEffect(() => {
    mounted.current = performance.now();
    const t = setTimeout(() => setShowHint(false), 8000);
    return () => clearTimeout(t);
  }, []);

  function handleSwitch(id) {
    if (id === activeId) return;
    // Don't switch to a member that doesn't exist in the registry yet (pre-load).
    if (registry.size && !registry.has(id)) return;
    switchTo(id, makeSwitchCtx());
  }

  const targetId = nearby?.targetId ?? null;

  return (
    <div
      className="dh-charbar"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {(showHint || hovered) && (
        <div className="dh-tab-hint">
          <span className="dh-tab-chip">TAB</span>
          <span>switch family</span>
        </div>
      )}
      {CHARACTERS.map((id) => {
        const isActive = id === activeId;
        const isGreeted = !!greeted[id];
        const isTarget = id === targetId;
        const npcState = npcStates[id] || 'idle';
        const glyph = !isActive ? NPC_GLYPH[npcState] ?? '·' : '';
        const isChase = npcState === 'chase' || npcState === 'touch';

        const cls = [
          'dh-tile',
          isActive && 'is-active',
          isTarget && !isActive && 'is-target',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <button
            key={id}
            type="button"
            className={cls}
            onClick={() => handleSwitch(id)}
            aria-pressed={isActive}
            aria-label={`${CHARACTER_LABELS[id]}${isActive ? ', active' : ''}${
              isGreeted ? ', greeted' : ''
            }`}
          >
            <span className="dh-tile-initial">{CHARACTER_LABELS[id].charAt(0)}</span>
            <span className="dh-tile-name">{CHARACTER_LABELS[id]}</span>
            {isGreeted && (
              <span className="dh-tile-check" aria-hidden="true">
                ✓
              </span>
            )}
            {glyph && (
              <span
                className={`dh-tile-glyph${isChase ? ' is-chase' : ''}`}
                aria-hidden="true"
              >
                {glyph}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
