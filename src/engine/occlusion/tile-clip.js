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
  const eye = new THREE.Vector3(), ctr = new THREE.Vector3(), projected = new THREE.Vector3();

  function clearTileClip() {
    const cutaway = ctx.p3dtiles && ctx.p3dtiles.cutaway;
    if (!cutaway) return;
    cutaway.screen.value.set(0, 0, 0, 0);
    if (ctx.p3dtiles.clipPlanes) ctx.p3dtiles.clipPlanes.length = 0;
  }

  function updateTileClip(carX, carY, carZ, view) {
    const cutaway = ctx.p3dtiles && ctx.p3dtiles.cutaway;
    if (!cutaway) return;
    eye.copy(ctx.camera.position);

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

    if (eye.distanceTo(ctr) < CLOSE_GUARD) { clearTileClip(); return; }

    const w = ctx._rw || ctx.canvas.clientWidth || innerWidth || 1;
    const h = ctx._rh || ctx.canvas.clientHeight || innerHeight || 1;
    ctx.camera.updateMatrixWorld();
    ctr.project(ctx.camera);
    if (ctr.z < -1 || ctr.z > 1) { clearTileClip(); return; }
    const cx = (ctr.x * 0.5 + 0.5) * w;
    const cy = (ctr.y * 0.5 + 0.5) * h;

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

    const shortSide = Math.min(w, h);
    const margin = view && view.aerial ? 62 : view && view.topdown ? 74 : 86;
    const minR = view && view.aerial ? 68 : view && view.topdown ? 82 : 96;
    const maxR = shortSide * (view && view.aerial ? 0.26 : 0.34);
    const rxp = Math.min(maxR, Math.max(minR, (maxX - minX) * 0.5 + margin));
    const ryp = Math.min(maxR, Math.max(minR, (maxY - minY) * 0.5 + margin));

    cutaway.eye.value.copy(eye);
    cutaway.target.value.set(carX, carY + 1.05 * s, carZ);
    cutaway.baseY.value = carY + 0.45;
    cutaway.screen.value.set(cx, cy, rxp, ryp);
    cutaway.minOpacity.value = 0.0;
    cutaway.depthPad.value = 0.35;
    cutaway.groundPad.value = 0.28;
  }

  return { updateTileClip, clearTileClip };
}
