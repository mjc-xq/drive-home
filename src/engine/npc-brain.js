// ============================================================================
// npc-brain.js — calm, varied behaviour "AI" for the rigged house/yard NPCs.
//
// Replaces the old dance-heavy FSM (45% dance + 33% emote + a sync-party every
// ~40s). Now an NPC mostly IDLES, WANDERS, and INSPECTS things; emotes are
// SPRINKLED in (cooldown-gated) and dancing is rare. In a scene that has animals
// (the yard) it can also CHASE a critter — or briefly get chased (FLEE).
//
// The engine still owns the NPC records + their makeController() controllers;
// this module only reads/writes `npc.brain` and calls ctrl.{locomotion,react,
// pose,reset,tick}. See npc-staging/INTEGRATION.md for the ~6-line wiring.
//
// ── data contract ──────────────────────────────────────────────────────────
//   npc   = { ctrl, group, x, z, yaw, baseY, brain? }            // engine-owned
//   ctrl  = { locomotion(spd), react(name), pose(name), reset(), tick(dt),
//             dances:[…], emotes:[…], sitClip:null|name,
//             idleClip?:name, lookClip?:name }                   // per-character
//   world = {                                                    // per-scene view
//     now,                       // performance.now()
//     speed, radius,             // NPC walk speed (m/s) + collision radius
//     floorY,                    // ground height the NPC stands on
//     nav   | null,              // makeNav(interior) — room graph (interior only)
//     props,                     // [{x,z,yaw}] inspectables (couches, shelves…)
//     seats,                     // [{x,z,y,yaw}] sit targets (or [])
//     collide(px,pz,nx,nz,rad),  // -> {x,z}  (interior.collide / a yard clamp)
//     player,                    // {x,z} the avatar — for greet + personal space
//     animals,                   // [{x,z,kind}] or []   (yard only)
//     spookAnimal?(a,x,z,now),   // optional: make animal `a` bolt away from x,z
//   }
// ============================================================================

const TAU = Math.PI * 2;
const rand = () => Math.random();
const pick = arr => arr[(rand() * arr.length) | 0];
const dist2 = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
function wrapPi(a) { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; }

// ── nav: room graph + door routing (interior only) ─────────────────────────
// Ported from the old engine roomGraph/roomIndexAt/routeDoor. Adjacency comes
// from room AABBs that ABUT (share a wall) — NOT door-mesh containment, which
// left most rooms isolated. Each link's waypoint is the shared-border midpoint,
// snapped to a real doorway when one lines up within 1.5 m.
export function makeNav(interior) {
  const rooms = interior.rooms || [], dws = interior.doorways || [];
  const adj = rooms.map(() => []);
  const PAD = 0.6;   // ~wall thickness
  for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
    const a = rooms[i], b = rooms[j];
    const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);   // overlap on X
    const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);   // overlap on Z
    const gapX = Math.max(a.minX - b.maxX, b.minX - a.maxX);
    const gapZ = Math.max(a.minZ - b.maxZ, b.minZ - a.maxZ);
    if (!((oz > 0.5 && gapX <= PAD) || (ox > 0.5 && gapZ <= PAD))) continue;   // not adjacent
    const bx = (Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2;
    const bz = (Math.max(a.minZ, b.minZ) + Math.min(a.maxZ, b.maxZ)) / 2;
    let door = { x: bx, z: bz }, bd = 1.5 * 1.5;
    for (const d of dws) { const dd = dist2(d.x, d.z, bx, bz); if (dd < bd) { bd = dd; door = d; } }
    adj[i].push({ to: j, door }); adj[j].push({ to: i, door });
  }
  // index of the room CONTAINING (x,z) (prefer the nearest-centroid container on
  // overlap), else the nearest room centroid.
  function roomAt(x, z) {
    let best = -1, bd = Infinity, hit = false;
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i], inside = x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
      if (hit && !inside) continue;
      if (inside && !hit) { hit = true; bd = Infinity; }
      const d = dist2(r.x, r.z, x, z); if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // first doorway on the shortest room-path from→to (BFS), or null.
  function routeDoor(from, to) {
    if (from < 0 || to < 0 || from === to || !adj[from]) return null;
    const prev = new Array(adj.length).fill(-2), prevDoor = new Array(adj.length).fill(null);
    prev[from] = -1; const q = [from];
    for (let qi = 0; qi < q.length; qi++) { const u = q[qi]; if (u === to) break; for (const e of adj[u]) if (prev[e.to] === -2) { prev[e.to] = u; prevDoor[e.to] = e.door; q.push(e.to); } }
    if (prev[to] === -2) return null;
    let cur = to, door = null;
    while (prev[cur] !== -1) { if (prev[cur] === from) door = prevDoor[cur]; cur = prev[cur]; }
    return door;
  }
  const nearestDoor = (x, z) => { let bd = Infinity, best = null; for (const d of dws) { const dd = dist2(d.x, d.z, x, z); if (dd < bd) { bd = dd; best = d; } } return best; };
  return { rooms, adj, doorways: dws, roomAt, routeDoor, nearestDoor };
}

