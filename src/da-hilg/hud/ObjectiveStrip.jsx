// Top-right objective: a kicker, four greet pips (one per family member), the
// running score (AGC, coin) and a small greeted count. Greeted pips flip to go;
// at 4/4 the score turns go and the whole strip pulses gold once on completion.

import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { CHARACTERS, CHARACTER_LABELS } from '../constants.js';
import { greetedAtom, scoreAtom, activePlayerIdAtom } from '../state/atoms.js';

export default function ObjectiveStrip() {
  const greeted = useAtomValue(greetedAtom);
  const score = useAtomValue(scoreAtom);
  const activeId = useAtomValue(activePlayerIdAtom);

  const count = CHARACTERS.reduce((n, id) => n + (greeted[id] ? 1 : 0), 0);
  const total = CHARACTERS.length;
  const complete = count >= total;

  // fire the one-shot gold pulse only on the rising edge to 4/4
  const ref = useRef(null);
  const wasComplete = useRef(false);
  useEffect(() => {
    if (complete && !wasComplete.current && ref.current) {
      // restart the CSS animation by toggling the class
      ref.current.classList.remove('is-complete');
      // force reflow so the animation can replay
      void ref.current.offsetWidth;
      ref.current.classList.add('is-complete');
    }
    wasComplete.current = complete;
  }, [complete]);

  return (
    <div
      ref={ref}
      className={`dh-objstrip dh-panel${complete ? ' is-complete' : ''}`}
      aria-live="polite"
    >
      <span className="dh-kick">Greet the family</span>
      <div className="dh-objrow">
        <div className="dh-pips">
          {CHARACTERS.map((id) => {
            const isGreeted = !!greeted[id];
            const isSelf = id === activeId && !isGreeted;
            const cls = ['dh-pip', isGreeted && 'is-greeted', isSelf && 'is-self']
              .filter(Boolean)
              .join(' ');
            return (
              <span
                key={id}
                className={cls}
                title={CHARACTER_LABELS[id]}
                aria-label={`${CHARACTER_LABELS[id]} ${isGreeted ? 'greeted' : 'not greeted'}`}
              >
                {isGreeted ? '✓' : CHARACTER_LABELS[id].charAt(0)}
              </span>
            );
          })}
        </div>
        <span
          className={`dh-score${complete ? ' is-complete' : ''}`}
          aria-label={`Score ${score}, greeted ${count} of ${total}`}
        >
          {score}
        </span>
      </div>
    </div>
  );
}
