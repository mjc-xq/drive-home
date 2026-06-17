import { DRIVE_CAMS, SCOOP_CAMS } from '../camera/presets.js';
export function createCam(ctx) {
  // Drive cameras. Default "Cruise" is the high chase the user likes: well above
  // the melty ground-level photogrammetry, a little behind the car, looking DOWN
  // THE ROAD AHEAD (ahead = metres in front to aim at). "Close" is the low
  // cinematic chase; "Top-down" looks straight down, heading-up.
  function cycleCamera() {
    ctx.driveCamUserPicked = true;
    ctx.camMode = (ctx.camMode + 1) % DRIVE_CAMS.length; ctx.camInit = false;
    ctx.czoom = 1; ctx.camOrbit.yaw = 0; ctx.camOrbit.pitch = 0; ctx._orbitUserSet = false; ctx._viewYaw = ctx.follow.viewHeading();   // fresh framing per view (pinch-zoom/look don't leak)
    const dd = DRIVE_CAMS[ctx.camMode].dragdrive;
    if (!DRIVE_CAMS[ctx.camMode].topdown) ctx.camera.up.set(0, 1, 0);   // only top-down is heading-up
    if (!dd) { ctx.inp2.navActive = false; ctx.navPtr = null; }         // leaving a drag-to-drive view ends it
    ctx.emit('driveCam', DRIVE_CAMS[ctx.camMode].name); ctx.controls.emitDriveZoom();
    ctx.toast('Camera: ' + DRIVE_CAMS[ctx.camMode].name + (dd ? ' · drag to drive 🪄' : ''), dd ? 1700 : 1100);
  }
  // Jump straight to the one-finger draw-to-drive (top-down) view — the most phone-native
  // control, otherwise buried behind the 🎥 cycle.
  function traceDrive() {
    ctx.driveCamUserPicked = true;
    const i = DRIVE_CAMS.findIndex(c => c.topdown);
    if (i < 0) return;
    if (ctx.camMode === i) {
      ctx.camMode = 0; ctx.camInit = false; ctx.czoom = 1; ctx.camOrbit.yaw = 0; ctx.camOrbit.pitch = 0; ctx._orbitUserSet = false; ctx._viewYaw = ctx.follow.viewHeading();
      ctx.inp2.navActive = false; ctx.navPtr = null; ctx.camera.up.set(0, 1, 0);
      ctx.emit('driveCam', DRIVE_CAMS[ctx.camMode].name); ctx.controls.emitDriveZoom();   // keep the overhead zoom slider's show/hide + value in sync with the view (mirrors cycleCamera)
      ctx.toast('Camera: ' + DRIVE_CAMS[ctx.camMode].name, 1100);
      return;
    }
    ctx.camMode = i; ctx.camInit = false; ctx.czoom = 1; ctx.camOrbit.yaw = 0; ctx.camOrbit.pitch = 0; ctx._orbitUserSet = false; ctx._viewYaw = ctx.follow.viewHeading();
    ctx.emit('driveCam', DRIVE_CAMS[i].name); ctx.controls.emitDriveZoom();   // entering top-down → show the overhead zoom slider (mirrors cycleCamera)
    ctx.toast('🪄 Trace a path — drag your finger to drive!', 2000);
  }
  function cycleScoopCamera() {
    ctx.scCam = (ctx.scCam + 1) % SCOOP_CAMS.length; ctx.camInit = false;
    ctx.toast('Camera: ' + SCOOP_CAMS[ctx.scCam].name, 1100);
  }
  function resolveCam(tx, ty, tz, px, py, pz) {
    let g = 1;
    // procedural buildings: march subject->camera, pull in before a wall
    const steps = 14;
    for (let s = 3; s <= steps; s++) {
      const f = s / steps;
      const x = tx + (px - tx) * f, y = ty + (py - ty) * f, z = tz + (pz - tz) * f;
      for (const bb of ctx.bldBoxes) {
        if (x > bb[0] && x < bb[1] && z > bb[2] && z < bb[3] && y < (bb[4] || 99)) {
          g = Math.max(0.2, (s - 1.5) / steps); s = steps + 1; break;
        }
      }
    }
    // photoreal tiles: raycast the same segment against the real (tall, dense)
    // tile geometry — the procedural bldBoxes are hidden, so this is what keeps
    // the chase/follow cam from burying itself in real trees & houses.
    if (ctx.p3dtiles && ctx.p3dtiles.holder.visible) {
      ctx._camRayD.set(px - tx, py - ty, pz - tz);
      const dist = ctx._camRayD.length();
      if (dist > 0.05) {
        ctx._camRayD.multiplyScalar(1 / dist);
        ctx.camRay.set(ctx._camRayO.set(tx, ty, tz), ctx._camRayD);
        ctx.camRay.far = dist;
        // tiles.raycast prunes by per-tile bounding volume + early-exits on the
        // first hit — far cheaper than intersectObject(group, true), which tested
        // every triangle of every loaded tile each frame.
        ctx._camHits.length = 0;
        ctx.p3dtiles.raycast(ctx.camRay, ctx._camHits);
        const hit = ctx._camHits[0];
        if (hit) g = Math.min(g, Math.max(0.12, (hit.distance - 0.6) / dist));
      }
    }
    return g;
  }
  return { cycleCamera, traceDrive, cycleScoopCamera, resolveCam };
}
