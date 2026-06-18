import { DRIVE_CAMS } from '../camera/presets.js';
import { clamp } from '../coords.js';
import { terrainAt } from '../data.js';
// Input + explore camera: pointer/wheel/keyboard handlers, the dynamic thumbstick + look-drag,
// draw-to-drive, and the explore-orbit camera (applyCam).
export function createControls(ctx) {
  function applyCam() {
    ctx.camera.position.set(
      ctx.ctl.tx + ctx.ctl.r * Math.sin(ctx.ctl.po) * Math.sin(ctx.ctl.az),
      ctx.ctl.ty + ctx.ctl.r * Math.cos(ctx.ctl.po),
      ctx.ctl.tz + ctx.ctl.r * Math.sin(ctx.ctl.po) * Math.cos(ctx.ctl.az));
    ctx.camera.lookAt(ctx.ctl.tx, ctx.ctl.ty, ctx.ctl.tz);
  }
  // drag-to-drive ("trace") is available in the overhead-style views (Top-down AND Aerial)
  const driveTopDown = () => ctx.mode === 'drive' && DRIVE_CAMS[ctx.camMode] && DRIVE_CAMS[ctx.camMode].dragdrive;
  // Overhead/Aerial zoom-out slider support: czoom is the altitude/orbit multiplier. Map it log-wise to
  // a 0..1 slider and push the value to the UI whenever it changes (pinch, wheel, view switch, slider).
  const driveZoomRange = () => (ctx.controls.driveTopDown() ? [0.14, 7] : [0.4, 3.4]);
  function emitDriveZoom() { const [lo, hi] = ctx.controls.driveZoomRange(); ctx.emit('driveZoom', { norm: clamp(Math.log(clamp(ctx.czoom, lo, hi) / lo) / Math.log(hi / lo), 0, 1), overhead: ctx.controls.driveTopDown() }); }
  function setDriveZoom(norm) { const [lo, hi] = ctx.controls.driveZoomRange(); ctx.czoom = lo * Math.pow(hi / lo, clamp(norm, 0, 1)); ctx.controls.emitDriveZoom(); }
  function setNavFromPointer(clientX, clientY) {
    const r = ctx.canvas.getBoundingClientRect();
    ctx._navNDC.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ctx._navRay.setFromCamera(ctx._navNDC, ctx.camera);
    ctx._navPlane.constant = -(ctx.car && ctx.car.groundY != null ? ctx.car.groundY : 0);   // ground plane at the car's height
    if (ctx._navRay.ray.intersectPlane(ctx._navPlane, ctx._navHit)) { ctx.inp2.navX = ctx._navHit.x; ctx.inp2.navZ = ctx._navHit.z; ctx.inp2.navActive = true; }
  }
  function lookDelta(dx, dy) {
    const w = Math.max(320, ctx.canvas.clientWidth || innerWidth || 800);
    const h = Math.max(320, ctx.canvas.clientHeight || innerHeight || 600);
    return { yaw: dx / w * ctx.LOOK_YAW_PER_SCREEN, pitch: dy / h * ctx.LOOK_PITCH_PER_SCREEN };
  }
  function scaledDeadzoneMagnitude(x, y) {
    const m = Math.min(1, Math.hypot(x, y));
    return m <= ctx.MOVE_DEADZONE ? 0 : (m - ctx.MOVE_DEADZONE) / (1 - ctx.MOVE_DEADZONE);
  }
  function hideJoy() {
    ctx.movePtr = null; ctx.inp2.jx = 0; ctx.inp2.jy = 0;
    if (ctx.mode === 'scoop') ctx.scoopMoveActive = false;
    if (ctx.ui.joy) ctx.ui.joy.style.display = 'none';
  }
  function clearLiveInput() {
    ctx.navPtr = null; ctx.lookPtrs.clear(); ctx.ptrs.clear();
    ctx.lastPinch = 0; ctx.lastMid = null; ctx.pinchD = 0; ctx.moved = 0;
    ctx.inp2.jx = ctx.inp2.jy = ctx.inp2.kx = ctx.inp2.ky = 0;
    ctx.inp2.steer = ctx.inp2.gas = ctx.inp2.brake = 0;
    ctx.inp2.hbrake = false; ctx.inp2.boost = false; ctx.inp2.navActive = false;
    ctx.scoopMoveActive = false;
    if (ctx.ui.joy) ctx.ui.joy.style.display = 'none';
    ctx.canvas.classList.remove('dragging');
  }
  function onPointerDown(e) {
    if ((ctx.mode === 'scoop' && ctx.imScoop) || (ctx.mode === 'drive' && ctx.imDrive && !ctx.traceMode)) return;   // scoop input is owned by the unified InputManager
    if (ctx.mode !== 'explore') {
      ctx.canvas.setPointerCapture(e.pointerId);
      // Overhead views: ONE finger draws-to-drive; a SECOND finger is a pinch-zoom (the
      // phone-native way to zoom the map the user asked for) which suspends steering until
      // you lift back to one finger.
      if (ctx.followMode || (ctx.autoDrive && ctx.controls.driveTopDown())) {
        // FOLLOWING, or AUTO-DRIVING in an overhead/aerial view: the whole screen ORBITS/pinches the camera
        // (one finger = look, two = pinch) so you can rotate the "race day" view freely — a drag must NOT
        // draw-to-drive or grab the joystick (which would cancel follow). Re-target via the minimap/search.
        ctx.lookPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (ctx.mode === 'drive') ctx.camOrbit.t = performance.now();
        if (ctx.lookPtrs.size === 2) { const a = [...ctx.lookPtrs.values()]; ctx.pinchD = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); }
        return;
      }
      if (ctx.controls.driveTopDown()) {
        if (ctx.navPtr === null && ctx.lookPtrs.size === 0) {
          ctx.navPtr = e.pointerId; ctx.navDownX = ctx.navCurX = e.clientX; ctx.navDownY = ctx.navCurY = e.clientY; ctx.navMoved = false; ctx.showT = 0; ctx.controls.setNavFromPointer(e.clientX, e.clientY);
        } else {
          if (ctx.navPtr !== null) { ctx.lookPtrs.set(ctx.navPtr, { x: ctx.navCurX, y: ctx.navCurY }); ctx.navPtr = null; ctx.inp2.navActive = false; }   // 2nd finger → stop driving, pinch instead
          ctx.lookPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (ctx.lookPtrs.size === 2) { const a = [...ctx.lookPtrs.values()]; ctx.pinchD = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); }
        }
        return;
      }
      const VW = ctx.canvas.clientWidth || innerWidth, VH = ctx.canvas.clientHeight || innerHeight;
      // Roblox touch convention, identical in drive + scoop: the LEFT HALF is the
      // movement zone — a press there SPAWNS the dynamic thumbstick under the thumb
      // (drag farther = move faster: full throttle / a run). The RIGHT HALF is dead
      // space for the camera — a single-finger drag there rotates (horizontal) and
      // tilts (vertical) the view; two fingers anywhere pinch-zoom. We reserve the
      // top strip from the move zone so a drag that begins up near the HUD reads as
      // a look, and so the thumbstick never spawns under the top bar.
      const steerZoneW = ctx.MOBILE ? 0.5 : 0.44;          // left half = move (slightly narrower with a mouse)
      const steerZoneTop = ctx.mode === 'drive' ? 0.14 : 0.18;
      if (ctx.movePtr === null && e.clientX < VW * steerZoneW && e.clientY > VH * steerZoneTop) {
        ctx.movePtr = e.pointerId; ctx.joyBX = e.clientX; ctx.joyBY = e.clientY;
        if (ctx.mode === 'scoop') { ctx.scoopMoveYaw = ctx.camYawS; ctx.scoopMoveActive = true; }
        if (ctx.ui.joy) {
          ctx.ui.joy.style.display = 'block';
          ctx.ui.joy.style.left = (e.clientX - ctx.JOY_R) + 'px'; ctx.ui.joy.style.top = (e.clientY - ctx.JOY_R) + 'px';
        }
        if (ctx.ui.knob) ctx.ui.knob.style.transform = 'translate(-50%,-50%)';
      } else {
        ctx.lookPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (ctx.mode === 'drive') ctx.camOrbit.t = performance.now();   // count a look-start as activity so the hold timer doesn't snap a resting finger back
        if (ctx.lookPtrs.size === 2) {
          const a = [...ctx.lookPtrs.values()];
          ctx.pinchD = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        }
      }
      return;
    }
    ctx.canvas.setPointerCapture(e.pointerId);
    ctx.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, b: e.button }); ctx.moved = 0;
    ctx.azVel = ctx.poVel = 0;
    ctx.canvas.classList.add('dragging');
    if (ctx.ptrs.size === 2) {
      const [a, b] = [...ctx.ptrs.values()];
      ctx.lastPinch = Math.hypot(a.x - b.x, a.y - b.y); ctx.lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  function onPointerMove(e) {
    if ((ctx.mode === 'scoop' && ctx.imScoop) || (ctx.mode === 'drive' && ctx.imDrive && !ctx.traceMode)) return;   // scoop input owned by InputManager
    if (ctx.mode !== 'explore') {
      if (e.pointerId === ctx.navPtr) { ctx.navCurX = e.clientX; ctx.navCurY = e.clientY; if (Math.hypot(e.clientX - ctx.navDownX, e.clientY - ctx.navDownY) > 12) ctx.navMoved = true; ctx.controls.setNavFromPointer(e.clientX, e.clientY); return; }   // draw-to-drive
      if (e.pointerId === ctx.movePtr) {
        let dx = e.clientX - ctx.joyBX, dy = e.clientY - ctx.joyBY;
        const d = Math.hypot(dx, dy), mx = ctx.JOY_MAX;
        if (d > mx) { dx *= mx / d; dy *= mx / d; }
        ctx.inp2.jx = dx / mx; ctx.inp2.jy = dy / mx;
        if (ctx.ui.knob) ctx.ui.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        if (Math.hypot(ctx.inp2.jx, ctx.inp2.jy) > 0.25) ctx.showT = 0;
        return;
      }
      const lp = ctx.lookPtrs.get(e.pointerId);
      if (!lp) return;
      const ox = lp.x, oy = lp.y;
      lp.x = e.clientX; lp.y = e.clientY;
      if (ctx.lookPtrs.size === 2) {
        const a = [...ctx.lookPtrs.values()];
        const nd = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (ctx.pinchD > 0 && nd > 0) {
          const f = ctx.pinchD / nd;
          if (ctx.mode === 'drive') { ctx.czoom = clamp(ctx.czoom * f, ctx.controls.driveTopDown() ? 0.14 : 0.4, ctx.controls.driveTopDown() ? 7 : 3.4); ctx.controls.emitDriveZoom(); }   // overhead gets a much wider+finer range (read one intersection ↔ neighbourhood overview)
          else ctx.szoom = clamp(ctx.szoom * f, 0.32, 2.6);                   // close over-the-shoulder → wide yard overview
        }
        ctx.pinchD = nd;
        return;
      }
      const dx = e.clientX - ox, dy = e.clientY - oy;
      if (Math.abs(dx) + Math.abs(dy) < 4) return; // look deadzone (kill resting-finger jitter on high-DPI screens)
      const ld = ctx.controls.lookDelta(dx, dy);
      if (ctx.mode === 'drive') {
        ctx.camOrbit.yaw = clamp(ctx.camOrbit.yaw - ld.yaw, -2.4, 2.4);   // clamp so a hard drag can't orbit under the map / lose the car
        ctx.camOrbit.pitch = clamp(ctx.camOrbit.pitch + ld.pitch, -0.45, 0.8);
        ctx.camOrbit.t = performance.now(); ctx._orbitUserSet = true;   // user grabbed the camera → stop the cinematic sweep, hold THEIR angle (relative to the car)
        ctx.showT = 0;
      } else {
        ctx.camYawS -= ld.yaw;
        ctx.scPitch = clamp(ctx.scPitch + ld.pitch, -0.3, 0.8);
        ctx.lastLookT = performance.now();   // pause follow-cam while the player looks
      }
      return;
    }
    if (!ctx.ptrs.has(e.pointerId)) return;
    const p = ctx.ptrs.get(e.pointerId);
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    ctx.moved += Math.abs(dx) + Math.abs(dy);
    p.x = e.clientX; p.y = e.clientY;
    if (ctx.ptrs.size === 1) {
      if (p.b === 2 || e.shiftKey) ctx.controls.pan(dx, dy);
      else {
        ctx.ctl.gaz -= dx * 0.0052; ctx.ctl.gpo = clamp(ctx.ctl.gpo - dy * 0.0042, 0.14, 1.46);
        ctx.azVel = -dx * 0.0052; ctx.poVel = -dy * 0.0042; // for flick momentum on release
      }
    } else if (ctx.ptrs.size === 2) {
      const [a, b] = [...ctx.ptrs.values()];
      const pinch = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (ctx.lastPinch) ctx.ctl.gr = clamp(ctx.ctl.gr * ctx.lastPinch / pinch, 14, 640);
      if (ctx.lastMid) ctx.controls.pan(mid.x - ctx.lastMid.x, mid.y - ctx.lastMid.y);
      ctx.lastPinch = pinch; ctx.lastMid = mid;
    }
  }
  function onPointerEnd(e) {
    if ((ctx.mode === 'scoop' && ctx.imScoop) || (ctx.mode === 'drive' && ctx.imDrive && !ctx.traceMode)) return;   // scoop input owned by InputManager
    if (e.pointerId === ctx.navPtr) {
      ctx.navPtr = null;
      // A TAP (no drag) on a road point → route there ALONG the roads and auto-drive, not a
      // straight line off-road. A DRAG was the freeform draw-to-drive, so release just coasts.
      if (!ctx.navMoved) ctx.nav.setDriveTarget(ctx.inp2.navX, ctx.inp2.navZ);
      else ctx.inp2.navActive = false;
    }
    if (e.pointerId === ctx.movePtr) ctx.controls.hideJoy();
    ctx.lookPtrs.delete(e.pointerId);
    if (ctx.lookPtrs.size < 2) ctx.pinchD = 0;
    ctx.ptrs.delete(e.pointerId); ctx.lastPinch = 0; ctx.lastMid = null;
    if (!ctx.ptrs.size) ctx.canvas.classList.remove('dragging');
  }
  function onWheel(e) {
    if ((ctx.mode === 'scoop' && ctx.imScoop) || (ctx.mode === 'drive' && ctx.imDrive && !ctx.traceMode)) return;   // scoop zoom owned by InputManager
    e.preventDefault();
    if (ctx.mode === 'explore') ctx.ctl.gr = clamp(ctx.ctl.gr * Math.exp(e.deltaY * ctx.ZOOM_RATE), 14, 640);
    else if (ctx.mode === 'drive') { ctx.czoom = clamp(ctx.czoom * Math.exp(e.deltaY * ctx.ZOOM_RATE), ctx.controls.driveTopDown() ? 0.14 : 0.4, ctx.controls.driveTopDown() ? 7 : 3.4); ctx.controls.emitDriveZoom(); }
    else if (ctx.mode === 'scoop') ctx.szoom = clamp(ctx.szoom * Math.exp(e.deltaY * ctx.ZOOM_RATE), 0.32, 2.6);
  }
  function onContextMenu(e) { e.preventDefault(); }
  function onDblClick() {
    if (ctx.mode === 'explore') { ctx.ctl.gtx = ctx.house.c[0]; ctx.ctl.gtz = ctx.house.c[1]; ctx.ctl.gr = 160; ctx.ctl.gpo = 0.95; }
  }
  function pan(dx, dy) {
    const s = ctx.ctl.r * 0.0013;
    const rx = Math.cos(ctx.ctl.az), rz = -Math.sin(ctx.ctl.az);
    const fx = -Math.sin(ctx.ctl.az), fz = -Math.cos(ctx.ctl.az);
    ctx.ctl.gtx = clamp(ctx.ctl.gtx - rx * dx * s + fx * dy * s, -310, 310);
    ctx.ctl.gtz = clamp(ctx.ctl.gtz - rz * dx * s + fz * dy * s, -310, 310);
    ctx.ctl.gty = terrainAt(ctx.ctl.gtx, ctx.ctl.gtz) + 3;
  }
  function focusHouse(close) {
    ctx.ctl.gtx = ctx.house.c[0]; ctx.ctl.gtz = ctx.house.c[1]; ctx.ctl.gty = ctx.house.baseY + 3.5;
    ctx.ctl.gr = close ? 48 : 120; ctx.ctl.gpo = close ? 0.78 : 0.95;
  }
  // ---------- keyboard ----------
  // True while the user is typing in a form field (the address search, etc.).
  // The game's key handler preventDefault()s Space + WASD + arrows; without this
  // guard those keystrokes never reach a focused <input>, so addresses with
  // spaces ("Circle Ave", "Castro Valley") couldn't be typed at all.
  function isEditable(t) {
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }
  function onKeyDown(e) {
    if (ctx.controls.isEditable(e.target)) return;   // let typing through — never hijack form input
    if (ctx.mode === 'drive' || ctx.mode === 'scoop') {
      if (ctx.mode === 'scoop' && e.key === 'Shift' && !e.repeat) {
        ctx.shiftLock = !ctx.shiftLock; ctx.emit('shiftLock', ctx.shiftLock);
        ctx.toast(ctx.shiftLock ? 'Shift-lock ON 🔒' : 'Shift-lock off', 900); e.preventDefault(); return;
      }
      if (ctx.mode === 'scoop' && (e.key === 'e' || e.key === 'E') && ctx.nearCar) { ctx.fn.driveFromScoop(); e.preventDefault(); return; }
      if (ctx.mode === 'scoop' && e.key === ' ' && !e.repeat) { ctx.api.jump(); e.preventDefault(); return; }   // Space = hop
      if (ctx.mode === 'drive' && e.key === ' ') { ctx.inp2.hbrake = true; e.preventDefault(); return; }        // Space = handbrake
      const dk = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'Escape'];
      if (dk.indexOf(e.key) < 0) return;
      if (e.key === 'ArrowUp' || e.key === 'w') ctx.inp2.ky = -1;
      if (e.key === 'ArrowDown' || e.key === 's') ctx.inp2.ky = 1;
      if (e.key === 'ArrowLeft' || e.key === 'a') ctx.inp2.kx = -1;
      if (e.key === 'ArrowRight' || e.key === 'd') ctx.inp2.kx = 1;
      if (e.key === 'Escape') (ctx.mode === 'drive' ? ctx.fn.exitDrive : ctx.fn.exitScoop)();
      e.preventDefault(); return;
    }
    const step = 0.12;
    if (e.key === 'ArrowLeft') ctx.ctl.gaz += step;
    else if (e.key === 'ArrowRight') ctx.ctl.gaz -= step;
    else if (e.key === 'ArrowUp') ctx.ctl.gpo = clamp(ctx.ctl.gpo - step, 0.14, 1.46);
    else if (e.key === 'ArrowDown') ctx.ctl.gpo = clamp(ctx.ctl.gpo + step, 0.14, 1.46);
    else if (e.key === '+' || e.key === '=') ctx.ctl.gr = clamp(ctx.ctl.gr * 0.85, 14, 640);
    else if (e.key === '-') ctx.ctl.gr = clamp(ctx.ctl.gr * 1.18, 14, 640);
    else if (e.key === 'Enter') ctx.controls.focusHouse(true);
    else return;
    e.preventDefault();
  }
  function onKeyUp(e) {
    // No editable-guard here on purpose: keyup never preventDefault()s (so it can't
    // block typing) and CLEARING a movement flag is always safe — guarding it could
    // strand a held key as "down" if focus moved to an input mid-press.
    if (ctx.mode === 'explore') return;
    if (e.key === 'ArrowUp' || e.key === 'w') ctx.inp2.ky = 0;
    if (e.key === 'ArrowDown' || e.key === 's') ctx.inp2.ky = 0;
    if (e.key === 'ArrowLeft' || e.key === 'a') ctx.inp2.kx = 0;
    if (e.key === 'ArrowRight' || e.key === 'd') ctx.inp2.kx = 0;
    if (e.key === ' ') ctx.inp2.hbrake = false;
  }
  return { driveTopDown, driveZoomRange, emitDriveZoom, setDriveZoom, setNavFromPointer, lookDelta, scaledDeadzoneMagnitude, hideJoy, clearLiveInput, onPointerDown, onPointerMove, onPointerEnd, onWheel, onContextMenu, onDblClick, pan, focusHouse, isEditable, onKeyDown, onKeyUp, applyCam };
}
