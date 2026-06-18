import { clamp } from '../coords.js';
// Neighbourhood POIs: the 5 real landmarks — waypoint pads + labels, proximity
// found-checks, the arrival celebration, and the visit-them-all chain.
export function createPoi(ctx) {
  function emitPOIs() { ctx.emit('poiProgress', { found: ctx.poiFound.size, total: ctx.POIS.length }); }
  // Route the player to the nearest place they HAVEN'T found yet — turns 5 one-shot
  // discoveries into a chained road trip ("now drive to the next place!").
  function chainToNextPOI(now) {
    let best = null, bd = 1e18;
    for (const p of ctx.POIS) { if (ctx.poiFound.has(p.key)) continue; const d = Math.hypot(p.x - ctx.car.x, p.z - ctx.car.z); if (d < 35) continue; if (d < bd) { bd = d; best = p; } }   // skip the one you're at
    if (!best) return;
    ctx.autoDrive = false;
    ctx.nav.setDestination(best.lat, best.lon, best.label, true);
    if (ctx.DEST) ctx.DEST.poiKey = best.key;   // tag so the chain only continues for places you chose
    ctx.toast('🏁 Next stop: floor it to ' + ctx.esc(best.label) + ' — follow the pink waypoint! 🏁', 2600);
  }
  function checkPOIs(now) {
    for (const poi of ctx.POIS) {
      if (ctx.poiSeen.has(poi.key)) continue;
      if (Math.hypot(ctx.car.x - poi.x, ctx.car.z - poi.z) < 45) {
        ctx.poiSeen.add(poi.key);
        const fresh = !ctx.poiFound.has(poi.key);
        ctx.poiFound.add(poi.key);
        try { localStorage.setItem(ctx.POI_KEY, JSON.stringify([...ctx.poiFound])); } catch (e) { }
        // fare score: a base + a speed bonus + the running combo (rewards a brisk trip)
        if (fresh && poi.key !== 'home') {
          const pts = 250 + Math.round(Math.abs(ctx.car.speed) * 4) + ctx.combo * 50;
          ctx.tripScore += pts;
          ctx.combo = (!ctx.comboExpired && now < ctx.comboExpire) ? ctx.combo + 1 : 1; ctx.comboExpire = now + 6000; ctx.comboExpired = false;
          ctx.poi.arriveCelebrate(poi.label, pts, now);   // the finish-line moment
        } else {
          ctx.toast(poi.msg + (fresh ? '  ·  🏆 ' + ctx.poiFound.size + '/' + ctx.POIS.length : ''), 2600);
          if (ctx.audio.sfxChime) ctx.audio.sfxChime(fresh ? [659, 988, 1319] : [659, 988]);
        }
        ctx.score.emitScore({}); ctx.poi.emitPOIs();
        if (ctx.poiFound.size === ctx.POIS.length && fresh) {
          ctx.cars.checkFerrariUnlock();
          ctx.toast('🏆 ALL 5 places found! Trip score ' + ctx.tripScore + ' 🎉', 3800);
        } else if (fresh && ctx.DEST && poi.key === (ctx.DEST.poiKey || '') ) {
          // only chain the road-trip if THIS was the place you were navigating to (you
          // opted in) — never force a new route line on a free-roam drive-by.
          ctx.poi.chainToNextPOI(now);
        }
      }
    }
  }
  function updateBeacons(now) {
    let nearestKey = null, nd = 1e18;
    for (const b of ctx.poiBeacons) { if (ctx.poiFound.has(b.poi.key)) continue; const d = Math.hypot(b.poi.x - ctx.car.x, b.poi.z - ctx.car.z); if (d < nd) { nd = d; nearestKey = b.poi.key; } }
    for (const b of ctx.poiBeacons) {
      const d = Math.hypot(b.poi.x - ctx.car.x, b.poi.z - ctx.car.z);
      const show = d > 16 && d < 1200;                // hide once you're basically there
      b.mesh.visible = show;
      if (!show) continue;
      const found = ctx.poiFound.has(b.poi.key);
      if (b.mesh.userData.groundY == null || now - (b.mesh.userData._gyT || 0) > 650) {
        b.mesh.userData.groundY = ctx.ground ? ctx.ground.actorGroundY(b.poi.x, b.poi.z, b.mesh.userData.groundY) : 0;
        b.mesh.userData._gyT = now;
      }
      b.mesh.position.set(b.poi.x, (b.mesh.userData.groundY || 0) + 0.24, b.poi.z);
      const fade = clamp((d - 16) / 55, 0, 1) * clamp(1 - (d - 260) / 940, 0.3, 1);   // strong near, fades far
      const activePulse = (b.poi.key === nearestKey && !ctx.reduceMotion) ? 1 + 0.055 * Math.sin(now * 0.006) : 1;
      b.mesh.rotation.y = (b.poi.key === nearestKey && !ctx.reduceMotion) ? Math.sin(now * 0.0015) * 0.08 : 0;
      b.mesh.userData.setState(found ? 0x6dffa8 : 0xff7ad8, fade * (found ? 0.46 : 0.92), activePulse);
    }
    // name-plates: legible only when you're close enough to actually be AT the place
    for (const l of ctx.poiLabels) {
      const d = Math.hypot(l.poi.x - ctx.car.x, l.poi.z - ctx.car.z);
      const show = d < 170;
      l.spr.visible = show;
      if (!show) continue;
      l.mat.color.setHex(ctx.poiFound.has(l.poi.key) ? 0x9bf3bb : 0xffffff);
      l.mat.opacity = clamp(1 - (d - 60) / 110, 0, 1);
    }
  }
  function hideBeacons() { for (const b of ctx.poiBeacons) b.mesh.visible = false; for (const l of ctx.poiLabels) l.spr.visible = false; }
  function arriveCelebrate(label, points, now) {
    ctx.arriveCenterT = now + 2600;
    const y = ctx.car.group ? ctx.car.group.position.y : 1;
    for (let k = 0; k < 4; k++) ctx.score.spawnCoinBurst(ctx.car.x + (k - 1.5) * 1.2, ctx.car.z, y, now);   // ~24 sparks
    if (ctx.audio.sfxChime) ctx.audio.sfxChime([523, 659, 784, 1047, 1319]);
    ctx.score.addBoost(0.5);                                     // arriving fills a big chunk of nitro for the next leg
    if (!ctx.reduceMotion) {
      ctx.timeScale = 0.4; ctx.slowmoHold = 0.32;             // HELD slow-mo (then it eases back) — a real beat, not a blink
      if (ctx.ui.fx) { ctx.ui.fx.classList.add('arrive'); setTimeout(() => ctx.ui.fx && ctx.ui.fx.classList.remove('arrive'), 850); }
    }
    // a second triumphant spark wave a beat later
    setTimeout(() => {
      if (ctx.mode !== 'drive') return;
      const y2 = ctx.car.group ? ctx.car.group.position.y : 1;
      for (let k = 0; k < 3; k++) ctx.score.spawnCoinBurst(ctx.car.x + (k - 1) * 1.6, ctx.car.z, y2, performance.now());
      if (ctx.audio.sfxChime) ctx.audio.sfxChime([784, 1047, 1319, 1568]);
    }, 280);
    ctx.emit('arrived', { label, points: points || 0, trip: ctx.tripScore });
  }
  return { emitPOIs, chainToNextPOI, checkPOIs, updateBeacons, hideBeacons, arriveCelebrate };
}
