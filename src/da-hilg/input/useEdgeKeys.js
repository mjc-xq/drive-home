// Edge-triggered keyboard actions — the one-shot verbs that should fire exactly
// once per press, with browser defaults suppressed:
//   Tab   → cycle which family member you control   (switchSystem.cycleSwitch)
//   V     → toggle first/third-person camera        (cameraModeAtom + cameraRig.mode)
//   E     → greet the nearest greetable NPC          (greetSystem.requestGreet)
//   1/2/3 → emote on the active player               (animationSystem.requestEmote)
//   F / left-click → PUNCH (melee) on the active player (animationSystem.requestPunch
//                    + nibblers.playerPunch — knocks clingers off / frees chasers)
//   Esc   → toggle pause + drop pointer lock
//
// These run OUTSIDE the GameSystems useFrame, so they do NOT need the physics
// world/rapier. GameSystems builds the full per-frame ctx (with world/rapier for
// stepMotion); switch/greet/emote only need {store, registry, cameraRig,
// levelMeta, now, activePlayerId}. We build that lighter ctx on demand here.

import { useEffect } from 'react';
import { daHilgStore } from '../state/store.js';
import { registry, cameraRig, levelMeta, activePlayer } from '../state/refs.js';
import { activePlayerIdAtom, cameraModeAtom } from '../state/atoms.js';
import { pausedAtom } from '../state/atoms.js';
import { EMOTE_SLOT } from '../animation/clips.js';
import { cycleSwitch } from '../systems/switchSystem.js';
import { requestGreet } from '../systems/greetSystem.js';
import { requestEmote, requestPunch, requestCelebrate } from '../systems/animationSystem.js';
import { ATTACK_POOLS, kickKey } from '../animation/attackPools.js';
import { playerPunch } from '../nibblers/systems/punchSystem.js';
import { playerPunchFamily } from '../systems/familyPunch.js';

// Keys whose browser defaults we must suppress so the game owns them.
const PREVENT_CODES = new Set([
  'Tab',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/**
 * Build the lighter per-event ctx (no world/rapier — not needed by the verbs
 * triggered here). Matches the ctx fields switch/greet/emote actually read.
 * @returns {object}
 */
function buildCtxLite() {
  return {
    store: daHilgStore,
    registry,
    cameraRig,
    levelMeta,
    now: performance.now(),
    activePlayerId: daHilgStore.get(activePlayerIdAtom),
  };
}

/**
 * Punch on the active player: play the one-shot 'attack' swing and resolve the melee
 * hit against the nibbler swarm. Routed through the same lite ctx as the other verbs.
 */
function doPunch(opts = {}) {
  const player = activePlayer();
  if (!player) return;
  const key = requestPunch(player, opts); // dynamic combo pick (null if gated by cooldown/downed)
  if (!key) return;                        // gated — don't resolve a hit on a swing that didn't happen
  const ctx = buildCtxLite();
  ctx.attackKey = key;                     // lets the swarm choose crush vs punt by the attack
  playerPunch(ctx);                        // crush/punt/dislodge nibblers in front (no-op in greet mode)
  playerPunchFamily(ctx);                  // shove + stagger any full-size family NPC caught in the forward cone
  // A finisher caps the combo with a short victory taunt (delayed so the finisher plays out;
  // the emote system cancels it the moment the player moves).
  if (key === ATTACK_POOLS[player.character]?.finisher) {
    setTimeout(() => requestCelebrate(activePlayer()), 480);
  }
}

/** Install the window keydown handler for the edge verbs. Mount once. */
export function useEdgeKeys() {
  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat) return; // ignore auto-repeat — these are one-shots
      if (PREVENT_CODES.has(e.code)) e.preventDefault();

      switch (e.code) {
        case 'Tab': {
          cycleSwitch(buildCtxLite());
          break;
        }
        case 'KeyV': {
          const next = daHilgStore.get(cameraModeAtom) === 'first' ? 'third' : 'first';
          daHilgStore.set(cameraModeAtom, next);
          cameraRig.mode = next; // keep the per-frame ref in lockstep with the atom
          break;
        }
        case 'KeyE': {
          requestGreet(buildCtxLite());
          break;
        }
        case 'Digit1':
        case 'Digit2':
        case 'Digit3': {
          const slot = Number(e.code.slice(-1));
          const player = activePlayer();
          const clip = EMOTE_SLOT[slot];
          if (player && clip) requestEmote(player, clip);
          break;
        }
        case 'KeyF': {
          // Keyboard fallback for punch (works without pointer lock).
          if (!daHilgStore.get(pausedAtom)) doPunch();
          break;
        }
        case 'KeyC': {
          // Dedicated KICK — the character's signature kick instead of the combo punch.
          if (!daHilgStore.get(pausedAtom)) {
            const p = activePlayer();
            if (p) doPunch({ key: kickKey(p.character) });
          }
          break;
        }
        // Esc is owned by HudMenu (toggles the pause menu); the browser also exits
        // pointer lock on Esc natively, so we don't handle it here.
        default:
          break;
      }
    };

    // Left-click → punch, but ONLY while the pointer is already locked to the canvas.
    // This keeps the FIRST click (the one that ACQUIRES the lock in usePointerLock)
    // and any HUD-widget clicks from punching — you punch only while actively looking
    // around in-game. Greet stays on E, so there is no greet-click to clobber.
    const onMouseDown = (e) => {
      if (e.button !== 0) return; // left button only
      const canvas = document.querySelector('canvas');
      if (!canvas || document.pointerLockElement !== canvas) return;
      if (daHilgStore.get(pausedAtom)) return;
      doPunch();
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, []);
}

export default useEdgeKeys;
