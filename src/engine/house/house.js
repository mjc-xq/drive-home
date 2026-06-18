import * as THREE from 'three';
import { makeNav, propsFromInterior, resetNpcs as brainReset, updateNpcs as brainUpdate, partyDance } from '../npc-brain.js';
// House interior: enter/leave the house + the non-playable NPC behaviour. The behaviour AI
// (idle / wander / inspect / sprinkled emotes / rare dance / sit / greet) lives in npc-brain.js;
// this module just owns the scene transitions and builds the per-frame `world` view for it.
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
    // House NPCs (dad, mom): lazy-load on first entry, then hand them to the behaviour brain.
    if (!ctx.npcsLoadStarted) {
      ctx.npcsLoadStarted = true;
      for (const load of ctx.NPC_LOADERS) load(ctrl => { if (ctx.disposed) return; const g = new THREE.Group(); g.add(ctrl.group); g.visible = false; ctx.scene.add(g); ctx.npcs.push({ ctrl, group: g, x: 0, z: 0, yaw: 0, baseY: ctx.interior ? ctx.interior.floorY : 0 }); ctx.houseSys.resetNpcs(); }, () => {});
    } else ctx.houseSys.resetNpcs();
    if (ctx.audio.blip) ctx.audio.blip();
    ctx.toast('🏠 Inside the house! Open the ☰ menu (top-right) for characters &amp; actions · tap "Leave house 🚪" to head back out', 3600);
  }

  // The per-frame view the brain needs of the INTERIOR scene. nav (room-graph BFS) + props
  // (inspectables) are static, so they're built once and cached on ctx. No animals indoors.
  function houseWorld(now) {
    if (!ctx._houseNav && ctx.interior) ctx._houseNav = makeNav(ctx.interior);
    if (!ctx._houseProps && ctx.interior) ctx._houseProps = propsFromInterior(ctx.interior);
    return {
      now, speed: ctx.NPC_SPD, radius: ctx.NPC_RAD, floorY: ctx.interior.floorY,
      nav: ctx._houseNav, props: ctx._houseProps, seats: ctx.interior.seats || [],
      collide: (px, pz, nx, nz, rad) => ctx.interior.collide(px, pz, nx, nz, rad, true),
      clearAt: (x, z, rad) => ctx.interior.clearAt(x, z, rad, true),
      player: ctx.CHAR, animals: [], center: ctx.interior.spawn,
    };
  }
  // Place the NPCs clustered near the entry, all calmly idling.
  function resetNpcs() {
    if (!ctx.interior || !ctx.interior.rooms || !ctx.interior.rooms.length || !ctx.npcs.length) return;
    ctx._syncDanceNext = 0;   // clear any pending party so it doesn't fire instantly on re-entry
    brainReset(ctx.npcs, houseWorld(performance.now()), ctx.interior.spawn);
  }
  function updateNpcs(dt, now) {
    if (!ctx.interior) return;
    const world = houseWorld(now);
    // RARE celebration: a yard-cleaned event sets _syncDanceNext to a past time → the whole house
    // does ONE synchronized dance, then everyone returns to normal behaviour. No periodic auto-party.
    if (ctx._syncDanceNext && now > ctx._syncDanceNext) { ctx._syncDanceNext = 0; partyDance(ctx.npcs, world, ctx.SYNC_DANCES[(Math.random() * ctx.SYNC_DANCES.length) | 0]); }
    brainUpdate(ctx.npcs, dt, world);
  }

  function leaveHouse(now) {
    ctx.houseSys.setInside(false);
    if (ctx.entryPt) { ctx.CHAR.x = ctx.entryPt[0] + ctx.entryU[0] * 1.6; ctx.CHAR.z = ctx.entryPt[1] + ctx.entryU[1] * 1.6; ctx.CHAR.yaw = Math.atan2(ctx.entryU[0], ctx.entryU[1]); }
    ctx.camYawS = ctx.CHAR.yaw; ctx.CHAR.airY = 0; ctx.CHAR.vy = 0; ctx.camInit = false; ctx.szoom = 1; ctx.camGroundRef = null;
    ctx.doorT = now + 1200; ctx.entryArmed = false;
    if (ctx.audio.blip) ctx.audio.blip();
  }
  return { setInside, enterHouse, leaveHouse, resetNpcs, updateNpcs };
}
