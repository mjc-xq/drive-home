import * as THREE from 'three';
import { terrainAt } from '../data.js';
import { clamp } from '../coords.js';

// Ground-height authority: the photoreal-tile surface height under (x,z), via a cheap
// firstHitOnly down-ray, with a procedural-terrain fallback. This is the height source for
// ACTORS + CAMERA only — collision stays on the data (bldPolys/treePts), so that invariant is
// untouched. Highest-fanout helper in the engine (car physics, scoop, traffic, parked cars,
// nav markers, coins, cameras all call actorGroundY/groundAt). Reads ctx.p3dtiles; owns its own
// reused ray scratch (never shared across modules — that would alias per-frame casts).
export function createGround(ctx) {
  const _downRay = new THREE.Raycaster(); _downRay.firstHitOnly = true;
  const _gO = new THREE.Vector3(), _gD = new THREE.Vector3(0, -1, 0), _gHits = [];

  function rawTileY(x, z, fromY) {
    if (!ctx.p3dtiles || !ctx.p3dtiles.holder.visible) return null;
    // Cast from `fromY` (default high). Casting from just above an actor skips
    // tree canopies / eaves overhead, so we read the ROAD under them, not the
    // canopy — that's what keeps the car from climbing trees.
    // The tiles are drawn in render space (logical − renderOrigin), so probe there;
    // the hit Y is unaffected (the holder only offsets X/Z), so the caller's logical
    // height stays correct. renderOrigin is 0 near home → identical there.
    const oy = fromY != null ? fromY : 600;
    const rx = x - ctx.renderOrigin.x, rz = z - ctx.renderOrigin.z;
    _downRay.set(_gO.set(rx, oy, rz), _gD); _downRay.far = oy + 700; _gHits.length = 0;
    ctx.p3dtiles.raycast(_downRay, _gHits);
    return _gHits.length ? _gHits[0].point.y : null;
  }
  function groundAt(x, z, fallback, fromY) {
    const y = rawTileY(x, z, fromY);
    if (y != null) return y;
    return fallback != null ? fallback : terrainAt(x, z);
  }
  // Height the actor (car/keeper) AND its clean patch ride: the REAL photoreal
  // ROAD surface, sampled by casting down from just above the actor so it skips
  // tree canopies, and clamped to within ~2 m of the procedural terrain so a
  // photogrammetry blob can never lift the actor off the ground topology. This
  // keeps the flat patch co-planar with the 3D road (so the patch reads as the
  // road surface, not a layer the 3D rises over) while never climbing trees.
  function actorGroundY(x, z, prevY) {
    const tA = terrainAt(x, z);
    if (!ctx.p3dtiles || !ctx.p3dtiles.holder.visible) return tA;
    // Inside the procedural neighborhood (±330 m) the FLAT heightfield is ground
    // truth — ride it DIRECTLY. That's the whole point of the game: keep the
    // photoreal tiles fully VISIBLE for the high-res look, but drive on smooth,
    // aligned terrain with no photogrammetry bumps — no lumps under parked cars,
    // no climbing trees/curbs/roofs. (Bonus: skips the per-sample tile raycasts in
    // the common near-home case, so it's cheaper too.)
    if (x * x + z * z <= 330 * 330) return tA;
    // Far out, beyond the heightfield, there's no procedural topology to ride, so
    // follow the real photoreal ROAD. Cast DOWN from just above the actor's roof:
    // a tree canopy / eave ABOVE the car is skipped (the ray starts beneath it), so
    // we read the road under the foliage, not the leaves. Retry from progressively
    // higher only when that misses — i.e. the road climbed above the car (steep
    // hill / onto a bridge), the one case we DO want to follow upward.
    const base = prevY != null ? prevY : tA;
    let y = rawTileY(x, z, base + 2.2);
    if (y == null) y = rawTileY(x, z, base + 10);
    if (y == null) y = rawTileY(x, z, base + 26);
    if (y == null) y = rawTileY(x, z);                            // full-height last resort: also recovers after a teleport to ground far ABOVE the held height (e.g. Paris), which the incremental casts can't reach
    if (y == null) return prevY != null ? prevY : tA;             // tile not streamed yet: hold height
    if (prevY == null) return y;
    // A continent-scale teleport lands on ground hundreds of metres off the held
    // height; that's a real elevation change, not a tree/roof blob, so SNAP to it
    // instead of crawling +1.5 m/frame (which would strand the camera under the map).
    if (Math.abs(y - prevY) > 50) return y;
    // Out here terrainAt is just a clamped edge value — useless as a reference — so
    // bound by CONTINUITY instead: a real road never steps UP more than ~1.5 m
    // between samples, but a photogrammetry tree/roof blob does, so reject the
    // sudden climb (ride the surface beneath it) while letting the car settle
    // downhill freely. This is what keeps the car off the treetops out on the open
    // road, where there's no procedural topology to clamp against.
    return clamp(y, prevY - 6, prevY + 1.5);
  }

  return { rawTileY, groundAt, actorGroundY };
}
