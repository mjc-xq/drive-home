import { useEffect, useRef, useState } from 'react';
import { createEngine } from './engine/engine.js';

// React owns the HUD chrome only; the engine owns the canvas, input and the
// game loop. Low-frequency state flows engine -> here via emit; per-frame
// values (mph, compass, joystick knob) are written by the engine straight
// into the DOM nodes registered in uiRefs.
export default function App() {
  const canvasRef = useRef(null);
  const uiRefs = useRef({ box: null, mph: null, needle: null, joy: null, knob: null });
  const engineRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [picking, setPicking] = useState(true);   // start menu: pick a mode before playing
  const [mode, setMode] = useState('explore');
  const [subline, setSubline] = useState('Hayward, CA');
  const [shiftLock, setShiftLock] = useState(false);
  const [scoopHud, setScoopHud] = useState({ name: '🥄 Trowel', bag: 0, cap: 6, total: 0, clean: 100 });
  const [nearCar, setNearCar] = useState(false);
  const [attribution, setAttribution] = useState('');   // live Google 3D Tiles data credit
  const [toast, setToast] = useState({ html: '', show: false });
  const [carCard, setCarCard] = useState({ name: '', spec: '', credit: '', show: false });
  const toastTimer = useRef(0);
  const cardTimer = useRef(0);

  useEffect(() => {
    const emit = (type, p) => {
      switch (type) {
        case 'ready': setReady(true); break;
        case 'mode': setMode(p); break;
        case 'subline': setSubline(p); break;
        case 'shiftLock': setShiftLock(p); break;
        case 'scoopHud': setScoopHud(p); break;
        case 'nearCar': setNearCar(p); break;
        case 'attribution': setAttribution(p); break;
        case 'carCard':
          setCarCard({ name: p.name, spec: p.spec, credit: p.credit || '', show: true });
          clearTimeout(cardTimer.current);
          cardTimer.current = setTimeout(() => setCarCard(c => ({ ...c, show: false })), 3200);
          break;
        case 'toast':
          setToast({ html: p.html, show: true });
          clearTimeout(toastTimer.current);
          toastTimer.current = setTimeout(() => setToast(t => ({ ...t, show: false })), p.ms || 1800);
          break;
        default: break;
      }
    };
    const engine = createEngine({ canvas: canvasRef.current, ui: uiRefs.current, emit });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      clearTimeout(toastTimer.current);
      clearTimeout(cardTimer.current);
    };
  }, []);

  const eng = () => engineRef.current;

  return (
    <>
      <div id="loading" className={ready ? 'done' : ''}>
        <div className="dot" />
        <span>Building the neighborhood…</span>
      </div>
      <canvas
        id="scene" ref={canvasRef} tabIndex={0}
        aria-label="Interactive 3D model of 1840 Dahill Lane with drivable neighborhood"
      />
      {ready && picking && (
        <div id="startMenu">
          <div className="startCard">
            <h1><em>1840</em> Dahill Lane</h1>
            <p>Choose how to explore</p>
            <div className="startBtns">
              <button className="btn primary" onClick={() => setPicking(false)}>🛰️ Explore</button>
              <button className="btn primary" onClick={() => { setPicking(false); eng().enterDrive(); }}>🏎️ Drive</button>
              <button className="btn primary" onClick={() => { setPicking(false); eng().enterScoop(); }}>💩 Scoop</button>
            </div>
          </div>
        </div>
      )}
      <div id="ui" ref={el => (uiRefs.current.box = el)} className={mode}>
        {mode === 'explore' && (
          <>
            <div id="title" className="chip">
              <h1><em>1840</em> Dahill Lane</h1>
              <p>{subline}</p>
            </div>
            <div id="btns">
              <button id="findBtn" className="btn" onClick={() => eng().focusHouse(true)}>Find my house</button>
              <button id="driveBtn" className="btn primary" onClick={() => eng().enterDrive()}>Drive 🏎️</button>
              <button id="scoopBtn" className="btn" onClick={() => eng().enterScoop()}>Scoop 💩</button>
            </div>
            <div id="hint" className="chip">
              Drag to orbit · Scroll or pinch to zoom<br />Two-finger drag to pan · Tap house to visit
            </div>
          </>
        )}
        <div id="compass" className="chip" aria-hidden="true">
          <svg viewBox="0 0 40 40" ref={el => (uiRefs.current.needle = el)}>
            <polygon points="20,5 24,22 20,19 16,22" fill="#d94f1e" />
            <polygon points="20,35 24,18 20,21 16,18" fill="#28241d" opacity=".35" />
            <text x="20" y="3.5" fontSize="7" fontWeight="700" textAnchor="middle" fill="#28241d" opacity=".55">N</text>
          </svg>
        </div>
        {mode === 'drive' && (
          <div id="hud">
            <div id="speedo"><b ref={el => (uiRefs.current.mph = el)}>0</b><span>MPH</span></div>
            <button id="exitBtn" className="btn" onClick={() => eng().exitDrive()}>Exit ✕</button>
            <button id="carSwap" className="btn icon" aria-label="Change vehicle" onClick={() => eng().cycleCar()}>🚗</button>
            <button id="camBtn" className="btn icon" aria-label="Camera view" onClick={() => eng().cycleCamera()}>🎥</button>
          </div>
        )}
        <div id="carCard" className={carCard.show ? 'show' : ''}>
          <h2>{carCard.name}</h2>
          <p>
            {carCard.spec}
            <br />
            <span style={{ opacity: .5, fontSize: 10, letterSpacing: '.04em' }}>{carCard.credit ? `${carCard.credit} · three.js` : 'three.js'}</span>
          </p>
        </div>
        {mode === 'scoop' && (
          <div id="shud">
            <div id="toolChip" className="chip">{scoopHud.name} <span>{scoopHud.bag}/{scoopHud.cap}</span></div>
            <div id="pooHud" className="chip">💩 {scoopHud.total} scooped · yard {scoopHud.clean}% ✨</div>
            <button id="exitScoop" className="btn" onClick={() => eng().exitScoop()}>Exit ✕</button>
            <button id="shiftLock" className={'btn icon' + (shiftLock ? ' on' : '')} aria-pressed={shiftLock} onClick={() => eng().toggleShiftLock()}>{shiftLock ? '🔒' : '🔓'}</button>
            <button id="scoopCam" className="btn icon" aria-label="Camera view" onClick={() => eng().cycleScoopCamera()}>🎥</button>
            {nearCar && <button id="getInCar" className="btn primary" onClick={() => eng().driveFromScoop()}>Get in &amp; drive 🚗</button>}
            <div id="lookHint" className="chip">left side to move · drag to look · scroll/pinch zoom · 🔒 shift-lock</div>
          </div>
        )}
        <div id="joy" ref={el => (uiRefs.current.joy = el)}><div id="knob" ref={el => (uiRefs.current.knob = el)} /></div>
        <div id="toast" className={toast.show ? 'show' : ''} dangerouslySetInnerHTML={{ __html: toast.html }} />
        {attribution && (
          <div id="credits" aria-label="Map data attribution">
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
            </svg>
            <span>{attribution}</span>
          </div>
        )}
      </div>
    </>
  );
}
