// NibblerFeedback - transient attack/combat pulses that ride hudEvents instead of
// atoms. Attachments, stomps, and danger-zone entries are short-lived feedback, so
// they should not write the shared store.

import { useEffect, useRef, useState } from 'react';
import { on } from '../../hud/hudEvents.js';

const SHOW_MS = 760;

export default function NibblerFeedback() {
  const [pulse, setPulse] = useState(null); // { id, tone, text }
  const idRef = useRef(0);
  const timerRef = useRef(null);

  useEffect(() => {
    const fire = (tone, text) => {
      const id = ++idRef.current;
      setPulse({ id, tone, text });
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setPulse((p) => (p && p.id === id ? null : p));
      }, SHOW_MS);
    };

    const offAttach = on('nibblerAttach', (payload) => {
      const n = payload?.count;
      fire('attach', Number.isFinite(n) ? `${n} attached` : 'Nibblers attached');
    });
    const offStomp = on('nibblerStomp', (payload) => {
      const n = payload?.count || 1;
      fire('stomp', `Stomped ${n}`);
    });
    const offDanger = on('dangerZoneEntered', (payload) => {
      fire('danger', payload?.label || 'Danger Zone');
    });

    return () => {
      offAttach();
      offStomp();
      offDanger();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!pulse) return null;

  return (
    <div
      key={pulse.id}
      className={`nb-feedback is-${pulse.tone}`}
      role="status"
      aria-live="assertive"
    >
      <span className="nb-feedback-text">{pulse.text}</span>
    </div>
  );
}
