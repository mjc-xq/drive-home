import { useEffect, useRef, useState } from 'react';
import { createEngine } from './engine/engine.js';

// Reusable address box with live Google Places autocomplete. `suggest(text)` returns
// [{description, placeId}]; picking one calls onPick(item); typing + submit calls onText.
function AddressSearch({ placeholder, actionLabel, suggest, onPick, onText }) {
  const [val, setVal] = useState('');
  const [sugs, setSugs] = useState([]);
  const [busy, setBusy] = useState(false);
  const tRef = useRef(0);
  const onChange = (v) => {
    setVal(v);
    clearTimeout(tRef.current);
    if (v.trim().length < 3) { setSugs([]); return; }
    tRef.current = setTimeout(() => { suggest(v).then(s => setSugs(s || [])).catch(() => setSugs([])); }, 220);
  };
  const choose = (item) => { setBusy(true); setSugs([]); setVal(item.description); Promise.resolve(onPick(item)).finally(() => setBusy(false)); };
  const submit = (e) => { e.preventDefault(); if (!val.trim()) return; setBusy(true); setSugs([]); Promise.resolve(onText(val.trim())).finally(() => setBusy(false)); };
  return (
    <form className="addrBox" onSubmit={submit} autoComplete="off">
      <div className="addrRow">
        <input value={val} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck="false" />
        <button type="submit" className="addrGo" disabled={busy}>{busy ? '…' : actionLabel}</button>
      </div>
      {sugs.length > 0 && (
        <ul className="addrSug">
          {sugs.map(s => <li key={s.placeId}><button type="button" onClick={() => choose(s)}><span className="pin">📍</span>{s.description}</button></li>)}
        </ul>
      )}
    </form>
  );
}

