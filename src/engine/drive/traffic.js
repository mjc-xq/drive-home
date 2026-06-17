import { clamp } from '../coords.js';
export function createTraffic(ctx) {
  const trafficActiveCount = () => Math.round(clamp(ctx.trafficDensity, 0, 2) / 2 * ctx.TRAFFIC_MAX);     function nextTrafficSeg(c) {
    const segs = ctx.traffic._segs, cand = [];
    for (const s of segs) {
      for (const pr of [[s[0], s[1]], [s[1], s[0]]]) {
        if (Math.hypot(pr[0][0] - c.b[0], pr[0][1] - c.b[1]) < 3.5 && Math.hypot(pr[1][0] - c.a[0], pr[1][1] - c.a[1]) > 4) cand.push(pr);
      }
    }
    if (cand.length) { const n = cand[Math.floor(Math.random() * cand.length)]; c.a = n[0]; c.b = n[1]; }
    else { const tmp = c.a; c.a = c.b; c.b = tmp; }   // dead end → U-turn
    c.t = 0;
  }
  function updateTraffic(dt, now) {
    if (!ctx.roadLifeOn) { ctx.trafficSys.hideTraffic(); return; }
    const active = ctx.trafficSys.trafficActiveCount();
    ctx.trafficTick++;
    for (let ci = 0; ci < ctx.traffic.length; ci++) {
      const c = ctx.traffic[ci];
      if (ci >= active) { if (c.group.visible) c.group.visible = false; continue; }   // parked by the density slider
      const dx = c.b[0] - c.a[0], dz = c.b[1] - c.a[1], len = Math.hypot(dx, dz) || 1;
      const fdx = dx / len, fdz = dz / len, rgx = fdz, rgz = -fdx;   // forward + right (for lanes)
      let cxp = c.a[0] + dx * c.t, czp = c.a[1] + dz * c.t;          // centreline point
      // YIELD: when the player is close and roughly ahead, the car slows right down (and
      // swings wide, below) so it's never an unavoidable head-on — you always have room.
      const toP = Math.hypot(ctx.car.x - cxp, ctx.car.z - czp);
      const ahead = (ctx.car.x - cxp) * fdx + (ctx.car.z - czp) * fdz;
      const yielding = toP < 28 && ahead > -6;
      const spdMul = yielding ? clamp((toP - 7) / 20, 0.06, 1) : 1;
      c.t += (c.speed * spdMul * dt) / len;
      if (c.t >= 1) { ctx.trafficSys.nextTrafficSeg(c); continue; }
      cxp = c.a[0] + dx * c.t; czp = c.a[1] + dz * c.t;
      // keep to the RIGHT of the centreline (a passable lane); if the player is bearing
      // down in this car's lane, swing wide to the OTHER side to clear a path.
      const pPerp = (ctx.car.x - cxp) * rgx + (ctx.car.z - czp) * rgz;       // >0 = player on the car's right
      const off = (yielding && pPerp > -1.2) ? -2.0 : 1.5;
      const x = cxp + rgx * off, z = czp + rgz * off;
      c.x = x; c.z = z;
      // GATE: cars far from the player are off-screen — hide them and skip the costly tile
      // raycast entirely (these 8 unthrottled casts were the biggest per-frame CPU chunk).
      if ((ctx.car.x - x) * (ctx.car.x - x) + (ctx.car.z - z) * (ctx.car.z - z) > 200 * 200) { c.group.visible = false; continue; }
      c.group.visible = true;
      // Use the SAME height authority as the player car. Raw groundAt follows the
      // bumpy photogrammetry mesh near home while the player rides the smooth
      // terrain road, which made traffic visibly float/sink on a different surface.
      // Keep the staggered refresh so only a few traffic cars sample tiles per frame.
      if (c.gy === undefined || (ctx.trafficTick + c.ti) % 4 === 0) c.gyT = ctx.ground.actorGroundY(x, z, c.gy) + 0.05;
      c.gy = c.gy === undefined ? c.gyT : c.gy + (c.gyT - c.gy) * Math.min(1, dt * 6);
      c.group.position.set(x, c.gy, z);
      c.group.rotation.set(0, Math.atan2(dx, dz), 0);
    }
  }
  function hideTraffic() { for (const c of ctx.traffic) c.group.visible = false; }

  return { trafficActiveCount, nextTrafficSeg, updateTraffic, hideTraffic };
}
