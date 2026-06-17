import { clamp } from '../coords.js';

// Read-only queries over the road graphs (procedural hood `ctx.roadSegs`/`ctx.allRoadSegs`, the
// live Google `ctx.ROUTE`, and the OSM network `ctx.osmRoadSegs`). Drives lane-keep assist, the
// off-road steer-back / soft-wall, reset-to-road, and "face along the street" while following.
// Pure: no outbound calls, reads ctx state live at each call (never captures the arrays).
export function createRoadGraph(ctx) {
  // Look-ahead point on the road the car is heading toward (lane-keep assist target). Returns
  // null when the car is >10 m off any road (don't tug you around a lawn).
  function roadTargetAhead(x, z, yaw, speed) {
    const segs = (x * x + z * z < 330 * 330) ? ctx.roadSegs : ctx.osmRoadSegs;   // hood graph near home, the fetched OSM graph everywhere else
    let carD = 1e18;                                 // how far the car is from the road right now
    for (const s of segs) {
      const ax = s[0][0], az = s[0][1], vx = s[1][0] - ax, vz = s[1][1] - az, L2 = vx * vx + vz * vz || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + vx * t - x, ez = az + vz * t - z, d = ex * ex + ez * ez;
      if (d < carD) carD = d;
    }
    if (carD > 100) return null;                     // >10 m off any road → no assist
    const La = clamp(Math.abs(speed) * 0.55, 7, 40); // look further ahead the faster you go
    const px = x + Math.sin(yaw) * La, pz = z + Math.cos(yaw) * La;
    let btx = 0, btz = 0, bd = 1e18; let found = false;
    for (const s of segs) {
      const ax = s[0][0], az = s[0][1];
      const mx = (ax + s[1][0]) / 2 - x, mz = (az + s[1][1]) / 2 - z;
      if (mx * mx + mz * mz > 900) continue;         // only roads within ~30 m (stay on THIS road)
      const vx = s[1][0] - ax, vz = s[1][1] - az, L2 = vx * vx + vz * vz || 1;
      let t = ((px - ax) * vx + (pz - az) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + vx * t, cz = az + vz * t, ex = cx - px, ez = cz - pz, d = ex * ex + ez * ez;
      if (d < bd) { bd = d; btx = cx; btz = cz; found = true; }
    }
    return found ? [btx, btz] : null;
  }
  // Nearest point on any neighbourhood road to (x,z), with its distance in metres. Drives
  // both the off-road steer-back (aim straight at it) and the auto-recover snap.
  function nearestRoadPoint(x, z) {
    let bx = x, bz = z, bd = 1e18;
    const tryAB = (ax, az, b0, b1) => {
      const vx = b0 - ax, vz = b1 - az, L2 = vx * vx + vz * vz || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t, pz = az + vz * t, d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bd) { bd = d; bx = px; bz = pz; }
    };
    // Live Google route first (real roads), then the OSM road network fetched around the car (works
    // far from the procedural hood), then EVERY mapped neighbourhood road. So the steer-back + soft
    // wall + reset always have a real road to aim at, anywhere on the map.
    if (ctx.ROUTE && ctx.ROUTE.length > 1) for (let i = 0; i < ctx.ROUTE.length - 1; i++) tryAB(ctx.ROUTE[i].x, ctx.ROUTE[i].z, ctx.ROUTE[i + 1].x, ctx.ROUTE[i + 1].z);
    for (const s of ctx.osmRoadSegs) tryAB(s[0][0], s[0][1], s[1][0], s[1][1]);
    for (const s of ctx.allRoadSegs) tryAB(s[0][0], s[0][1], s[1][0], s[1][1]);
    return { x: bx, z: bz, d: Math.sqrt(bd) };
  }
  // Unit tangent {tx,tz} of the nearest mapped road segment (so a followed car can face ALONG the
  // street), or null if no road is known. Mirrors nearestRoadPoint's source order.
  function nearestRoadSeg(x, z) {
    let bd = 1e18, tx = 0, tz = 0, found = false;
    const tryAB = (ax, az, b0, b1) => {
      const vx = b0 - ax, vz = b1 - az, L2 = vx * vx + vz * vz; if (L2 < 1) return;
      let t = ((x - ax) * vx + (z - az) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t, pz = az + vz * t, d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bd) { bd = d; const L = Math.sqrt(L2); tx = vx / L; tz = vz / L; found = true; }
    };
    if (ctx.ROUTE && ctx.ROUTE.length > 1) for (let i = 0; i < ctx.ROUTE.length - 1; i++) tryAB(ctx.ROUTE[i].x, ctx.ROUTE[i].z, ctx.ROUTE[i + 1].x, ctx.ROUTE[i + 1].z);
    for (const s of ctx.osmRoadSegs) tryAB(s[0][0], s[0][1], s[1][0], s[1][1]);
    for (const s of ctx.allRoadSegs) tryAB(s[0][0], s[0][1], s[1][0], s[1][1]);
    return found ? { tx, tz, d: Math.sqrt(bd) } : null;
  }

  return { roadTargetAhead, nearestRoadPoint, nearestRoadSeg };
}