// derive inspectable "props" from an interior: the seats (couches/chairs) plus
// each room's centre as a "stand and look around" spot. Cheap + needs no new
// interior data. Pass the result as world.props.
export function propsFromInterior(interior) {
  const props = [];
  for (const s of (interior.seats || [])) props.push({ x: s.x, z: s.z, yaw: s.yaw });
  for (const r of (interior.rooms || [])) props.push({ x: r.x, z: r.z, yaw: null });   // null yaw → face wherever you arrived from
  return props;
}

// ── movement: one walk step toward (tx,tz), routed through doorways ─────────
// Returns the achieved speed (m/s) so the caller can drive ctrl.locomotion().
function walkStep(npc, tx, tz, dt, world) {
  let wx = tx, wz = tz;
  if (world.nav) {                                   // interior: head for the next doorway on the BFS route
    const cur = world.nav.roomAt(npc.x, npc.z), goal = world.nav.roomAt(tx, tz);
    if (cur !== goal && cur >= 0 && goal >= 0) {
      const door = world.nav.routeDoor(cur, goal) || world.nav.nearestDoor(npc.x, npc.z);
      if (door && Math.hypot(door.x - npc.x, door.z - npc.z) > 0.3) {
        const px = tx - door.x, pz = tz - door.z, pl = Math.hypot(px, pz) || 1;
        wx = door.x + px / pl * 0.4; wz = door.z + pz / pl * 0.4;   // aim ~0.4 m PAST the door so the heading carries THROUGH it
      }
    }
  }
  const dx = wx - npc.x, dz = wz - npc.z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d;
  const want = world.speed * dt;
  let nx = npc.x + ux * want, nz = npc.z + uz * want;
  if (world.collide) { const r = world.collide(npc.x, npc.z, nx, nz, world.radius); nx = r.x; nz = r.z; }
  const moved = Math.hypot(nx - npc.x, nz - npc.z);
  npc.x = nx; npc.z = nz; npc.yaw = Math.atan2(ux, uz);
  return moved / Math.max(dt, 1e-3);
}

// face (tx,tz), easing the yaw so the turn reads naturally.
function faceToward(npc, tx, tz, dt, rate = 6) {
  const want = Math.atan2(tx - npc.x, tz - npc.z);
  npc.yaw += wrapPi(want - npc.yaw) * (1 - Math.exp(-dt * rate));
}

// a random reachable point inside a room (prefer the player's room sometimes), or
// null for an open scene (the yard) — the caller then picks a point near the NPC.
function wanderTarget(world) {
  if (world.nav && world.nav.rooms.length) {
    const rs = world.nav.rooms;
    const r = (rand() < 0.45 && world.player) ? rs[world.nav.roomAt(world.player.x, world.player.z)] || pick(rs) : pick(rs);
    return [r.minX + 0.6 + rand() * Math.max(0.3, r.maxX - r.minX - 1.2),
            r.minZ + 0.6 + rand() * Math.max(0.3, r.maxZ - r.minZ - 1.2)];
  }
  return null;
}

