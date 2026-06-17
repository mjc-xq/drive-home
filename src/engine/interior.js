import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clamp } from './coords.js';
import interiorUrl from '../assets/house-interior.glb';
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';
import couchyUrl from '../assets/couchy.usdz';
import cageUrl from '../assets/stash.glb';
import guineasUrl from '../assets/guineas.glb';
import phebUrl from '../assets/pheb.glb';

// The house interior is a furniture-segmented room scan (PLAIN GLB — no Draco, no animations,
// no extensions, so the stock GLTFLoader loads it). Names live on NODES (every mesh.name is
// undefined), so we categorise by node name: 56 wall_* + 18 joint_* (structure), 12 door_*
// (passable openings), 10 floor_* (per-room ground), and the named furniture.
//
// It is mounted FAR from the yard (the engine places it ~2 km away). In Scoop the fog is pulled
// in tight (near 38 / far 92), so when the indoor camera is at the interior the whole yard is
// fogged to the background and never drawn — no per-object hide needed. The room floats as a
// roofless dollhouse under the sky (the scan has no ceiling); more rooms come later.
const FLOOR_RE = /^floor_/;
const WALL_RE = /^(wall_|joint_)/;
const DOOR_RE = /^door_/;
// Only the big floor-standing pieces a walking kid can bump into get colliders. Chairs and the
// wall-hugging mid/low cabinets are skipped — they're already covered by the wall colliders.
// Movement is blocked by ALL furniture (everything that isn't floor/wall/door/window) EXCEPT chairs,
// which stay walk-through so a dining table's 4 chairs don't cluster into an impassable ring. Doorways
// stay open because movement uses the floor footprint, so solid furniture no longer traps you.

const nameOf = o => o.name || (o.parent && o.parent.name) || '';
const boxXZ = (b, pad = 0) => [b.min.x - pad, b.max.x + pad, b.min.z - pad, b.max.z + pad];

