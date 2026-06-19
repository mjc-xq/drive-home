// ObjectiveHint — one quiet bottom-center line that swaps by game state. The copy
// pulls the eye toward the loop's goal (find safety) without ever being a wall of
// text. Three states, derived from change-gated atoms:
//   not marked            → "Explore — find Safe Zones"   (neutral)
//   marked                → "MARKED — reach a Safe Zone!"  (--nav, gentle pull)
//   marked + many riders  → "Get to safety!"               (--reverse, urgent)
//
// The keyed wrapper restarts the swap fade whenever the line changes (split/stagger
// soft enter), never a hard cut.

import { useAtomValue } from 'jotai';
import { markedAtom } from '../../state/atoms.js';
import { attachedCountAtom } from '../state/nibblerAtoms.js';

// Once this many riders cling, urgency overrides the calmer "reach a safe zone".
const CRITICAL_ATTACHED = 50;

export default function ObjectiveHint() {
  const marked = useAtomValue(markedAtom);
  const attached = useAtomValue(attachedCountAtom) | 0;

  let text;
  let tone = '';
  if (!marked) {
    text = 'Explore — find Safe Zones';
  } else if (attached >= CRITICAL_ATTACHED) {
    text = 'Get to safety!';
    tone = ' is-crit';
  } else {
    text = 'MARKED — reach a Safe Zone!';
    tone = ' is-marked';
  }

  return (
    <div
      key={text}
      className={`nb-hint nb-panel${tone}`}
      role="status"
      aria-live="polite"
    >
      {text}
    </div>
  );
}
