import { TOOLS, toolAfterScoop } from '../animals.js';
import { SCOOP_CAMS } from '../camera/presets.js';
import { clamp } from '../coords.js';
import { terrainAt } from '../data.js';
// Scoop game: the keeper HUD/tools, the yard scoop loop (updateScoop), and the indoor
// follow-cam + see-through occluder hiding (updateScoopInterior).
export function createScoop(ctx) {
  // ---------- scoop mode ----------
  function pushScoopHud() {
    ctx.emit('scoopHud', {
      lvl: ctx.CHAR.lvl, name: TOOLS[ctx.CHAR.lvl].name, bag: ctx.CHAR.bag,
      cap: TOOLS[ctx.CHAR.lvl].cap, total: ctx.CHAR.total, clean: ctx.crowd.cleanPct()
    });
  }
  function setTool(lvl) {
    ctx.CHAR.lvl = lvl;
    // voxel scoop props only show on the fallback keeper; Drew has no held tool
    for (let i = 0; i < 3; i++) if (ctx.CHAR.scoops[i]) ctx.CHAR.scoops[i].visible = !ctx.CHAR.drew && i === lvl;
    ctx.scoop.pushScoopHud();
  }
  function updateScoop(dt, now) {
    const inside = ctx.scoopScene === 'interior' && ctx.interior;
    // Keyboard Left/Right TURN the keeper (tank-style) instead of strafing sideways; the touch
    // joystick still strafes camera-relative. (Walking sideways on arrow keys felt wrong.)
    if (ctx.inp2.kx) { ctx.camYawS -= ctx.inp2.kx * 2.6 * dt; ctx.CHAR.yaw = ctx.camYawS; ctx.scoopMoveYaw = ctx.camYawS; ctx.lastLookT = now; }
    let jx = clamp(ctx.inp2.jx, -1, 1), jy = clamp(ctx.inp2.jy + ctx.inp2.ky, -1, 1);
    const rawMag = Math.min(1, Math.hypot(jx, jy));
    const mag = ctx.controls.scaledDeadzoneMagnitude(jx, jy);
    if (ctx.shiftLock) ctx.CHAR.yaw = ctx.camYawS; // Roblox shift-lock: keeper faces the camera
    if (mag > 0) {
      if (!ctx.scoopMoveActive) { ctx.scoopMoveYaw = ctx.camYawS; ctx.scoopMoveActive = true; }
      // Capture the movement camera when the stick engages. Right-side look can
      // orbit freely while a walk is held without re-aiming that active walk.
      const basisYaw = ctx.shiftLock ? ctx.camYawS : ctx.scoopMoveYaw;
      const fX = Math.sin(basisYaw), fZ = Math.cos(basisYaw);
      const rX = -Math.cos(basisYaw), rZ = Math.sin(basisYaw);
      let mx = rX * jx - fX * jy, mz = rZ * jx - fZ * jy;
      const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
      if (!ctx.shiftLock) ctx.CHAR.yaw = Math.atan2(mx, mz); // else keep facing camera, strafe
      // Roblox follow cam: your right-side swipe OWNS the camera. We only add a very
      // gentle drift to bring it back behind the keeper, and only after you've left
      // the camera alone for a good while (2.5 s) — so looking around actually holds
      // instead of being yanked back the instant you start walking. Shift-lock opts
      // out entirely (the camera leads and the keeper strafes).
      if (!ctx.shiftLock && now - ctx.lastLookT > 2500) {
        let dyaw = ctx.CHAR.yaw - ctx.camYawS;
        while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
        while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
        ctx.camYawS += dyaw * Math.min(1, dt * 0.8);   // ~1.2 s settle, barely noticeable
      }
      const sp = 4.4 * mag;
      let nx = ctx.CHAR.x + mx * sp * dt, nz = ctx.CHAR.z + mz * sp * dt;
      const rad = 0.42;
      if (inside) {
        // per-wall + furniture pushout/slide with passable doorways (interior.collide)
        const r = ctx.interior.collide(ctx.CHAR.x, ctx.CHAR.z, nx, nz, 0.34); nx = r.x; nz = r.z;   // slimmer radius so doorways/tight spots pass
      } else {
        // collide against real building/structure footprints (not the oversized
        // AABBs) and slide along the wall — otherwise the house's AABB walls off
        // half the open lawn around the keeper's spawn.
        if (ctx.fn.insideScoopBuilding(nx, nz)) {
          if (!ctx.fn.insideScoopBuilding(nx, ctx.CHAR.z)) nz = ctx.CHAR.z;
          else if (!ctx.fn.insideScoopBuilding(ctx.CHAR.x, nz)) nx = ctx.CHAR.x;
          else { nx = ctx.CHAR.x; nz = ctx.CHAR.z; }
        }
        for (const t of ctx.scoopTrees) {
          const dx = nx - t[0], dz = nz - t[1], d2 = dx * dx + dz * dz, rr = 0.55 + rad;
          if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2); nx = t[0] + dx / d * rr; nz = t[1] + dz / d * rr; }
        }
        for (const a of ctx.ANIMALS) {
          const dx = nx - a.x, dz = nz - a.z, d2 = dx * dx + dz * dz, rr = a.r + rad;
          if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2); nx = a.x + dx / d * rr; nz = a.z + dz / d * rr; }
        }
        if (Math.hypot(nx, nz) > 314) { const d = Math.hypot(nx, nz); nx *= 314 / d; nz *= 314 / d; }
      }
      ctx.CHAR.x = nx; ctx.CHAR.z = nz;
      ctx.CHAR.bob += dt * 10 * mag;
    } else { ctx.scoopMoveActive = false; ctx.CHAR.bob += dt * 1.5; }
    // ground on the fixed interior floor, or the procedural yard terrain
    const cy = inside ? ctx.interior.floorY : terrainAt(ctx.CHAR.x, ctx.CHAR.z);
    // jump arc: integrate vertical velocity under gravity; land back on the ground
    if (ctx.CHAR.vy !== 0 || ctx.CHAR.airY > 0) {
      ctx.CHAR.airY += ctx.CHAR.vy * dt; ctx.CHAR.vy -= 22 * dt;
      if (ctx.CHAR.airY <= 0) { ctx.CHAR.airY = 0; ctx.CHAR.vy = 0; }
    }
    const bobY = (ctx.CHAR.airY > 0 || ctx.CHAR.drew) ? 0 : Math.abs(Math.sin(ctx.CHAR.bob)) * 0.05;
    ctx.CHAR.group.position.set(ctx.CHAR.x, cy + ctx.CHAR.airY + bobY, ctx.CHAR.z);
    ctx.CHAR.group.rotation.y = ctx.CHAR.yaw - Math.PI / 2;
    if (ctx.CHAR.drew) { ctx.CHAR.drew.locomotion(rawMag > ctx.MOVE_DEADZONE ? 4.4 * mag : 0); ctx.CHAR.drew.tick(dt); }
    if (inside) { ctx.scoop.updateScoopInterior(dt, now); return; }
    // ===== YARD =====
    // door ENTRY: stand on the front-yard pad to walk inside the house
    if (ctx.interior && ctx.entryPt) {
      ctx.doorMarker.visible = true;
      ctx.doorMarker.position.set(ctx.entryPt[0], terrainAt(ctx.entryPt[0], ctx.entryPt[1]) + 2.6 + Math.abs(Math.sin(now * 0.005)) * 0.3, ctx.entryPt[1]);
      const din = Math.hypot(ctx.CHAR.x - ctx.entryPt[0], ctx.CHAR.z - ctx.entryPt[1]);
      if (din > 4.0) ctx.entryArmed = true;
      if (ctx.entryArmed && din < 2.6 && now > ctx.doorT) { ctx.houseSys.enterHouse(now); ctx.scoop.updateScoopInterior(dt, now); return; }   // run the interior frame now — no 1-frame yard flash
    } else ctx.doorMarker.visible = false;
    // always-on-top marker so Drew is never lost behind a real tree
    ctx.marker.visible = true;
    ctx.marker.position.set(ctx.CHAR.x, cy + 2.6 + Math.abs(Math.sin(now * 0.004)) * 0.22, ctx.CHAR.z);
    ctx.marker.rotation.y = now * 0.003;
    // scooping
    const tool = TOOLS[ctx.CHAR.lvl];
    for (let i = ctx.POOPS.length - 1; i >= 0; i--) {
      const p = ctx.POOPS[i];
      if (Math.hypot(ctx.CHAR.x - p.x, ctx.CHAR.z - p.z) < tool.r) {
        if (ctx.CHAR.bag >= tool.cap) {
          if (!ctx.bagWarned) { ctx.toast('Scoop is full! Empty it at the green bin ♻️'); ctx.bagWarned = true; }
          break;
        }
        ctx.removePoop(p); ctx.CHAR.bag++; ctx.CHAR.total++; ctx.audio.sfxScoop();
        const nl = toolAfterScoop(ctx.CHAR.lvl, ctx.CHAR.total);
        if (nl !== ctx.CHAR.lvl) {
          ctx.scoop.setTool(nl);
          ctx.audio.sfxChime(nl === 1 ? [523, 659, 784] : [523, 659, 784, 1047]);
          ctx.toast(nl === 1 ? 'Bigger scoop unlocked! 🥄✨' : 'MEGA SHOVEL unlocked! 🦾💩');
          if (ctx.CHAR.drew) ctx.CHAR.drew.react('cheer');     // Drew celebrates the upgrade
        } else ctx.scoop.pushScoopHud();
      }
    }
    if (ctx.COMPOST) {
      // green pin over the bin whenever you're carrying — makes the dump-off obvious
      ctx.compostMarker.visible = ctx.CHAR.bag > 0;
      if (ctx.compostMarker.visible) ctx.compostMarker.position.set(ctx.COMPOST[0], terrainAt(ctx.COMPOST[0], ctx.COMPOST[1]) + 3.2 + Math.abs(Math.sin(now * 0.005)) * 0.4, ctx.COMPOST[1]);
      if (ctx.CHAR.bag > 0 && Math.hypot(ctx.CHAR.x - ctx.COMPOST[0], ctx.CHAR.z - ctx.COMPOST[1]) < 3) {
        const dumped = ctx.CHAR.bag; ctx.CHAR.bag = 0; ctx.bagWarned = false; ctx.audio.sfxChime([392, 523]); ctx.scoop.pushScoopHud();
        ctx.toast('Composted ' + dumped + ' ♻️');
      }
    }
    if (ctx.POOPS.length === 0 && !ctx.spotless) { ctx.spotless = true; ctx.toast('Yard is spotless ✨ (for now…)', 2400); if (ctx.CHAR.drew) ctx.CHAR.drew.react('dance'); ctx._syncDanceNext = now; }   // clean yard → the house throws a dance party next time you step inside
    if (ctx.POOPS.length > 0) ctx.spotless = false;
    if (ctx.scoopHudDirty) { ctx.scoopHudDirty = false; ctx.scoop.pushScoopHud(); }
    // Scoop renders the full procedural world (its aerial-photo terrain IS the
    // backyard ground, with the real house + sanctuary structures), so the old
    // grass disc / fence ring (workarounds for the photoreal case) are off — they
    // would z-fight the terrain and the ring would cut through the house.
    if (ctx.groundPatch) ctx.groundPatch.visible = false;
    if (ctx.scoopGrass) ctx.scoopGrass.visible = false;
    if (ctx.scoopFence) ctx.scoopFence.visible = false;
    // follow cam — preset (Overhead / Angled / Close), cycled with the 🎥 button.
    const fx = Math.sin(ctx.camYawS), fz = Math.cos(ctx.camYawS);
    const SC = SCOOP_CAMS[ctx.scCam];
    // vertical look = TILT only (raise/lower the camera height); pinch/scroll
    // (szoom) is the sole distance control. Mirrors Drive (pitch->height, zoom->dist)
    // instead of the old dolly that stacked scPitch into both dist AND szoom.
    const dist = SC.dist * ctx.szoom, h = (SC.h + ctx.scPitch * 9) * Math.max(0.75, ctx.szoom);
    ctx.camGroundRef = ctx.camGroundRef == null ? cy : ctx.camGroundRef + (cy - ctx.camGroundRef) * Math.min(1, dt * 1.5);
    const camT = ctx._camT.set(ctx.CHAR.x - fx * dist, ctx.camGroundRef + h, ctx.CHAR.z - fz * dist);
    if (!ctx.camInit) { ctx.camV.copy(camT); ctx.camInit = true; }
    ctx.camV.lerp(camT, Math.min(1, dt * 6));
    ctx.camV.y = Math.max(ctx.camV.y, terrainAt(ctx.camV.x, ctx.camV.z) + 1.2);
    ctx.camera.position.copy(ctx.camV);
    ctx.camera.lookAt(ctx.CHAR.x, cy + 1.0, ctx.CHAR.z);
    // walk-to-drive: prompt when Drew reaches a parked car in the driveway, and
    // float a pin over the nearest car so the handoff is discoverable from the yard.
    let near = false, best = null, bestD = 1e9;
    for (const s of ctx.parkedSpots) {
      const d = Math.hypot(ctx.CHAR.x - s.x, ctx.CHAR.z - s.z);
      if (d < 3.6) near = true;
      if (d < bestD) { bestD = d; best = s; }
    }
    if (near !== ctx.nearCar) { ctx.nearCar = near; ctx.emit('nearCar', near); }
    ctx.carMarker.visible = !!best && !near;
    if (ctx.carMarker.visible) ctx.carMarker.position.set(best.x, terrainAt(best.x, best.z) + 5.2 + Math.abs(Math.sin(now * 0.005)) * 0.4, best.z);
  }
  function updateScoopInterior(dt, now) {
    ctx.marker.visible = false; ctx.carMarker.visible = false; ctx.compostMarker.visible = false; ctx.doorMarker.visible = false;
    ctx.exitMarker.visible = false; ctx.exitRing.visible = false;   // no blue indicators inside — exit via the "Leave house" button
    ctx.houseSys.updateNpcs(dt, now);
    // small indoor follow cam: pull IN before it pokes a wall (but never collapse onto the avatar),
    // and rise toward overhead when forced close; clamp under the ceiling.
    const fx = Math.sin(ctx.camYawS), fz = Math.cos(ctx.camYawS);
    const szi = clamp(ctx.szoom, 0.7, 1.35), ra = ctx.interior.roomAABB, MIND = 1.6;
    let dist = (4.0 + Math.max(0, ctx.scPitch) * 1.2) * szi;
    let camX = ctx.CHAR.x - fx * dist, camZ = ctx.CHAR.z - fz * dist;
    for (let k = 0; k < 6 && dist > MIND && (camX < ra[0] + 0.3 || camX > ra[1] - 0.3 || camZ < ra[2] + 0.3 || camZ > ra[3] - 0.3); k++) {
      dist = Math.max(MIND, dist * 0.78); camX = ctx.CHAR.x - fx * dist; camZ = ctx.CHAR.z - fz * dist;
    }
    const camY = ctx.interior.floorY + 2.1 + ctx.scPitch * 3.4 * Math.max(0.75, szi);
    const cc = ctx.interior.clampCam(camX, camY, camZ, 0.3);
    const camT = ctx._camT.set(cc.x, cc.y, cc.z);
    if (!ctx.camInit) { ctx.camV.copy(camT); ctx.camInit = true; }
    ctx.camV.lerp(camT, Math.min(1, dt * 6));
    const cl = ctx.interior.clampCam(ctx.camV.x, ctx.camV.y, ctx.camV.z, 0.28);
    ctx.camV.set(cl.x, Math.max(cl.y, ctx.interior.floorY + 0.7), cl.z);
    // if an outer-wall corner clamped the camera in close, rise toward overhead so we look DOWN at the
    // kid instead of zooming into their head.
    const pd = Math.hypot(ctx.camV.x - ctx.CHAR.x, ctx.camV.z - ctx.CHAR.z);
    if (pd < MIND) ctx.camV.y = Math.min(ctx.interior.ceilingY - 0.3, Math.max(ctx.camV.y, ctx.interior.floorY + 1.1 + (MIND - pd) * 2.0 + 1.2));
    ctx.camera.position.copy(ctx.camV);
    ctx.camera.lookAt(ctx.CHAR.x, ctx.interior.floorY + 1.1, ctx.CHAR.z);
    // SEE-THROUGH: hide any non-floor mesh between the camera and a BOUNDARY around the avatar — not just
    // the one dead-centre ray (which left walls covering the kid's body/sides in the way). Cast a small fan
    // to the torso, head, and a ring around them, so a wall blocking ANY part of the kid (or right around
    // them) is cut — a clean cutout boundary. Collision still uses precomputed AABBs, so hidden walls block.
    const occ = ctx.interior.occluders;
    if (occ && now - ctx._wallCutT > (ctx.MOBILE ? 75 : 45)) {
      ctx._wallCutT = now;
      for (const w of occ) if (!w.userData.permaHidden) w.visible = true;
      const cp = ctx.camera.position, fy = ctx.interior.floorY;
      const hideAlong = (tx, ty, tz) => {
        const dx = tx - cp.x, dy = ty - cp.y, dz = tz - cp.z, len = Math.hypot(dx, dy, dz) || 1;
        ctx._wallRay.set(cp, ctx._wallDir.set(dx / len, dy / len, dz / len)); ctx._wallRay.far = Math.max(0.1, len - 0.5);
        const hits = ctx._wallRay.intersectObjects(occ, false);
        for (const h of hits) h.object.visible = false;
      };
      hideAlong(ctx.CHAR.x, fy + 1.1, ctx.CHAR.z);                                                            // torso
      hideAlong(ctx.CHAR.x, fy + 1.75, ctx.CHAR.z);                                                           // head
      // Ring boundary — clears walls right around the kid. SKIP ring points that fall outside the room
      // shell: when the kid hugs a perimeter wall the 0.85 radius overshoots PAST the outer wall, so a
      // camera->outside ray would punch through (hide) the exterior wall/window and expose the skybox.
      const RING = ctx.MOBILE ? 4 : 6;   // fewer perimeter rays on phones — intersectObjects has no BVH, so each cast is O(tris)
      for (let i = 0; i < RING; i++) {
        const a = i / RING * Math.PI * 2, rx = ctx.CHAR.x + Math.cos(a) * 0.85, rz = ctx.CHAR.z + Math.sin(a) * 0.85;
        if (rx > ra[0] + 0.2 && rx < ra[1] - 0.2 && rz > ra[2] + 0.2 && rz < ra[3] - 0.2) hideAlong(rx, fy + 0.9, rz);
      }
    }
  }
  return { pushScoopHud, setTool, updateScoop, updateScoopInterior };
}
