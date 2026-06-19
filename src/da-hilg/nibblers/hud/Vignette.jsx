// Vignette — the visibility penalty made visible. A single full-screen DOM
// overlay (radial darkening) whose edge alpha = 1 - visibilityFactor, capped so
// it never fully blinds. NO postprocessing, NO backdrop blur for v1 — just a
// cheap GPU-compositable radial gradient transitioning between the atom's quantized
// 0.05 steps. Sits behind every widget, above the canvas.
//
// visibilityFactorAtom commits only on 0.05 steps (commitNibblers), so this
// updates a dozen-ish times across a full swarm ramp; a CSS transition on the
// gradient smooths each step, and a safe-zone clear (factor → 1) gives a relief
// swoosh. Reduced-motion keeps the static darkening (it's information) but the
// nibblers.css block kills the transition + the decorative edge-crawl.

import { useAtomValue } from 'jotai';
import { visibilityFactorAtom } from '../state/nibblerAtoms.js';

// Never fully blind — leave a sliver of clarity even at max attachments.
const MAX_EDGE_ALPHA = 0.8;
// Edge-crawl only kicks in once visibility is genuinely degraded ("overwhelmed").
const CRAWL_ONSET = 0.45;

export default function Vignette() {
  const vis = useAtomValue(visibilityFactorAtom);
  const v = Number.isFinite(vis) ? Math.max(0, Math.min(1, vis)) : 1;

  const edge = (1 - v) * MAX_EDGE_ALPHA;
  // crawl fades in below the onset, fully on near-blind
  const crawl = v < CRAWL_ONSET ? Math.min(1, (CRAWL_ONSET - v) / CRAWL_ONSET) : 0;

  return (
    <div
      className="nb-vignette"
      aria-hidden="true"
      style={{ '--nb-edge': edge.toFixed(3), '--nb-crawl': crawl.toFixed(2) }}
    />
  );
}
