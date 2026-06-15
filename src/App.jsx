import { useEffect, useRef, useState } from 'react';
import { createEngine } from './engine/engine.js';

// React owns the HUD chrome only; the engine owns the canvas, input and the
// game loop. Low-frequency state flows engine -> here via emit; per-frame
// values (mph, compass, joystick knob) are written by the engine straight
// into the DOM nodes registered in uiRefs.
export default function App() {
  const canvasRef = useRef(null);
  const uiRefs = useRef({ box: null, mph: null, needle: null, joy: null, knob: null, minimap: null, speedBar: null, fx: null, runTime: null, rev: null, eta: null, brakeLbl: null, boostBar: null });
  const engineRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [picking, setPicking] = useState(true);   // start menu: pick a mode before playing
  const [mode, setMode] = useState('explore');
  const [subline, setSubline] = useState('Hayward, CA');
  const [shiftLock, setShiftLock] = useState(false);
  const [scoopHud, setScoopHud] = useState({ name: '🥄 Trowel', bag: 0, cap: 6, total: 0, clean: 100 });
  const [nearCar, setNearCar] = useState(false);
  const [driveHint, setDriveHint] = useState(false);    // brief "how to drive" hint
  const [driveScore, setDriveScore] = useState({ got: 0, total: 0, best: 0, bestStr: '', combo: 0 });
  const [carPicker, setCarPicker] = useState(false);    // car select menu open
  const [cars, setCars] = useState([]);
  const [navOpen, setNavOpen] = useState(false);        // address picker open
  const [navAddr, setNavAddr] = useState('');           // custom address input
  const [navErr, setNavErr] = useState('');
  const [dest, setDest] = useState(null);               // { label }
  const [autoDrive, setAutoDrive] = useState(false);
  const [camName, setCamName] = useState('Cruise');     // current drive camera label (on the 🎥 button)
  const [poi, setPoi] = useState({ found: 0, total: 5 });  // neighbourhood places visited (persisted)
  const [arrived, setArrived] = useState(null);         // finish-line "ARRIVED" card
  const [music, setMusic] = useState(true);             // soundtrack on/off (🔊 toggle)
  const [drifting, setDrifting] = useState(false);      // sustained-drift glow + DRIFT chip
  const [moreOpen, setMoreOpen] = useState(false);      // PIT WALL ⋯ secondary-actions tray
  const arrivedTimer = useRef(0);
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
        case 'dest': setDest(p); if (!p) setAutoDrive(false); break;
        case 'driveScore': setDriveScore(p); break;
        case 'autodrive': setAutoDrive(p); break;
        case 'driveCam': setCamName(p); break;
        case 'poiProgress': setPoi(p); break;
        case 'cars': setCars(p); break;
        case 'music': setMusic(p); break;
        case 'drift': setDrifting(p); break;
        case 'arrived':
          setArrived(p); clearTimeout(arrivedTimer.current);
          arrivedTimer.current = setTimeout(() => setArrived(null), 3600);
          break;
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
      clearTimeout(arrivedTimer.current);
    };
  }, []);

  useEffect(() => {
    if (mode !== 'drive') return;
    setDriveHint(true);
    const t = setTimeout(() => setDriveHint(false), 7000);
    return () => clearTimeout(t);
  }, [mode]);

  const eng = () => engineRef.current;

  // Quick destinations (live-geocoded for accuracy; hardcoded fallback so they
  // always work even if the Geocoding API isn't enabled on the key).
  const PRESETS = [
    { label: "Meemaw's", q: '4311 Circle Drive, Castro Valley, CA', ll: [37.7205, -122.0775] },
    { label: 'Canyon Middle', q: 'Canyon Middle School, Castro Valley, CA', ll: [37.7054126, -122.0518696] },
    { label: 'Stanton Elem', q: 'Stanton Elementary School, Castro Valley, CA', ll: [37.6905, -122.079] },
    { label: "Dad's work", q: '807 Broadway, Oakland, CA', ll: [37.8004778, -122.2739559] },
  ];
  const goTo = async (q, label, fallback) => {
    const key = import.meta.env.VITE_GOOGLE_MAPS_KEY;
    if (key) {
      try {
        const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${key}`);
        const j = await r.json();
        const loc = j.results && j.results[0] && j.results[0].geometry && j.results[0].geometry.location;
        if (loc) { eng().setDestination(loc.lat, loc.lng, label || q); setNavOpen(false); return; }
      } catch (e) { /* fall back below */ }
    }
    if (fallback) { eng().setDestination(fallback[0], fallback[1], label || q); setNavOpen(false); }
    else setNavErr('Couldn’t find that address');
  };

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
      <div id="fx" ref={el => (uiRefs.current.fx = el)} />
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
            {poi.found > 0 && <p className="poiBadge">🏆 {poi.found}/{poi.total} neighborhood places found{poi.found < poi.total ? ' — drive to the rest!' : ' — all done! 🎉'}</p>}
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
            {/* ── PIT WALL: one telemetry blade across the top. Replaces the minimap /
                dock / bottom speed module / coin panels; the whole middle + both bottom
                thumb-zones stay clear so the car is never covered. ── */}
            <div id="pitwall" className="panel">
              {/* top strip: exit · destination headline (or free-roam) · actions */}
              <div className="pwTop">
                <button className="pwExit" aria-label="Exit drive" onClick={() => eng().exitDrive()}>✕</button>
                {dest ? (
                  <div className="pwDest">
                    <i className="kick">NEXT STOP</i>
                    <b>{dest.label}</b>
                    <i className="lead" />
                    <i className="eta" ref={el => (uiRefs.current.eta = el)} />
                    <button className={'mini' + (autoDrive ? ' on' : '')} aria-label="Auto-drive" onClick={() => eng().toggleAutoDrive()}>{autoDrive ? '🤖' : 'Go'}</button>
                    <button className="mini" aria-label="Clear destination" onClick={() => eng().clearDestination()}>✕</button>
                  </div>
                ) : (
                  <div className="pwDest free"><i className="kick">FREE ROAM</i><span>tap the map to drive there</span></div>
                )}
                <div className="pwActions">
                  <button className="dockBtn" aria-label="Navigate to address" onClick={() => { setNavErr(''); setNavOpen(o => !o); }}>🧭</button>
                  <button className="dockBtn cam" aria-label={'Camera: ' + camName} onClick={() => eng().cycleCamera()}>🎥<i>{camName}</i></button>
                  <button className={'dockBtn' + (moreOpen ? ' on' : '')} aria-label="More controls" onClick={() => setMoreOpen(o => !o)}>⋯</button>
                </div>
              </div>
              {/* main row: speed tower · telemetry · minimap tile */}
              <div className="pwMain">
                <div className="pwSpeed">
                  <i id="revInd" ref={el => (uiRefs.current.rev = el)}>R</i>
                  <b ref={el => (uiRefs.current.mph = el)}>0</b><span>MPH</span>
                </div>
                <div className="pwTel">
                  {driveScore.total > 0 && (
                    <div className="pwScore">
                      <span className="coin">💛{driveScore.got}/{driveScore.total}</span>
                      <span className="places">🏆{poi.found}/{poi.total}</span>
                      {driveScore.combo > 1 && <span className={'combo' + (driveScore.combo >= 5 ? ' fire' : '')}>🔥×{driveScore.combo}</span>}
                      {driveScore.trip > 0 && <span className="trip">🏁{driveScore.trip}</span>}
                    </div>
                  )}
                  <div className="pwRow">
                    <span className="clock">⏱<i ref={el => (uiRefs.current.runTime = el)}>0:00</i></span>
                    <div id="nitroTrack"><i id="nitroFill" ref={el => (uiRefs.current.boostBar = el)} /><span>NITRO</span></div>
                  </div>
                </div>
                <canvas id="minimap" width={132} height={132} title="Tap to drive here"
                  ref={el => (uiRefs.current.minimap = el)}
                  onClick={e => { const r = e.target.getBoundingClientRect(); eng().tapMinimap(e.clientX - r.left, e.clientY - r.top, r.width, r.height); }} />
              </div>
              {/* the blade's bottom edge IS the speedometer */}
              <div id="speedRail"><div id="speedFill" ref={el => (uiRefs.current.speedBar = el)} /></div>
              {/* ⋯ tray: secondary actions hinged under the blade */}
              {moreOpen && (
                <div className="pwTray">
                  <button className="dockBtn" aria-label="Choose vehicle" onClick={() => { setCars(eng().getCars()); setCarPicker(true); setMoreOpen(false); }}>🚗</button>
                  <button className="dockBtn" aria-label="Trace a path to drive" onClick={() => { eng().traceDrive(); setMoreOpen(false); }}>🪄</button>
                  <button className="dockBtn" aria-label="Back to road" onClick={() => { eng().resetToRoad(); setMoreOpen(false); }}>🛣️</button>
                  <button className={'dockBtn' + (music ? ' on' : '')} aria-label={music ? 'Music on' : 'Music off'} onClick={() => eng().toggleMusic()}>{music ? '🔊' : '🔇'}</button>
                </div>
              )}
            </div>
            {/* gas + brake pedals (bottom-right, right thumb). Decoupled from steering:
                the left stick only turns, these drive. Just steering still auto-creeps. */}
            <div id="pedals">
              {/* analog GO: press = ~65%, slide your thumb down the pedal toward 100% (floor it).
                  pointer capture keeps the press alive through a thumb-roll mid-corner. */}
              <button id="gasBtn" className="panel holdBtn pedal gas" aria-label="Gas (hold to accelerate, slide down to floor it)"
                onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); const r = e.currentTarget.getBoundingClientRect(); const v = Math.max(0.6, Math.min(1, 0.55 + (e.clientY - r.top) / r.height * 0.5)); e.currentTarget.style.setProperty('--fill', (v * 100) + '%'); eng().setGasAmount(v); }}
                onPointerMove={e => { if (e.buttons) { const r = e.currentTarget.getBoundingClientRect(); const v = Math.max(0.55, Math.min(1, 0.55 + (e.clientY - r.top) / r.height * 0.5)); e.currentTarget.style.setProperty('--fill', (v * 100) + '%'); eng().setGasAmount(v); } }}
                onPointerUp={e => { e.currentTarget.style.setProperty('--fill', '0%'); eng().setGasAmount(0); }} onPointerCancel={e => { e.currentTarget.style.setProperty('--fill', '0%'); eng().setGasAmount(0); }}><i className="gasFill" /><span>GO</span></button>
              <button id="brakeBtn" className="panel holdBtn pedal brake" aria-label="Brake (hold to slow / reverse)"
                onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); eng().setBrake(true); }} onPointerUp={() => eng().setBrake(false)}
                onPointerCancel={() => eng().setBrake(false)}><span ref={el => (uiRefs.current.brakeLbl = el)}>STOP</span></button>
            </div>
            {/* faint resting steer hint (bottom-left, first few seconds only) — pointer-events:none
                so the real joystick still spawns under the thumb; tells first-timers where to steer */}
            {driveHint && <div id="steerGhost" aria-hidden="true"><span>↺</span><i>steer</i></div>}
            {/* handbrake (hold to drift) + horn, bottom-left */}
            <button id="hbrakeBtn" className={'panel holdBtn' + (drifting ? ' drifting' : '')} aria-label="Handbrake (hold to drift)"
              onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); eng().setHandbrake(true); }} onPointerUp={() => eng().setHandbrake(false)}
              onPointerCancel={() => eng().setHandbrake(false)}>✋</button>
            <button id="hornBtn" className="panel holdBtn" aria-label="Horn" onClick={() => eng().horn()}>📣</button>
            {drifting && <div id="driftChip">💨 DRIFT!</div>}
            {driveHint && <div id="driveHint" className="panel">stick = steer · GO = gas (slide ↓ to floor it) · STOP = brake · ✋ drift · tap map to drive · 💛 coins</div>}
            {navOpen && (
              <div id="navPanel" className="startCard">
                <h3>Drive to…</h3>
                <div className="navPresets">
                  {PRESETS.map(p => (
                    <button key={p.label} className="btn" onClick={() => goTo(p.q, p.label, p.ll)}>{p.label}</button>
                  ))}
                </div>
                <form onSubmit={e => { e.preventDefault(); if (navAddr.trim()) goTo(navAddr.trim(), navAddr.trim(), null); }}>
                  <input value={navAddr} onChange={e => { setNavErr(''); setNavAddr(e.target.value); }} placeholder="Type any address…" />
                  <button type="submit" className="btn primary">Go</button>
                </form>
                {navErr && <p className="navErr">{navErr}</p>}
                <button className="btn navClose" onClick={() => setNavOpen(false)}>Close</button>
              </div>
            )}
            {carPicker && (
              <div id="carPicker" className="startCard">
                <h3>Choose your ride</h3>
                <div className="carList">
                  {cars.map(c => (
                    <button key={c.slot} className={'carRow' + (c.current ? ' current' : '') + (c.locked ? ' locked' : '')} disabled={!c.loaded || c.locked}
                      onClick={() => { eng().pickCar(c.slot); setCars(eng().getCars()); if (!c.locked) setCarPicker(false); }}>
                      <span className="carName">{c.locked ? '🔒 ' : ''}{c.name}{c.current ? ' ✓' : ''}</span>
                      <span className="carSpec">{c.spec}</span>
                      <span className="carCredit">{c.locked ? 'find all 5 places to unlock' : (c.loaded ? c.credit : 'loading…')}</span>
                    </button>
                  ))}
                </div>
                <button className="btn navClose" onClick={() => setCarPicker(false)}>Close</button>
              </div>
            )}
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
        {arrived && (
          <div id="arrivedCard">
            <div className="arrivedFlag">🏁</div>
            <h2>You made it to {arrived.label}!</h2>
            {arrived.points > 0 && <p className="arrivedPts">+{arrived.points} points</p>}
            <p className="arrivedTrip">🏁 Trip score {arrived.trip}</p>
          </div>
        )}
        {mode === 'scoop' && (
          <div id="shud">
            <div id="toolChip" className="chip">{scoopHud.name} <span>{scoopHud.bag}/{scoopHud.cap}</span></div>
            <div id="pooHud" className="chip">💩 {scoopHud.total} scooped · yard {scoopHud.clean}% ✨</div>
            <button id="exitScoop" className="btn" onClick={() => eng().exitScoop()}>Exit ✕</button>
            <button id="shiftLock" className={'btn icon' + (shiftLock ? ' on' : '')} aria-pressed={shiftLock} onClick={() => eng().toggleShiftLock()}>{shiftLock ? '🔒' : '🔓'}</button>
            <button id="scoopCam" className="btn icon" aria-label="Camera view" onClick={() => eng().cycleScoopCamera()}>🎥</button>
            <button id="danceBtn" className="btn icon" aria-label="Dance" onClick={() => eng().dance()}>🕺</button>
            <button id="jumpBtn" className="btn primary icon" aria-label="Jump" onClick={() => eng().jump()}>🦘</button>
            {nearCar && <button id="getInCar" className="btn primary" onClick={() => eng().driveFromScoop()}>Get in &amp; drive 🚗</button>}
            <div id="lookHint" className="chip">left to move · drag to look · 🦘 jump · 🕺 dance · 🔒 shift-lock</div>
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
