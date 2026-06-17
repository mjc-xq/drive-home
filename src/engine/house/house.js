import * as THREE from 'three';
// House interior: enter/leave the house, and the non-playable NPC behaviour FSM with
// room-graph (BFS-through-doorways) navigation and dancing.
export function createHouse(ctx) {
  // Show/hide the interior. The yard is NOT hidden object-by-object — it's 2 km away and fogged
  // out — so this only flips the scene flag, the interior group, and yard-only pins.
  function setInside(on) {
    ctx.scoopScene = on ? 'interior' : 'yard';
    if (ctx.interior) ctx.interior.group.visible = on;
    if (on) { ctx.marker.visible = false; ctx.carMarker.visible = false; ctx.compostMarker.visible = false; ctx.doorMarker.visible = false; if (ctx.nearCar) { ctx.nearCar = false; ctx.emit('nearCar', false); } }
    else { ctx.exitMarker.visible = false; ctx.exitRing.visible = false; for (const npc of ctx.npcs) npc.group.visible = false; }
    ctx.emit('house', { inside: on, ready: !!ctx.interior });
  }
  function enterHouse(now) {
    if (!ctx.interior) return;
    ctx.houseSys.setInside(true);
    const sp = ctx.interior.spawn;
    ctx.CHAR.x = sp.x; ctx.CHAR.z = sp.z; ctx.CHAR.yaw = sp.yaw; ctx.camYawS = sp.yaw;
    ctx.CHAR.airY = 0; ctx.CHAR.vy = 0; ctx.camInit = false; ctx.szoom = 1; ctx.scPitch = 0.2; ctx.camGroundRef = null;   // reset tilt so indoor entry framing is consistent (not pinned to the ceiling)
    ctx.doorT = now + 1200; ctx.exitArmed = false;
    // House NPCs (dad, mom): lazy-load on first entry, then have each walk out of a room and dance.
    if (!ctx.npcsLoadStarted) {
      ctx.npcsLoadStarted = true;
      for (const load of ctx.NPC_LOADERS) load(ctrl => { if (ctx.disposed) return; const g = new THREE.Group(); g.add(ctrl.group); g.visible = false; ctx.scene.add(g); ctx.npcs.push({ ctrl, group: g, x: 0, z: 0, yaw: 0, state: 'act', act: 'idle', actUntil: 0 }); ctx.houseSys.resetNpcs(); }, () => {});
    } else ctx.houseSys.resetNpcs();
    if (ctx.audio.blip) ctx.audio.blip();
    ctx.toast('🏠 Inside the house! Open the ☰ menu (top-right) for characters &amp; actions · tap "Leave house 🚪" to head back out', 3600);
  }
  function playerRoomIndex() {
    const rs = ctx.interior.rooms;
    if (!rs || !rs.length) return 0;
    for (let i = 0; i < rs.length; i++) { const r = rs[i]; if (ctx.CHAR.x >= r.minX && ctx.CHAR.x <= r.maxX && ctx.CHAR.z >= r.minZ && ctx.CHAR.z <= r.maxZ) return i; }
    let best = 0, bd = Infinity; rs.forEach((r, i) => { const d = (r.x - ctx.CHAR.x) ** 2 + (r.z - ctx.CHAR.z) ** 2; if (d < bd) { bd = d; best = i; } }); return best;
  }
  // ---- ROOM-GRAPH NAVIGATION: NPCs PLAN a path room-to-room (BFS through doorways) instead of walking
  // a straight line into a wall and jamming. The rooms + doorways are static, so the connectivity graph
  // is built once and cached on `interior`. Each doorway connects the two rooms whose AABBs it sits on.
  function roomGraph() {
    if (ctx.interior._navGraph) return ctx.interior._navGraph;
    const rooms = ctx.interior.rooms || [], dws = ctx.interior.doorways || [];
    const adj = rooms.map(() => []);
    // Connect rooms whose floor AABBs ABUT (share a wall) — NOT by door-mesh containment, which left
    // most rooms isolated (the scan's door_* meshes are sparse + several openings have no door mesh).
    // The waypoint is the shared-border midpoint, snapped to a real doorway if one lines up within 1.5 m.
    const PAD = 0.6;   // ~wall thickness
    for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i], b = rooms[j];
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);   // overlap on X
      const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);   // overlap on Z
      const gapX = Math.max(a.minX - b.maxX, b.minX - a.maxX);          // >0 = separated on X
      const gapZ = Math.max(a.minZ - b.maxZ, b.minZ - a.maxZ);
      if (!((oz > 0.5 && gapX <= PAD) || (ox > 0.5 && gapZ <= PAD))) continue;   // not adjacent
      const bx = (Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2;
      const bz = (Math.max(a.minZ, b.minZ) + Math.min(a.maxZ, b.maxZ)) / 2;
      let door = { x: bx, z: bz }, bd = 1.5 * 1.5;                      // prefer a real door within 1.5 m of the shared border
      for (const d of dws) { const dd = (d.x - bx) ** 2 + (d.z - bz) ** 2; if (dd < bd) { bd = dd; door = d; } }
      adj[i].push({ to: j, door }); adj[j].push({ to: i, door });
    }
    return (ctx.interior._navGraph = adj);
  }
  function roomIndexAt(x, z) {
    const rooms = ctx.interior.rooms || [];
    // Prefer the CONTAINING room whose centroid is nearest — room AABBs can overlap in the scan, so the
    // first container isn't necessarily the right one. Fall back to the nearest centroid if none contains it.
    let best = -1, bd = Infinity, hit = false;
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i], inside = x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
      if (hit && !inside) continue;                       // once we've seen a container, only rank containers
      if (inside && !hit) { hit = true; bd = Infinity; }  // first container found — reset best to rank among containers only
      const d = (r.x - x) ** 2 + (r.z - z) ** 2; if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // The doorway to head for FIRST on the shortest room-path from `from` to `to` (BFS), or null if same
  // room / unreachable. Recomputed each frame: as the NPC clears one door its room index advances and
  // the next door takes over, so multi-room routes work without storing a path.
  function routeDoor(from, to) {
    if (from < 0 || to < 0 || from === to) return null;
    const adj = ctx.houseSys.roomGraph(); if (!adj[from]) return null;
    const prev = new Array(adj.length).fill(-2); prev[from] = -1;
    const prevDoor = new Array(adj.length).fill(null);
    const q = [from];
    for (let qi = 0; qi < q.length; qi++) { const u = q[qi]; if (u === to) break; for (const e of adj[u]) if (prev[e.to] === -2) { prev[e.to] = u; prevDoor[e.to] = e.door; q.push(e.to); } }
    if (prev[to] === -2) return null;
    let cur = to, door = null;
    while (prev[cur] !== -1) { if (prev[cur] === from) door = prevDoor[cur]; cur = prev[cur]; }
    return door;
  }
  function startTravel(npc, tx, tz) {
    npc.state = 'travel'; npc.target = [tx, tz];   // door routing is recomputed each frame in updateNpcs
    npc.stuckT = 0;
  }
  function triggerMove(npc, now) {
    const pool = npc.act === 'emote' && npc.ctrl.emotes.length ? npc.ctrl.emotes : npc.ctrl.dances;
    if (pool && pool.length && npc.ctrl.react) npc.ctrl.react(pool[(Math.random() * pool.length) | 0]);
    npc.nextMove = now + 3500 + Math.random() * 2500;
  }
  function enterActivity(npc, now) {
    npc.state = 'act';
    // Sit only if we actually reached the couch we set out for (a wall-jam arrival shouldn't teleport us).
    if (npc.wantSeat && npc.ctrl.sitClip && npc.ctrl.pose && Math.hypot(npc.wantSeat.x - npc.x, npc.wantSeat.z - npc.z) < 1.5) {
      const s = npc.wantSeat; npc.x = s.x; npc.z = s.z; npc.baseY = s.y; npc.yaw = s.yaw; npc.seat = s;
      npc.act = 'sit'; npc.ctrl.pose(npc.ctrl.sitClip); npc.actUntil = now + 8000 + Math.random() * 9000; npc.wantSeat = null; return;
    }
    npc.wantSeat = null; npc.baseY = ctx.interior.floorY;
    const roll = Math.random();
    if (roll < 0.45 && npc.ctrl.dances.length) { npc.act = 'dance'; npc.nextMove = 0; ctx.houseSys.triggerMove(npc, now); }
    else if (roll < 0.78 && (npc.ctrl.emotes.length || npc.ctrl.dances.length)) { npc.act = 'emote'; npc.nextMove = 0; ctx.houseSys.triggerMove(npc, now); }
    else { npc.act = 'idle'; npc.ctrl.locomotion(0); }
    npc.actUntil = now + 5000 + Math.random() * 7000;
  }
  function pickNextRoom(npc, now) {
    if (npc.ctrl.reset) npc.ctrl.reset();   // stand up from a sit / end any dance cleanly before walking
    npc.seat = null; npc.baseY = ctx.interior.floorY;
    const rs = ctx.interior.rooms;
    if (!rs || !rs.length) { npc.state = 'act'; npc.act = 'idle'; npc.actUntil = now + 4000; return; }   // no rooms (GLB w/o floors) — just idle
    const room = (Math.random() < 0.55 ? rs[ctx.houseSys.playerRoomIndex()] : rs[(Math.random() * rs.length) | 0]) || rs[0];
    let wantSeat = null;   // sometimes go sit on a free couch
    if (npc.ctrl.sitClip && ctx.interior.seats && ctx.interior.seats.length && Math.random() < 0.4) {
      const taken = new Set(ctx.npcs.map(n => n.seat).filter(Boolean));
      let bs = Infinity; for (const s of ctx.interior.seats) { if (taken.has(s)) continue; const d = (s.x - room.x) ** 2 + (s.z - room.z) ** 2; if (d < bs) { bs = d; wantSeat = s; } }
    }
    npc.wantSeat = wantSeat;
    let tx, tz;
    if (wantSeat) { const ap = ctx.interior.clearAt(wantSeat.x + Math.sin(wantSeat.yaw) * 0.75, wantSeat.z + Math.cos(wantSeat.yaw) * 0.75, ctx.NPC_RAD, true); tx = ap.x; tz = ap.z; }
    else { const p = ctx.interior.clearAt(room.minX + 0.6 + Math.random() * Math.max(0.2, room.maxX - room.minX - 1.2), room.minZ + 0.6 + Math.random() * Math.max(0.2, room.maxZ - room.minZ - 1.2), ctx.NPC_RAD, true); tx = p.x; tz = p.z; }
    ctx.houseSys.startTravel(npc, tx, tz);
  }
  // Each NPC starts in a distinct far room and heads for the main room, then wanders.
  function resetNpcs() {
    if (!ctx.interior || !ctx.interior.rooms || !ctx.interior.rooms.length || !ctx.npcs.length) return;
    ctx._syncDance = false; ctx._syncDanceNext = 0;   // re-arm the dance-party timer fresh on entry, so it doesn't fire instantly every time you step back inside
    const main = ctx.interior.spawn, now = performance.now();
    ctx.npcs.forEach((npc, i) => {
      if (npc.ctrl.reset) npc.ctrl.reset();
      // START clustered around the MAIN room (where the player enters) so they're together near you, not
      // scattered into far bedrooms they then get stuck pathing out of. They idle a beat, then wander off.
      const a = i / Math.max(1, ctx.npcs.length) * Math.PI * 2 + 0.4;
      const from = ctx.interior.clearAt(main.x + Math.cos(a) * 1.5, main.z + Math.sin(a) * 1.5, ctx.NPC_RAD, true);
      npc.x = from.x; npc.z = from.z; npc.yaw = Math.atan2(main.x - from.x, main.z - from.z); npc.seat = null; npc.wantSeat = null; npc.baseY = ctx.interior.floorY;
      npc.state = 'act'; npc.act = 'idle'; npc.actUntil = now + 2200 + Math.random() * 3500; npc.ctrl.locomotion(0);
      npc.group.visible = true; npc.group.position.set(npc.x, npc.baseY, npc.z);
    });
  }
  function updateNpcs(dt, now) {
    // SYNCHRONIZED DANCE PARTY: every ~30-55 s the whole house stops what it's doing and dances the
    // SAME clip together (pose() loops it, started on the same frame for all, so they stay in lockstep).
    if (!ctx._syncDanceNext) ctx._syncDanceNext = now + 20000 + Math.random() * 16000;
    if (ctx._syncDance && now > ctx._syncDanceUntil) { ctx._syncDance = false; ctx._syncDanceNext = now + 30000 + Math.random() * 25000; for (const npc of ctx.npcs) ctx.houseSys.pickNextRoom(npc, now); }
    else if (!ctx._syncDance && now > ctx._syncDanceNext && ctx.npcs.length > 1 && ctx.interior) {
      ctx._syncDance = true; ctx._syncDanceUntil = now + 11000 + Math.random() * 6000;
      const clip = ctx.SYNC_DANCES[(Math.random() * ctx.SYNC_DANCES.length) | 0];
      for (const npc of ctx.npcs) {
        npc.state = 'act'; npc.act = 'dance'; npc.seat = null; npc.wantSeat = null; npc.baseY = ctx.interior.floorY;
        npc.yaw = Math.atan2(ctx.interior.spawn.x - npc.x, ctx.interior.spawn.z - npc.z);   // turn in toward the middle → a little dance circle
        if (npc.ctrl.pose) npc.ctrl.pose(clip);
      }
    }
    for (const npc of ctx.npcs) {
      npc.group.visible = true;
      // GREET: when the player walks up, turn to face them and throw a quick move (not mid-party).
      if (!ctx._syncDance && npc.state === 'act' && now > (npc.greetT || 0)) {
        const dpx = ctx.CHAR.x - npc.x, dpz = ctx.CHAR.z - npc.z;
        if (dpx * dpx + dpz * dpz < 2.7 * 2.7) {
          npc.greetT = now + 6500;
          if (npc.seat) { if (npc.ctrl.reset) npc.ctrl.reset(); npc.seat = null; npc.baseY = ctx.interior.floorY; }   // get up off the couch first, else she'd "stand" floating at seat height + hog the seat
          npc.yaw = Math.atan2(dpx, dpz);                                          // look at the player
          const pool = (npc.ctrl.emotes && npc.ctrl.emotes.length) ? npc.ctrl.emotes : npc.ctrl.dances;
          if (pool && pool.length && npc.ctrl.react) { npc.ctrl.react(pool[(Math.random() * pool.length) | 0]); npc.act = 'emote'; npc.nextMove = now + 2600; npc.actUntil = Math.max(npc.actUntil || 0, now + 2600); }
        }
      }
      let speed = 0;
      if (ctx._syncDance) { npc.group.position.set(npc.x, npc.baseY, npc.z); npc.group.rotation.y = npc.yaw - Math.PI / 2; npc.ctrl.tick(dt); continue; }   // partying: hold position, the pose() loops
      if (npc.state === 'travel') {
        const gx = npc.target[0], gz = npc.target[1], finalD = Math.hypot(gx - npc.x, gz - npc.z);
        if (finalD < 0.5) ctx.houseSys.enterActivity(npc, now);
        else {
          // PLAN the path: find our room + the goal's room and head for the next DOORWAY on the BFS route
          // (not a straight line into a wall). Re-evaluated every frame, so clearing one door hands off to
          // the next. Far from the door → aim at it; close → aim at the goal so we step THROUGH it.
          let tx = gx, tz = gz;
          const cur = ctx.houseSys.roomIndexAt(npc.x, npc.z), goalRoom = ctx.houseSys.roomIndexAt(gx, gz);
          if (cur !== goalRoom) {
            let door = ctx.houseSys.routeDoor(cur, goalRoom);
            if (!door) { let bd = Infinity; for (const dw of (ctx.interior.doorways || [])) { const dd = (dw.x - npc.x) ** 2 + (dw.z - npc.z) ** 2; if (dd < bd) { bd = dd; door = dw; } } }   // graph said nothing → at least aim at the NEAREST opening, never a wall
            if (door && Math.hypot(door.x - npc.x, door.z - npc.z) > 0.3) { const px = gx - door.x, pz = gz - door.z, pl = Math.hypot(px, pz) || 1; tx = door.x + px / pl * 0.4; tz = door.z + pz / pl * 0.4; }   // aim ~0.4 m PAST the door toward the goal so the heading carries straight THROUGH the opening, not into the jamb
          }
          const dx = tx - npc.x, dz = tz - npc.z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d, want = ctx.NPC_SPD * dt;
          const r = ctx.interior.collide(npc.x, npc.z, npc.x + ux * want, npc.z + uz * want, ctx.NPC_RAD, true);
          const moved = Math.hypot(r.x - npc.x, r.z - npc.z);
          npc.x = r.x; npc.z = r.z; npc.yaw = Math.atan2(ux, uz); speed = moved / Math.max(dt, 1e-3);
          // "stuck" = collision is eating the step (a wall-jam) — judged by ACTUAL displacement, NOT
          // progress toward the final target, so routing to a side doorway waypoint can't false-trigger.
          if (moved < want * 0.35) { npc.stuckT += dt; if (npc.stuckT > 1.5) ctx.houseSys.enterActivity(npc, now); } else npc.stuckT = 0;
        }
        npc.baseY = ctx.interior.floorY; npc.ctrl.locomotion(speed);
      } else {   // 'act' — staying put; sit holds, dance/emote cycle, idle just loops
        if (now > npc.actUntil) ctx.houseSys.pickNextRoom(npc, now);
        else if ((npc.act === 'dance' || npc.act === 'emote') && now > (npc.nextMove || 0)) ctx.houseSys.triggerMove(npc, now);
      }
      npc.group.position.set(npc.x, npc.baseY, npc.z);
      npc.group.rotation.y = npc.yaw - Math.PI / 2;
      npc.ctrl.tick(dt);
    }
  }
  function leaveHouse(now) {
    ctx.houseSys.setInside(false);
    if (ctx.entryPt) { ctx.CHAR.x = ctx.entryPt[0] + ctx.entryU[0] * 1.6; ctx.CHAR.z = ctx.entryPt[1] + ctx.entryU[1] * 1.6; ctx.CHAR.yaw = Math.atan2(ctx.entryU[0], ctx.entryU[1]); }
    ctx.camYawS = ctx.CHAR.yaw; ctx.CHAR.airY = 0; ctx.CHAR.vy = 0; ctx.camInit = false; ctx.szoom = 1; ctx.camGroundRef = null;
    ctx.doorT = now + 1200; ctx.entryArmed = false;
    if (ctx.audio.blip) ctx.audio.blip();
  }
  return { setInside, enterHouse, leaveHouse, playerRoomIndex, roomGraph, roomIndexAt, routeDoor, startTravel, triggerMove, enterActivity, pickNextRoom, resetNpcs, updateNpcs };
}
