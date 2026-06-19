// Root DOM overlay for Da Hilg. Sits above the R3F <Canvas> as a fixed,
// pointer-events:none layer; only interactive widgets re-enable hit-testing.
// Composes the core HUD (this cluster) plus the optional cluster6 pieces and the
// mobile controls. Both trees render under the shared Jotai <Provider store> set
// up in DaHilgApp, so useAtomValue here reads the same store the Canvas writes.
//
// Import-order tolerance: the cluster6 widgets (EmoteWheel/HudMenu/ToastFeed/
// CelebrationBanner) and the mobile controls are siblings owned by other clusters.
// They're pulled in with React.lazy + a missing-file fallback so this overlay
// builds and runs even while those files are still landing.

import './hud.css';
import '../fonts.css';

import { lazy, Suspense, Component } from 'react';
import { useAtomValue } from 'jotai';
import { gamePhaseAtom, pausedAtom } from '../state/atoms.js';
import { gameModeAtom } from '../nibblers/state/nibblerAtoms.js';

import LoadingVeil from './LoadingVeil.jsx';
import ProgressBridge from './ProgressBridge.jsx';
import Crosshair from './Crosshair.jsx';
import StateStrip from './StateStrip.jsx';
import ObjectiveStrip from './ObjectiveStrip.jsx';
import CharacterBar from './CharacterBar.jsx';
import InteractPrompt from './InteractPrompt.jsx';
import LockOverlay from './LockOverlay.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import NibblersHud from '../nibblers/hud/NibblersHud.jsx';

/** A lazy component that resolves to render-nothing if the module is missing. */
function optional(importer) {
  return lazy(() =>
    importer()
      .then((m) => ({ default: m.default || (() => null) }))
      .catch(() => ({ default: () => null }))
  );
}

// Cluster6 pieces (may not exist yet — tolerated).
const EmoteWheel = optional(() => import('./EmoteWheel.jsx'));
const HudMenu = optional(() => import('./HudMenu.jsx'));
const ToastFeed = optional(() => import('./ToastFeed.jsx'));
const CelebrationBanner = optional(() => import('./CelebrationBanner.jsx'));

// Mobile controls (rendered only on coarse pointers; also cluster-owned).
const TouchJoystick = optional(() => import('./mobile/TouchJoystick.jsx'));
const TouchLook = optional(() => import('./mobile/TouchLook.jsx'));
const TouchButtons = optional(() => import('./mobile/TouchButtons.jsx'));
const LookHint = optional(() => import('./mobile/LookHint.jsx'));

// Touch detection (coarse pointer). Evaluated once at module load.
const isTouch =
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(pointer: coarse)').matches;

/** Swallow render errors from optional widgets so the core HUD never goes down. */
class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err) {
    console.error('[DaHilgHud] optional HUD widget crashed', err);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Wrap an optional lazy widget in its own boundary + suspense (null fallback). */
function Optional({ children }) {
  return (
    <Boundary>
      <Suspense fallback={null}>{children}</Suspense>
    </Boundary>
  );
}

export default function DaHilgHud() {
  const phase = useAtomValue(gamePhaseAtom);
  const paused = useAtomValue(pausedAtom);
  const mode = useAtomValue(gameModeAtom);

  const playing = phase === 'playing' || phase === 'won';
  const greet = mode !== 'nibblers'; // greet-the-family widgets only in greet mode

  return (
    <div className="dahilg-hud">
      {/* Bridges drei useProgress → loadProgressAtom + flips phase to playing. */}
      <ProgressBridge />

      {/* Always-on veils. */}
      <LoadingVeil />
      <LockOverlay />

      {/* In-play HUD (kept mounted through 'won' for the celebration). */}
      {playing && (
        <>
          {!paused && <Crosshair />}
          <StateStrip />
          {greet && <ObjectiveStrip />}
          <CharacterBar />
          <SettingsPanel />
          {greet && !paused && <InteractPrompt />}

          {/* Nibblers HUD (self-gates to nibblers mode): marked / swarm / health /
              minimap / vignette. */}
          <NibblersHud />

          {/* Optional cluster6 widgets. */}
          <Optional>
            <ToastFeed />
          </Optional>
          <Optional>
            <EmoteWheel />
          </Optional>
          <Optional>
            <HudMenu />
          </Optional>
          {greet && (
            <Optional>
              <CelebrationBanner />
            </Optional>
          )}

          {/* Mobile cluster — only on touch devices. */}
          {isTouch && (
            <>
              <Optional>
                <TouchJoystick />
              </Optional>
              <Optional>
                <TouchLook />
              </Optional>
              <Optional>
                <TouchButtons />
              </Optional>
              <Optional>
                <LookHint />
              </Optional>
            </>
          )}
        </>
      )}
    </div>
  );
}
