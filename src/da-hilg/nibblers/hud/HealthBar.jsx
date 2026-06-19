// HealthBar — the active player's HP, under SwarmCount. Fill ramps go (>60) →
// coin (30..60) → reverse (<30); width = health%. A drain shimmer overlay scales
// with the attached count (more riders = more visible drain). Deliberately
// de-emphasized vs SwarmCount (movement pressure is the real threat, health is
// secondary) — thin, slightly faded.
//
// Reads framework healthAtom (per-char map) keyed by the active player id, plus
// the bucketed attachedCountAtom for the shimmer intensity. All change-gated.

import { useAtomValue } from 'jotai';
import { healthAtom, activePlayerIdAtom } from '../../state/atoms.js';
import { HEALTH_MAX } from '../../constants.js';
import { attachedCountAtom } from '../state/nibblerAtoms.js';

export default function HealthBar() {
  const health = useAtomValue(healthAtom);
  const activeId = useAtomValue(activePlayerIdAtom);
  const attached = useAtomValue(attachedCountAtom) | 0;

  const hp = health?.[activeId];
  const value = Number.isFinite(hp) ? hp : HEALTH_MAX;
  const pct = Math.max(0, Math.min(100, (value / HEALTH_MAX) * 100));

  const fillClass =
    pct < 30 ? 'is-low' : pct < 60 ? 'is-mid' : '';

  // Shimmer fades in only while actively draining (riders attached), capped.
  const drain = attached > 0 ? Math.min(0.6, attached / 120) : 0;

  return (
    <div className="nb-health" aria-label={`Health ${Math.round(value)} of ${HEALTH_MAX}`}>
      <div className="nb-health-track">
        <div
          className={`nb-health-fill ${fillClass}`}
          style={{ width: `${pct}%`, '--nb-drain': drain.toFixed(2) }}
        />
      </div>
    </div>
  );
}
