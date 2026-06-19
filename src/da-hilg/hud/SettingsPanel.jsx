// SettingsPanel — a small in-game graphics-settings widget (bottom-left). Three
// toggles: photo Facades (export-baked, gated by visibility), fancy Water + Grass
// (runtime effects). Collapsible behind a gear so it doesn't clutter the HUD.
//
// DOM overlay, pointer-events re-enabled on the panel only. Reads/writes the shared
// settings atoms; the Level renderers react to them.

import { useState } from 'react';
import { useAtom } from 'jotai';
import { showFacadesAtom, showWaterAtom, showGrassAtom } from '../state/settingsAtoms.js';

function Toggle({ label, atom }) {
  const [on, setOn] = useAtom(atom);
  return (
    <button
      type="button"
      className="dhSetRow"
      aria-pressed={on}
      onClick={() => setOn((v) => !v)}
    >
      <span className="dhSetName">{label}</span>
      <span className={'dhSetPill' + (on ? ' on' : '')}>{on ? 'ON' : 'OFF'}</span>
    </button>
  );
}

export default function SettingsPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="dhSettings">
      <button
        type="button"
        className="dhSetGear"
        aria-label="Graphics settings"
        onClick={() => setOpen((v) => !v)}
      >
        ⚙ Graphics
      </button>
      {open && (
        <div className="dhSetBody">
          <Toggle label="Photo facades" atom={showFacadesAtom} />
          <Toggle label="Fancy water" atom={showWaterAtom} />
          <Toggle label="Grass" atom={showGrassAtom} />
        </div>
      )}
      <style>{`
        .dhSettings{ position:fixed; left:14px; bottom:74px; z-index:40; display:flex;
          flex-direction:column; gap:6px; align-items:flex-start; pointer-events:none; }
        .dhSettings > *{ pointer-events:auto; }
        .dhSetGear, .dhSetRow{ font:600 12px/1 system-ui,sans-serif; color:#dfe7f5;
          background:rgba(8,10,14,.66); border:1px solid rgba(255,255,255,.18);
          border-radius:8px; padding:7px 10px; cursor:pointer; letter-spacing:.02em; }
        .dhSetGear:hover{ border-color:rgba(255,255,255,.4); }
        .dhSetBody{ display:flex; flex-direction:column; gap:5px; pointer-events:none; }
        .dhSetBody > *{ pointer-events:auto; }
        .dhSetRow{ display:flex; align-items:center; gap:10px; min-width:150px;
          justify-content:space-between; }
        .dhSetName{ opacity:.92; }
        .dhSetPill{ font-size:10px; font-weight:800; padding:2px 7px; border-radius:6px;
          background:rgba(255,82,71,.22); color:#ff8a80; border:1px solid rgba(255,82,71,.4); }
        .dhSetPill.on{ background:rgba(43,232,79,.18); color:#79f59a;
          border-color:rgba(43,232,79,.45); }
      `}</style>
    </div>
  );
}
