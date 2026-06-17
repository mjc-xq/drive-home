import { clamp } from '../coords.js';
// Drive scoring + FX: pooled skid/smoke/coin particles, the coin-rally run clock, combo,
// trip score, nitro/boost economy, and near-miss detection.
export function createScore(ctx) {
  function spawnSkid(x, z, y, yaw, now) {
    const s = ctx.FX.skids[ctx.FX.si++ % ctx.FX.skids.length];
    s.born = now; s.mesh.visible = true;
    s.mesh.position.set(x, y + 0.035, z);
    s.mesh.rotation.set(0, yaw, 0);
    s.mesh.material.opacity = 0.5;
  }
  function spawnSmoke(x, z, y, now, onRoad) {
    const p = ctx.FX.smoke[ctx.FX.mi++ % ctx.FX.smoke.length];
    p.born = now; p.spr.visible = true;
    p.spr.position.set(x, y + 0.3, z);
    p.vx = (ctx.FX.mi % 7 - 3) * 0.25; p.vz = (ctx.FX.mi % 5 - 2) * 0.25;
    p.spr.scale.setScalar(1.1);
    p.spr.material.color.setHex(onRoad === false ? 0xb89066 : 0xc8c8c8);   // brown dust off-road, grey tyre smoke on tarmac
    p.spr.material.opacity = 0.32;
  }
  function spawnCoinBurst(x, z, y, now) {
    for (let i = 0; i < 6; i++) {
      const p = ctx.FX.sparks[ctx.FX.pi++ % ctx.FX.sparks.length];
      const a = i / 6 * Math.PI * 2;
      p.born = now; p.spr.visible = true;
      p.spr.position.set(x, y + 0.8, z);
      p.vx = Math.cos(a) * 3.2; p.vz = Math.sin(a) * 3.2; p.vy = 4 + (i % 3);
      p.spr.scale.setScalar(0.7);
      p.spr.material.opacity = 0.95;
    }
  }
  function tickParticles(now, dt) {
    for (const s of ctx.FX.skids) {
      if (!s.mesh.visible) continue;
      const age = (now - s.born) / 1000;
      if (age > 6) { s.mesh.visible = false; continue; }
      s.mesh.material.opacity = 0.5 * (1 - age / 6);
    }
    for (const p of ctx.FX.smoke) {
      if (!p.spr.visible) continue;
      const age = (now - p.born) / 1000;
      if (age > 0.85) { p.spr.visible = false; continue; }
      p.spr.position.x += p.vx * dt; p.spr.position.z += p.vz * dt;
      p.spr.position.y += (2.2 - age) * dt;
      p.spr.scale.setScalar(1.1 + age * 5);
      p.spr.material.opacity = 0.32 * (1 - age / 0.85);
    }
    for (const p of ctx.FX.sparks) {
      if (!p.spr.visible) continue;
      const age = (now - p.born) / 1000;
      if (age > 0.6) { p.spr.visible = false; continue; }
      p.vy -= 14 * dt;
      p.spr.position.x += p.vx * dt; p.spr.position.y += p.vy * dt; p.spr.position.z += p.vz * dt;
      p.spr.material.opacity = 0.95 * (1 - age / 0.6);
    }
  }
  function resetParticles() {
    for (const s of ctx.FX.skids) s.mesh.visible = false;
    for (const p of ctx.FX.smoke) p.spr.visible = false;
    for (const p of ctx.FX.sparks) p.spr.visible = false;
  }
  const fmtTime = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function startRun(now) { if (!ctx.runActive && ctx.coinsGot < ctx.coins.length) { ctx.runActive = true; ctx.runStart = now; } }
  function emitScore(extra) { ctx.emit('driveScore', Object.assign({ got: ctx.coinsGot, total: ctx.coins.length, best: ctx.bestMs, bestStr: ctx.bestMs ? ctx.score.fmtTime(ctx.bestMs) : '', combo: ctx.combo, trip: ctx.tripScore }, extra)); }
  function collectCoin(now) {
    if (ctx.audio.sfxChime) ctx.audio.sfxChime(ctx.combo >= 2 ? [784, 1047, 1319] : [784, 1047]);
    ctx.score.startRun(now);
    ctx.combo = (!ctx.comboExpired && now < ctx.comboExpire) ? ctx.combo + 1 : 1;   // chain within 4s to ramp it
    ctx.comboExpire = now + 4000; ctx.comboExpired = false;
    ctx.score.comboFx(now);
    // First coin teaches the loop: tell the kid what the coins are FOR (a time trial).
    if (ctx.coinsGot === 1 && ctx.coins.length > 1) ctx.toast('💛 First coin! Grab them all for a time trial 🏁', 1600);
    let finishMs = 0;
    if (ctx.coinsGot >= ctx.coins.length) {                                // rally complete → stop clock, save best
      ctx.runActive = false; ctx.lastRunMs = now - ctx.runStart; finishMs = ctx.lastRunMs;
      if (!ctx.bestMs || ctx.lastRunMs < ctx.bestMs) { ctx.bestMs = ctx.lastRunMs; try { localStorage.setItem(ctx.BEST_KEY, String(ctx.bestMs)); } catch (e) { } }
    }
    ctx.score.emitScore({ finishMs });
  }
  function comboFx(now) {
    if (ctx.combo <= ctx.comboPeak) { if (ctx.combo < 2) ctx.comboPeak = 0; return; }
    ctx.comboPeak = ctx.combo;
    if (ctx.combo === 3) { ctx.toast('🔥 Combo ×3!', 1100); if (ctx.audio.sfxWhoosh) ctx.audio.sfxWhoosh(0.6); }
    else if (ctx.combo === 5) { ctx.toast('🔥🔥 ON FIRE! ×5', 1500); if (ctx.audio.sfxChime) ctx.audio.sfxChime([784, 988, 1319, 1568]); if (ctx.ui.fx && !ctx.reduceMotion) { ctx.ui.fx.classList.add('arrive'); setTimeout(() => ctx.ui.fx && ctx.ui.fx.classList.remove('arrive'), 420); } }
    else if (ctx.combo >= 8 && ctx.combo % 3 === 2) { ctx.toast('🔥🔥🔥 UNSTOPPABLE! ×' + ctx.combo, 1500); }
  }
  function resetRun() { ctx.runActive = false; ctx.runStart = 0; ctx.lastRunMs = 0; ctx.combo = 0; ctx.comboExpired = true; ctx.tripScore = 0; }     function nearMiss(now) {
    if (now - ctx.lastNearT < 650) return;
    ctx.lastNearT = now;
    ctx.combo = (!ctx.comboExpired && now < ctx.comboExpire) ? ctx.combo + 1 : 1;
    ctx.comboExpire = now + 4000; ctx.comboExpired = false;
    ctx.tripScore += 40 + ctx.combo * 20; ctx.score.addBoost(0.13);
    if (ctx.audio.sfxWhoosh) ctx.audio.sfxWhoosh(0.8);
    ctx.toast('💨 Close one!' + (ctx.combo > 1 ? ' ×' + ctx.combo : ''), 850);
    ctx.score.comboFx(now);
    ctx.score.emitScore({});
  }
  function addBoost(amt) { ctx.boost = clamp(ctx.boost + amt, 0, 1); }

  return { spawnSkid, spawnSmoke, spawnCoinBurst, tickParticles, resetParticles, fmtTime, startRun, emitScore, collectCoin, comboFx, resetRun, nearMiss, addBoost };
}
