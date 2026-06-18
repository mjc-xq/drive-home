import { clamp } from '../coords.js';

// Read-only queries over the road graphs (procedural hood `ctx.roadSegs`/`ctx.allRoadSegs`, the
// live Google `ctx.ROUTE`, and the OSM network `ctx.osmRoadSegs`). Drives lane-keep assist, the
// off-road steer-back / soft-wall, reset-to-road, and "face along the street" while following.
// Pure: no outbound calls, reads ctx state live at each call (never captures the arrays).
export function createRoadGraph(ctx) {
  const homeRoadRadius = () => ctx.HOME_ROAD_RADIUS || 380;
  const nearHomeRoads = (x, z) => x * x + z * z <= homeRoadRadius() * homeRoadRadius();

  function nearestRoadLocation(x, z, opts = {}) {
    let best = null, bd = Infinity;
    const maxD = opts.maxDistance == null ? Infinity : opts.maxDistance;
    const maxD2 = maxD * maxD;
    const includeRoute = opts.includeRoute !== false;
    const includeOsm = opts.includeOsm !== false;
    const includeHome = opts.includeHome == null ? nearHomeRoads(x, z) : !!opts.includeHome;
    const tryAB = (ax, az, bx, bz, source) => {
      const vx = bx - ax, vz = bz - az, L2 = vx * vx + vz * vz;
      if (L2 < 1e-8) return;
      const t = clamp(((x - ax) * vx + (z - az) * vz) / L2, 0, 1);
      const px = ax + vx * t, pz = az + vz * t, d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bd) {
        const L = Math.sqrt(L2);
        bd = d; best = { x: px, z: pz, d: Math.sqrt(d), tx: vx / L, tz: vz / L, source };
      }
    };
    if (includeRoute && ctx.ROUTE && ctx.ROUTE.length > 1) {
      for (let i = 0; i < ctx.ROUTE.length - 1; i++) tryAB(ctx.ROUTE[i].x, ctx.ROUTE[i].z, ctx.ROUTE[i + 1].x, ctx.ROUTE[i + 1].z, 'route');
    }
    if (includeOsm) for (const s of ctx.osmRoadSegs) tryAB(s[0][0], s[0][1], s[1][0], s[1][1], 'osm');
    if (includeHome) for (const s of ctx.allRoadSegs) tryAB(s[0][0], s[0][1], s[1][0], s[1][1], 'home');
    return best && bd <= maxD2 ? best : null;
  }

  // Look-ahead point on the road the car is heading toward (lane-keep assist target). Returns
  // null when the car is >10 m off any road (don't tug you around a lawn).
  function roadTargetAhead(x, z, yaw, speed) {
    const segs = nearHomeRoads(x, z) ? ctx.roadSegs : ctx.osmRoadSegs;   // hood graph near home, the fetched OSM graph everywhere else
    let carD = 1e18;                                 // how far the car is from the road right now
    for (const s of segs) {
      const ax = s[0][0], az = s[0][1], vx = s[1][0] - ax, vz = s[1][1] - az, L2 = vx * vx + vz * vz || 1;
      let t = clamp(((x - ax) * vx + (z - az) * vz) / L2, 0, 1);
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
      let t = clamp(((px - ax) * vx + (pz - az) * vz) / L2, 0, 1);
      const cx = ax + vx * t, cz = az + vz * t, ex = cx - px, ez = cz - pz, d = ex * ex + ez * ez;
      if (d < bd) { bd = d; btx = cx; btz = cz; found = true; }
    }
    return found ? [btx, btz] : null;
  }
  // Nearest point on any known road to (x,z), with its distance in metres. Drives
  // both the off-road steer-back (aim straight at it) and the auto-recover snap.
  function nearestRoadPoint(x, z, opts) {
    const p = nearestRoadLocation(x, z, opts);
    return p ? { x: p.x, z: p.z, d: p.d, source: p.source } : { x, z, d: Infinity, source: null };
  }
  // Unit tangent {tx,tz} of the nearest mapped road segment (so a followed car can face ALONG the
  // street), or null if no road is known. Mirrors nearestRoadPoint's source order.
  function nearestRoadSeg(x, z, opts) {
    const p = nearestRoadLocation(x, z, opts);
    return p ? { tx: p.tx, tz: p.tz, d: p.d, source: p.source } : null;
  }

  return { roadTargetAhead, nearestRoadLocation, nearestRoadPoint, nearestRoadSeg };
}
