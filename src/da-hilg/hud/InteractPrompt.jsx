// Center-low glass pill: "Press E to greet X" driven by nearbyGreetableAtom.
// Hidden when nothing is greetable. On mobile the keycap is dropped (the round
// GREET button glows instead); detection is left to CSS/parent — here we always
// render the keycap and let the mobile cluster's own glow take the lead.

import { useAtomValue } from 'jotai';
import { nearbyGreetableAtom } from '../state/atoms.js';

export default function InteractPrompt() {
  const nearby = useAtomValue(nearbyGreetableAtom);
  if (!nearby) return null;

  const label = nearby.label || 'them';

  return (
    <div className="dh-prompt" role="status" aria-live="polite">
      <span className="dh-keycap" aria-hidden="true">
        E
      </span>
      <span className="dh-prompt-text">Press E to greet {label}</span>
    </div>
  );
}
