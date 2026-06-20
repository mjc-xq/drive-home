// NibblersHud — the Nibblers DOM HUD cluster root. Mounted by the framework HUD
// (DaHilgHud) inside the `.dahilg-hud` overlay so every brand token + the global
// reduced-motion block cascade for free. Renders ONLY in nibblers mode; in greet
// mode it's an exact no-op (return null), so the framework can mount it
// unconditionally.
//
// Composition order matters for stacking: Vignette sits behind (z-index 0) as the
// visibility wash; the readout widgets (MarkedIndicator/SwarmCount/HealthBar/
// ObjectiveHint/Minimap) sit above; SafeBanner is the top-most relief wash. The
// wrapper is pointer-events:none — nothing in this cluster is interactive.

import './nibblers.css';

import { useAtomValue } from 'jotai';
import { gameModeAtom } from '../state/nibblerAtoms.js';

import Vignette from './Vignette.jsx';
import MarkedIndicator from './MarkedIndicator.jsx';
import SwarmCount from './SwarmCount.jsx';
import HealthBar from './HealthBar.jsx';
import ObjectiveHint from './ObjectiveHint.jsx';
import Minimap from './Minimap.jsx';
import SafeBanner from './SafeBanner.jsx';
import NibblerFeedback from './NibblerFeedback.jsx';

export default function NibblersHud() {
  const mode = useAtomValue(gameModeAtom);
  if (mode !== 'nibblers') return null;

  return (
    <div className="nb-hud">
      {/* visibility wash, behind everything */}
      <Vignette />

      {/* readouts */}
      <MarkedIndicator />
      <SwarmCount />
      <HealthBar />
      <ObjectiveHint />
      <Minimap />
      <NibblerFeedback />

      {/* relief wash, above everything */}
      <SafeBanner />
    </div>
  );
}
