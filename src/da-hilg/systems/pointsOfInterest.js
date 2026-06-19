// Points of interest — the landmarks NPCs stroll between while wandering. Derived
// once from the level metadata (house center + spawns) so they sit on walkable
// ground in recentered coords. Each POI carries an optional lookAt (turn to face
// the thing) and a rare emote (wave at the mailbox, cheer at the creek) so the
// family reads as alive — strolling, pausing, looking — not constantly dancing.
//
// pickWander() does navmesh-free target selection: weighted toward nearer POIs,
// never immediately repeating the last one, returning { pos, lookAt?, emote? }.

import * as THREE from 'three';

// Module-level cache: built once from levelMeta, shared by reference. Positions
// are THREE.Vector3 in recentered world space (house ≈ origin, ground ≈ y0).
/** @type {Array<{id:string,pos:THREE.Vector3,lookAt?:THREE.Vector3,emote?:string}>} */
let POIS = [];
let built = false;

/**
 * Derive ~5 points of interest near the house from level metadata. Idempotent —
 * safe to call again once levelMeta has loaded (rebuilds from the real numbers).
 * @param {any} levelMeta  refs.levelMeta
 * @returns {Array<{id:string,pos:THREE.Vector3,lookAt?:THREE.Vector3,emote?:string}>}
 */
export function buildPOIs(levelMeta) {
  const meta = levelMeta || {};
  const hc = meta.houseCenter || [0, 0, 0];
  const cx = hc[0];
  const cz = hc[2];
  const gy = typeof meta.groundY === 'number' ? meta.groundY : 0;
  const feet = gy + 0.05; // stand on the ground, not buried in it

  // Landmarks ringed around the house in the OPEN YARD — every point sits well
  // OUTSIDE the house footprint (~±12 x ±9 m) and biased to the front/side yard
  // (the +Z half, where the player spawns and the terrain is flat), so wanderers
  // stroll open ground instead of pressing into the building walls or off the
  // hill's back/creek edge. lookAt points back at the house so they face inward.
  const house = new THREE.Vector3(cx, feet + 1.4, cz);
  /** @type {Array<{id:string,pos:THREE.Vector3,lookAt?:THREE.Vector3,emote?:string}>} */
  const list = [
    {
      id: 'front_lawn',
      pos: new THREE.Vector3(cx + 0, feet, cz + 16),
      lookAt: house.clone(),
    },
    {
      id: 'driveway',
      pos: new THREE.Vector3(cx + 15, feet, cz + 11),
      lookAt: house.clone(),
      emote: 'wave',
    },
    {
      id: 'mailbox',
      pos: new THREE.Vector3(cx + 11, feet, cz + 18),
      lookAt: house.clone(),
      emote: 'wave',
    },
    {
      id: 'east_yard',
      pos: new THREE.Vector3(cx + 16, feet, cz - 1),
      lookAt: house.clone(),
    },
    {
      id: 'west_yard',
      pos: new THREE.Vector3(cx - 15, feet, cz + 9),
      lookAt: house.clone(),
      emote: 'cheer',
    },
    {
      id: 'corner_oak',
      pos: new THREE.Vector3(cx - 14, feet, cz + 17),
      lookAt: house.clone(),
    },
  ];

  POIS = list;
  built = true;
  return POIS;
}

/**
 * Pick the next wander destination for an actor: weighted toward nearer POIs,
 * avoiding the one it just visited. Returns a fresh-enough target object the
 * FSM stores on actor.ai.wanderTo.
 * @param {any} actor  registry actor
 * @param {any} ctx    per-frame context (uses ctx.levelMeta for lazy build)
 * @returns {{pos:THREE.Vector3, lookAt?:THREE.Vector3, emote?:string}}
 */
export function pickWander(actor, ctx) {
  // Lazy build in case the FSM ran before buildPOIs was called explicitly.
  if (!built) buildPOIs(ctx && ctx.levelMeta);
  if (POIS.length === 0) {
    // Degenerate fallback: hold position (home, or current pos).
    const home = actor.ai && actor.ai.home ? actor.ai.home : actor.motion.pos;
    return { pos: home.clone() };
  }

  const pos = actor.motion.pos;
  const lastId = actor.ai ? actor.ai.lastPoi : null;

  // Weight each candidate by inverse distance (nearer = more likely), skipping
  // the one we just came from so the family doesn't pace the same two spots.
  let total = 0;
  const weights = new Array(POIS.length);
  for (let i = 0; i < POIS.length; i++) {
    const p = POIS[i];
    if (p.id === lastId && POIS.length > 1) {
      weights[i] = 0;
      continue;
    }
    const dx = p.pos.x - pos.x;
    const dz = p.pos.z - pos.z;
    const d = Math.hypot(dx, dz);
    // +4 keeps very-close points from dominating; clamp avoids div-by-zero.
    const w = 1 / (d + 4);
    weights[i] = w;
    total += w;
  }

  // Weighted draw.
  let chosen = 0;
  if (total > 0) {
    let r = Math.random() * total;
    for (let i = 0; i < POIS.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        chosen = i;
        break;
      }
    }
  }

  const poi = POIS[chosen];
  if (actor.ai) actor.ai.lastPoi = poi.id;
  return {
    pos: poi.pos.clone(),
    lookAt: poi.lookAt ? poi.lookAt.clone() : undefined,
    emote: poi.emote,
  };
}
