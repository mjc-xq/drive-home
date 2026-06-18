import { POOP_ACTIVE_CAP } from '../animals.js';
import { clamp } from '../coords.js';
import { terrainAt } from '../data.js';
import { CECE_HEIGHT_M, DREW_HEIGHT_M } from '../drew.js';
// Pedestrian crowd: placement + density of the CeCe/Drew/Dad/Mom dancers on sidewalks and
// at POIs, the nearest-N visibility cap, and the car hit-launch.
export function createCrowd(ctx) {
  // Reused scratch for the ~9 Hz visibility scan so it allocates ZERO heap per scan (the old
  // `const cand = [], prio = []` + per-spot `{sp,d2}` objects were a reliable mobile GC spike).
  const _cand = [], _prio = [], _slotPool = []; let _slotN = 0;
  const _takeSlot = (sp, d2) => { const s = _slotN < _slotPool.length ? _slotPool[_slotN] : (_slotPool[_slotN] = { sp: null, d2: 0 }); _slotN++; s.sp = sp; s.d2 = d2; return s; };
  const cleanPct = () => Math.max(0, Math.round(100 * (1 - ctx.POOPS.length / POOP_ACTIVE_CAP)));
  // Pick a street/scatter pedestrian: mostly the CeCe/Drew kids, with the occasional grown-up Dad/Mom
  // mixed in (taller, distinct models). Falls back to the kids if the adult rigs haven't loaded.
  const pickPed = (i) => { const r = Math.random(); if (ctx.dadCrowd && r < 0.09) return ctx.dadCrowd; if (ctx.momCrowd && r < 0.18) return ctx.momCrowd; return (i & 1) ? ctx.ceceCrowd : ctx.drewCrowd; };
  function placeCrowd() {
    const put = (crowd, x, z, zone, onRoadHt, opts = {}) => {
      if (!crowd) return;
      // FINITE Y always: far POI clusters (schools) are placed before their photoreal tiles stream in,
      // so actorGroundY() there returns NaN. A NaN baseY is sticky (settle's lerp keeps it NaN forever),
      // so those dancers never appeared. Fall back to a finite height now; settleCrowdSpot snaps them to
      // the real ground the moment you arrive and the tiles are loaded.
      const gy = onRoadHt ? ctx.ground.actorGroundY(x, z) : terrainAt(x, z);
      const y = (Number.isFinite(gy) ? gy : (ctx.car.groundY ?? 0)) + 0.02;
      const yaw = opts.yaw != null ? opts.yaw : Math.random() * Math.PI * 2;
      ctx.crowdSpots.push({ rec: crowd.add(ctx.scene, { x, y, z, yaw, clip: opts.clip }), zone, onRoadHt: !!onRoadHt, settleT: 0 });
    };
    const hx = ctx.house.c[0], hz = ctx.house.c[1];
    // Keep a yard dancer out of any building footprint: if the ring spot lands inside a
    // wall (the house/garage), walk it OUTWARD from the yard centre until it's on open
    // ground (CeCe was spawning inside the houses).
    const clearYard = (x, z) => {
      if (!ctx.fn.insideScoopBuilding(x, z)) return [x, z];
      let dx = x - hx, dz = z - hz; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
      for (let r = d + 2; r < d + 22; r += 1.5) { const nx = hx + dx * r, nz = hz + dz * r; if (!ctx.fn.insideScoopBuilding(nx, nz)) return [nx, nz]; }
      return [x, z];
    };
    // YARD (Scoop): a few CeCes + Drews dancing around the front yard (clear of the walls)
    for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2 + 0.5, r = 6 + i * 1.6; const [px, pz] = clearYard(hx + Math.cos(a) * r, hz + Math.sin(a) * r); put(ctx.ceceCrowd, px, pz, 'yard', false); }
    for (let i = 0; i < 2; i++) { const a = i * 2.3 + 1.6; const [px, pz] = clearYard(hx + Math.cos(a) * 8.5, hz + Math.sin(a) * 8.5); put(ctx.drewCrowd, px, pz, 'yard', false, { clip: 'dance' }); }
    // STREETS (Drive): walk EVERY drivable road segment and drop pedestrians along its whole
    // length, on randomized sidewalk offsets and either side — so they line the sidewalks
    // across the WHOLE neighbourhood, not just near home. Denser slider → smaller spacing.
    const D = ctx.CROWD_DENSITY;
    const cn = Math.min(20, Math.round(16 * D));                 // school-cluster size (also used below); hoisted so it counts against the cap
    const RESERVED = (D > 0 ? 18 : 0) + cn * 2 + Math.min(8, cn) + (D > 0 ? 2 : 0);   // POI dancers (18) + 2 school clusters + XQ Mike cluster + meemaw pair — reserved out of the single cap
    const POOL = Math.max(0, Math.round(ctx.CROWD_POOL_CAP * D) - RESERVED);   // sidewalk+scatter share of ONE hard clone cap (keeps total boot clones ≈ CROWD_POOL_CAP×D)
    let placed = 0;
    if (D > 0 && POOL > 0) {
      // Spacing is derived from the TOTAL curb length so the sidewalk pass spreads its share
      // EVENLY across the whole hood instead of clustering near the first segments and hitting
      // the cap there. ~70% of the pool lines sidewalks; the rest scatters on open ground.
      const sidewalkTarget = Math.round(POOL * 0.7);
      let totalCurb = 0;
      for (const s of ctx.roadSegs) { const L = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]); if (L >= 6) totalCurb += L; }
      const step = totalCurb > 0 ? Math.max(12, totalCurb / Math.max(1, sidewalkTarget)) : 1e9;
      for (const s of ctx.roadSegs) {
        if (placed >= sidewalkTarget) break;
        const ax = s[0][0], az = s[0][1], bx = s[1][0], bz = s[1][1];
        const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
        if (L < 6) continue;                                         // skip stubs
        const ux = dx / L, uz = dz / L, nx = -uz, nz = ux;           // unit-along + unit-normal
        for (let t = step * 0.5; t < L && placed < sidewalkTarget; t += step) {
          const jt = clamp(t + (Math.random() - 0.5) * step * 0.5, 0, L);   // jitter along the curb
          const cx = ax + ux * jt, cz = az + uz * jt;
          const side = Math.random() < 0.5 ? 1 : -1;                 // random side each time
          const off = ctx.SIDEWALK_OFF + Math.random() * 1.4;
          const px = cx + nx * side * off, pz = cz + nz * side * off;
          if (ctx.fn.insideBuilding(px, pz) || ctx.fn.insideScoopBuilding(px, pz)) continue;
          const crowd = ctx.crowd.pickPed(placed);
          put(crowd, px, pz, 'street', true, { yaw: Math.atan2(-nx * side, -nz * side) });   // face the road
          placed++;
        }
      }
      // SCATTER: fill the rest of the pool with random open-ground spots across the whole hood
      // (yards/parks/verges) so pedestrians aren't only on the curb. Bounded by the same POOL.
      for (let i = 0; placed < POOL && i < POOL * 3; i++) {
        const px = (Math.random() - 0.5) * 600, pz = (Math.random() - 0.5) * 600;   // ≤ ±300 = the flat field
        if (Math.hypot(px, pz) < 28) continue;                       // not on top of the house
        if (ctx.fn.insideBuilding(px, pz) || ctx.fn.insideScoopBuilding(px, pz)) continue;
        put(ctx.crowd.pickPed(placed), px, pz, 'street', false);
        placed++;
      }
    }
    // DESTINATIONS (Drive): every preset stop gets Drew/Cece right on or beside
    // the arrival point, so there is something visible and hittable when you get there.
    ctx.POIS.forEach((p, pi) => {
      const count = p.key === 'home' ? 2 : 4;
      for (let i = 0; i < count; i++) {
        const a = pi * 0.7 + i / count * Math.PI * 2 + 0.35;
        const r = p.key === 'home' ? 5.5 + i * 1.4 : 1.3 + (i % 2) * 2.9;
        const crowd = (i + pi) % 2 ? ctx.ceceCrowd : ctx.drewCrowd;
        put(crowd, p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, p.key, true, {
          yaw: a + Math.PI,
          clip: crowd === ctx.drewCrowd ? (i % 2 ? 'dance' : 'cheer') : undefined
        });
      }
    });
    // FEATURE CLUSTERS: CeCe takes over Stanton, Drew takes over Canyon — TONS of them spread
    // ALL OVER each school: actorGroundY rides whatever photoreal surface is under each spot, so a
    // tight spawn lands them up ON THE ROOF, a mid radius fills the PARKING LOT / grounds, and the
    // wide edge reaches the ROAD nearby. They auto-cycle their dance pool once visible.
    const scatterCluster = (crowd, p, n, clip) => {
      if (!crowd || !p) return;
      for (let i = 0; i < n; i++) {
        const onRoof = i % 5 === 0;                                       // ~1 in 5 lands on the building itself → up on the roof
        const r = onRoof ? Math.random() * 8 : 10 + Math.random() * 78;   // roof cluster ↔ grounds ↔ all the way out to the ROAD frontage (~80 m) where the car parks
        const a = i * 2.39996323 + (Math.random() - 0.5) * 0.7;           // golden-angle spread so they ring the whole site
        put(crowd, p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, p.key, true, { yaw: a + Math.PI, clip });
      }
    };
    scatterCluster(ctx.ceceCrowd, ctx.POIS.find(q => q.key === 'stanton'), cn, 'All_Night_Dance');   // CeCe all over Stanton Elementary (cn hoisted above, counted against the cap)
    scatterCluster(ctx.drewCrowd, ctx.POIS.find(q => q.key === 'canyon'), cn, 'dance');               // Drew all over Canyon Middle
    scatterCluster(ctx.dadCrowd, D > 0 ? ctx.POIS.find(q => q.key === 'dad') : null, Math.min(8, cn), 'Bass_Beats');   // a few Mikes hanging around XQ (Dad's work)
    // MEEMAW: a CeCe + Drew pair dancing together right out front of the house.
    const meemaw = D > 0 ? ctx.POIS.find(q => q.key === 'meemaw') : null;
    if (meemaw) {
      const a = Math.PI / 2, r = 7;   // out the front, side by side, facing back toward the house
      const fx = meemaw.x + Math.cos(a) * r, fz = meemaw.z + Math.sin(a) * r;
      put(ctx.ceceCrowd, fx - 1.2, fz, 'meemaw', true, { yaw: a + Math.PI, clip: 'All_Night_Dance' });
      put(ctx.drewCrowd, fx + 1.2, fz, 'meemaw', true, { yaw: a + Math.PI, clip: 'dance' });
    }
    ctx.crowd.placeInteriorDancers();   // the decorative Drew + CeCe inside the house (survives a density re-pool)
  }
  // Remove every placed pedestrian (stop mixers, detach groups, drop the clone pool) so a
  // density change can re-place from scratch without leaking clones/mixers.
  function clearCrowd() {
    for (const sp of ctx.crowdSpots) { if (sp.rec.grp.parent) sp.rec.grp.parent.remove(sp.rec.grp); sp.rec.mixer.stopAllAction(); }
    ctx.crowdSpots.length = 0;
    if (ctx.ceceCrowd) ctx.ceceCrowd.removeAll(); if (ctx.drewCrowd) ctx.drewCrowd.removeAll();
    if (ctx.dadCrowd) ctx.dadCrowd.removeAll(); if (ctx.momCrowd) ctx.momCrowd.removeAll();
  }
  function setCrowdDensity(v) {
    ctx.CROWD_DENSITY = clamp(+v || 0, 0, 2);
    try { localStorage.setItem('dahill.peddensity', String(ctx.CROWD_DENSITY)); } catch (e) { }
    // DEBOUNCE the re-pool: a slider drag fires every step, and clearCrowd()+placeCrowd()
    // re-clones the whole pedestrian pool (skinned-mesh clones) — doing that per step stalls the
    // main thread. Re-pool once, ~220 ms after the drag settles.
    clearTimeout(ctx._crowdReplaceT);
    ctx._crowdReplaceT = setTimeout(() => { if (!ctx.disposed && ctx.ceceCrowd && ctx.drewCrowd) { ctx.crowd.clearCrowd(); ctx.crowd.placeCrowd(); } }, 220);
    return ctx.CROWD_DENSITY;
  }
  const _doPlace = () => { if (ctx.disposed || ctx._crowdPlaced || !(ctx.ceceCrowd && ctx.drewCrowd)) return; ctx._crowdPlaced = true; ctx._placedNoAdults = !(ctx.dadCrowd && ctx.momCrowd); ctx.crowd.placeCrowd(); ctx.nav.geocodePOIs(); };
  const _onCrowd = () => {
    if (ctx.disposed) return;
    ctx._crowdN++;
    if (!ctx._crowdPlaced) { if (ctx._crowdN >= 4) ctx.crowd._doPlace(); return; }   // wait for all four rigs so Dad/Mom are mixed in from the FIRST placement (no slider needed)
    // If the 9 s fallback placed a kids-only crowd before the adult rigs loaded, re-pool ONCE (debounced,
    // same path as the density slider) when both Dad + Mom finally arrive so they aren't absent all session.
    if (ctx._placedNoAdults && ctx.dadCrowd && ctx.momCrowd) { ctx._placedNoAdults = false; clearTimeout(ctx._crowdReplaceT); ctx._crowdReplaceT = setTimeout(() => { if (!ctx.disposed && ctx.ceceCrowd && ctx.drewCrowd) { ctx.crowd.clearCrowd(); ctx.crowd.placeCrowd(); } }, 220); }
  };
  function hideCrowd() {
    for (const sp of ctx.crowdSpots) sp.rec.grp.visible = false;
  }
  function settleCrowdSpot(sp, dt) {
    if (!sp.onRoadHt || sp.rec.vel) return;
    sp.settleT = (sp.settleT || 0) + dt;
    if (sp.settleT < 0.25) return;   // pedestrians barely move; re-raycast ground height ~4 Hz, not ~12 Hz — cuts the per-frame tile-raycast cost on mobile (the big snap on relocate/arrival is instant regardless)
    sp.settleT = 0;
    const y = ctx.ground.actorGroundY(sp.rec.x, sp.rec.z, sp.rec.baseY) + 0.02;
    if (!Number.isFinite(y)) return;
    // SNAP on the first valid ground (baseY was a NaN/placeholder) or a big jump (just relocated /
    // arrived at a far cluster); otherwise ease, to smooth small bumps. Without the snap a placeholder
    // baseY never converged (NaN) and the dancers stayed invisible underground.
    if (!Number.isFinite(sp.rec.baseY) || Math.abs(y - sp.rec.baseY) > 5) sp.rec.baseY = y;
    else sp.rec.baseY += (y - sp.rec.baseY) * Math.min(1, dt * 5);
    if (!sp.rec.vel) sp.rec.grp.position.y = sp.rec.baseY;
  }
  // Re-home a culled STREET pedestrian onto a local road near the car, so the street pool FOLLOWS the
  // car and pedestrians populate every street as the map streams in (instead of all sitting back at
  // home, culled). Uses the OSM road graph far from home, the procedural roads near it; scatters on open
  // ground if no road is handy. No raycast here — settleCrowdSpot snaps the height when it turns visible.
  function relocateStreetSpot(sp) {
    const fromHome = Math.hypot(ctx.car.x, ctx.car.z);
    const segs = (fromHome < 340 && ctx.roadSegs.length) ? ctx.roadSegs : (ctx.osmRoadSegs.length ? ctx.osmRoadSegs : ctx.roadSegs);
    let nx = null, nz = null;
    if (segs && segs.length) {
      for (let tr = 0; tr < 8; tr++) {
        const s = segs[(Math.random() * segs.length) | 0];
        const ax = s[0][0], az = s[0][1], bx = s[1][0], bz = s[1][1];
        const sdx = bx - ax, sdz = bz - az, L = Math.hypot(sdx, sdz); if (L < 6) continue;
        const t = Math.random(), cx = ax + sdx * t, cz = az + sdz * t;
        const d = Math.hypot(cx - ctx.car.x, cz - ctx.car.z);
        if (d < 45 || d > 230) continue;                                   // not on top of you, within the cull radius
        const ux = sdx / L, uz = sdz / L, side = Math.random() < 0.5 ? 1 : -1;
        const off = ctx.SIDEWALK_OFF + Math.random() * 1.4;
        nx = cx + (-uz) * side * off; nz = cz + ux * side * off; break;     // out to the sidewalk
      }
    }
    if (nx == null) { const a = Math.random() * Math.PI * 2, r = 70 + Math.random() * 150; nx = ctx.car.x + Math.cos(a) * r; nz = ctx.car.z + Math.sin(a) * r; }
    const rec = sp.rec;
    rec.x = nx; rec.z = nz; rec.baseX = nx; rec.baseZ = nz;
    rec.grp.position.x = nx; rec.grp.position.z = nz;
    rec.baseY = (Number.isFinite(ctx.car.groundY) ? ctx.car.groundY : 0) + 0.02;    // rough; settle snaps to the real tile ground when visible. Number.isFinite guards a NaN groundY (?? lets NaN through → ped stuck underground forever)
    rec.grp.position.y = rec.baseY;
    rec.vel = null; rec.respawnAt = 0; sp.onRoadHt = true; sp.settleT = 0;
  }
  function updateCrowd(dt, now) {
    if (!ctx.crowdSpots.length) return;
    const inDrive = ctx.mode === 'drive', inScoop = ctx.mode === 'scoop';
    const wantInt = inScoop && ctx.scoopScene === 'interior';
    if (!ctx.roadLifeOn) {
      // "People + traffic" OFF hides street/yard pedestrians — but the in-house companion is gameplay,
      // not road life, so keep showing + ticking it.
      for (const sp of ctx.crowdSpots) sp.rec.grp.visible = wantInt && sp.zone === 'interior' && sp.char !== ctx.CHAR.avatar;
      if (wantInt) { if (ctx.ceceCrowd) ctx.ceceCrowd.tick(dt, now); if (ctx.drewCrowd) ctx.drewCrowd.tick(dt, now); if (ctx.dadCrowd) ctx.dadCrowd.tick(dt, now); if (ctx.momCrowd) ctx.momCrowd.tick(dt, now); }
      return;
    }
    if (inScoop) {
      for (const sp of ctx.crowdSpots) {
        // indoors: show only the companion you're NOT playing (one at a time); outdoors: the yard pair
        if (sp.zone === 'interior') sp.rec.grp.visible = wantInt && sp.char !== ctx.CHAR.avatar;
        else sp.rec.grp.visible = !wantInt && sp.zone === 'yard';
      }
    } else if (inDrive) {
      // VISIBILITY CAP: with a spread-out pool we can't animate them all (skinned meshes are
      // costly). Show only the nearest CROWD_VIS_CAP within a cull radius — bounds the per-frame
      // mixer work to N. The scan/sort itself is throttled to ~9 Hz (pedestrians barely move).
      if (now - ctx._crowdVisT > 110) {
        ctx._crowdVisT = now;
        const CULL2 = 240 * 240;
        _cand.length = 0; _prio.length = 0; _slotN = 0;   // prio = POI-cluster dancers shown FIRST so street peds
        let _reloc = 0;                                   // following the car don't hide the cluster you drove to.
        for (const sp of ctx.crowdSpots) {
          if (sp.zone === 'yard' || sp.zone === 'interior') { sp.rec.grp.visible = false; continue; }
          const d2 = (sp.rec.x - ctx.car.x) ** 2 + (sp.rec.z - ctx.car.z) ** 2;
          if (d2 < CULL2) { (sp.zone === 'street' ? _cand : _prio).push(_takeSlot(sp, d2)); continue; }
          sp.rec.grp.visible = false;
          if (sp.zone === 'street' && _reloc < 8) { ctx.crowd.relocateStreetSpot(sp); _reloc++; }   // budgeted: a few culled street peds follow you onto local roads each scan
        }
        _prio.sort((a, b) => a.d2 - b.d2); _cand.sort((a, b) => a.d2 - b.d2);
        let _shown = 0;
        for (const c of _prio) { const v = _shown < ctx.CROWD_VIS_CAP; c.sp.rec.grp.visible = v; if (v) _shown++; }   // POI clusters first
        for (const c of _cand) { const v = _shown < ctx.CROWD_VIS_CAP; c.sp.rec.grp.visible = v; if (v) _shown++; }   // then the nearest street peds
      }
      for (const sp of ctx.crowdSpots) if (sp.rec.grp.visible) ctx.crowd.settleCrowdSpot(sp, dt);   // settle ground height each frame for the visible few
    } else {
      for (const sp of ctx.crowdSpots) sp.rec.grp.visible = false;
    }
    // COMEDY: plough into a pedestrian and they cartwheel off the road (then pop back up).
    if (inDrive && Math.abs(ctx.car.speed) > 6 && now - ctx._crowdHitT > 250) {
      const dir = Math.sign(ctx.car.speed) || 1, vx = Math.sin(ctx.car.yaw) * dir, vz = Math.cos(ctx.car.yaw) * dir, sp = Math.abs(ctx.car.speed);
      const hit = (ctx.ceceCrowd && ctx.ceceCrowd.launchNear(ctx.car.x, ctx.car.z, vx, vz, sp)) || (ctx.drewCrowd && ctx.drewCrowd.launchNear(ctx.car.x, ctx.car.z, vx, vz, sp)) || (ctx.dadCrowd && ctx.dadCrowd.launchNear(ctx.car.x, ctx.car.z, vx, vz, sp)) || (ctx.momCrowd && ctx.momCrowd.launchNear(ctx.car.x, ctx.car.z, vx, vz, sp));
      if (hit) { ctx._crowdHitT = now; if (ctx.audio.sfxThunk) ctx.audio.sfxThunk(0.5); ctx.toast('🎳 WHEEE!', 700); if (navigator.vibrate) { try { navigator.vibrate(22); } catch (e) { } } }
    }
    if (ctx.ceceCrowd) ctx.ceceCrowd.tick(dt, now);   // tick() advances visible mixers + any in-flight launch
    if (ctx.drewCrowd) ctx.drewCrowd.tick(dt, now);
    if (ctx.dadCrowd) ctx.dadCrowd.tick(dt, now);
    if (ctx.momCrowd) ctx.momCrowd.tick(dt, now);
  }
  // A Drew + a CeCe hanging out inside (the original "a drew and cece inside") — decorative crowd
  // dancers, distinct from the playable avatar, gated to the interior scene. Re-added after a
  // pedestrian-density re-pool (placeCrowd calls this) so the slider doesn't wipe them.
  function placeInteriorDancers() {
    if (!ctx.interior || !ctx.ceceCrowd || !ctx.drewCrowd) return;
    if (ctx.crowdSpots.some(s => s.zone === 'interior')) return;
    const sp = ctx.interior.spawn, fwd = [Math.sin(sp.yaw), Math.cos(sp.yaw)];
    const c = ctx.interior.clearAt(sp.x + fwd[0] * 2.6, sp.z + fwd[1] * 2.6);   // open floor, not embedded in a sofa/table
    // Both stand at the same (cleared) spot; updateCrowd shows only the ONE you're not currently playing.
    const add = (crowd, charName, h, clip) => {
      ctx.crowdSpots.push({ rec: crowd.add(ctx.scene, { x: c.x, y: ctx.interior.floorY, z: c.z, yaw: sp.yaw + Math.PI, targetH: h, clip }), zone: 'interior', char: charName, onRoadHt: false, settleT: 0 });
    };
    add(ctx.drewCrowd, 'drew', DREW_HEIGHT_M, 'dance');
    add(ctx.ceceCrowd, 'cece', CECE_HEIGHT_M);
  }
  return { cleanPct, pickPed, placeCrowd, clearCrowd, setCrowdDensity, _doPlace, _onCrowd, hideCrowd, settleCrowdSpot, relocateStreetSpot, updateCrowd, placeInteriorDancers };
}
