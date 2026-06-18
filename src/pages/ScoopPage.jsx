import { useEffect, useRef, useState } from 'react';
import { useEngine, useEngineEvent } from '../lib/engine-context.jsx';
import { useOrientation, useOutsideDismiss } from '../lib/hooks.js';
import MobileControls from '../ui/MobileControls.jsx';
import Toast from '../ui/Toast.jsx';
import Credits from '../ui/Credits.jsx';

export default function ScoopPage() {
  const { engine, uiRefs } = useEngine();
  const orientation = useOrientation();

  // Helper so extracted handlers can call eng().foo() verbatim.
  const eng = () => engine;

  // -- local state --
  const [scoopMenuOpen, setScoopMenuOpen] = useState(false);
  const [scoopHud, setScoopHud] = useState({ name: '🥄 Trowel', bag: 0, cap: 6, total: 0, clean: 100 });
  const [scoopChar, setScoopChar] = useState('drew');
  const [scoopActions, setScoopActions] = useState([]);
  const [house, setHouse] = useState({ inside: false, ready: false });
  const [nearCar, setNearCar] = useState(false);
  const [shiftLock, setShiftLock] = useState(false);

  // -- refs --
  const scoopMenuRef = useRef(null);

  // -- engine events --
  useEngineEvent('scoopHud', (p) => setScoopHud(p));
  useEngineEvent('avatar', (p) => { setScoopChar(p.name); if (p.actions) setScoopActions(p.actions); });
  useEngineEvent('house', (p) => setHouse(p));
  useEngineEvent('nearCar', (p) => setNearCar(p));
  useEngineEvent('shiftLock', (p) => setShiftLock(p));

  // -- outside dismiss for scoop menu --
  useOutsideDismiss(scoopMenuOpen, scoopMenuRef, () => setScoopMenuOpen(false));

  // -- resize on mount so the engine knows the #ui box is present --
  useEffect(() => { if (engine && engine.resize) engine.resize(); }, [engine]);

  return (
    <div id="ui" ref={el => (uiRefs.current.box = el)} className="scoop">
      {/* compass chip — scoop is the non-drive mode that shows it */}
      <div id="compass" className="chip" aria-hidden="true">
        <svg viewBox="0 0 40 40" ref={el => (uiRefs.current.needle = el)}>
          <text x="20" y="6.2" fontSize="6.5" fontWeight="700" textAnchor="middle" fill="var(--nav)" fontFamily="'Chakra Petch'">N</text>
          <polygon points="20,8.5 24,21 20,17.6 16,21" fill="var(--nav)" />
          <polygon points="20,32 24,19 20,22.4 16,19" fill="#fff" opacity=".4" />
          <circle cx="20" cy="20" r="2" fill="#fff" />
        </svg>
      </div>

      {/* scoop HUD */}
      <div id="shud">
        <div id="toolChip" className="chip">{scoopHud.name} <span>{scoopHud.bag}/{scoopHud.cap}</span></div>
        <div id="pooHud" className="chip">💩 {scoopHud.total} scooped · yard {scoopHud.clean}% ✨</div>

        {/* collapsible side menu */}
        <div className="dvTopRight scoopTopRight" ref={scoopMenuRef}>
          <div className="segBar">
            <button
              className={'segBtn segMenu' + (scoopMenuOpen ? ' open' : '')}
              aria-label="Scoop menu"
              aria-expanded={scoopMenuOpen}
              onClick={() => {
                if (!scoopMenuOpen) {
                  setScoopChar(eng().getAvatar());
                  setScoopActions(eng().getScoopActions());
                }
                setScoopMenuOpen(o => !o);
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
            </button>
          </div>
          {scoopMenuOpen && (
            <div className="segMenuPanel scoopMenuPanel">
              {/* go inside / leave the house */}
              {house.ready && !house.inside && (
                <button className="menuItem accent" onClick={() => { eng().enterHouse(); setScoopMenuOpen(false); }}>
                  <span className="miIcon go">🏠</span><span className="miTxt"><b>Go inside</b><i className="go">Enter the house</i></span>
                </button>
              )}
              {house.inside && (
                <button className="menuItem accent" onClick={() => { eng().leaveHouse(); setScoopMenuOpen(false); }}>
                  <span className="miIcon go">🚪</span><span className="miTxt"><b>Leave house</b><i className="go">Back outside</i></span>
                </button>
              )}
              {/* who you control */}
              <div className="charSwitch" role="radiogroup" aria-label="Who you control">
                <button className={'charOpt' + (scoopChar === 'drew' ? ' on' : '')} role="radio" aria-checked={scoopChar === 'drew'} onClick={() => eng().setAvatar('drew')}>🧒 Drew</button>
                <button className={'charOpt' + (scoopChar === 'cece' ? ' on' : '')} role="radio" aria-checked={scoopChar === 'cece'} onClick={() => eng().setAvatar('cece')}>👧 CeCe</button>
              </div>
              {/* action buttons for the active character */}
              {scoopActions.length > 0 && (
                <div className="actionWrap">
                  <div className="actionKick">Actions</div>
                  <div className="actionGrid">
                    {scoopActions.map(a => (
                      <button key={a.key} className="actionBtn" onClick={() => eng().playAction(a.key)}>{a.label}</button>
                    ))}
                  </div>
                </div>
              )}
              <button className="menuItem" onClick={() => eng().cycleScoopCamera()}>
                <span className="miIcon nav">🎥</span><span className="miTxt"><b>Camera</b><i className="off">Cycle view</i></span>
              </button>
              <button className={'menuItem' + (shiftLock ? ' on' : '')} aria-pressed={shiftLock} onClick={() => eng().toggleShiftLock()}>
                <span className="miIcon jump">{shiftLock ? '🔒' : '🔓'}</span><span className="miTxt"><b>Shift-lock</b><i className={shiftLock ? 'jump' : 'off'}>{shiftLock ? 'On' : 'Off'}</i></span>
              </button>
              <button className="menuItem" onClick={() => { eng().exitScoop(); setScoopMenuOpen(false); }}>
                <span className="miIcon reverse">✕</span><span className="miTxt"><b>Exit scoop</b><i className="off">Back to menu</i></span>
              </button>
            </div>
          )}
        </div>

        <button id="jumpBtn" className="btn primary icon" aria-label="Jump" onClick={() => eng().jump()}>🦘</button>
        {nearCar && <button id="getInCar" className="btn primary" onClick={() => eng().driveFromScoop()}>Get in &amp; drive 🚗</button>}
        <div id="lookHint" className="chip">left to move · drag to look · 🦘 jump · ☰ menu: characters, actions &amp; exit</div>
      </div>

      {/* joystick */}
      <div id="joy" ref={el => (uiRefs.current.joy = el)}><div id="knob" ref={el => (uiRefs.current.knob = el)} /></div>
      {eng() && eng().im && <MobileControls input={eng().im} orientation={orientation} buttons={false} />}
      <Toast />
      <Credits />
    </div>
  );
}