// createInterior(scene, {cx,cz,floorY}, onReady, onFail) -> cancel()
// Loads + normalises the interior, builds collision data in WORLD space, and hands back a small
// module: { group, floorY, ceilingY, roomAABB, spawn, collide, clampCam }. Fail-soft.
export function createInterior(scene, { cx = 0, cz = 0, floorY = 0 }, onReady, onFail) {
  let cancelled = false;
  new GLTFLoader().load(interiorUrl, g => {
    if (cancelled) return;
    const model = g.scene;
    model.updateMatrixWorld(true);
    const floors = [], walls = [], doors = [], furniture = [], sofas = [], windows = [], cabinets = [], shelves = [];
    model.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false;
      const n = nameOf(o);
      if (FLOOR_RE.test(n)) floors.push(o);
      else if (WALL_RE.test(n)) walls.push(o);
      else if (DOOR_RE.test(n)) doors.push(o);
      else if (/^window/.test(n)) windows.push(o);
      else if (/^chair/.test(n)) { /* chairs stay walk-through (see-through only) — a table's 4 chairs would otherwise cluster into an impassable ring */ }
      else { furniture.push(o); if (/^sofa/.test(n)) sofas.push(o); else if (/^storage_cabinet/.test(n)) cabinets.push(o); else if (/^storage_shelf/.test(n)) shelves.push(o); }   // EVERYTHING else (tables, cabinets, appliances, sofas, beds, …) is solid
    });
    // Double-side the walls so inward-facing faces aren't black, and lift any near-black scan
    // material a touch so rooms read (the scan's albedo can be very dark).
    model.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const wall = WALL_RE.test(nameOf(o));
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m) continue;
        if (wall) m.side = THREE.DoubleSide;
        if (m.metalness !== undefined) m.metalness = Math.min(m.metalness, 0.3);
        if (m.roughness !== undefined) m.roughness = Math.max(m.roughness, 0.9);   // less shiny -> less blown out
        if (m.color) m.color.multiplyScalar(0.7);                                  // tame the bright scan albedo (was washed out)
      }
    });

    // Recenter: floor TOP (not min.y — that would sink the character ~10cm) to world floorY,
    // and the footprint centre to (cx,cz). floor_* tops give the true standing height.
    const tmp = new THREE.Box3();
    let floorTop = -Infinity;
    for (const f of floors) { tmp.setFromObject(f); if (tmp.max.y > floorTop) floorTop = tmp.max.y; }
    const overall = new THREE.Box3().setFromObject(model);
    if (!isFinite(floorTop)) floorTop = overall.min.y + 0.1;
    const ctrX = (overall.min.x + overall.max.x) / 2, ctrZ = (overall.min.z + overall.max.z) / 2;
    const ceilingH = overall.max.y - floorTop;

    // House at REAL scale (1:1). It was scaled 1.4x for the old, smaller map so the kids could move,
    // but that dwarfed the real-height people ("everyone's too short"). The current scan is bigger and
    // the floor-footprint collision is forgiving, so 1:1 keeps people correctly proportioned.
    const S = 1.0;
    const group = new THREE.Group();
    group.add(model);
    group.scale.setScalar(S);
    group.position.set(cx - ctrX * S, floorY - floorTop * S, cz - ctrZ * S);
    group.visible = false;
    // The roofless scan is already lit by the GLOBAL scene sun + hemi, so just a faint ambient fill
    // to keep shadowed corners from going black. A full interior rig ON TOP of the scene sun blew
    // the bright scan albedo out (washed out).
    group.add(new THREE.AmbientLight(0xfff4e6, 0.12 * Math.PI));
    scene.add(group);
    group.updateMatrixWorld(true);

    // World-space colliders. Per-wall (NOT the union — that's just the outer shell, which would
    // let the character walk through every interior partition). Doorways are passable portals.
    const wallColliders = walls.map(w => boxXZ(tmp.setFromObject(w)));
    const doorPortals = doors.map(d => boxXZ(tmp.setFromObject(d), 0.18));
    const furnitureColliders = furniture.map(f => boxXZ(tmp.setFromObject(f)));
    // Everything except the floor can hide the avatar — collect ALL non-floor meshes so the wall
    // cabinets / chairs / appliances between the camera and the player also go see-through (not just
    // walls + the big floor-standing furniture). The couch is appended on load.
    const occluders = [];
    model.traverse(o => { if (o.isMesh && !FLOOR_RE.test(o.name || '')) occluders.push(o); });
    // Outer shell = union of walls; the hard clamp that keeps the player in the building.
    const roomAABB = [Infinity, -Infinity, Infinity, -Infinity];
    for (const w of wallColliders) { roomAABB[0] = Math.min(roomAABB[0], w[0]); roomAABB[1] = Math.max(roomAABB[1], w[1]); roomAABB[2] = Math.min(roomAABB[2], w[2]); roomAABB[3] = Math.max(roomAABB[3], w[3]); }
    if (!isFinite(roomAABB[0])) { roomAABB[0] = cx - 4.5; roomAABB[1] = cx + 4.5; roomAABB[2] = cz - 7; roomAABB[3] = cz + 7; }

    // Collision predicate — defined BEFORE spawn so spawn-clearance uses the SAME test.
    // FOOTPRINT model: you can walk anywhere there's FLOOR (continuous through doorways), blocked only
    // by the big furniture. Per-wall AABBs are NOT used for movement — in this denser scan some wall
    // meshes' bounding boxes span the open doorways and sealed rooms (the "invisible barrier"). The
    // floor footprint already has the openings, so it's the robust boundary.
    const RAD = 0.34;
    const floorAABBs = floors.map(f => boxXZ(tmp.setFromObject(f), 0.25));   // padded so you can reach the wall faces
    const onFloor = (x, z) => { for (const f of floorAABBs) if (x > f[0] && x < f[1] && z > f[2] && z < f[3]) return true; return false; };
    const blocked = (x, z, rad) => {
      if (!onFloor(x, z)) return true;   // off the floor footprint = into a wall / outside the house
      for (const f of furnitureColliders) if (x > f[0] - rad && x < f[1] + rad && z > f[2] - rad && z < f[3] + rad) return true;
      return false;
    };

    // Per-room centroids (world) — spawn in the largest room's open centre.
    const rooms = floors.map(f => { tmp.setFromObject(f); return { x: (tmp.min.x + tmp.max.x) / 2, z: (tmp.min.z + tmp.max.z) / 2, area: (tmp.max.x - tmp.min.x) * (tmp.max.z - tmp.min.z) }; });
    rooms.sort((a, b) => b.area - a.area);
    const sp = rooms[0] || { x: cx, z: cz };
    // Spawn must clear furniture/walls AT THE COLLISION RADIUS — a bare-AABB test dropped the player
    // ~1cm inside the padded table collider and soft-locked them. Spiral out to the nearest open floor.
    let sx = sp.x, sz = sp.z;
    if (blocked(sx, sz, RAD)) {
      outer: for (let r = 0.6; r <= 6; r += 0.4) for (let a = 0; a < 16; a++) {
        const x = sp.x + Math.cos(a / 16 * 6.283) * r, z = sp.z + Math.sin(a / 16 * 6.283) * r;
        if (!blocked(x, z, RAD) && x > roomAABB[0] + RAD && x < roomAABB[1] - RAD && z > roomAABB[2] + RAD && z < roomAABB[3] - RAD) { sx = x; sz = z; break outer; }
      }
    }
    const spawn = { x: sx, z: sz, yaw: Math.atan2(cx - sx, cz - sz) };
    const ceilingY = floorY + ceilingH * S;

    onReady({
      group, floorY, ceilingY, roomAABB, spawn, walls, occluders, rooms,
      // Resolve a move from (px,pz)->(nx,nz): per-wall/furniture pushout with axis slide, plus the
      // outer shell clamp. Doorways are passable so per-wall collision doesn't seal the rooms.
      collide(px, pz, nx, nz, rad) {
        // Depenetration: if we're somehow already embedded, never freeze — let the move out through.
        if (blocked(px, pz, rad)) return { x: clamp(nx, roomAABB[0] + rad, roomAABB[1] - rad), z: clamp(nz, roomAABB[2] + rad, roomAABB[3] - rad) };
        let x = nx, z = nz;
        if (blocked(x, z, rad)) {
          if (!blocked(x, pz, rad)) z = pz;
          else if (!blocked(px, z, rad)) x = px;
          else { x = px; z = pz; }
        }
        x = clamp(x, roomAABB[0] + rad, roomAABB[1] - rad);
        z = clamp(z, roomAABB[2] + rad, roomAABB[3] - rad);
        return { x, z };
      },
      // Keep the follow-camera inside the walls and under the (virtual) ceiling.
      clampCam(x, y, z, m) {
        return { x: clamp(x, roomAABB[0] + m, roomAABB[1] - m), y: Math.min(y, ceilingY - 0.25), z: clamp(z, roomAABB[2] + m, roomAABB[3] - m) };
      },
      // Nearest open floor to (x,z) — used to keep NPCs/companions out of furniture & walls.
      clearAt(x, z, rad = 0.34) {
        const inside = (px, pz) => px > roomAABB[0] + rad && px < roomAABB[1] - rad && pz > roomAABB[2] + rad && pz < roomAABB[3] - rad;
        if (!blocked(x, z, rad) && inside(x, z)) return { x, z };
        for (let r = 0.5; r <= 4; r += 0.5) for (let a = 0; a < 12; a++) {
          const nx = x + Math.cos(a / 12 * 6.283) * r, nz = z + Math.sin(a / 12 * 6.283) * r;
          if (!blocked(nx, nz, rad) && inside(nx, nz)) return { x: nx, z: nz };
        }
        return { x: clamp(x, roomAABB[0] + rad, roomAABB[1] - rad), z: clamp(z, roomAABB[2] + rad, roomAABB[3] - rad) };
      },
    });

    // Swap couchy.usdz in for the couch nearest a window. Loaded non-blocking so it never holds up
    // the room; the original sofa shows until it lands and stays on failure. three's USDLoader reads
    // the binary USDC + AVIF textures (pure JS, no wasm) and auto-converts Z-up. Scaled to the
    // original couch's length and dropped on its spot — the original's furniture collider stays, so
    // the new couch still blocks. The original sofa is then hidden.
    if (sofas.length && windows.length) {
      const wCtr = windows.map(w => tmp.setFromObject(w).getCenter(new THREE.Vector3()));
      let target = null, tBox = null, bd = Infinity;
      for (const s of sofas) {
        const b = new THREE.Box3().setFromObject(s), c = b.getCenter(new THREE.Vector3());
        for (const w of wCtr) { const d = (c.x - w.x) ** 2 + (c.z - w.z) ** 2; if (d < bd) { bd = d; target = s; tBox = b; } }
      }
      if (target) new USDLoader().load(couchyUrl, dog => {
        if (cancelled || !dog) return;
        dog.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; if (o.material) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && m.metalness !== undefined) m.metalness = Math.min(m.metalness, 0.3); } });   // keep default frustumCulled so the far-away couch isn't drawn in the yard
        const dgrp = new THREE.Group(); dgrp.add(dog);
        scene.add(dgrp);                                  // parent to the SCENE, not the 1.4x interior group, so the
        dgrp.updateMatrixWorld(true);                     // house scale doesn't double-apply and overshoot the placement
        const ds = new THREE.Box3().setFromObject(dgrp).getSize(new THREE.Vector3());   // native couch size
        const ss = tBox.getSize(new THREE.Vector3());     // tBox = the already-house-scaled sofa, in world space
        dgrp.rotation.y = ((ss.z > ss.x) !== (ds.z > ds.x) ? Math.PI / 2 : 0) + Math.PI;   // align long axis, then face INTO the room (the dogs were looking out the window)
        dgrp.scale.setScalar(Math.max(ss.x, ss.z) / (Math.max(ds.x, ds.z) || 1));   // match the couch's length
        dgrp.updateMatrixWorld(true);
        const gb = new THREE.Box3().setFromObject(dgrp), gc = gb.getCenter(new THREE.Vector3()), tc = tBox.getCenter(new THREE.Vector3());
        dgrp.position.set(tc.x - gc.x, tBox.min.y - gb.min.y, tc.z - gc.z);   // drop exactly on the sofa's spot (scene == world space)
        dgrp.traverse(o => { if (o.isMesh) occluders.push(o); });   // the couch is a see-through occluder too
        target.userData.permaHidden = true; target.visible = false;   // hide the original couch for good (collider stays); the see-through reset must skip permaHidden meshes
      }, undefined, e => console.warn('[interior] couch (usdz) failed, keeping the original sofa', e));
    }

    // Critter cages: swap each GLB onto a SPECIFIC cabinet (node names picked from the 6/16 map's
    // geometry — see docs/house-interior.md). The cage is scene-parented, scaled UNIFORMLY to the
    // cabinet's footprint (keeps the model's own aspect ratio), dropped on its spot, and the cabinet
    // is hidden but its collider stays so the cage blocks. Non-blocking + fail-soft per cage.
    const placeOnCabinet = (cabName, url) => {
      const target = cabinets.find(c => nameOf(c) === cabName);
      if (!target) { console.warn('[interior] cage target cabinet not found:', cabName); return; }
      const tBox = new THREE.Box3().setFromObject(target);
      new GLTFLoader().load(url, gg => {
        if (cancelled || !gg.scene) return;
        gg.scene.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; if (o.material) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && m.metalness !== undefined) m.metalness = Math.min(m.metalness, 0.3); } });
        const grp = new THREE.Group(); grp.add(gg.scene); scene.add(grp); grp.updateMatrixWorld(true);
        const ds = new THREE.Box3().setFromObject(grp).getSize(new THREE.Vector3());
        const ts = tBox.getSize(new THREE.Vector3());
        grp.scale.setScalar(Math.max(ts.x, ts.z) / (Math.max(ds.x, ds.z) || 1));   // match footprint, keep aspect ratio
        grp.updateMatrixWorld(true);
        const gb = new THREE.Box3().setFromObject(grp), gc = gb.getCenter(new THREE.Vector3()), tc = tBox.getCenter(new THREE.Vector3());
        grp.position.set(tc.x - gc.x, tBox.min.y - gb.min.y, tc.z - gc.z);   // on the cabinet's spot, on the floor
        grp.traverse(o => { if (o.isMesh) occluders.push(o); });
        target.userData.permaHidden = true; target.visible = false;   // hide the cabinet (collider stays, so the cage blocks)
      }, undefined, e => console.warn('[interior] cage swap failed for ' + cabName + ', keeping the cabinet', e));
    };
    placeOnCabinet('storage_cabinet_mid27', cageUrl);     // bearded-dragon — couchy couch's room, across the table the couch faces
    placeOnCabinet('storage_cabinet_mid25', guineasUrl);  // guinea-pig — TV wall, behind the overstuffed chair, by the dining table
    placeOnCabinet('storage_cabinet_tall20', phebUrl);    // chinchilla — the tall cabinet across from the guinea one, by the dining table
  }, undefined, e => { if (!cancelled) { console.warn('[interior] house GLB failed, door is inert', e); onFail && onFail(e); } });
  return () => { cancelled = true; };
}
