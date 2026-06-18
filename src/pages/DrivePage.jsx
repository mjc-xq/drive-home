// DrivePage — the full Drive HUD, extracted from the pre-split App.jsx.
// The engine is shared via EngineProvider; this page owns only its own state
// and renders everything that was inside the (mode === 'drive') block plus the
// drive-related siblings (#fx, #carCard, #arrivedCard, joystick, MobileControls).

import { useEffect, useRef, useState } from 'react';
import { useEngine, useEngineEvent } from '../lib/engine-context.jsx';
import { useOrientation, useOutsideDismiss, usePersistentNumber } from '../lib/hooks.js';
import AddressSearch from '../ui/AddressSearch.jsx';
import MobileControls from '../ui/MobileControls.jsx';
import Toast from '../ui/Toast.jsx';
import Credits from '../ui/Credits.jsx';

export default function DrivePage() {
  const { engine, uiRefs } = useEngine();
  // Convenience alias — callers use eng().foo() verbatim from the original.
  const eng = () => engine;

  const dvTopRightRef = useRef(null);
  const arrivedTimer = useRef(0);
  const cardTimer = useRef(0);

  // ── local state ──
  const [driveHint, setDriveHint]   = useState(false);
  const [carPicker, setCarPicker]   = useState(false);
  const [navOpen, setNavOpen]       = useState(false);
  const [menuOpen, setMenuOpen]     = useState(false);
  const [navErr, setNavErr]         = useState('');
  const [selDest, setSelDest]       = useState(null);
  const [cars, setCars]             = useState([]);
  const [dest, setDest]             = useState(null);
  const [autoDrive, setAutoDrive]   = useState(false);
  const [following, setFollowing]   = useState(false);
  const [traceMode, setTraceMode]   = useState(false);
  const [driveScore, setDriveScore] = useState({ got: 0, total: 0, best: 0, bestStr: '', combo: 0 });
  const [camName, setCamName]       = useState('Cruise');
  const [driveZoom, setDriveZoom]   = useState({ norm: 0.3, overhead: false });
  const [sound, setSound]           = useState(true);
  const [autoSteer, setAutoSteer]   = useState(true);
  const [roadLife, setRoadLife]     = useState(true);
  const [drifting, setDrifting]     = useState(false);
  const [arrived, setArrived]       = useState(null);
  const [carCard, setCarCard]       = useState({ name: '', spec: '', credit: '', show: false });
  const [subline, setSubline]       = useState('Hayward, CA');

  // ── persistent sliders (same keys + parse logic as original lines 90–93) ──
  const [autoMax, setAutoMax] = usePersistentNumber(
    'dahill.automax', 0,
    raw => { const v = parseInt(raw, 10); return v || 0; }
  );
  const [speedMul, setSpeedMul] = usePersistentNumber(
    'dahill.speedmul', 1,
    raw => { const v = parseFloat(raw); return v >= 0.3 && v <= 2 ? v : undefined; }
  );
  const [pedDensity, setPedDensity] = usePersistentNumber(
    'dahill.peddensity', 1,
    raw => { const v = parseFloat(raw); return v >= 0 && v <= 2 ? v : undefined; }
  );
  const [trafficDensity, setTrafficDensity] = usePersistentNumber(
    'dahill.trafficdensity', 1,
    raw => { const v = parseFloat(raw); return v >= 0 && v <= 2 ? v : undefined; }
  );

  // ── engine event subscriptions ──
  useEngineEvent('subline',    p => setSubline(p));
  useEngineEvent('follow',     p => setFollowing(p));
  useEngineEvent('traceMode',  p => setTraceMode(p));
  useEngineEvent('dest',       p => { setDest(p); if (!p) setAutoDrive(false); });
  useEngineEvent('driveScore', p => setDriveScore(p));
  useEngineEvent('autodrive',  p => setAutoDrive(p));
  useEngineEvent('driveCam',   p => setCamName(p));
  useEngineEvent('driveZoom',  p => setDriveZoom(p));
  useEngineEvent('cars',       p => setCars(p));
  useEngineEvent('sound',      p => setSound(p));
  useEngineEvent('autosteer',  p => setAutoSteer(p));
  useEngineEvent('roadlife',   p => setRoadLife(p));
  useEngineEvent('drift',      p => setDrifting(p));
  useEngineEvent('arrived',    p => {
    setArrived(p);
    clearTimeout(arrivedTimer.current);
    arrivedTimer.current = setTimeout(() => setArrived(null), 1800);
  });
  useEngineEvent('carCard', p => {
    setCarCard({ name: p.name, spec: p.spec, credit: p.credit || '', show: true });
    clearTimeout(cardTimer.current);
    cardTimer.current = setTimeout(() => setCarCard(c => ({ ...c, show: false })), 1900);
  });

  // ── drive hint: show briefly on mount, clear after 7000ms ──
  useEffect(() => {
    setDriveHint(true);
    const t = setTimeout(() => setDriveHint(false), 7000);
    return () => clearTimeout(t);
  }, []);

  // ── preload Maps SDK when nav panel opens ──
  useEffect(() => { if (navOpen && eng() && eng().preloadMaps) eng().preloadMaps(); }, [navOpen]);

  // ── outside-dismiss for the top-right ☰ menu ──
  useOutsideDismiss(menuOpen, dvTopRightRef, () => setMenuOpen(false));

  // ── resize-on-mount so the freshly-mounted #ui box is measured by the engine ──
  useEffect(() => { if (engine && engine.resize) engine.resize(); }, [engine]);

  // ── cleanup timers on unmount ──
  useEffect(() => () => { clearTimeout(arrivedTimer.current); clearTimeout(cardTimer.current); }, []);

  // ── orientation for MobileControls ──
  const orientation = useOrientation();

  // ── derived values (verbatim from original) ──
  const traceDrive = camName === 'Top-down' || camName === 'Aerial';
  const driveHelp = traceDrive
    ? 'Drag the road to drive · right stick to orbit the camera · tap the map to route'
    : 'Left stick moves · push up for gas · pull back to reverse · swipe right side to look';
  const carColor = slot => ['#48ff6a', '#62b6ff', '#ff3f2f', '#ffb23a', '#8df0ff', '#ff4747', '#f5f0dc', '#f4f7ff', '#9b7bff', '#ffd23a', '#5affc8', '#ff8a3a', '#c0ff5a', '#ff5ad0', '#a0a4ad'][slot] || '#ffffff';

  const PRESETS = [
    { label: 'Home', home: true },
    { label: "Meemaw's", q: '4311 Circle Ave, Castro Valley, CA', ll: [37.6995618, -122.0639216] },
    { label: 'Canyon Middle', q: 'Canyon Middle School, Castro Valley, CA', ll: [37.7046462, -122.0524363] },
    { label: 'Stanton Elem', q: 'Stanton Elementary School, Castro Valley, CA', ll: [37.7005734, -122.0940411] },
    { label: 'XQ', q: '807 Broadway, Oakland, CA', ll: [37.8004778, -122.2739559] },
  ];

  return (
    <>
      <div id="fx" ref={el => (uiRefs.current.fx = el)} />
      <div id="ui" ref={el => (uiRefs.current.box = el)} className={'drive' + (dest ? ' hasDest' : '') + (menuOpen ? ' menuOpen' : '')}>

        <div id="hud" className={'driveHud' + (traceDrive ? ' tracing' : '')}>

          {/* ══ TOP-LEFT: score strip above minimap ══ */}
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
            <button className="searchBar" onClick={() => { setNavErr(''); setSelDest(null); setNavOpen(true); setMenuOpen(false); }}>
              <span className="sbIcon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg></span>
              <span className="sbText">Where to? Search or tap the map</span>
              <span className="sbGo">GO</span>
            </button>
          )}
          {!dest && subline && <div className="locNow">📍 {subline}</div>}

          {/* ══ overhead/aerial ZOOM-OUT slider ══ */}
          {driveZoom.overhead && (
            <div className="zoomCtl">
              <span>＋</span>
              <input className="zoomSlider" type="range" min="0" max="1" step="0.01"
                value={1 - driveZoom.norm}
                onChange={e => eng().setDriveZoom(1 - +e.target.value)} aria-label="Zoom out" />
              <span>－</span>
            </div>
          )}

          {/* ══ TOP-RIGHT: segmented VIEW / FIX-ROAD / ☰ menu ══ */}
          <div className="dvTopRight" ref={dvTopRightRef}>
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
                <button className={'menuItem life' + (roadLife ? ' on' : '')} aria-pressed={roadLife} onClick={() => { eng().toggleRoadLife(); }}>
                  <span className="miIcon go"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 11l1-4h8l1 4" /><rect x="3" y="11" width="14" height="5" /><circle cx="6.5" cy="16.5" r="1.4" /><circle cx="13.5" cy="16.5" r="1.4" /><circle cx="19" cy="7" r="2" /><path d="M19 9v6M17 12h4" /></svg></span>
                  <span className="miTxt"><b>People + traffic</b><i className={roadLife ? 'go' : 'off'}>{roadLife ? 'On' : 'Off'}</i></span>
                </button>
                <button className="menuItem" onClick={() => { eng().toggleSound(); }}>
                  <span className="miIcon nav"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" />{sound ? <><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5.5a9 9 0 0 1 0 13" /></> : <path d="m22 9-6 6M16 9l6 6" />}</svg></span>
                  <span className="miTxt"><b>Sound</b><i className={sound ? 'nav' : 'off'}>{sound ? 'On' : 'Off'}</i></span>
                </button>
                <button className={'menuItem' + (traceMode ? ' on' : '')} onClick={() => { eng().setTraceMode(!traceMode); eng().traceDrive(); }}>
                  <span className="miIcon jump"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 19l14-9M5 19l3-6 6-3" /></svg></span>
                  <span className="miTxt"><b>Draw to drive</b><i className={traceMode ? 'jump' : 'off'}>{traceMode ? 'On' : 'Off'}</i></span>
                </button>
                <button className="menuItem" onClick={() => { setCars(eng().getCars()); setCarPicker(true); setMenuOpen(false); }}>
                  <span className="miIcon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 11l1-5h12l1 5" /><rect x="3" y="11" width="18" height="6" /></svg></span>
                  <span className="miTxt"><b>Cars</b><i className="off">Garage</i></span>
                </button>
                <button className="menuItem" onClick={() => { eng().exitDrive(); }}>
                  <span className="miIcon reverse"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg></span>
                  <span className="miTxt"><b>Exit drive</b><i className="off">Back to menu</i></span>
                </button>
                <div className="menuSlider">
                  <div className="navSlider">
                    <label>People <b>{Math.round(pedDensity * 100)}%</b></label>
                    <input type="range" min="0" max="2" step="0.25" value={pedDensity}
                      onChange={e => { const v = +e.target.value; setPedDensity(v); eng().setCrowdDensity?.(v); }} />
                    <div className="sliderEnds"><span>none</span><span>lots</span></div>
                  </div>
                  <div className="navSlider">
                    <label>Traffic <b>{Math.round(trafficDensity * 100)}%</b></label>
                    <input type="range" min="0" max="2" step="0.25" value={trafficDensity}
                      onChange={e => { const v = +e.target.value; setTrafficDensity(v); eng().setTrafficDensity?.(v); }} />
                    <div className="sliderEnds"><span>none</span><span>lots</span></div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ══ BOTTOM-CENTER: dash cluster (speed · gear · compass · time) ══ */}
          <div className={'dashCluster' + (drifting ? ' drift' : '')}>
            <div className="dashSpeed">
              <i className="dashRev" ref={el => (uiRefs.current.rev = el)}>R</i>
              <b ref={el => (uiRefs.current.mph = el)}>0</b>
              <div className="dashSpeedMeta">
                <span className="dashKick">MPH</span>
                <div className="dashBar"><i ref={el => (uiRefs.current.speedBar = el)} /></div>
                <div className="boostBar" aria-hidden="true"><i ref={el => (uiRefs.current.boostBar = el)} /></div>
              </div>
            </div>
            <div className="dashDiv" />
            <div className="dashCol">
              <span className="dashKick">GEAR</span>
              <b className="dashGear" data-gear="P" ref={el => (uiRefs.current.gear = el)}>P</b>
            </div>
            <div className="dashDiv" />
            <div className="dashCol">
              <span className="dashKick">TIME</span>
              <b className="dashTime" ref={el => (uiRefs.current.runTime = el)}>0:00</b>
            </div>
          </div>

          {/* ── touch hints (passive, pointer-events:none) ── */}
          {!traceDrive && (<>
          <div className={'moveHint' + (driveHint ? ' pulse' : '')} aria-hidden="true">
            <div className="stickRing" />
            <div className="stickArrow up"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4l6 8H6z" /></svg></div>
            <div className="stickArrow down"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 20l6-8H6z" /></svg></div>
            <div className="stickKnob" />
            <div className="stickLabel move">DRAG TO DRIVE</div>
          </div>
          <div className="lookHint" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="2.4" /></svg>
            <div className="stickLabel">SWIPE TO LOOK</div>
          </div>
          </>)}
          {traceDrive && <div className="dragDriveHint" aria-hidden="true">✦ Drag the map to drive · tap a spot to route there</div>}

          {drifting && <div id="driftChip">💨 DRIFT!</div>}
          {driveHint && <div className="driveHintCard">{driveHelp}</div>}

          {/* ── Nav panel: Drive-to (green) vs Jump-to (violet) ── */}
          {navOpen && (
            <div id="navPanel">
              <div className="navHead"><h3>Go somewhere</h3><button className="navX" aria-label="Close" onClick={() => { setSelDest(null); setNavOpen(false); }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button></div>

              <label className="navLbl"><span className="navDot go" /> Where to?</label>
              <div className="navTool">
                <AddressSearch placeholder="Search an address or place" actionLabel="Set"
                  suggest={t => eng().placeSuggest(t)}
                  onPick={s => { setNavErr(''); setSelDest({ placeId: s.placeId, label: s.description }); }}
                  onText={t => { setNavErr(''); setSelDest({ q: t, label: t }); }} />
                <div className="navPresets">
                  {PRESETS.map(p => (
                    <button key={p.label} className={'navChip' + (selDest && selDest.label === p.label ? ' sel' : '')}
                      onClick={() => { setNavErr(''); setSelDest({ home: p.home, q: p.q, ll: p.ll, label: p.label }); }}>{p.label}</button>
                  ))}
                </div>
              </div>

              {selDest && (
                <div className="navGo">
                  <div className="navGoLabel">📍 {selDest.label}</div>
                  <div className="navGoBtns">
                    <button className="navGoBtn drive" onClick={() => {
                      setNavErr('');
                      const run = selDest.home ? eng().driveHome()
                        : selDest.placeId ? eng().driveToPlace(selDest.placeId, selDest.label)
                          : eng().driveToText(selDest.q).catch(() => selDest.ll ? eng().driveToLatLon(selDest.ll[0], selDest.ll[1], selDest.label) : Promise.reject());
                      Promise.resolve(run).then(() => { setSelDest(null); setNavOpen(false); }).catch(() => setNavErr("Couldn't find that destination"));
                    }}>🚗 Drive there</button>
                    <button className="navGoBtn jump" onClick={() => {
                      setNavErr('');
                      const run = selDest.home ? eng().jumpHome()
                        : selDest.placeId ? eng().jumpToPlace(selDest.placeId, selDest.label)
                          : eng().jumpToText(selDest.q).catch(() => selDest.ll ? eng().jumpToAddress(selDest.ll[0], selDest.ll[1], selDest.label) : Promise.reject());
                      Promise.resolve(run).then(() => { setSelDest(null); setNavOpen(false); }).catch(() => setNavErr("Couldn't find that destination"));
                    }}>⚡ Jump there</button>
                  </div>
                </div>
              )}

              <label className="navLbl"><span className="navDot jump" /> Your location</label>
              <div className="navTool">
                <div className="navPresets">
                  <button className="navChip" onClick={() => { setNavErr(''); Promise.resolve(eng().driveToMyLocation(false)).then(() => setNavOpen(false)).catch(() => setNavErr("Couldn't get your location — allow access?")); }}>🚗 Drive to me</button>
                  <button className={'navChip' + (following ? ' on' : '')} onClick={() => {
                    setNavErr('');
                    if (following) { eng().stopFollow(); }
                    else { Promise.resolve(eng().driveToMyLocation(true)).then(() => setNavOpen(false)).catch(() => setNavErr("Couldn't get your location — allow access?")); }
                  }}>{following ? '⏹ Stop following' : '📡 Follow me'}</button>
                </div>
                <div className="navHintSm">{following ? 'The car is chasing your live GPS location.' : '"Follow me" keeps the car coming to wherever you are — it tracks you as you move.'}</div>
              </div>

              <div className="navSlider">
                <label>Driving speed <b>{Math.round(speedMul * 100)}%</b></label>
                <input type="range" min="0.4" max="1.5" step="0.05" value={speedMul}
                  onChange={e => { const v = +e.target.value; setSpeedMul(v); eng().setSpeedMul(v); }} />
                <div className="sliderEnds"><span>gentle</span><span>fast</span></div>
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
                  <button key={c.slot} className={'carRow' + (c.current ? ' current' : '') + (c.locked ? ' locked' : '')} disabled={c.locked}
                    onClick={() => { eng().pickCar(c.slot); setCars(eng().getCars()); if (!c.locked) setCarPicker(false); }}>
                    <span className="carThumb" style={{ '--car-accent': carColor(c.slot) }}><svg width="24" height="20" viewBox="0 0 30 22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 12 8 6h14l2 6" /><rect x="3" y="11" width="24" height="7" rx="2" /><circle cx="8.5" cy="18" r="2" /><circle cx="21.5" cy="18" r="2" /></svg></span>
                    <span className="carInfo"><span className="carName">{c.name}</span><span className="carSpec">{c.locked ? 'Find all 5 places to unlock' : (c.loaded ? c.credit : 'tap to drive')}</span></span>
                    <span className="carTag">{c.locked ? '🔒' : c.current ? '✓ ON' : c.spec}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div id="carCard" className={carCard.show ? 'show' : ''}>
          <h2>{carCard.name}</h2>
          <p>
            {carCard.spec}
            <br />
            <span style={{ opacity: .5, fontSize: 10, letterSpacing: '.04em' }}>{carCard.credit ? `${carCard.credit} · three.js` : 'three.js'}</span>
          </p>
        </div>

        {arrived && (
          <div id="arrivedCard" role="status" aria-live="polite">
            <span className="acFlag">🏁</span>
            <span className="acText">Arrived · <b>{arrived.label}</b></span>
            {arrived.points > 0 && <span className="acPts">+{arrived.points}</span>}
          </div>
        )}

        <div id="joy" ref={el => (uiRefs.current.joy = el)}><div id="knob" ref={el => (uiRefs.current.knob = el)} /></div>
        {eng() && eng().im && !traceMode && <MobileControls input={eng().im} orientation={orientation} buttons={false} />}

        <Toast />
        <Credits />
      </div>
    </>
  );
}
