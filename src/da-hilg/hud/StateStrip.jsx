// Top-left square-glass strip: the active player's motion/emote word (AGC) plus a
// zone cell that slides in only when a zone is active. A flavor readout that makes
// the world feel responsive to what you're doing.

import { useAtomValue } from 'jotai';
import { playerStateAtom, currentZoneAtom } from '../state/atoms.js';

// Map the raw playerState word → a friendly uppercase HUD word.
const STATE_WORDS = {
  idle: 'EXPLORING',
  walk: 'WALKING',
  run: 'RUNNING',
  jump: 'JUMP',
  dance: 'DANCING',
  wave: 'WAVING',
  cheer: 'CHEERING',
  greet: 'GREETING',
};

// Emote states tint the word jump-violet.
const EMOTE_STATES = new Set(['dance', 'wave', 'cheer', 'greet']);

// Per-zone display color. Unknown zones fall back to nav.
const ZONE_COLORS = {
  home: 'var(--go)',
  creek: 'var(--nav)',
  roadside: 'var(--coin)',
  driveway: 'var(--coin)',
};

/** Pick a readable label + color for a raw zone id/label, or null to hide. */
function zoneView(zone) {
  if (!zone) return null;
  const key = String(zone).toLowerCase();
  const color = ZONE_COLORS[key] || 'var(--nav)';
  // home reads "HOME · SAFE"; everything else just the label uppercased
  const label = key === 'home' ? 'HOME · SAFE' : String(zone).toUpperCase();
  return { label, color };
}

export default function StateStrip() {
  const state = useAtomValue(playerStateAtom);
  const zone = useAtomValue(currentZoneAtom);

  const word = STATE_WORDS[state] || 'EXPLORING';
  const isEmote = EMOTE_STATES.has(state);
  const zv = zoneView(zone);

  return (
    <div className="dh-statestrip dh-panel">
      <div className="dh-cell">
        <span className={`dh-state-word${isEmote ? ' is-emote' : ''}`}>{word}</span>
      </div>
      <div
        className={`dh-cell dh-zone-cell${zv ? '' : ' is-hidden'}`}
        style={zv ? { '--zone-color': zv.color } : undefined}
      >
        <span className="dh-zone-dot" />
        <span className="dh-zone-label">{zv ? zv.label : ''}</span>
      </div>
    </div>
  );
}
