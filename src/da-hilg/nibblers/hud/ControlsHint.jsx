// ControlsHint - compact Nibblers state readout. Keep this focused on the current
// survival goal; the shared input layer already owns keyboard/touch controls.

import { useAtomValue } from 'jotai';
import { markedAtom } from '../../state/atoms.js';
import { attachedCountAtom, currentSafeZoneAtom } from '../state/nibblerAtoms.js';

export default function ControlsHint() {
  const marked = useAtomValue(markedAtom);
  const attached = useAtomValue(attachedCountAtom) | 0;
  const safe = useAtomValue(currentSafeZoneAtom);

  let status = 'Scout the block. Safe zones hold the line.';
  let tone = '';
  if (safe) {
    status = `${safe} secured`;
    tone = ' is-safe';
  } else if (attached > 0) {
    status = 'Swarm attached. Break away or reach safety.';
    tone = ' is-danger';
  } else if (marked) {
    status = 'Marked. Reach a Safe Zone.';
    tone = ' is-danger';
  }

  return (
    <div className={`nb-controls nb-panel${tone}`} role="status" aria-live="polite">
      <div className="nb-control-status">{status}</div>
    </div>
  );
}