// ── the ACTION table ───────────────────────────────────────────────────────
// Each action: { weight(npc,world), enter(npc,world), tick(npc,dt,world)->bool }
//   weight  — relative likelihood of being chosen (0 = unavailable right now)
//   enter   — set up targets / fire a clip
//   tick    — advance; return TRUE when finished (then a new action is chosen)
// Cooldowns live on npc.brain.cool so emote/dance/greet/etc. stay SPRINKLED.
const COOL = { emote: 16000, dance: 70000, greet: 7000, inspect: 9000, chase: 14000, sit: 25000 };

const ACTIONS = {
  // stand and breathe; occasionally glance around. The DOMINANT state.
  idle: {
    weight: () => 30,
    enter(npc, world) {
      const b = npc.brain;
      b.until = world.now + 2600 + rand() * 4200;
      b.glanceT = world.now + 1200 + rand() * 1800;
      if (npc.ctrl.idleClip && npc.ctrl.pose) npc.ctrl.pose(npc.ctrl.idleClip);   // a real STAND clip if the rig has one
      else npc.ctrl.locomotion(0);
    },
    tick(npc, dt, world) {
      const b = npc.brain;
      if (world.now > b.glanceT) { b.glanceYaw = npc.yaw + (rand() - 0.5) * 1.4; b.glanceT = world.now + 1800 + rand() * 2600; }
      if (b.glanceYaw != null) npc.yaw += wrapPi(b.glanceYaw - npc.yaw) * (1 - Math.exp(-dt * 3));
      if (!npc.ctrl.idleClip) npc.ctrl.locomotion(0);
      return world.now > b.until;
    },
  },

  // stroll to a point in a (usually nearby) room, then we're done → next action.
  wander: {
    weight: (npc, world) => (world.nav && world.nav.rooms.length) || world.openWander ? 26 : 0,
    enter(npc, world) {
      const b = npc.brain;
      let t = wanderTarget(world);
      if (!t) { const a = rand() * TAU, rr = 2 + rand() * 5; t = [npc.x + Math.cos(a) * rr, npc.z + Math.sin(a) * rr]; }
      b.target = t; b.stuckT = 0; b.until = world.now + 12000;   // hard timeout so a wall-jam can't trap us
    },
    tick(npc, dt, world) {
      const b = npc.brain, [tx, tz] = b.target;
      if (Math.hypot(tx - npc.x, tz - npc.z) < 0.5 || world.now > b.until) { npc.ctrl.locomotion(0); return true; }
      const spd = walkStep(npc, tx, tz, dt, world);
      npc.ctrl.locomotion(spd);
      if (spd < world.speed * 0.35) { b.stuckT += dt; if (b.stuckT > 1.4) return true; } else b.stuckT = 0;
      return false;
    },
  },

  // walk up to a prop, face it, and have a brief LOOK (a soft look-beat or just a
  // curious idle), then move on. The "walk up to things and inspect them" verb.
  inspect: {
    weight: (npc, world) => (world.props && world.props.length && world.now > npc.brain.cool.inspect) ? 24 : 0,
    enter(npc, world) {
      const b = npc.brain;
      // a prop near us, biased to the closest few
      let best = null, bd = Infinity;
      for (const p of world.props) { const d = dist2(p.x, p.z, npc.x, npc.z); if (d > 0.6 && d < bd && (best == null || rand() < 0.7)) { bd = d; best = p; } }
      b.prop = best || pick(world.props);
      b.phase = 'walk'; b.stuckT = 0; b.until = world.now + 11000;
      b.cool.inspect = world.now + COOL.inspect;
    },
    tick(npc, dt, world) {
      const b = npc.brain, p = b.prop; if (!p) return true;
      // approach a point ~0.7 m off the prop face (or just outside it)
      const fy = p.yaw != null ? p.yaw : Math.atan2(npc.x - p.x, npc.z - p.z);
      const sx = p.x + Math.sin(fy) * 0.7, sz = p.z + Math.cos(fy) * 0.7;
      if (b.phase === 'walk') {
        if (Math.hypot(sx - npc.x, sz - npc.z) < 0.45 || world.now > b.until) { b.phase = 'look'; b.until = world.now + 2400 + rand() * 2600; npc.ctrl.locomotion(0); if (npc.ctrl.lookClip && npc.ctrl.react) npc.ctrl.react(npc.ctrl.lookClip); }
        else { const spd = walkStep(npc, sx, sz, dt, world); npc.ctrl.locomotion(spd); if (spd < world.speed * 0.35) { b.stuckT += dt; if (b.stuckT > 1.4) { b.phase = 'look'; b.until = world.now + 1800; } } else b.stuckT = 0; }
        return false;
      }
      faceToward(npc, p.x, p.z, dt, 7);   // study it
      if (!npc.ctrl.lookClip) npc.ctrl.locomotion(0);
      return world.now > b.until;
    },
  },

  // a SINGLE sprinkled emote from the FULL pool (cycled so it doesn't repeat),
  // facing the player when they're near. Cooldown-gated so it's an accent, not a loop.
  emote: {
    weight: (npc, world) => ((npc.ctrl.emotes.length || npc.ctrl.dances.length) && world.now > npc.brain.cool.emote) ? 7 : 0,
    enter(npc, world) {
      const b = npc.brain;
      const pool = npc.ctrl.emotes.length ? npc.ctrl.emotes : npc.ctrl.dances;
      let clip = pick(pool); if (pool.length > 1 && clip === b.lastEmote) clip = pick(pool);
      b.lastEmote = clip;
      if (world.player && dist2(world.player.x, world.player.z, npc.x, npc.z) < 4 * 4) faceToward(npc, world.player.x, world.player.z, 1, 99);
      if (npc.ctrl.react) npc.ctrl.react(clip);
      b.until = world.now + 2600 + rand() * 1400;   // react() auto-returns to idle; this just bounds the slot
      b.cool.emote = world.now + COOL.emote;
    },
    tick(npc, dt, world) { return world.now > npc.brain.until; },
  },

  // RARE dance — a held loop for a bit, then stand back up. Long cooldown.
  dance: {
    weight: (npc, world) => (npc.ctrl.dances.length && world.now > npc.brain.cool.dance) ? 3 : 0,
    enter(npc, world) {
      const b = npc.brain;
      if (npc.ctrl.pose) npc.ctrl.pose(pick(npc.ctrl.dances));
      b.until = world.now + 6000 + rand() * 5000; b.cool.dance = world.now + COOL.dance;
    },
    tick(npc, dt, world) { if (world.now > npc.brain.until) { if (npc.ctrl.reset) npc.ctrl.reset(); return true; } return false; },
  },

  // sit on a free couch for a while (mom has a sit clip; others skip — weight 0).
  sit: {
    weight: (npc, world) => (npc.ctrl.sitClip && world.seats && world.seats.length && world.now > npc.brain.cool.sit) ? 12 : 0,
    enter(npc, world) {
      const b = npc.brain;
      const taken = new Set(world._sitTaken || []);
      let best = null, bd = Infinity; for (const s of world.seats) { if (taken.has(s)) continue; const d = dist2(s.x, s.z, npc.x, npc.z); if (d < bd) { bd = d; best = s; } }
      b.seat = best; b.phase = 'walk'; b.stuckT = 0; b.until = world.now + 12000;
      b.cool.sit = world.now + COOL.sit;
    },
    tick(npc, dt, world) {
      const b = npc.brain, s = b.seat; if (!s) return true;
      if (b.phase === 'walk') {
        const ax = s.x + Math.sin(s.yaw) * 0.7, az = s.z + Math.cos(s.yaw) * 0.7;
        if (Math.hypot(ax - npc.x, az - npc.z) < 0.5) { npc.x = s.x; npc.z = s.z; npc.baseY = s.y; npc.yaw = s.yaw; npc.seat = s; b.phase = 'sit'; b.until = world.now + 8000 + rand() * 9000; if (npc.ctrl.pose) npc.ctrl.pose(npc.ctrl.sitClip); }
        else if (world.now > b.until) return true;
        else { const spd = walkStep(npc, ax, az, dt, world); npc.ctrl.locomotion(spd); if (spd < world.speed * 0.35) { b.stuckT += dt; if (b.stuckT > 1.6) return true; } else b.stuckT = 0; }
        return false;
      }
      if (world.now > b.until) { if (npc.ctrl.reset) npc.ctrl.reset(); npc.seat = null; npc.baseY = world.floorY; b.seat = null; return true; }
      return false;
    },
  },

  // YARD ONLY — pursue the nearest critter; it bolts (via world.spookAnimal). Back
  // off after a few seconds or once it's got away. Gated by range + cooldown.
  chase: {
    weight: (npc, world) => {
      if (!world.animals || !world.animals.length || world.now < npc.brain.cool.chase) return 0;
      for (const a of world.animals) if (dist2(a.x, a.z, npc.x, npc.z) < 9 * 9) return 18;
      return 0;
    },
    enter(npc, world) {
      const b = npc.brain;
      let best = null, bd = Infinity; for (const a of world.animals) { const d = dist2(a.x, a.z, npc.x, npc.z); if (d < bd) { bd = d; best = a; } }
      b.prey = best; b.until = world.now + 3500 + rand() * 2500; b.cool.chase = world.now + COOL.chase;
    },
    tick(npc, dt, world) {
      const b = npc.brain, a = b.prey; if (!a) return true;
      const d = Math.hypot(a.x - npc.x, a.z - npc.z);
      if (world.spookAnimal) world.spookAnimal(a, npc.x, npc.z, world.now);   // make it flee the NPC, not just the player
      if (world.now > b.until || d > 11) { npc.ctrl.locomotion(0); return true; }
      const spd = walkStep(npc, a.x, a.z, dt, world);
      npc.ctrl.locomotion(Math.max(spd, world.speed));   // a little hustle while chasing
      return false;
    },
  },

  // YARD ONLY — playful "the iguana came at me!": scurry away from a too-close critter.
  flee: {
    weight: () => 0,   // reactive only (see runReactive); never chosen by the weighted picker
    enter(npc, world) { const b = npc.brain; b.until = world.now + 1400 + rand() * 1000; },
    tick(npc, dt, world) {
      const b = npc.brain, a = b.threat;
      if (!a || world.now > b.until) { npc.ctrl.locomotion(0); return true; }
      const away = Math.atan2(npc.x - a.x, npc.z - a.z);
      const spd = walkStep(npc, npc.x + Math.sin(away) * 3, npc.z + Math.cos(away) * 3, dt, world);
      npc.ctrl.locomotion(Math.max(spd, world.speed * 1.1));
      return false;
    },
  },
};

