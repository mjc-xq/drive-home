// TouchButtons — bottom-right cluster of round 64px discs for the core verbs on
// touch: JUMP, GREET, SWITCH, EMOTE. JUMP writes the jump buffer onto the shared
// input ref (consumed in stepMotion). GREET / SWITCH call into the game systems
// with a light ctx assembled from the shared refs + store (the DOM tree has no
// access to the Rapier world, which these verbs don't need). EMOTE toggles the
// emote wheel atom. GREET glows when a family member is greetable (canGreetAtom).

import { useAtom, useAtomValue } from 'jotai';
import { canGreetAtom, emoteOpenAtom, activePlayerIdAtom } from '../../state/atoms.js';
import { input, cameraRig, registry, levelMeta, clock } from '../../state/refs.js';
import { daHilgStore } from '../../state/store.js';
import { requestGreet } from '../../systems/greetSystem.js';
import { cycleSwitch } from '../../systems/switchSystem.js';

// Build the light per-action ctx the systems expect. The DOM overlay can't reach
// the Rapier world/rapier module (those live inside the Canvas), but greet/switch
// only need the registry, cameraRig, store, and timing — so we pass null for the
// physics fields and the real values for everything else.
function lightCtx() {
  return {
    store: daHilgStore,
    world: null,
    rapier: null,
    registry,
    input,
    cameraRig,
    levelMeta,
    now: clock.now || performance.now(),
    dt: 0,
    // Read the active id from the atom (authoritative), mirroring useEdgeKeys'
    // buildCtxLite — cameraRig.targetId can lag during the switch grace window.
    activePlayerId: daHilgStore.get(activePlayerIdAtom),
  };
}

export default function TouchButtons() {
  const canGreet = useAtomValue(canGreetAtom);
  const [emoteOpen, setEmoteOpen] = useAtom(emoteOpenAtom);

  function jump() {
    input.jumpQueued = true;
    input.jumpQueuedT = clock.now || performance.now();
  }

  function greet() {
    requestGreet(lightCtx());
  }

  function cycle() {
    cycleSwitch(lightCtx(), 1);
  }

  function toggleEmote() {
    setEmoteOpen((o) => !o);
  }

  return (
    <div className="dhBtnCluster" style={clusterStyle}>
      <Disc label="SWITCH" glyph="⇄" ring={JUMP} onTrigger={cycle} style={{ marginRight: '4px' }} />
      <Disc
        label="GREET"
        glyph="👋"
        ring={NAV}
        glow={canGreet}
        onTrigger={greet}
        style={{ marginRight: '4px' }}
      />
      <Disc
        label="EMOTE"
        glyph="✨"
        ring={COIN}
        active={emoteOpen}
        onTrigger={toggleEmote}
        style={{ marginRight: '4px' }}
      />
      <Disc label="JUMP" glyph="⤴" ring={JUMP} big onTrigger={jump} />
      <style>{keyframes}</style>
    </div>
  );
}

/** A single round disc. Fires on pointerdown for snappy game feel. */
function Disc({ label, glyph, ring, onTrigger, big, glow, active, style }) {
  return (
    <button
      type="button"
      className="dhDisc"
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        onTrigger();
      }}
      style={{
        ...discStyle,
        ...(big ? discBigStyle : null),
        border: `2px solid ${ring}`,
        boxShadow: glow
          ? `0 0 18px ${ring}, 0 8px 24px rgba(0,0,0,.4)`
          : '0 8px 24px rgba(0,0,0,.4)',
        background: active
          ? `radial-gradient(circle at 35% 30%, ${ring}, rgba(8,10,14,.7))`
          : 'radial-gradient(circle at 35% 30%, rgba(40,52,72,.7), rgba(8,10,14,.7))',
        animation: glow ? 'dhDiscPulse 1.4s ease-in-out infinite' : 'none',
        ...style,
      }}
    >
      <span style={glyphStyle} aria-hidden="true">
        {glyph}
      </span>
      <span style={labelStyle}>{label}</span>
    </button>
  );
}

const NAV = '#2D8CFF';
const JUMP = '#9B7BFF';
const COIN = '#FFC83D';
const FONT = "'Chakra Petch',system-ui,sans-serif";

const clusterStyle = {
  position: 'absolute',
  right: 'calc(20px + env(safe-area-inset-right,0px))',
  bottom: 'calc(20px + env(safe-area-inset-bottom,0px))',
  display: 'flex',
  alignItems: 'flex-end',
  pointerEvents: 'auto',
  touchAction: 'none',
  zIndex: 4,
};

const discStyle = {
  width: '56px',
  height: '56px',
  borderRadius: '50%',
  color: '#fff',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '1px',
  cursor: 'pointer',
  transition: 'transform .08s ease, box-shadow .12s ease',
  touchAction: 'none',
};

const discBigStyle = { width: '64px', height: '64px' };

const glyphStyle = { fontSize: '20px', lineHeight: 1 };

const labelStyle = {
  fontFamily: FONT,
  fontWeight: 700,
  fontSize: '8px',
  letterSpacing: '.06em',
};

const keyframes = `
.dhDisc:active{transform:scale(.92)}
@keyframes dhDiscPulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.35)}}
`;
