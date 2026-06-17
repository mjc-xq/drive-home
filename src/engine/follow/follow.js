import { clamp } from '../coords.js';
// Follow-the-car: live-GPS follow (critically-damped spring glide), device-compass heading,
// drive-to-my-location, and the speed / auto-max settings.
export function createFollow(ctx) {
  function startHeading() {
    if (ctx._headingOn) return;
    ctx._headingOn = true;   // claim SYNCHRONOUSLY so a stopHeading()/dispose() during the async iOS permission prompt makes a late grant a no-op (else attach() would orphan window listeners)
    const myGen = ++ctx._headingGen;   // a stop→restart while a permission prompt is still pending must not let the OLD grant attach a second, unremovable listener pair
    const onOrient = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;   // iOS: degrees clockwise from true north
      else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;                                          // others: alpha rises counter-clockwise from north
      if (h != null) ctx._followHeading = Math.PI - h * Math.PI / 180;   // → world yaw (x=E, z=-N, forward=(sin,cos)): yaw = π − heading
    };
    const attach = () => {
      if (!ctx._headingOn || ctx.disposed || myGen !== ctx._headingGen) return;   // follow ended/restarted or engine torn down while the permission dialog was open → don't attach orphan listeners
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
      ctx._headingOff = () => { window.removeEventListener('deviceorientationabsolute', onOrient, true); window.removeEventListener('deviceorientation', onOrient, true); };
    };
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') DOE.requestPermission().then(s => { if (s === 'granted') attach(); }).catch(() => { });   // iOS 13+: gesture-gated permission
    else attach();
  }
  function stopHeading() { if (ctx._headingOff) { try { ctx._headingOff(); } catch (e) { } } ctx._headingOff = null; ctx._headingOn = false; ctx._followHeading = null; }
  function stopFollow() {
    const was = ctx.followMode || ctx._geoWatch != null;
    if (ctx._geoWatch != null) { try { navigator.geolocation.clearWatch(ctx._geoWatch); } catch (e) { } ctx._geoWatch = null; }
    ctx.followMode = false; ctx._followGeo = null; ctx._followSeeded = false; ctx._followVx = 0; ctx._followVz = 0; ctx._jumpSnap = null; ctx.follow.stopHeading();
    if (was) ctx.emit('follow', false);
  }
  // Set the live follow target, CLAMPED to the 30 km sanity ring (beyond it the flat-earth ENU
  // mapping + ground tiles break down, and the glide — which bypasses the physics ring clamp — would
  // otherwise march the car off into the void chasing a far/garbage fix).
  function setFollowGeo(lat, lon) {
    const w = ctx.geo.geoToWorld(lat, lon); let wx = w[0], wz = w[1];
    const r = Math.hypot(wx, wz); if (r > 30000) { const s = 30000 / r; wx *= s; wz *= s; }
    if (!ctx._followSeeded) { ctx._followSeeded = true; ctx.car.x = wx; ctx.car.z = wz; ctx._followVx = 0; ctx._followVz = 0; ctx.nav.settleAfterTeleport(); }   // JUMP to the user at the START (at rest) — don't drive/glide there. Subsequent fixes spring-track.
    ctx._followGeo = { x: wx, z: wz };
  }
  function driveToMyLocation(follow) {
    if (!navigator.geolocation) { ctx.toast('📍 Location unavailable on this device', 1800); return Promise.reject(new Error('no-geo')); }
    ctx.follow.stopFollow();
    if (ctx.mode !== 'drive') ctx.fn.enterDrive();
    if (follow) {
      ctx.follow.startHeading();                                                  // request the compass NOW, inside the button-tap gesture (iOS requires that)
      ctx.followMode = true; ctx.autoDrive = false; ctx.nav.clearRouteRail(); ctx.nav.clearDestination();   // exact-follow OWNS the car — kill any rail/route
      ctx.emit('autodrive', false); ctx.emit('follow', true);
      ctx.toast('📍 Following you — the car tracks your location', 1700);
    }
    return new Promise((resolve, reject) => {
      let done = false;
      navigator.geolocation.getCurrentPosition(
        pos => {
          const lat = pos.coords.latitude, lon = pos.coords.longitude;
          if (Number.isFinite(lat) && Number.isFinite(lon) && ctx.mode === 'drive') {
            if (follow) { if (pos.coords.accuracy == null || pos.coords.accuracy <= 60) ctx.follow.setFollowGeo(lat, lon); }   // gate the SEED too — a junk/stale first fix is exactly what put the car on the wrong street; the watcher supplies a good one if this is dropped
            else { ctx.nav.driveToLatLon(lat, lon, '📍 Your location'); ctx.toast('📍 Driving to you', 1500); }
          }
          if (!done) { done = true; resolve({ lat, lon }); }
        },
        err => {
          // In FOLLOW the long-lived watch (below) is the resilient source — a cold/indoor SEED timeout
          // (10 s) routinely fires before the watch (15 s) delivers, so DON'T tear follow down here; let the
          // watch carry it. Only the non-follow one-shot "drive to me" truly fails on a seed error.
          if (!follow) { ctx.follow.stopFollow(); ctx.toast('📍 Could not get your location (allow access?)', 2200); }
          if (!done) { done = true; reject(err); }
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 });   // fresh-ish seed (the 2 s cache could hand back a stale low-accuracy fix)
      if (follow) {
        ctx._geoWatch = navigator.geolocation.watchPosition(pos => {
          const lat = pos.coords.latitude, lon = pos.coords.longitude;
          if (!ctx.followMode || ctx.mode !== 'drive' || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
          if (pos.coords.accuracy != null && pos.coords.accuracy > 60) return;   // drop junk fixes — those caused the "wrong street" jumps
          ctx.follow.setFollowGeo(lat, lon);                                       // just move the (ring-clamped) target; the glide in updateDrive smooths jitter + can't overshoot
        }, (werr) => { if (werr && werr.code === werr.PERMISSION_DENIED) { ctx.follow.stopFollow(); ctx.toast('📍 Location access needed to follow you', 2200); } }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 });   // end follow only on a REAL permission failure, not a transient timeout (the watch keeps retrying)
      }
    });
  }
  function setAutoMaxMph(mph) { ctx.autoMaxMph = Math.max(0, mph | 0); try { localStorage.setItem('dahill.automax', String(ctx.autoMaxMph)); } catch (e) { } ctx.emit('automax', ctx.autoMaxMph); }
  function setSpeedMul(v) { ctx.speedMul = clamp(+v || 1, 0.3, 2); try { localStorage.setItem('dahill.speedmul', String(ctx.speedMul)); } catch (e) { } }
  // The heading the MAP views (overhead/aerial main view + both minimaps) orient to: the live COMPASS
  // heading while following (so the map turns like the user/phone), else the car's own heading.
  function viewHeading() { return (ctx.followMode && ctx._followHeading != null) ? ctx._followHeading : ctx.car.yaw; }

  return { startHeading, stopHeading, stopFollow, setFollowGeo, driveToMyLocation, viewHeading, setAutoMaxMph, setSpeedMul };
}