// reactive interrupts that can preempt the running action (greet the player; flee
// an animal that's right on top of us). Returns an action name to switch to, or null.
function runReactive(npc, world) {
  const b = npc.brain;
  // flee: a critter is < ~1.2 m and we rolled the "spooked" dice
  if (world.animals && b.action !== 'flee' && b.action !== 'chase') {
    for (const a of world.animals) if (dist2(a.x, a.z, npc.x, npc.z) < 1.2 * 1.2 && rand() < 0.5) { b.threat = a; return 'flee'; }
  }
  // greet: the player walked up — face them + a quick wave, then carry on
  if (world.player && b.action !== 'greet' && world.now > b.cool.greet && dist2(world.player.x, world.player.z, npc.x, npc.z) < 2.6 * 2.6) {
    b.cool.greet = world.now + COOL.greet;
    if (npc.seat && npc.ctrl.reset) { npc.ctrl.reset(); npc.seat = null; npc.baseY = world.floorY; }
    faceToward(npc, world.player.x, world.player.z, 1, 99);
    const pool = npc.ctrl.emotes.length ? npc.ctrl.emotes : npc.ctrl.dances;
    if (pool.length && npc.ctrl.react) { npc.ctrl.react(pick(pool)); b.action = 'emote'; b.until = world.now + 2400; return null; }   // borrow the emote slot, don't re-enter
  }
  return null;
}

