import * as THREE from 'three';

// Drive-mode tile cutaway — the photoreal tiles between the camera and the car are sliced away
// so the car is always visible. The occluding volume is the CONVEX HULL of the eye (camera) and
// a padded oriented car box: every sightline of a pinhole camera passes through the eye, so the
// rays that reach the car form the cone from the eye to the car box, and anything inside that
// cone (between eye and car) is exactly what can hide the car. We hand tiles3d.js the OUTWARD-
// normal face planes of that hull; with clipIntersection=true a fragment is discarded iff it is
// behind EVERY plane — i.e. inside the hull — so only the true occluders are cut.
//
// Why this beats the old flat-cap corridor: the hull tapers along the real sightline (no bizarre
// flat strip), tall/wide occluders can't leak past a cap, and TERRAIN IS NEVER CUT — the hull's
// lower boundary is the eye→car-BASE sightline, which rises above the road everywhere except
// directly under the car (where the car covers it). One code path serves every camera angle
// (chase / cruise / overhead / aerial); overhead simply becomes a near-vertical hull.
//
// The clipPlanes array is OWNED by tiles3d.js (shared by every tile material, clipIntersection=true).
// We always write EXACTLY N planes (padding spare slots with no-op planes) so the per-fragment
// clip-plane count never changes — a changing count forces Three.js to recompile tile shaders.
export function createTileClip(ctx) {
  // Base (dispScale=1) padded car box. Footprint + roof scale with car.dispScale so the cut
  // matches the rendered car (which is blown up 3–9× in overhead/aerial); FLOOR_PAD does NOT
  // scale — it is the fixed margin that keeps the road (and graded road) out of the cut.
  const CAR_HALF_LEN = 2.3, CAR_HALF_WID = 1.05;   // ~4.6 m × 2.1 m car
  const PAD_LEN = 0.9, PAD_WID = 0.7;              // margin so the car never clips its own edges + a thin surround
  const ROOF = 1.95;                               // box top above the road (covers a tall van + margin)
  const FLOOR_PAD = 0.5;                           // box bottom above the road → terrain stays below the cut
  const CLOSE_GUARD = 5;                           // eye within 5 m of the car → don't cut (showcase orbit / nose-in)
  const N = 9;                                     // FIXED plane count = max hull faces (3–5 back faces + 4–6 silhouette edges)
  const EPS = 1e-5;

  // 12 box edges as corner-index pairs. Corner index bits: b0 = forward sign, b1 = right sign, b2 = up.
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

  const pool = Array.from({ length: N }, () => new THREE.Plane());   // reused every frame (zero per-frame allocation)
  const C = Array.from({ length: 8 }, () => new THREE.Vector3());    // box corners
  const eye = new THREE.Vector3(), ctr = new THREE.Vector3();
  const n = new THREE.Vector3(), ab = new THREE.Vector3(), ae = new THREE.Vector3(), tmp = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  // commit the pool (first `used` slots are real planes; pad the rest with no-ops that don't change
  // the clipIntersection result, then publish to the shared array without reallocating it)
  function commit(clip, used, noopBehind) {
    for (let i = used; i < N; i++) {
      // padding: clipIntersection discards a fragment only if it's behind ALL planes. A plane that
      // every fragment is BEHIND (constant −1e9) leaves the real planes in charge (use when cutting);
      // a plane every fragment is IN FRONT of (constant +1e9) forces "kept" (use for no-cut).
      pool[i].normal.copy(UP); pool[i].constant = noopBehind ? -1e9 : 1e9;
    }
    for (let i = 0; i < N; i++) clip[i] = pool[i];
    clip.length = N;
  }

  function updateTileClip(carX, carY, carZ /*, view */) {
    const clip = ctx.p3dtiles && ctx.p3dtiles.clipPlanes;
    if (!clip) return;
    eye.copy(ctx.camera.position);

    // --- padded oriented car box (scaled to the rendered car) ---
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

    // --- guard: eye too close / inside the box → no occlusion needed ---
    if (eye.distanceTo(ctr) < CLOSE_GUARD) { commit(clip, 0, false); return; }

    let used = 0;
    const tryFace = (nx, ny, nz, px, py, pz) => {
      // back face of the hull ⇔ eye on the inner (negative) side of this outward-normal box face
      if (nx * (eye.x - px) + ny * (eye.y - py) + nz * (eye.z - pz) <= EPS && used < N) {
        const p = pool[used++]; p.normal.set(nx, ny, nz); p.constant = -(nx * px + ny * py + nz * pz);
      }
    };
    // 6 box faces (outward normal + a point on the face = box centre + normal·halfExtent)
    tryFace(fx, 0, fz, ctr.x + fx * hl, ctr.y, ctr.z + fz * hl);      // +forward
    tryFace(-fx, 0, -fz, ctr.x - fx * hl, ctr.y, ctr.z - fz * hl);    // −forward
    tryFace(rx, 0, rz, ctr.x + rx * hw, ctr.y, ctr.z + rz * hw);      // +right
    tryFace(-rx, 0, -rz, ctr.x - rx * hw, ctr.y, ctr.z - rz * hw);    // −right
    tryFace(0, 1, 0, ctr.x, yt, ctr.z);                               // +up
    tryFace(0, -1, 0, ctr.x, yb, ctr.z);                             // −up

    // 12 box edges → the plane through (eye, A, B) is a hull (silhouette) face iff every box corner
    // is on its inner side. This builds the tapered cone walls from the eye to the car silhouette.
    for (const [ia, ib] of EDGES) {
      if (used >= N) break;
      const A = C[ia], B = C[ib];
      ab.subVectors(B, A); ae.subVectors(eye, A);
      n.crossVectors(ab, ae);
      const len = n.length();
      if (len < EPS) continue;                                         // eye colinear with the edge
      n.multiplyScalar(1 / len);
      if (n.dot(tmp.subVectors(ctr, A)) > 0) n.negate();               // orient OUTWARD (away from the box centre)
      let supporting = true;
      for (let i = 0; i < 8; i++) { if (n.dot(tmp.subVectors(C[i], A)) > EPS) { supporting = false; break; } }
      if (!supporting) continue;                                       // corners on both sides → interior edge, skip
      const p = pool[used++]; p.normal.copy(n); p.constant = -n.dot(A);
    }

    commit(clip, used, true);
  }

  return { updateTileClip };
}