// React owns the HUD chrome only; the engine owns the canvas, input and the
// game loop. Low-frequency state flows engine -> here via emit; per-frame
// values (mph, compass, joystick knob) are written by the engine straight
// into the DOM nodes registered in uiRefs.
export default function App() {
  const canvasRef = useRef(null);
  const uiRefs = useRef({ box: null, mph: null, gear: null, needle: null, joy: null, knob: null, minimap: null, speedBar: null, fx: null, runTime: null, rev: null, eta: null, brakeLbl: null, boostBar: null });
  const engineRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [photoreal, setPhotoreal] = useState(false);   // real Google tiles are up (vs the procedural placeholder)
  const [revealTimedOut, setRevealTimedOut] = useState(false);   // fallback so the loader never hangs if tiles fail
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
  const [menuOpen, setMenuOpen] = useState(false);      // top-right ☰ menu expanded
  const [navErr, setNavErr] = useState('');
  const [autoMax, setAutoMax] = useState(() => { try { return parseInt(localStorage.getItem('dahill.automax') || '0', 10) || 0; } catch (e) { return 0; } });   // auto-drive top-speed cap (mph; 0 = unlimited)
  const [dest, setDest] = useState(null);               // { label }
  const [autoDrive, setAutoDrive] = useState(false);
  const [camName, setCamName] = useState('Cruise');     // current drive camera label (on the 🎥 button)
  const [poi, setPoi] = useState({ found: 0, total: 5 });  // neighbourhood places visited (persisted)
  const [arrived, setArrived] = useState(null);         // finish-line "ARRIVED" card
  const [music, setMusic] = useState(true);             // soundtrack on/off (🔊 toggle)
  const [autoSteer, setAutoSteer] = useState(true);     // lane-keep assist (🛟 toggle)
  const [drifting, setDrifting] = useState(false);      // sustained-drift glow + DRIFT chip
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
        case 'photoreal': setPhotoreal(true); break;
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
        case 'autosteer': setAutoSteer(p); break;
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

  // Hold the loading veil until the real Google tiles are up, so the procedural placeholder
  // world doesn't flash in first. A 5.5 s fallback ensures the loader never hangs (e.g. no key).
  useEffect(() => { if (!ready) return; const t = setTimeout(() => setRevealTimedOut(true), 5500); return () => clearTimeout(t); }, [ready]);

  const eng = () => engineRef.current;
  // NOTE: camera LOOK has no dedicated on-screen stick anymore. Following Roblox's
  // touch convention, the whole RIGHT HALF of the screen is camera dead-space — the
  // engine's canvas pointer handler turns any single-finger drag there into a
  // rotate/tilt (and two fingers into a pinch-zoom). The HUD only paints a passive,
  // non-interactive hint there; it never intercepts the drag.
  // Warm the Google Maps SDK the moment the nav panel opens, so the first keystroke in the
  // address box doesn't jank (the SDK script parse used to land on ~the 3rd character typed).
  useEffect(() => { if (navOpen && eng() && eng().preloadMaps) eng().preloadMaps(); }, [navOpen]);

  // Quick destinations (live-geocoded for accuracy; hardcoded fallback so they
  // always work even if the Geocoding API isn't enabled on the key).
  const PRESETS = [
    { label: "Meemaw's", q: '4311 Circle Ave, Castro Valley, CA', ll: [37.6995618, -122.0639216] },
    { label: 'Canyon Middle', q: 'Canyon Middle School, Castro Valley, CA', ll: [37.7046462, -122.0524363] },
    { label: 'Stanton Elem', q: 'Stanton Elementary School, Castro Valley, CA', ll: [37.7005734, -122.0940411] },
    { label: "Dad's work", q: '807 Broadway, Oakland, CA', ll: [37.8004778, -122.2739559] },
  ];
  const traceDrive = camName === 'Top-down' || camName === 'Aerial';
  const driveHelp = traceDrive
    ? 'Drag the road to drive · right stick to orbit the camera · tap the map to route'
    : 'Left stick to move · pull back to reverse · right stick to look · tap the map to route';

  return (
    <>
      <div id="loading" className={(ready && (photoreal || revealTimedOut)) ? 'done' : ''}>
        <div className="loadInner">
          <div className="loadKick">1840 Dahill Lane</div>
          <div className="loadTitle">Neighborhood<br />Drive</div>
          <div className="loadBar"><i /></div>
          <div className="loadSub">Building the neighborhood…</div>
        </div>
      </div>
      <canvas
        id="scene" ref={canvasRef} tabIndex={0}
        aria-label="Interactive 3D model of 1840 Dahill Lane with drivable neighborhood"
      />
      <div id="fx" ref={el => (uiRefs.current.fx = el)} />
      {ready && picking && (
        <div id="startMenu">
          <div className="menuSheet startSheet">
            <div className="menuHead">
              <div>
                <div className="menuKick">Welcome back</div>
                <h1 className="menuTitle">1840 Dahill<br />Lane</h1>
              </div>
              {poi.found > 0 && (
                <div className="placesBadge">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--go)" strokeWidth="2.2" strokeLinecap="round"><path d="M12 21s-7-5.2-7-11a7 7 0 0 1 14 0c0 5.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.2" /></svg>
                  <span className="pbNum">{poi.found}<i>/{poi.total}</i></span><span className="pbLbl">places found</span>
                </div>
              )}
            </div>
            <div className="modeCards">
              <button className="modeCard" onClick={() => setPicking(false)}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
                <span className="mcTitle">Explore</span><span className="mcSub">Free look around</span>
              </button>
              <button className="modeCard drive" onClick={() => { setPicking(false); eng().enterDrive(); }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--go)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 11l1-5h12l1 5" /><rect x="3" y="11" width="18" height="6" /><circle cx="7.5" cy="17.5" r="1.4" /><circle cx="16.5" cy="17.5" r="1.4" /></svg>
                <span className="mcTitle">Drive</span><span className="mcSub">Arcade controls</span>
              </button>
              <button className="modeCard" onClick={() => { setPicking(false); eng().enterScoop(); }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12a7 7 0 0 1 14 0v5H5z" /><path d="M9 17v3M15 17v3" /></svg>
                <span className="mcTitle">Scoop</span><span className="mcSub">Collect &amp; deliver</span>
              </button>
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
        {mode !== 'drive' && (
          <div id="compass" className="chip" aria-hidden="true">
            <svg viewBox="0 0 40 40" ref={el => (uiRefs.current.needle = el)}>
              <text x="20" y="6.2" fontSize="6.5" fontWeight="700" textAnchor="middle" fill="var(--nav)" fontFamily="'Chakra Petch'">N</text>
              <polygon points="20,8.5 24,21 20,17.6 16,21" fill="var(--nav)" />
              <polygon points="20,32 24,19 20,22.4 16,19" fill="#fff" opacity=".4" />
              <circle cx="20" cy="20" r="2" fill="#fff" />
            </svg>
          </div>
        )}
        {mode === 'drive' && (
          <div id="hud" className="driveHud">

            {/* ══ TOP-LEFT: score strip (scored run only) above the framed minimap ══ */}
            <div className="dvLeft">
              {driveScore.total > 0 && (
                <div className={'scoreStrip' + (driveScore.combo >= 5 ? ' onFire' : '')}>
                  <div className="ssCell"><span className="coinDot" /><span className="ssNum">{driveScore.got}<i>/{driveScore.total}</i></span></div>
                  {driveScore.combo > 1 && (
                    <><div className="ssDiv" />
                    <div className={'ssCell combo' + (driveScore.combo >= 5 ? ' fire' : '')}>
                      {driveScore.combo >= 5 && (
                        <svg className="fireIc" width="13" height="13" viewBox="0 0 24 24" fill="#fff"><path d="M12 2c1 3-2 4-2 7a4 4 0 0 0 8 0c0-1-1-2-1-2 2 2 3 4 3 7a8 8 0 0 1-16 0c0-5 5-7 6-12z" /></svg>
                      )}
                      <span className="comboNum">×{driveScore.combo}</span>
                    </div></>
                  )}
                  {driveScore.trip > 0 && (
                    <><div className="ssDiv" />
                    <div className="ssCell trip"><span className="ssKick">TRIP</span><span className="tripNum">{driveScore.trip.toLocaleString()}</span></div></>
                  )}
                </div>
              )}
              <div className="miniFrame">
                <canvas id="minimap" width={174} height={150} title="Tap to drive here"
                  ref={el => (uiRefs.current.minimap = el)}
                  onClick={e => { const r = e.target.getBoundingClientRect(); eng().tapMinimap(e.clientX - r.left, e.clientY - r.top, r.width, r.height); }} />
                {/* live Google minimap — covers the canvas fallback once the SDK loads */}
                <div id="gmap" ref={el => { if (el && eng() && eng().initMiniMap) eng().initMiniMap(el); }} />
                <span className="miniTag">MAP</span>
              </div>
              <div className="miniHint">Tap map to drive</div>
            </div>

            {/* ══ TOP-CENTER: search bar (free-roam) → nav card (route active) ══ */}
            {dest ? (
              <div className="navCard">
                <div className="ncTurn">
                  <div className="ncArrow">
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2D8CFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 20V10a4 4 0 0 1 4-4h5" /><path d="m15 3 4 3-4 3" /></svg>
                  </div>
                  <div className="ncDest"><b>{dest.label}</b><span>Head to destination</span></div>
                </div>
                <div className="ncDiv" />
                <div className="ncEta">
                  <div className="ncMin"><span className="ncEtaVal" ref={el => (uiRefs.current.eta = el)}>—</span></div>
                  <button className={'ncAuto' + (autoDrive ? ' on' : '')} aria-label="Auto-drive" onClick={() => eng().toggleAutoDrive()}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="9" width="12" height="9" /><path d="M9 9V6a3 3 0 0 1 6 0v3" /><circle cx="9.5" cy="13.5" r=".8" /><circle cx="14.5" cy="13.5" r=".8" /></svg>
                    <span>AUTO</span>
                  </button>
                  <button className="ncClear" aria-label="Clear destination" onClick={() => eng().clearDestination()}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                </div>
              </div>
            ) : (
              <button className="searchBar" onClick={() => { setNavErr(''); setNavOpen(true); setMenuOpen(false); }}>
                <span className="sbIcon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg></span>
                <span className="sbText">Where to? Search or tap the map</span>
                <span className="sbGo">GO</span>
              </button>
            )}

            {/* ══ TOP-RIGHT: segmented VIEW / FIX-ROAD / ☰ menu ══ */}
            <div className="dvTopRight">
              <div className="segBar">
                <button className="segBtn" aria-label={'Camera: ' + camName} onClick={() => eng().cycleCamera()}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2D8CFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="14" height="10" rx="2" /><path d="m16 10 6-3v10l-6-3z" /></svg>
                  <span className="segLab"><i>VIEW</i><b>{camName}</b></span>
                </button>
                <div className="segDiv" />
                <button className="segBtn" aria-label="Back to road" onClick={() => eng().resetToRoad()}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" /><path d="M12 1v3M12 20v3M1 12h3M20 12h3" /></svg>
                  <span className="segLab"><i>FIX</i><b>ROAD</b></span>
                </button>
                <div className="segDiv" />
                <button className={'segBtn segMenu' + (menuOpen ? ' open' : '')} aria-label="Menu" onClick={() => setMenuOpen(o => !o)}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
                </button>
              </div>
              {menuOpen && (
                <div className="segMenuPanel">
                  <button className="menuItem accent" onClick={() => { setNavErr(''); setNavOpen(true); setMenuOpen(false); }}>
                    <span className="miIcon go"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s-7-5.2-7-11a7 7 0 0 1 14 0c0 5.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.2" /></svg></span>
                    <span className="miTxt"><b>Go to…</b><i className="go">Search · jump</i></span>
                  </button>
                  <button className="menuItem" onClick={() => { eng().toggleAutoSteer(); }}>
                    <span className="miIcon go"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l2 5 4-12 2 7h6" /></svg></span>
                    <span className="miTxt"><b>Assist</b><i className={autoSteer ? 'go' : 'off'}>{autoSteer ? 'On' : 'Off'}</i></span>
                  </button>
                  <button className="menuItem" onClick={() => { eng().toggleMusic(); }}>
                    <span className="miIcon nav"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.6" /><circle cx="16" cy="16" r="2.6" /></svg></span>
                    <span className="miTxt"><b>Music</b><i className={music ? 'nav' : 'off'}>{music ? 'On' : 'Muted'}</i></span>
                  </button>
                  <button className={'menuItem' + (traceDrive ? ' on' : '')} onClick={() => { eng().traceDrive(); }}>
                    <span className="miIcon jump"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 19l14-9M5 19l3-6 6-3" /></svg></span>
                    <span className="miTxt"><b>Trace</b><i className={traceDrive ? 'jump' : 'off'}>{traceDrive ? 'On' : 'Off'}</i></span>
                  </button>
                  <button className="menuItem" onClick={() => { setCars(eng().getCars()); setCarPicker(true); setMenuOpen(false); }}>
                    <span className="miIcon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 11l1-5h12l1 5" /><rect x="3" y="11" width="18" height="6" /></svg></span>
                    <span className="miTxt"><b>Cars</b><i className="off">Garage</i></span>
                  </button>
                  <button className="menuItem" onClick={() => { eng().exitDrive(); }}>
                    <span className="miIcon reverse"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg></span>
                    <span className="miTxt"><b>Exit drive</b><i className="off">Back to explore</i></span>
                  </button>
                </div>
              )}
            </div>

            {/* ══ BOTTOM-CENTER: the DASH cluster (speed · gear · compass · time) ══ */}
            <div className={'dashCluster' + (drifting ? ' drift' : '')}>
              <div className="dashSpeed">
                <i className="dashRev" ref={el => (uiRefs.current.rev = el)}>R</i>
                <b ref={el => (uiRefs.current.mph = el)}>0</b>
                <div className="dashSpeedMeta">
                  <span className="dashKick">MPH</span>
                  <div className="dashBar"><i ref={el => (uiRefs.current.speedBar = el)} /></div>
                </div>
              </div>
              <div className="dashDiv" />
              <div className="dashCol">
                <span className="dashKick">GEAR</span>
                <b className="dashGear" data-gear="P" ref={el => (uiRefs.current.gear = el)}>P</b>
              </div>
              <div className="dashDiv" />
              <div className="dashCompass">
                <svg viewBox="0 0 40 40" ref={el => (uiRefs.current.needle = el)}>
                  <text x="20" y="6.2" fontSize="6.5" fontWeight="700" textAnchor="middle" fill="var(--nav)" fontFamily="'Chakra Petch'">N</text>
                  <polygon points="20,8.5 24,21 20,17.6 16,21" fill="var(--nav)" />
                  <polygon points="20,32 24,19 20,22.4 16,19" fill="#fff" opacity=".4" />
                  <circle cx="20" cy="20" r="2" fill="#fff" />
                </svg>
              </div>
              <div className="dashDiv" />
              <div className="dashCol">
                <span className="dashKick">TIME</span>
                <b className="dashTime" ref={el => (uiRefs.current.runTime = el)}>0:00</b>
              </div>
            </div>

            {/* Roblox-style touch hints — PASSIVE only (pointer-events:none). The real
                input is the engine's canvas handler: left half spawns the dynamic
                thumbstick under your thumb, right half is drag-to-look. Hints fade
                away on their own once you've taken control. Hidden in the overhead
                drag-to-drive cams, which use a different (tap/drag-the-map) scheme. */}
            {!traceDrive && (<>
            {/* ── BOTTOM-LEFT: where the dynamic move thumbstick spawns ── */}
            <div className={'moveHint' + (driveHint ? ' pulse' : '')} aria-hidden="true">
              <div className="stickRing" />
              <div className="stickArrow up"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4l6 8H6z" /></svg></div>
              <div className="stickArrow down"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 20l6-8H6z" /></svg></div>
              <div className="stickKnob" />
              <div className="stickLabel move">DRAG TO DRIVE</div>
            </div>
            {/* ── BOTTOM-RIGHT: dead-space camera zone (swipe to look) ── */}
            <div className="lookHint" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="2.4" /></svg>
              <div className="stickLabel">SWIPE TO LOOK</div>
            </div>
            </>)}
            {traceDrive && <div className="dragDriveHint">✦ Drag the map to drive · tap a spot to route there</div>}
            <button className="hornBtn" aria-label="Horn" onClick={() => eng().horn()}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M16 9a5 5 0 0 1 0 6" /></svg>
            </button>

            {drifting && <div id="driftChip">💨 DRIFT!</div>}
            {driveHint && <div className="driveHintCard">{driveHelp}</div>}

            {/* ── Navigate panel: Drive-to (green) vs Jump-to (violet) ── */}
            {navOpen && (
              <div id="navPanel">
                <div className="navHead"><h3>Navigate</h3><button className="navX" aria-label="Close" onClick={() => setNavOpen(false)}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button></div>

                <label className="navLbl drive"><span className="navDot go" /> Drive to <i>route &amp; chauffeur there</i></label>
                <div className="navTool drive">
                  <AddressSearch placeholder="Search an address or place" actionLabel="Go"
                    suggest={t => eng().placeSuggest(t)}
                    onPick={s => eng().driveToPlace(s.placeId, s.description).then(() => setNavOpen(false)).catch(() => setNavErr("Couldn't find that place"))}
                    onText={t => eng().driveToText(t).then(() => setNavOpen(false)).catch(() => setNavErr("Couldn't find that address"))} />
                  <div className="navPresets">
                    {PRESETS.map(p => (
                      <button key={p.label} className="navChip" onClick={() => { setNavErr(''); eng().driveToText(p.q).then(() => setNavOpen(false)).catch(() => { eng().setDestination(p.ll[0], p.ll[1], p.label); setNavOpen(false); }); }}>{p.label}</button>
                    ))}
                  </div>
                </div>

                <label className="navLbl jump"><span className="navDot jump" /> Jump to <i>teleport &amp; start over</i></label>
                <div className="navTool jump">
                  <AddressSearch placeholder="Teleport to an address…" actionLabel="Jump"
                    suggest={t => eng().placeSuggest(t)}
                    onPick={s => eng().jumpToPlace(s.placeId, s.description).then(() => setNavOpen(false)).catch(() => setNavErr("Couldn't find that place"))}
                    onText={t => eng().jumpToText(t).then(() => setNavOpen(false)).catch(() => setNavErr("Couldn't find that address"))} />
                </div>

                <div className="navSlider">
                  <label>Auto-drive top speed <b>{autoMax ? autoMax + ' mph' : 'unlimited'}</b></label>
                  <input type="range" min="0" max="700" step="25" value={autoMax}
                    onChange={e => { const v = +e.target.value; setAutoMax(v); eng().setAutoMaxMph(v); }} />
                  <div className="sliderEnds"><span>slow</span><span>700</span></div>
                </div>

                {navErr && <p className="navErr">{navErr}</p>}
              </div>
            )}
            {carPicker && (
              <div id="carPicker" className="menuSheet">
                <div className="menuHead"><h3 className="cpTitle">Choose your ride</h3><button className="navX" aria-label="Close" onClick={() => setCarPicker(false)}>✕</button></div>
                <div className="carList">
                  {cars.map(c => (
                    <button key={c.slot} className={'carRow' + (c.current ? ' current' : '') + (c.locked ? ' locked' : '')} disabled={!c.loaded || c.locked}
                      onClick={() => { eng().pickCar(c.slot); setCars(eng().getCars()); if (!c.locked) setCarPicker(false); }}>
                      <span className="carThumb"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 11l1-5h12l1 5" /><rect x="3" y="11" width="18" height="6" /><circle cx="7.5" cy="17.5" r="1.4" /><circle cx="16.5" cy="17.5" r="1.4" /></svg></span>
                      <span className="carInfo"><span className="carName">{c.name}</span><span className="carSpec">{c.locked ? 'Find all 5 places to unlock' : (c.loaded ? c.credit : 'loading…')}</span></span>
                      <span className="carTag">{c.locked ? '🔒' : c.current ? '✓ ON' : c.spec}</span>
                    </button>
                  ))}
                </div>
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