// weighted choice over the available actions for this npc right now.
function chooseAction(npc, world) {
  let total = 0; const opts = [];
  for (const name in ACTIONS) { const w = ACTIONS[name].weight(npc, world); if (w > 0) { total += w; opts.push([name, total]); } }
  if (!total) return 'idle';
  const r = rand() * total;
  for (const [name, acc] of opts) if (r < acc) return name;
  return 'idle';
}

function switchTo(npc, name, world) {
  npc.brain.action = name; npc.brain.phase = null;
  ACTIONS[name].enter(npc, world);
}

// ── public API ──────────────────────────────────────────────────────────────
// place NPCs clustered near a spawn point, all idling. Call on entering a scene.
export function resetNpcs(npcs, world, spawn) {
  const now = world.now;
  npcs.forEach((npc, i) => {
    if (npc.ctrl.reset) npc.ctrl.reset();
    const a = i / Math.max(1, npcs.length) * TAU + 0.4;
    const px = spawn.x + Math.cos(a) * 1.5, pz = spawn.z + Math.sin(a) * 1.5;
    const c = world.clearAt ? world.clearAt(px, pz, world.radius) : { x: px, z: pz };
    npc.x = c.x; npc.z = c.z; npc.yaw = Math.atan2(spawn.x - c.x, spawn.z - c.z);
    npc.seat = null; npc.baseY = world.floorY;
    npc.brain = { action: 'idle', until: now + 1500 + rand() * 2500, cool: { emote: now + 4000, dance: now + 20000, greet: 0, inspect: now + 3000, chase: now + 5000, sit: now + 8000 } };
    ACTIONS.idle.enter(npc, world);
    npc.group.visible = true; npc.group.position.set(npc.x, npc.baseY, npc.z);
  });
}

