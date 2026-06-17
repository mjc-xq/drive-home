import * as THREE from 'three';

// Drive-mode tile cutaway: rewrites ctx.p3dtiles.clipPlanes each frame so the photoreal
// tiles between the camera and the car are sliced away (you can always see the car). The
// clipPlanes array is OWNED by tiles3d.js (assigned to every tile material with
// clipIntersection=true); this module only MUTATES its contents. Scratch planes are reused
// per frame and kept module-private (never shared — that would alias the per-frame cut).
// Empty array == no clip, so explore/scoop (which never call this) are uncut.
export function createTileClip(ctx) {
  const _clipHoriz = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);   // kept side: BELOW the (tilted) sightline + clearance
  const _clipDepth = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);    // kept side: AT/BEYOND the car along the camera→car axis
  const _clipConeA = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);    // cone wall (+lateral): kept side = outside the wedge
  const _clipConeB = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);   // cone wall (−lateral)
  const _clipBox = [new THREE.Plane(), new THREE.Plane(), new THREE.Plane(), new THREE.Plane()];   // overhead column walls (±x, ±z)
  const _clipN = new THREE.Vector3(), _clipP = new THREE.Vector3();

  function updateTileClip(carX, carY, carZ, view) {
    const planes = ctx.p3dtiles && ctx.p3dtiles.clipPlanes;
    if (!planes) return;
    // eye→car vector d; dist = |d|, dh = its horizontal extent (how horizontal the view is).
    const ex = ctx.camera.position.x, ey = ctx.camera.position.y, ez = ctx.camera.position.z;
    const dx = carX - ex, dy = carY - ey, dz = carZ - ez;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-3) { planes.length = 0; return; }
    const dh = Math.hypot(dx, dz);
    if (view.topdown || dh < dist * 0.25) {
      // OVERHEAD COLUMN: cap the canopy just above the car and box it to ±W around the car so the
      // cut is a tight column over the road, never spreading to trees off to the sides.
      const W = 7, clearance = 2.5;                          // clearance ≥ tallest car roof (~2 m van) so the car never clips
      _clipHoriz.constant = carY + clearance;   // kept BELOW carY+clearance (normal fixed at construction)
      // Box walls point INWARD so "behind EVERY plane" (clipIntersection) = inside the column. (Outward
      // normals made the four behind-halves mutually exclusive → empty cut → overhead clipped nothing.)
      _clipBox[0].normal.set(-1, 0, 0); _clipBox[0].constant = (carX - W);    // behind ⇔ x > carX−W
      _clipBox[1].normal.set(1, 0, 0);  _clipBox[1].constant = -(carX + W);   // behind ⇔ x < carX+W
      _clipBox[2].normal.set(0, 0, -1); _clipBox[2].constant = (carZ - W);    // behind ⇔ z > carZ−W
      _clipBox[3].normal.set(0, 0, 1);  _clipBox[3].constant = -(carZ + W);   // behind ⇔ z < carZ+W
      planes.length = 0; planes.push(_clipHoriz, _clipBox[0], _clipBox[1], _clipBox[2], _clipBox[3]);
      return;
    }
    // OBLIQUE (chase / cruise / aerial): a constant-width CORRIDOR from the camera to the car.
    const W = 6, clearance = 2.5;                            // ±W slab around the look axis; flat-cap height above the car
    // (1) FLAT height cap at carY + clearance. The earlier TILTED sightline rose to CAMERA height near
    // the lens, so near-camera foreground sat below it and was never cut — it "reappeared right before
    // your eyes" as you drove forward. A flat cap stays low ALL the way back to the camera, so the whole
    // corridor (lens → car) is cleared. It can't gouge distant hills (the old "white middle") because the
    // ±W slab below bounds the cut to the road strip, which is ~flat; the car itself is kept by the depth
    // gate, not this cap, so the clearance only needs to tolerate the road's grade over the corridor.
    _clipHoriz.constant = carY + clearance;                 // kept BELOW carY + clearance (normal fixed at construction)
    // (2) depth gate: keep everything at/beyond (car − 2.6 m) along the eye→car axis. 2.6 m (not less)
    // because the car's own tail sits ~2.25 m behind its centre along this axis in chase/cruise; a
    // tighter band would clip the car's rear.
    const fx = dx / dist, fy = dy / dist, fz = dz / dist;
    _clipN.set(fx, fy, fz);
    _clipP.set(carX, carY, carZ).addScaledVector(_clipN, -2.6);
    _clipDepth.normal.copy(_clipN);
    _clipDepth.constant = -_clipN.dot(_clipP);
    // (3) corridor walls — a constant-width slab, NOT an apex cone (a cone is a point at the lens and
    // only ±W/2 at mid-corridor, which leaves the SIDES of the trees). u = horizontal ⊥ the look axis
    // = normalize(f.z,0,−f.x); two VERTICAL planes ±W along u bound a ±W strip around the WHOLE eye→car
    // line. Removed (behind both) = within W m either side of the line of sight — "a few metres each side".
    const ul = Math.hypot(fz, fx) || 1, ux = fz / ul, uz = -fx / ul;   // unit horizontal ⊥ f
    const ue = ux * ex + uz * ez;                                      // u·E (u has no y component)
    _clipConeA.normal.set(ux, 0, uz);   _clipConeA.constant = -ue - W;   // behind ⇔ u·P < u·E + W
    _clipConeB.normal.set(-ux, 0, -uz); _clipConeB.constant = ue - W;    // behind ⇔ u·P > u·E − W
    planes.length = 0; planes.push(_clipHoriz, _clipDepth, _clipConeA, _clipConeB);
  }

  return { updateTileClip };
}
