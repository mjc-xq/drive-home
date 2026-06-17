import * as THREE from 'three';

// Tile prefetch: a low-res virtual "scout" camera that sweeps the route ahead and registers
// it with the 3d-tiles renderer, so the COARSE ground tiles you're about to drive over are
// already streaming/cached (no pop-in on a fast cross-town run). Only active while driving with
// a destination + route, so free-roam near home pays nothing. setScout(false) unregisters the
// scout camera and must run in dispose BEFORE p3dtiles.disposeAll().
export function createPrefetch(ctx) {
  const scoutCam = new THREE.PerspectiveCamera(60, 1.5, 1, 4000);

  function pointAlongRoute(dist) {
    if (!ctx.ROUTE || ctx.ROUTE.length < 2) return null;
    let px = ctx.car.x, pz = ctx.car.z, acc = 0;
    for (let i = Math.max(0, ctx.routeIdx); i < ctx.ROUTE.length; i++) {
      const dx = ctx.ROUTE[i].x - px, dz = ctx.ROUTE[i].z - pz, seg = Math.hypot(dx, dz) || 1e-3;
      if (acc + seg >= dist) { const t = (dist - acc) / seg; return { x: px + dx * t, z: pz + dz * t }; }
      acc += seg; px = ctx.ROUTE[i].x; pz = ctx.ROUTE[i].z;
    }
    return { x: px, z: pz };
  }
  function setScout(on) {
    if (on === ctx.scoutOn || !ctx.p3dtiles) return;
    ctx.scoutOn = on;
    if (on) { ctx.p3dtiles.setCamera(scoutCam); ctx.p3dtiles.setResolution(scoutCam, 360, 240); }
    else if (ctx.p3dtiles.deleteCamera) ctx.p3dtiles.deleteCamera(scoutCam);
  }
  function updateTilePrefetch(now) {
    if (!ctx.p3dtiles || ctx.mode !== 'drive' || !ctx.p3dtiles.holder.visible || !ctx.DEST || !ctx.ROUTE || ctx.ROUTE.length < 2) { setScout(false); return; }
    if (now - ctx._scoutT < 220) return;                       // ~4.5 Hz
    ctx._scoutT = now;
    setScout(true);
    ctx._scoutPhase = (ctx._scoutPhase + 1) % 6;                   // sweep the aim through the corridor ahead…
    const p = pointAlongRoute(90 + ctx._scoutPhase * 135);     // …≈90–765 m along the route (reach matches the faster rail cruise)
    if (!p) { setScout(false); return; }
    const gy = ctx.car.groundY != null ? ctx.car.groundY : 0;
    scoutCam.up.set(0, 0, -1);
    scoutCam.position.set(p.x, gy + 260, p.z);             // high, straight down → warms the ground tiles ahead
    scoutCam.lookAt(p.x, gy, p.z);
    scoutCam.updateMatrixWorld(true);
  }

  return { setScout, updateTilePrefetch, pointAlongRoute };
}