// per-frame tick for every NPC. `world` is rebuilt by the caller each frame.
export function updateNpcs(npcs, dt, world) {
  // who's currently on a seat (so two NPCs don't claim the same couch)
  world._sitTaken = npcs.map(n => n.seat).filter(Boolean);
  for (const npc of npcs) {
    if (!npc.brain) npc.brain = { action: 'idle', until: 0, cool: { emote: 0, dance: 0, greet: 0, inspect: 0, chase: 0, sit: 0 } };
    npc.group.visible = true;
    const react = runReactive(npc, world);
    if (react) switchTo(npc, react, world);
    if (ACTIONS[npc.brain.action].tick(npc, dt, world)) switchTo(npc, chooseAction(npc, world), world);
    npc.group.position.set(npc.x, npc.baseY, npc.z);
    npc.group.rotation.y = npc.yaw - Math.PI / 2;
    npc.ctrl.tick(dt);
  }
}

// optional: every so often the WHOLE house does the same dance together (kept as a
// rare special moment, not the constant party it used to be). Call when you want it
// (e.g. once after the yard is cleaned). Returns true if it started one.
export function partyDance(npcs, world, clip) {
  if (npcs.length < 2) return false;
  for (const npc of npcs) {
    npc.seat = null; npc.baseY = world.floorY;
    faceToward(npc, world.center ? world.center.x : npc.x, world.center ? world.center.z : npc.z, 1, 99);
    if (npc.ctrl.pose) npc.ctrl.pose(clip);
    npc.brain.action = 'dance'; npc.brain.until = world.now + 9000 + Math.random() * 4000; npc.brain.cool.dance = world.now + COOL.dance;
  }
  return true;
}
