import { useEffect, useRef, useState } from 'react';
import { useEngineEvent } from '../lib/engine-context.jsx';

// Shared transient toast. Both mini-games call engine.toast(...) → a 'toast'
// emit; whichever page is mounted renders one of these inside its HUD.
export default function Toast() {
  const [toast, setToast] = useState({ html: '', show: false });
  const timer = useRef(0);
  useEngineEvent('toast', (p) => {
    setToast({ html: p.html, show: true });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(t => ({ ...t, show: false })), p.ms || 1800);
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div id="toast" role="status" aria-live="polite" aria-atomic="true"
      className={toast.show ? 'show' : ''} dangerouslySetInnerHTML={{ __html: toast.html }} />
  );
}
