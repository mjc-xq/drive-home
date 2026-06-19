// SwarmCount — top-left square-glass readout: ACTIVE (chasing) + ATTACHED (riding
// you). AGC tabular numbers so 9→10→100 never reflows. Both values tint as they
// climb past thresholds tuned to the 32-NPC pool. A one-shot pop/jiggle
// fires on the 'nibblerAttach' / 'nibblerStomp' transient pulses (hudEvents, NOT an
// atom) — the count "nips" up/down.
//
// Subscribes to the bucketed activeNibblersAtom / attachedCountAtom (change-gated);
// the pulses ride hudEvents so per-attach juice never thrashes the store.

import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { activeNibblersAtom, attachedCountAtom } from '../state/nibblerAtoms.js';
import { on } from '../../hud/hudEvents.js';

const ACTIVE_WARN_AT = 10; // --coin
const ACTIVE_CRIT_AT = 22; // --reverse
const ATTACHED_WARN_AT = 3; // --coin
const ATTACHED_CRIT_AT = 8; // --reverse

function tintClass(n, warnAt, critAt) {
  if (n >= critAt) return ' is-crit';
  if (n >= warnAt) return ' is-warn';
  return '';
}

/** Restart a CSS keyframe by toggling the class with a forced reflow. */
function popOnce(el) {
  if (!el) return;
  el.classList.remove('is-pop');
  void el.offsetWidth; // reflow so the animation can replay
  el.classList.add('is-pop');
}

export default function SwarmCount() {
  const active = useAtomValue(activeNibblersAtom) | 0;
  const attached = useAtomValue(attachedCountAtom) | 0;

  const attachedRef = useRef(null);

  // Both attach and stomp visibly change the attached pile → pop that readout.
  useEffect(() => {
    const pop = () => popOnce(attachedRef.current);
    const offA = on('nibblerAttach', pop);
    const offS = on('nibblerStomp', pop);
    return () => {
      offA();
      offS();
    };
  }, []);

  return (
    <div className="nb-swarm nb-panel" aria-live="off">
      <div className="nb-swarm-row">
        <span className="nb-kick">Active</span>
        <span
          className={`nb-swarm-val${tintClass(active, ACTIVE_WARN_AT, ACTIVE_CRIT_AT)}`}
          aria-label={`${active} nibblers active`}
        >
          {active}
        </span>
      </div>
      <div className="nb-swarm-row">
        <span className="nb-kick">Attached</span>
        <span
          ref={attachedRef}
          className={`nb-swarm-val${tintClass(attached, ATTACHED_WARN_AT, ATTACHED_CRIT_AT)}`}
          aria-label={`${attached} nibblers attached`}
        >
          {attached}
        </span>
      </div>
      {attached > 0 && (
        <div className="nb-swarm-effect" aria-live="polite">
          Slowed / jump weakened / draining
        </div>
      )}
    </div>
  );
}
