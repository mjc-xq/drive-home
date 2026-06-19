// MarkedIndicator — top-center alarm. Hidden until you're Marked; then it slams
// in (one keyframe) and holds a steady --reverse pulse whose rate scales with the
// attraction tier (faster = more danger). Shows the MARKED word, a 5-segment
// attraction-tier ramp (0..4), and an mm:ss timer from markedTimerAtom.
//
// Subscribes only to discrete, change-gated atoms (markedAtom edge, tier on
// crossing, timer at 1 Hz) — no per-frame work.

import { useAtomValue } from 'jotai';
import { markedAtom } from '../../state/atoms.js';
import { attractionTierAtom, markedTimerAtom } from '../state/nibblerAtoms.js';

const TIER_SEGMENTS = 5; // tiers 0..4 → segment i lit when i < tier
// Pulse period per tier (seconds): calmer at tier 0, frantic at tier 4.
const PULSE_BY_TIER = ['1.4s', '1.1s', '0.85s', '0.62s', '0.45s'];

/** mm:ss from whole seconds. */
function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export default function MarkedIndicator() {
  const marked = useAtomValue(markedAtom);
  const tier = useAtomValue(attractionTierAtom);
  const seconds = useAtomValue(markedTimerAtom);

  if (!marked) return null;

  const t = Math.max(0, Math.min(TIER_SEGMENTS - 1, tier | 0));
  const pulse = PULSE_BY_TIER[t] || PULSE_BY_TIER[0];

  return (
    <div className="nb-marked nb-panel" role="alert" aria-live="assertive">
      <div className="nb-marked-head">
        <span
          className="nb-marked-word"
          style={{ '--nb-pulse': pulse }}
          aria-label="You are marked"
        >
          Marked
        </span>
        <span className="nb-marked-timer" aria-label={`Marked for ${fmtTime(seconds)}`}>
          {fmtTime(seconds)}
        </span>
      </div>
      <div className="nb-ramp" aria-hidden="true">
        {Array.from({ length: TIER_SEGMENTS }, (_, i) => (
          <span key={i} className={`nb-ramp-seg${i < t + 1 ? ' is-on' : ''}`} />
        ))}
      </div>
    </div>
  );
}
