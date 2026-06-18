import * as THREE from 'three';

// Drive-mode tile visibility window. The old version built a box/cone from the car bounds, which
// could read as a square chunk missing from the Google tiles. This version behaves more like a
// polished third-person/isometric game: project the car to screen, draw an oval "keep the subject
// readable" window around it, and let the tile shader dissolve only tile fragments that are:
//   1. inside that oval,
//   2. physically between the camera and car, and
//   3. above the road-level sightline.
// The result keeps the car unobstructed without cutting a boxy hole through the street.
export function createTileClip(ctx) {
  // Base (dispScale=1) padded car box. We only use its projected footprint to size the oval.
  const CAR_HALF_LEN = 2.3, CAR_HALF_WID = 1.05;   // ~4.6 m × 2.1 m car
  const PAD_LEN = 1.15, PAD_WID = 0.9;
  const ROOF = 2.15;
  const FLOOR_PAD = 0.35;
  const CLOSE_GUARD = 4.5;
  const C = Array.from({ length: 8 }, () => new THREE.Vector3());
  const eye = new THREE.Vector3(), ctr = new THREE.Vector3(), projected = new THREE.Vector3(), cutTarget = new THREE.Vector3();

  function clearTileClip() {
    const cutaway = ctx.p3dtiles && ctx.p3dtiles.cutaway;
    if (!cutaway) return;
    cutaway.screen.value.set(0, 0, 0, 0);
    cutaway.columnRadius.value = 0;
    if (ctx.p3dtiles.clipPlanes) ctx.p3dtiles.clipPlanes.length = 0;
  }

  function updateTileClip(carX, carY, carZ, view) {
    const cutaway = ctx.p3dtiles && ctx.p3dtiles.cutaway;
    if (!cutaway) return;
    eye.copy(ctx.camera.position);

    const aerial = !!(view && view.aerial);
    const topdown = !!(view && view.topdown);
    const close = !!(view && !view.drone && !view.topdown && !view.aerial);

    // --- padded oriented car box, projected only to derive a rounded screen window ---
    const s = Math.max(0.5, ctx.car.dispScale || 1);
    const hl = (CAR_HALF_LEN + PAD_LEN) * s, hw = (CAR_HALF_WID + PAD_WID) * s;
    const yb = carY + FLOOR_PAD, yt = carY + ROOF * s;
    const fx = Math.sin(ctx.car.yaw), fz = Math.cos(ctx.car.yaw);   // forward (world)
    const rx = Math.cos(ctx.car.yaw), rz = -Math.sin(ctx.car.yaw);  // right (world)
    let idx = 0;
    for (let up = 0; up < 2; up++) for (let sr = -1; sr <= 1; sr += 2) for (let sf = -1; sf <= 1; sf += 2) {
      C[idx++].set(carX + rx * sr * hw + fx * sf * hl, up ? yt : yb, carZ + rz * sr * hw + fz * sf * hl);
    }
    ctr.set(carX, (yb + yt) / 2, carZ);

    cutTarget.set(carX, carY + 1.05 * s, carZ);
    if (close) {
      // Close chase needs a real sight corridor, not just a car-sized hole. Extend
      // it through the car along the actual camera sightline, so reverse/free-look
      // never moves the cutaway to the wrong side of the vehicle.
      let dx = carX - eye.x, dz = carZ - eye.z;
      let len = Math.hypot(dx, dz);
      if (len < 0.001) { dx = fx; dz = fz; len = 1; }
      const lookDist = ctx._lookV ? Math.hypot(ctx._lookV.x - carX, ctx._lookV.z - carZ) : (view?.ahead || 12);
      const clearDist = Math.min(34, Math.max(14 * s, lookDist));
      cutTarget.set(carX + dx / len * clearDist, carY + 1.15 * s, carZ + dz / len * clearDist);
    }

    if (eye.distanceTo(ctr) < CLOSE_GUARD) { clearTileClip(); return; }

    const w = ctx._rw || ctx.canvas.clientWidth || innerWidth || 1;
    const h = ctx._rh || ctx.canvas.clientHeight || innerHeight || 1;
    ctx.camera.updateMatrixWorld();
    ctr.project(ctx.camera);
    if (ctr.z < -1 || ctr.z > 1) { clearTileClip(); return; }
    let cx = (ctr.x * 0.5 + 0.5) * w;
    let cy = (ctr.y * 0.5 + 0.5) * h;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, visibleCorners = 0;
    for (let i = 0; i < 8; i++) {
      projected.copy(C[i]).project(ctx.camera);
      if (projected.z < -1 || projected.z > 1) continue;
      const px = (projected.x * 0.5 + 0.5) * w;
      const py = (projected.y * 0.5 + 0.5) * h;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      visibleCorners++;
    }
    if (!visibleCorners) { clearTileClip(); return; }

    if (close) {
      projected.copy(cutTarget).project(ctx.camera);
      if (projected.z >= -1 && projected.z <= 1) {
        const px = (projected.x * 0.5 + 0.5) * w;
        const py = (projected.y * 0.5 + 0.5) * h;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
        cx = cx * 0.42 + px * 0.58;
        cy = cy * 0.42 + py * 0.58;
      }
    }

    const aerialWide = aerial && (ctx.czoom || 1) > 2.2;
    const shortSide = Math.min(w, h);
    const margin = topdown ? 24 : aerial ? (aerialWide ? 18 : 34) : close ? 162 : 112;
    const minR = topdown ? 48 : aerial ? (aerialWide ? 42 : 58) : close ? 138 : 112;
    const maxRx = shortSide * (topdown ? 0.16 : aerial ? (aerialWide ? 0.11 : 0.18) : close ? 0.62 : 0.34);
    const maxRy = shortSide * (topdown ? 0.16 : aerial ? (aerialWide ? 0.11 : 0.18) : close ? 0.78 : 0.34);
    const rxp = Math.min(maxRx, Math.max(minR, (maxX - minX) * 0.5 + margin));
    const ryp = Math.min(maxRy, Math.max(minR, (maxY - minY) * 0.5 + margin));

    cutaway.eye.value.copy(eye);
    cutaway.target.value.copy(cutTarget);
    cutaway.baseY.value = carY + 0.55;
    cutaway.screen.value.set(cx, cy, rxp, ryp);
    cutaway.minOpacity.value = close ? 0.05 : topdown ? 0.2 : aerial ? (aerialWide ? 0.36 : 0.18) : 0.14;
    cutaway.flatMinOpacity.value = close ? 0.78 : topdown ? 0.76 : aerial ? 0.88 : 0.86;
    cutaway.flatFadeHeight.value = close ? 4.4 : topdown ? 2.9 : aerial ? 3.8 : 2.8;
    cutaway.depthPad.value = topdown || aerial ? 0.12 : 0.28;
    cutaway.groundPad.value = close ? 0.45 : topdown || aerial ? 0.12 : 0.2;
    cutaway.minHeight.value = topdown ? 1.05 : aerial ? 1.25 : close ? 2.05 : 0.75;
    // Overhead views get an extra world-space column so the cut only follows blockers
    // almost directly over the car, instead of clearing a broad screen-shaped patch.
    cutaway.columnRadius.value = topdown ? Math.max(4.0, 1.55 * s) : aerial ? Math.max(aerialWide ? 4.5 : 7.0, (aerialWide ? 0.9 : 1.45) * s) : 0;
    cutaway.columnSoftness.value = topdown ? 1.8 : aerial ? 3.0 : 1.0;
  }

  return { updateTileClip, clearTileClip };
}
