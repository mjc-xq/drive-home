import { DRIVE_CAMS } from '../camera/presets.js';
import { clamp } from '../coords.js';
import { terrainAt } from '../data.js';
// Driving physics: the per-frame updateDrive integrator (throttle/brake/steer/drift/boost/
// soft-wall/auto-drive rail) and collision feedback (carHit).
export function createDrive(ctx) {
  // Returns true only when a FRESH hit registers (past the 200ms cooldown). The
  // caller gates its speed-scrub on that so a car overlapping geometry for several
  // frames isn't scrubbed to a dead stop every frame — the position push-out ejects
  // it while it keeps most of its momentum.
  function carHit(impact, kind) {
    const tnow = performance.now();
    if (impact < 4 || tnow - ctx.lastHitT < 200) return false;
    ctx.lastHitT = tnow;
    ctx.shakeMag = Math.max(ctx.shakeMag, clamp(impact * 0.05, 0.15, 1.4));
    if (ctx.audio.sfxThunk) ctx.audio.sfxThunk(clamp(impact / 60, 0.2, 1));
    if (navigator.vibrate) { try { navigator.vibrate(Math.round(clamp(impact * 1.4, 10, 55))); } catch (e) { } }
    if (kind === 'animal') ctx.toast('🦆 Watch the critters!', 900);
    // BIG hit → a celebrated moment: a beat of slow-mo, a white flash, a CRUNCH. It also
    // BREAKS your combo — that's the risk that makes near-misses worth the reward.
    else if (impact > 40) {
      if (!ctx.reduceMotion) { ctx.timeScale = 0.32; if (ctx.ui.fx) { ctx.ui.fx.classList.add('crash'); setTimeout(() => ctx.ui.fx && ctx.ui.fx.classList.remove('crash'), 320); } }
      // halve the combo (not a full wipe) — a hard knock on an invisible footprint
      // shouldn't erase a whole chain, but it should sting.
      const lost = ctx.combo > 2 ? '  ·  combo halved' : '';
      if (ctx.combo > 2) { ctx.combo = Math.floor(ctx.combo / 2); ctx.comboExpired = false; ctx.comboExpire = tnow + 4000; ctx.score.emitScore({}); }
      ctx.toast('💥 CRUNCH! ' + Math.round(impact * 2.237) + ' mph' + lost, 1200);
    }
    return true;
  }
  function updateDrive(dt, now) {
    // Mix stick (jx/jy), keyboard (kx/ky), and legacy pedal inputs. The left
    // thumbstick is a Roblox-style move stick: X steers, up is gas, down is
    // brake/reverse. Just steering gently auto-accelerates so kids still cruise.
    // keyboard arrows are binary ±1 — ramp them over ~0.15 s so desktop steering eases
    // in like the touch stick instead of snapping (kSteer feeds jx; touch jx stays direct).
    ctx.car.kSteer = (ctx.car.kSteer || 0) + (ctx.inp2.kx - (ctx.car.kSteer || 0)) * Math.min(1, dt * 7);
    let jx = clamp(ctx.inp2.jx + ctx.car.kSteer + ctx.inp2.steer, -1, 1);
    let throttleTarget = 0, brake = 0, reverse = false;
    // TWIN-STICK MOVE: the left stick's vertical axis IS the throttle/brake now.
    //   jy < 0 (push up)   → gas, proportional to how far up
    //   jy > 0 (pull down) → brake / reverse
    // (setGasAmount/setBrake still feed inp2.gas/inp2.brake for back-compat.)
    const jyGas = ctx.inp2.jy < -ctx.MOVE_DEADZONE ? clamp((-ctx.inp2.jy - ctx.MOVE_DEADZONE) / (1 - ctx.MOVE_DEADZONE), 0, 1) : 0;
    const jyBrake = ctx.inp2.jy > ctx.MOVE_DEADZONE;
    // BRAKE vs REVERSE — the fix for "too easy to end up backwards": a light/partial down-pull only
    // BRAKES (stop + hold at 0). Reverse needs a DELIBERATE near-full pull-down (or full brake button /
    // held down-arrow) AND the car already stopped for a moment, so steering with a little downward
    // drift — or a hard brake-to-stop — can no longer fling the car into reverse.
    const wantReverse = (ctx.inp2.jy > 0.62 || ctx.inp2.brake > 0.85 || ctx.inp2.ky > 0);
    if (wantReverse && Math.abs(ctx.car.speed) < 1.4) ctx.car.revArmT = (ctx.car.revArmT || 0) + dt; else if (!wantReverse) ctx.car.revArmT = 0;
    reverse = wantReverse && (ctx.car.revArmT || 0) > 0.32;
    if (ctx.inp2.brake || ctx.inp2.ky > 0 || jyBrake) brake = 1;
    else if (ctx.inp2.ky < 0) throttleTarget = 1;                  // keyboard = full
    else if (jyGas > 0) throttleTarget = jyGas;                // left stick up = analog gas
    else if (ctx.inp2.gas > 0) throttleTarget = ctx.inp2.gas;          // touch gas (analog 0..1)
    // Stick-only "auto-creep": cruise GENTLY toward ~18 u/s (≈40 mph) instead of
    // flooring it — a kid who only steers should roll at a corner-able pace, never
    // pin to the 220 mph top end. Push up for the real speed.
    else if (Math.abs(jx) > 0.05) throttleTarget = clamp((13 - ctx.car.speed) / 13, 0, 0.42);   // steer-only: roll at a gentle, corner-able pace
    // ANALOG pedal: squeeze the throttle up over ~0.4 s and bleed it off faster, so the
    // gas feels like a pedal you press (feather power out of a slide), not a switch.
    const cur = ctx.car.throttle || 0;
    const tRate = throttleTarget > cur ? 2.6 : 5.4;
    ctx.car.throttle = cur + (throttleTarget - cur) * Math.min(1, dt * tRate);
    let throttle = ctx.car.throttle;
    // GRAB THE WHEEL: any real steer/gas/brake input drops auto-drive so the player
    // instantly takes over instead of fighting the robot.
    const _userInput = Math.abs(ctx.inp2.jx + ctx.inp2.kx + ctx.inp2.steer) > 0.2 || Math.abs(ctx.inp2.jy) > ctx.MOVE_DEADZONE || ctx.inp2.gas || ctx.inp2.brake || ctx.inp2.ky;
    if (ctx.autoDrive && _userInput) {
      ctx.autoDrive = false; ctx.inp2.navActive = false; ctx.nav.clearRouteRail(); ctx.follow.stopFollow(); ctx.emit('autodrive', false); ctx.toast('🕹️ You took the wheel!', 900);
    }
    // FOLLOW runs with autoDrive OFF, so the grab-wheel check above won't catch it — let real input end it too.
    if (ctx.followMode && _userInput) { ctx.follow.stopFollow(); ctx.toast('🕹️ You took the wheel!', 900); }
    // advance the route waypoint as the car passes it. Advance by PROJECTION (how far the car
    // has travelled along the current segment), not just proximity — at high speed the car
    // overshoots a 16 m radius without ever entering it, so routeIdx would stick and the car
    // would circle the same point. The while-loop clears several waypoints in one fast frame.
    while (ctx.ROUTE && ctx.routeIdx < ctx.ROUTE.length - 1) {
      const a = ctx.ROUTE[ctx.routeIdx], b = ctx.ROUTE[ctx.routeIdx + 1];
      const vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz || 1;
      const t = ((ctx.car.x - a.x) * vx + (ctx.car.z - a.z) * vz) / L2;
      if (t > 0.8 || Math.hypot(a.x - ctx.car.x, a.z - ctx.car.z) < 16) ctx.routeIdx++; else break;
    }
    // auto-drive: follow the road ROUTE. Arrival is reaching the END OF THE ROUTE (the road
    // point nearest the target) — NOT the raw target, so a tap that lands off-road doesn't
    // make the car circle forever trying to reach a point with no road. While no route is
    // ready it simply HOLDS (idles) rather than cutting straight across the land.
    if (ctx.autoDrive && ctx.DEST) {
      const end = ctx.ROUTE && ctx.ROUTE.length ? ctx.ROUTE[ctx.ROUTE.length - 1] : null;
      // When the RAIL is active (ROUTE has ≥2 pts) it OWNS the approach and the precise braked stop. Do NOT
      // let this physics check "arrive" early: at 12 m out the rail can still be doing ~79 m/s (its √(2·a·d)
      // cap), and clearing the destination there drops the car at speed with NO rail → it coasts straight
      // PAST the target. That was the "autodrive overshoot when it goes fast". Defer to the rail's own stop.
      const railActive = !!(ctx.ROUTE && ctx.ROUTE.length > 1);
      const atEnd = !railActive && end && (ctx.routeIdx >= ctx.ROUTE.length || Math.hypot(end.x - ctx.car.x, end.z - ctx.car.z) < 12);
      if (!ctx.ROUTE) { ctx.inp2.navActive = false; if (ctx.DEST.geo && now - (ctx.DEST._retryT || 0) > 4000) { ctx.DEST._retryT = now; ctx.nav.fetchRoute(ctx.DEST.geo.lat, ctx.DEST.geo.lon); } }   // hold + self-retry the route every 4 s (transient API/network blip → self-heals)
      else if (atEnd) {
        if (!ctx.DEST.reached) { ctx.DEST.reached = true; if (ctx.DEST.celebrate && !ctx.POIS.some(p => Math.hypot(p.x - ctx.DEST.x, p.z - ctx.DEST.z) < 50)) ctx.poi.arriveCelebrate(ctx.DEST.label, 0, now); }
        ctx.nav.clearDestination();   // arrived — drop the nav card + route line (was sticking on "arriving…") and end auto-drive
      } else { const t = ctx.nav.navTarget(); ctx.inp2.navActive = true; ctx.inp2.navX = t.x; ctx.inp2.navZ = t.z; }
    }
    // Reached a self-driven destination: clear the route either way, but only show the
    // ARRIVAL banner for a place chosen from the GO address search (DEST.celebrate). A
    // casual tap-to-trace is not an "arrival" worth a banner (the user: only show it if
    // you pick an address from GO). POIs run their own richer celebration via checkPOIs.
    else if (ctx.DEST && !ctx.DEST.reached && Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z) < 14) {
      ctx.DEST.reached = true;
      if (ctx.DEST.celebrate && !ctx.POIS.some(p => Math.hypot(p.x - ctx.DEST.x, p.z - ctx.DEST.z) < 50)) ctx.poi.arriveCelebrate(ctx.DEST.label, 0, now);
      ctx.nav.clearDestination();
    }
    // Point-and-drive override (Top-down drag + auto-drive): steer toward the target
    // ground point. Speed scales with DISTANCE (drag far = floor it, near = creep),
    // and if the target is BEHIND the car it reverses toward it instead of looping.
    let autoTurnLimit = Infinity;   // robot's heading-error speed governor; also feeds the autoCap below
    if (ctx.inp2.navActive) {
      const dx = ctx.inp2.navX - ctx.car.x, dz = ctx.inp2.navZ - ctx.car.z, dd = Math.hypot(dx, dz);
      let dyaw = Math.atan2(dx, dz) - ctx.car.yaw;
      while (dyaw > Math.PI) dyaw -= 2 * Math.PI; while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      const farT = clamp(dd / (ctx.autoDrive ? 52 : 40), 0, 1); // 0 near → 1 far; robot looks further ahead
      const robot = ctx.autoDrive && ctx.DEST;
      if (dd < 2.5) { jx = 0; throttle = 0; brake = Math.abs(ctx.car.speed) > 2 ? 0.7 : 0; }
      else if (Math.abs(dyaw) > 1.95 && (!robot || dd < 13)) {   // behind & (manual, or robot at close range) → reverse to it
        const rdyaw = dyaw > 0 ? dyaw - Math.PI : dyaw + Math.PI;
        jx = clamp(rdyaw * 2.0, -1, 1);
        throttle = 0; brake = clamp(0.35 + farT * 0.45, 0, 0.85); reverse = true;   // deliberately backing toward a behind-target → allow reverse past the stop gate
      } else {                                             // drive forward toward it — a robot with a FAR
        // target behind it arcs around (forward U-turn) at full steering lock instead of
        // reversing the whole way across lawns into whatever's behind it.
        jx = clamp(-dyaw * (robot ? 1.6 : 2.0), -1, 1);   // gentler robot gain → no overshoot/wobble on angled (non-90°) turns
        const align = clamp(1 - Math.abs(dyaw) / 1.7, robot ? 0.42 : 0.22, 1); // robot keeps pace through bends
        if (robot) {
          const dDest = Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z);
          // HEADING-ERROR GOVERNOR: the sharper the angle to the aim point, the slower the car
          // must be to actually make the turn. Without this the chauffeur blasts straight
          // through bends at top speed and leaves the route — "autodrive breaks when fast".
          autoTurnLimit = clamp(64 - Math.abs(dyaw) * 80, 12, 64);
          // ...and slow BEFORE the bend, not at it: cap to a speed we can brake down to a corner-able
          // pace by the time we reach the next turn (distToNextTurn looks ~500 m ahead). This is what
          // actually keeps the chauffeur on the route far from home instead of blasting past corners.
          const _turnDist = ctx.nav.distToNextTurn();
          autoTurnLimit = Math.min(autoTurnLimit, 26 + Math.sqrt(Math.max(0, 2 * 30 * (_turnDist - 18))));
          const want = Math.min(ctx.nav.autoDriveTargetSpeed(dDest), autoTurnLimit);
          const gap = want - Math.abs(ctx.car.speed);
          throttle = clamp(0.42 + gap / Math.max(22, want) * 0.95, 0, 1) * align;
          brake = gap < -6 ? clamp((-gap - 4) / 22, 0, 0.85) : 0;   // brake sooner + harder when overspeed for the bend
          if (brake > 0.05) throttle = 0;
        } else {
          throttle = clamp((0.22 + farT * 0.78) * align, 0, 1);
          brake = 0;
        }
      }
    }
    if (throttle > 0.1 || brake > 0.1) ctx.showT = 0;
    if (throttle > 0.1) ctx.score.startRun(now);                 // first gas starts the coin-rally clock
    const road = ctx.onRoad(ctx.car.x, ctx.car.z);
    // "Open road" = on a procedural street OR out past the neighbourhood block
    // (±340 m), where the only surface is the real photoreal road — let it rip there
    // so a cross-town blast to Meemaw's can hit triple digits. WITHIN the block,
    // off the streets means lawns: a real penalty so the pavement is the fast line.
    const fromHome = Math.hypot(ctx.car.x, ctx.car.z);
    const openRoad = road || fromHome > 340;
    const highway = fromHome > 340;   // the real open road / cross-town — let it RIP (way faster)
    // Per-car handling profile (Sienna heavy+grippy, Ferrari fast+slidey, Toy twitchy).
    const profActive = ctx.car.models[ctx.car.modelIdx];
    const prof = (profActive && profActive.profile) || { accel: 1, top: 1, grip: 1, slip: 0.7 };
    // High top speed on the open road (maxF 100 u/s ≈ 224 mph × per-car). Lawns cap
    // ~44 mph with heavy drag so you slow right down and steer back to the street.
    // NITRO: spend the meter (built from near-misses / drifts / arrivals) for a surge —
    // routes the skill economy into raw speed, the addictive part of an arcade loop.
    // auto-fire: flooring the throttle (or the Shift/🚀 input) with charge dumps nitro —
    // no spare thumb is free for a manual button (left=steer, right=pedals).
    const boosting = (ctx.inp2.boost || throttle > 0.92) && ctx.boost > 0.02 && Math.abs(ctx.car.speed) > 1.5;
    if (boosting) { ctx.boost = Math.max(0, ctx.boost - dt * 0.4); if (!ctx.boostWas) { if (ctx.audio.sfxWhoosh) ctx.audio.sfxWhoosh(1); ctx.toast('🚀 NITRO!', 700); if (!ctx.reduceMotion) { ctx.shakeMag = Math.max(ctx.shakeMag, 0.6); if (ctx.ui.fx) { ctx.ui.fx.classList.add('boost'); setTimeout(() => ctx.ui.fx && ctx.ui.fx.classList.remove('boost'), 160); } } } }   // hard-earned nitro gets a real punch: camera kick + a brief flash
    ctx.boostWas = boosting;
    const boostMul = boosting ? 1.34 : 1;
    let maxF = (highway ? 250 : openRoad ? 115 : 38) * prof.top * boostMul * ctx.speedMul; const maxR = -11;   // highway = supersonic; lawns crawl
    if (ctx.autoDrive && (highway || openRoad)) maxF = Math.max(maxF, 440 * boostMul * ctx.speedMul);   // let the chauffeur RIP — it follows the route on rails (see the rail block), so it can't overshoot; a cross-town trip should take ~30-90 s
    // SENSE-OF-SPEED reference — deliberately MUCH lower than the real top (maxF
    // 100·top). All the rush (FOV kick, speed-lines, gauge fill, engine rev) saturates
    // around ~60 mph so normal neighbourhood driving FEELS fast, while you can still
    // pin the real 180-220 mph on the open road (it just stays maxed up there).
    const feelRef = 27 * prof.top;
    // ACCELERATION CURVE — the pedal maps to a TARGET speed through a curve that's gentle at
    // the bottom (a feather of gas = a slow, accurate crawl you can hold) and reaches the
    // full top only when floored. Accel CHASES that target: firm pull when you're below it,
    // a soft coast when you lift above it. So light pedal SETTLES at a low cruise (precise
    // manoeuvring) while flooring it pulls hard to the top (fast) — and because it eases in
    // as you approach the target, it never overshoots off the road.
    // Driving BY HAND gets a steeper pedal curve (a feather of gas = a true slow crawl you can
    // hold on a residential street) and a softer accel cap, so building speed takes longer and
    // is controllable; flooring it still reaches the same top. Auto-drive keeps the snappier
    // numbers so the chauffeur still makes good time.
    const manual = !ctx.autoDrive;
    // FINE-CONTROL low band: by hand, the first ~18% of pedal maps to a gentle linear crawl
    // (up to ~7 u/s ≈ 15 mph) you can HOLD for precise manoeuvring, instead of the cube curve's
    // near-zero-then-lunge bottom. Above that the cube curve takes over toward the top; floored
    // (throttle=1) the cube far exceeds the crawl band, so top speed is untouched.
    const fine = manual ? Math.min(throttle, 0.18) / 0.18 * Math.min(7, maxF * 0.5) : 0;   // cap the crawl band under maxF so a tiny lawn/slow-car maxF doesn't flat-line the upper pedal
    const pedalTgt = Math.max(fine, Math.pow(throttle, manual ? 3.4 : 2.4) * maxF);  // curved pedal → target speed; steeper manual = easier SLOW crawl at the bottom
    const aGap = pedalTgt - ctx.car.speed;
    const aMax = (highway ? 62 : openRoad ? 32 : 13) * prof.accel * boostMul * ctx.speedMul * (manual ? 0.50 : 1);   // peak engine pull (cap); manual builds speed more gradually (gentler off the line)
    let acc = clamp(aGap * (aGap > 0 ? (manual ? 1.25 : 2.6) : 0.9), -aMax, aMax);     // chase target; softer manual pull eases toward target (precision) + lift-off coast
    if (aGap > 0) acc *= 0.75 + 0.25 * clamp(Math.abs(ctx.car.speed) / 6, 0, 1);   // gentle off-the-line ramp — keeps a floored stab feeling punchy, not sluggish
    // PROGRESSIVE brake: ramp the brake force in over ~0.25 s so a quick tap trail-brakes
    // lightly (corner-entry finesse) while a long hold still hauls it down hard.
    const braking = brake > 0.1;
    const bcur = ctx.car.brakeAmt || 0;
    ctx.car.brakeAmt = bcur + ((braking ? 1 : 0) - bcur) * Math.min(1, dt * (braking ? 4 : 9));
    if (braking) acc = ctx.car.speed > 0.5 ? -32 * ctx.car.brakeAmt : ctx.car.speed < -0.5 ? 32 * ctx.car.brakeAmt : (reverse ? -13 : 0);   // forward → brake; rolling backward → brake forward to a stop; stopped → back up only on a DELIBERATE reverse
    // (engine-braking is now implicit: lifting off drops the pedal target below your speed,
    // so the curve above coasts you down on its own.)
    // LOAD TRANSFER: the body dives forward under braking and squats back under power —
    // gives the car visible weight (a Sienna wallows, a Ferrari is crisp via prof.grip).
    ctx.car.pitchDyn = (ctx.car.pitchDyn || 0) + (clamp(-acc * 0.012, -0.2, 0.2) / (0.6 + prof.grip * 0.5) - (ctx.car.pitchDyn || 0)) * Math.min(1, dt * 6);
    // Auto-drive cap scales with distance to the next turn / the destination — long
    // straight legs of a cross-town route run fast (up to maxF), only corners and the
    // final approach slow the chauffeur down, so the trip isn't a crawl.
    let autoCap = 200;
    if (ctx.autoDrive) {
      const dDest = ctx.DEST ? Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z) : 1e9;
      // FAST on the straights, still turn-aware. The throttle controller above aims at this
      // pace; this cap is the guardrail. The old +70 highway bonus let the cap stay high right
      // at a bend (so it blew the turn) — keep it modest, and ALSO respect the heading-error
      // governor so the cap actually drops as the route bends ahead.
      autoCap = Math.min(ctx.nav.autoDriveTargetSpeed(dDest) + 20, autoTurnLimit + 16);
    }
    ctx.car.speed += acc * dt;
    ctx.car.speed -= ctx.car.speed * (highway ? 0.06 : openRoad ? 0.1 : 0.28) * dt;   // highway = slippery-fast, lawns drag
    ctx.car.speed = clamp(ctx.car.speed, maxR, maxF);
    if (ctx.autoDrive && ctx.car.speed > autoCap) ctx.car.speed += (autoCap - ctx.car.speed) * Math.min(1, dt * 7);   // brake to the cap FAST so a fast leg can still slow for the next turn (was dt*3.2 → too slow, overshot)
    if (throttle < 0.1 && brake < 0.1 && Math.abs(ctx.car.speed) < 0.4) ctx.car.speed = 0;
    // tighter turns at speed (makes corners) but softened up high so the open-road blast
    // the design invites stays pointable instead of going numb.
    const steerTarget = (-jx) * 0.5 / (1 + Math.abs(ctx.car.speed) * 0.05);   // tame yaw authority up top so the blast stays pointable
    ctx.car.steer += (steerTarget - ctx.car.steer) * Math.min(1, dt * 12);   // snappier wheel — less lag between thumb and tyres
    // brake-to-drift: stab the brake while turning fast (or the Space handbrake) and
    // the tail steps out; a handbrake yaw kick helps rotate through tight corners.
    const hb = (ctx.inp2.hbrake || (brake > 0.1 && Math.abs(ctx.car.speed) > 8)) ? 1 : 0;
    // High-speed yaw DAMPER: without this the speed/2.7 term overwhelms the steer-angle
    // falloff and net yaw rate climbs all the way up, making the flat-out blast twitchier
    // the faster you go. Authority now peaks ~mid-speed (~35 mph) and tapers above so a
    // 200 mph straight tracks with small corrections.
    const yawDamp = clamp(1 - (Math.abs(ctx.car.speed) - 20) * 0.008, 0.55, 1);   // keep enough authority to DODGE at speed
    ctx.car.yaw += (ctx.car.speed / 2.7) * Math.tan(ctx.car.steer) * (0.8 + prof.grip * 0.25) * (1 + hb * 0.4) * yawDamp * dt;
    // Distance to the nearest road, ALWAYS measured at the car's EXACT current position
    // (nearestRoadPoint now consults the live ROUTE + free-roam snap + every mapped road, so it's
    // valid even far from the procedural hood). inHood still gates the discrete snap-back below.
    const inHood = Math.hypot(ctx.car.x, ctx.car.z) < 330;
    const nrp = ctx.roads.nearestRoadPoint(ctx.car.x, ctx.car.z);
    const offRoadDist = nrp.d;
    ctx.nav.updateAreaRoads(now);   // fetch/refresh the OSM road network around the car so the assist has real roads to hug far from home
    ctx.nav.updateLocationLabel(now);   // live STREET · CITY, ST readout in the subline
    // AUTO-STEER assist: aim the car along the ROUTE (when navigating), or — in free-roam —
    // along the nearest road via a look-ahead point that takes street corners for you. When
    // you've drifted OFF the road it switches to RECOVERY: aim straight back at the nearest
    // tarmac from any angle, strongly, so it actively steers you home. Your steering always
    // overrides the corner/track assist (fades to 0 as you push the stick).
    let assistTargetRate = 0;
    if (!ctx.followMode && ctx.autoSteer && !ctx.inp2.navActive && !hb && Math.abs(ctx.car.speed) > 4) {   // follow OWNS the heading (street-tangent ease below) — don't let the steer-assist fight it
      let dir = null, recover = false; const onRoute = !!(ctx.ROUTE && ctx.routeIdx < ctx.ROUTE.length);
      if (onRoute) { const t = ctx.nav.navTarget(); dir = [t.x - ctx.car.x, t.z - ctx.car.z]; }
      else if (offRoadDist > 8 && offRoadDist < 60) { dir = [nrp.x - ctx.car.x, nrp.z - ctx.car.z]; recover = true; }   // drifted off → steer straight back to the nearest road (hood OR the fetched OSM graph)
      else { const tp = ctx.roads.roadTargetAhead(ctx.car.x, ctx.car.z, ctx.car.yaw, ctx.car.speed); if (tp) dir = [tp[0] - ctx.car.x, tp[1] - ctx.car.z]; }   // hug the road ahead (roadTargetAhead uses the OSM graph far from home)
      if (dir && (dir[0] || dir[1])) {
        let d = Math.atan2(dir[0], dir[1]) - ctx.car.yaw;
        while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        // Wide gate: a street corner bends the road ~90° vs your heading, so a narrow gate
        // would switch the assist OFF exactly at the turn. Recovery uses the FULL circle so
        // it can haul you back even if you're pointed straight away from the road.
        // Recovery gate capped (not the full circle) so the assist never tries to spin you
        // ALL the way around — it nudges you back toward the road, you stay in control.
        const gate = recover ? 2.0 : (onRoute ? 1.6 : 1.45);
        if (Math.abs(d) < gate) {
          // Gentler everywhere: it HELPS you hug the road, it doesn't wrestle the wheel. Even
          // recovery now yields to your input instead of ignoring it.
          const yours = clamp(Math.abs(jx) * (recover ? 1.4 : onRoute ? 1.8 : 1.7), 0, 1);
          const k = (1 - yours) * clamp(Math.abs(ctx.car.speed) / 16, 0.5, 1) * (recover ? 2.8 : (onRoute ? 3.0 : 2.6));
          assistTargetRate = clamp(d, -1.1, 1.1) * k;
        }
      }
    }
    // SMOOTH the assist: low-pass the correction rate so a jump in the aim point (a segment
    // switch or a waypoint advance) eases in over a few frames instead of snapping the wheel
    // — this kills the "jerky road assist". Decays to 0 when the assist isn't engaged.
    ctx.car.assistRate = (ctx.car.assistRate || 0) + (assistTargetRate - (ctx.car.assistRate || 0)) * (1 - Math.exp(-dt * 7));
    ctx.car.yaw += ctx.car.assistRate * dt;
    // AUTO-RECOVER: if you're stranded well off the road — drove deep into a yard, or
    // crashed and stopped out there — the steer-back can't reach you, so snap to the
    // nearest road automatically (assist on, in the hood, not mid-route). While a ROUTE is
    // active the Google line need not lie on the procedural roadSegs, so measuring off-road
    // distance against roadSegs would ping-pong the reset (snap to route → "off roadSegs" →
    // snap again) and the camera never settles — that was the "crash hides the car". The
    // route-autosteer handles staying on a route; a cooldown blocks any immediate re-fire.
    ctx.recoverCooldown = Math.max(0, ctx.recoverCooldown - dt);
    const onRouteNow = !!(ctx.ROUTE && ctx.routeIdx < ctx.ROUTE.length);
    if (!ctx.followMode && ctx.autoSteer && inHood && !onRouteNow && ctx.recoverCooldown <= 0) {
      if (offRoadDist > 14) ctx.offRoadT += dt; else ctx.offRoadT = 0;
      const stuck = Math.abs(ctx.car.speed) < 3;
      if (offRoadDist > 42 || (ctx.offRoadT > 1.5 && offRoadDist > 22) || (ctx.offRoadT > 2.2 && stuck)) { ctx.offRoadT = 0; ctx.fn.resetToRoad(); }
    } else if (ctx.autoDrive && onRouteNow && ctx.recoverCooldown <= 0) {
      // The chauffeur wandered off the ROUTE line — snap back so it re-syncs. Require PERSISTENCE
      // (off for a beat, or way off) so a single momentary overshoot on a bend doesn't teleport-loop.
      if (offRoadDist > 30) ctx.offRoadT += dt; else ctx.offRoadT = 0;
      if (offRoadDist > 80 || (ctx.offRoadT > 1.2 && offRoadDist > 45)) { ctx.offRoadT = 0; ctx.fn.resetToRoad(); }
    } else ctx.offRoadT = 0;
    // HARD UNSTICK: a bad teleport/landing can bury the car inside a building footprint, where
    // the collision below collapses every move candidate to its own spot (can't budge in any
    // gear). If we're already inside one, snap back to the road now (resetToRoad uses the live
    // route far from home); the heading is re-derived from the corrected state just below.
    // Gate on recoverCooldown so it can't 60 Hz-spam (blip/toast/reset) if a snap point ever
    // lands back inside a footprint — it retries at most every ~1.8 s instead.
    if (!ctx.followMode && ctx.recoverCooldown <= 0 && ctx.fn.insideBuilding(ctx.car.x, ctx.car.z)) ctx.fn.resetToRoad();   // follow's glide phases through buildings and OWNS position — don't let recovery yank/fight it
    const fx = Math.sin(ctx.car.yaw), fz = Math.cos(ctx.car.yaw);
    // arcade drift: tail-out lateral slip — readable even WITHOUT the handbrake now;
    // grip recovers it. On THROTTLE the rear stays out (a power-slide you can hold on
    // exit), so we ease grip recovery while you're on the gas instead of killing it.
    const slip = prof.slip * (1 + hb * 1.9);
    ctx.car.vlat = (ctx.car.vlat || 0) + ctx.car.steer * Math.abs(ctx.car.speed) * slip * 1.4 * dt;
    // POWER-SLIDE reward: on the gas, at speed, while turning → the throttle actively
    // pushes the tail out (positive exit-yaw), so flooring it through a corner holds a
    // satisfying drift instead of just leaning on grip recovery being eased.
    if (throttle > 0.4 && !hb && Math.abs(ctx.car.speed) > 10) ctx.car.vlat += ctx.car.steer * throttle * prof.slip * 18 * dt;
    const gripK = (prof.grip * (hb ? 1.4 : 3.5)) * (throttle > 0.5 && !hb ? 0.55 : 1);
    ctx.car.vlat *= Math.exp(-gripK * dt);
    // spin-recovery assist: tail way out + you're NOT actively steering or handbraking
    // → it tucks back in faster, so an over-rotation is catchable, not a full spin-out.
    if (!hb && Math.abs(jx) < 0.3 && Math.abs(ctx.car.vlat) > 7) ctx.car.vlat *= Math.exp(-2.2 * dt);
    ctx.car.vlat = clamp(ctx.car.vlat, -26, 26);
    const rpx = Math.cos(ctx.car.yaw), rpz = -Math.sin(ctx.car.yaw);   // car's right vector
    let nx = ctx.car.x + (fx * ctx.car.speed + rpx * ctx.car.vlat) * dt, nz = ctx.car.z + (fz * ctx.car.speed + rpz * ctx.car.vlat) * dt;
    // SOFT WALL / gravity-well: once the car strays past the lane edge, pull it back toward the
    // nearest road point. A positional nudge folded into THIS frame's move (so the building/tree
    // collision below still clamps it) — works even stopped or pointed away, where the yaw assist
    // can't. Ramps in over a few metres (soft edge), clamps under driving speed (never yanks), and
    // fades as you steer, so it reads like an invisible berm on the shoulder. Only where a road
    // graph exists (the hood or a live route) so it never tugs you back into town from the open road.
    if (ctx.autoSteer && !hb && (inHood || onRouteNow || ctx.osmRoadSegs.length) && offRoadDist > ctx.LANE_HALF && offRoadDist < 120) {
      const over = offRoadDist - ctx.LANE_HALF;
      const ramp = clamp(over / 6, 0, 1);                       // ease in over the first 6 m
      const yours = clamp(Math.abs(jx) * 1.5, 0, 1);            // fade out as the player steers hard
      let ux = nrp.x - ctx.car.x, uz = nrp.z - ctx.car.z; const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
      const pull = Math.min(ctx.WALL_MAX, over * ctx.WALL_GAIN) * ramp * (1 - yours);
      nx += ux * pull * dt; nz += uz * pull * dt;
    }
    ctx.trafficSys.updateTraffic(dt, now);   // move the ambient cars (positions feed the collision below)
    const rad = 1.25;
    let hitThisFrame = false, nearThisFrame = false;
    const fast = Math.abs(ctx.car.speed) > 14;
    // buildings are solid only at their real footprint; slide along the wall
    // instead of stopping dead so you can scrape past a corner.
    if (ctx.fn.insideBuilding(nx, nz)) {
      if (!ctx.fn.insideBuilding(nx, ctx.car.z)) nz = ctx.car.z;
      else if (!ctx.fn.insideBuilding(ctx.car.x, nz)) nx = ctx.car.x;
      else { nx = ctx.car.x; nz = ctx.car.z; }
      if (ctx.drive.carHit(Math.abs(ctx.car.speed), 'wall')) ctx.car.speed *= 0.38;   // scrub only on a fresh hit (else position push-out frees you)
      hitThisFrame = true;
    }
    for (const t of ctx.treePts) {
      const dx = nx - t[0], dz = nz - t[1], d2 = dx * dx + dz * dz, rr = 0.75 + rad;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2); nx = t[0] + dx / d * rr; nz = t[1] + dz / d * rr;
        if (ctx.drive.carHit(Math.abs(ctx.car.speed), 'tree')) ctx.car.speed *= 0.42;
        hitThisFrame = true;
      } else if (fast && d2 < (rr + 1.6) * (rr + 1.6)) nearThisFrame = true;   // skimmed it
    }
    // sanctuary-safe: animals always bounce the car, never get hurt
    for (const a of ctx.ANIMALS) {
      const dx = nx - a.x, dz = nz - a.z, d2 = dx * dx + dz * dz, rr = a.r + rad + 0.5;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2); nx = a.x + dx / d * rr; nz = a.z + dz / d * rr;
        if (ctx.drive.carHit(Math.abs(ctx.car.speed), 'animal')) ctx.car.speed *= 0.5;   // deflect, don't fling backward
        hitThisFrame = true;
      } else if (fast && d2 < (rr + 1.6) * (rr + 1.6)) nearThisFrame = true;
    }
    // TRAFFIC: weave past it for a near-miss combo, clip it for a soft deflect (it yields
    // + keeps its lane, so a tap is a glancing bump you keep rolling through, not a wall).
    if (ctx.roadLifeOn) {
      for (const c of ctx.traffic) {
        if (c.x === undefined) continue;
        const dx = nx - c.x, dz = nz - c.z, d2 = dx * dx + dz * dz, rr = 1.9 + rad;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2); nx = c.x + dx / d * rr; nz = c.z + dz / d * rr;
          if (ctx.drive.carHit(Math.abs(ctx.car.speed), 'car')) ctx.car.speed *= 0.72;
          hitThisFrame = true;
        } else if (fast && d2 < (rr + 2.4) * (rr + 2.4)) nearThisFrame = true;
      }
    }
    if (nearThisFrame && !hitThisFrame) ctx.score.nearMiss(now);   // Burnout-style close-call reward
    // Roam across the streamed Google tiles. The procedural neighborhood (and its collision)
    // only spans ~±340 m; past that the car rides the real photoreal road directly
    // (see actorGroundY), so there is no arbitrary starting-house radius clamp here.
    if (!ctx.followMode) { ctx.car.x = nx; ctx.car.z = nz; }   // in follow the glide below OWNS position — don't let the physics step creep the car forward each frame (it caused a ~1.5 m steady-state drift past the target)
    // AUTO-DRIVE RAIL: when the chauffeur has a route, ignore the physics result and glide the car
    // ALONG the route by arc-length at a fast cruise — so it follows the road EXACTLY (no overshoot,
    // no ping-pong) and a cross-town trip takes ~30-90 s. Position is overridden here (after the
    // collision step), so it phases through obstacles on the route — that's the point.
    if (ctx.followMode && ctx._followGeo) {
      // EXACT FOLLOW via a CRITICALLY-DAMPED SPRING toward the live GPS point. A raw lerp has no momentum,
      // so each new (sparse) fix made the car DART then stop — stop-and-go jerk. The spring carries velocity:
      // a fix-jump accelerates the car smoothly and it eases in with no overshoot (critical damping), so
      // motion stays continuous between updates. No routing/rail here (those snapped to the wrong street).
      const dx = ctx._followGeo.x - ctx.car.x, dz = ctx._followGeo.z - ctx.car.z;
      const K = 12, C = 2 * Math.sqrt(K);   // critical → no overshoot, ~1.2 s to close a gap, smooth speed-ups/downs
      ctx._followVx += (dx * K - ctx._followVx * C) * dt;
      ctx._followVz += (dz * K - ctx._followVz * C) * dt;
      let mx = ctx._followVx * dt, mz = ctx._followVz * dt;
      const step = Math.hypot(mx, mz), MAXSTEP = 520 * ctx.speedMul * dt;   // safety cap (a far/garbage target can't fling the car)
      if (step > MAXSTEP && step > 1e-4) { const s = MAXSTEP / step; mx *= s; mz *= s; ctx._followVx *= s; ctx._followVz *= s; }
      ctx.car.x += mx; ctx.car.z += mz; ctx.car.groundY = null; ctx.car.vlat = 0; ctx.car.steer = 0; ctx.car.assistRate = 0; ctx.car.pitchDyn = 0;   // assistRate=0 so a residual steer-assist rate can't keep rotating yaw under the street-tangent ease; pitchDyn=0 because the spring glide isn't pedal-driven — the physics 'acc' is phantom here and would tilt the body nose-up
      ctx.car.speed = Math.hypot(mx, mz) / Math.max(dt, 1e-3);   // for cam framing / wheel spin
      ctx.car.railS = null; ctx.car.railSpeed = null;
      // Face the car along its ACTUAL travel (the glide velocity) — NOT the compass (the compass drives the
      // MAP rotation via viewHeading()). Snap to the nearest road tangent ONLY when that road runs roughly
      // the same way (within ~45°), so a perpendicular cross-street or an off-road glide can never turn the
      // car sideways. Nearly stopped → hold the current heading (no spinning at the target).
      const _vlen = Math.hypot(ctx._followVx, ctx._followVz);
      let tgtYaw = ctx.car.yaw;
      if (_vlen > 1.0) {
        const vx = ctx._followVx / _vlen, vz = ctx._followVz / _vlen;
        tgtYaw = Math.atan2(vx, vz);                                    // along the direction of travel
        const seg = ctx.roads.nearestRoadSeg(ctx.car.x, ctx.car.z);
        if (seg && seg.d < 40) { const dot = seg.tx * vx + seg.tz * vz; if (Math.abs(dot) > 0.7) tgtYaw = Math.atan2(dot < 0 ? -seg.tx : seg.tx, dot < 0 ? -seg.tz : seg.tz); }   // snap to the road only when it runs OUR way (>~45°)
      }
      let _fd = tgtYaw - ctx.car.yaw; while (_fd > Math.PI) _fd -= 2 * Math.PI; while (_fd < -Math.PI) _fd += 2 * Math.PI;
      ctx.car.yaw += _fd * (1 - Math.exp(-dt * 6));
    } else if (ctx.autoDrive && ctx.ROUTE && ctx.ROUTE.length > 1) {
      if (ctx.car.railS == null || ctx._railRoute !== ctx.ROUTE) { ctx.car.railS = ctx.nav.railArcAt(ctx.car.x, ctx.car.z); ctx._railRoute = ctx.ROUTE; ctx.car.railSpeed = Math.abs(ctx.car.speed); }
      const total = ctx.nav.routeTotalLen(), remain = total - ctx.car.railS;
      // MUCH FASTER on the way: scale hard with the open road ahead (up to ~520 m/s), easing only for
      // real bends. distToNextTurn looks ~500 m ahead, so long straights peg the cap. The rail OWNS the
      // speed via its own railSpeed (and overwrites car.speed) so the physics autodrive governor (autoCap,
      // pulled hard at dt*7 above) can't clamp it down — safe because the rail glues the car to the
      // polyline by arc-length, so it can't leave the route at ANY speed.
      const _cruise = clamp(150 + ctx.nav.distToNextTurn() * 3.4, 150, 520 * ctx.speedMul);
      ctx.car.railSpeed += (_cruise - ctx.car.railSpeed) * Math.min(1, dt * 3);           // smooth ACCEL toward the cruise
      // GUARANTEED STOP AT THE DESTINATION: HARD-cap the speed to the fastest you could still brake to 0
      // within the distance left (v = √(2·a·d)) — a hard clamp, NOT a lagged ease. With the old ease the
      // speed stayed ABOVE this cap and the car ran in too hot and overshot; clamped, the car can always
      // stop in `remain` and decelerates at exactly BRAKE_A to rest at the end. Super-braking decel (~26 g,
      // it's on rails) so it never needs to start slowing early to make the stop.
      const BRAKE_A = 260;
      const stopCap = Math.sqrt(Math.max(0, 2 * BRAKE_A * remain));
      if (ctx.car.railSpeed > stopCap) ctx.car.railSpeed = stopCap;                       // hard clamp → always able to stop by the destination
      if (ctx.car.railSpeed < 0) ctx.car.railSpeed = 0;
      ctx.car.speed = ctx.car.railSpeed;
      ctx.car.railS = Math.min(total, ctx.car.railS + ctx.car.speed * dt);                    // never roll past the destination
      // Don't mistake the end of a still-loading route for ARRIVAL: if the real destination is still far
      // away (the full Directions route lands a beat after the seed/local route we set off on), hold at
      // the route end and let the rail re-acquire when the longer route arrives — give up after ~6 s so a
      // route that never comes can't soft-lock the car.
      if (remain <= 1.5) ctx.car.railEndT = (ctx.car.railEndT || 0) + dt; else ctx.car.railEndT = 0;
      const farFromDest = ctx.DEST && Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z) > 150;
      if (remain <= 1.5 && ctx.car.speed < 6 && (!farFromDest || ctx.car.railEndT > 6)) {  // braked to a near-stop AT the destination → arrive
        if (ctx.DEST) { const bx = ctx.DEST.rawX != null ? ctx.DEST.rawX : ctx.DEST.x, bz = ctx.DEST.rawZ != null ? ctx.DEST.rawZ : ctx.DEST.z; if (Math.hypot(bx - ctx.car.x, bz - ctx.car.z) > 1) ctx.car.yaw = Math.atan2(bx - ctx.car.x, bz - ctx.car.z); }   // PARK facing the actual BUILDING (rawX/rawZ), not the snapped curb point (≈ the car)
        ctx.car.speed = 0; ctx.car.railS = null; ctx.car.railSpeed = null; ctx.car.railEndT = 0;
        if (ctx.DEST && !ctx.DEST.reached) { ctx.DEST.reached = true; if (ctx.DEST.celebrate && !ctx.POIS.some(p => Math.hypot(p.x - ctx.DEST.x, p.z - ctx.DEST.z) < 50)) ctx.poi.arriveCelebrate(ctx.DEST.label, 0, now); }
        ctx.nav.clearDestination();
      } else {
        const rp = ctx.nav.railPointAt(ctx.car.railS);
        ctx.car.x = rp.x; ctx.car.z = rp.z; ctx.routeIdx = rp.i;
        // PARK IN FRONT: over the last few metres, turn from the route tangent to FACE the actual
        // address so the car pulls up looking at the building instead of stopping mid-lane.
        let aimYaw = rp.yaw;
        if (ctx.DEST && remain < 9) { const bx = ctx.DEST.rawX != null ? ctx.DEST.rawX : ctx.DEST.x, bz = ctx.DEST.rawZ != null ? ctx.DEST.rawZ : ctx.DEST.z; if (Math.hypot(bx - ctx.car.x, bz - ctx.car.z) > 1.5) { const fy = Math.atan2(bx - ctx.car.x, bz - ctx.car.z); let d = fy - rp.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; aimYaw = rp.yaw + d * clamp(1 - remain / 9, 0, 1); } }   // turn to face the actual BUILDING (rawX/rawZ) on the final approach; the >1.5 m guard avoids atan2 noise
        let _dy = aimYaw - ctx.car.yaw; while (_dy > Math.PI) _dy -= 2 * Math.PI; while (_dy < -Math.PI) _dy += 2 * Math.PI;
        ctx.car.yaw += _dy * Math.min(1, dt * 12);                                    // ease the heading onto the route tangent / toward the address on arrival
        ctx.car.vlat = 0; ctx.car.steer = 0;                                             // no physics slide while on rails
      }
    }
    // Ride the real photoreal ROAD surface (canopy-skipped + clamped to topology),
    // tracked ASYMMETRICALLY: settle DOWN gently (smooth on descents + bumps) but catch
    // UP quickly, and never let the smoothed height sink more than a hair below the real
    // surface. A symmetric low-pass used to lag BELOW a road that climbs faster than it
    // can track (uphill/onto a bridge at speed) — and once the car was under the surface,
    // the canopy-skipping down-ray (cast from just above the car) could no longer see the
    // road ABOVE it, so it stayed buried. The hard floor keeps that from ever happening.
    // Sample the car's road height, but skip the (expensive far-from-home tile raycast) when the
    // car has barely moved — the road under a near-stationary car doesn't change. Near home this is
    // already the cheap procedural terrainAt; the gate only bites out on the streamed photoreal road.
    const _gd2 = (ctx.car.x - (ctx.car._gyX ?? 1e9)) ** 2 + (ctx.car.z - (ctx.car._gyZ ?? 1e9)) ** 2;
    if (ctx.car._gyRaw == null || _gd2 > 0.25 || now - (ctx.car._gyT || 0) > 120) {
      ctx.car._gyRaw = ctx.ground.actorGroundY(ctx.car.x, ctx.car.z, ctx.car.groundY);
      ctx.car._gyX = ctx.car.x; ctx.car._gyZ = ctx.car.z; ctx.car._gyT = now;
    }
    const yr = ctx.car._gyRaw;
    if (ctx.car.groundY == null) ctx.car.groundY = yr;
    else { const rate = yr > ctx.car.groundY ? dt * 18 : dt * 9; ctx.car.groundY += (yr - ctx.car.groundY) * Math.min(1, rate); }
    if (yr != null && ctx.car.groundY < yr - 0.8) ctx.car.groundY = yr - 0.8;   // anti-bury backstop, loose enough that a brief canopy/roof spike can't snap the car up
    const yC = ctx.car.groundY;
    const rxv = Math.cos(ctx.car.yaw), rzv = -Math.sin(ctx.car.yaw);
    // The 4 corner probes feed only the visual pitch/roll, which tolerates a lower rate, so
    // refresh these tile raycasts ~every 3rd frame and reuse the result between. (These were
    // the single biggest per-frame CPU cost on mobile — 4 brute-force tile casts every frame.)
    // LITE phones skip the 4 corner casts entirely (flat ride); else throttle to every 5th frame on
    // mobile / 3rd on desktop — these tile casts were the single biggest per-frame mobile CPU cost.
    if (ctx.LITE || ctx.followMode) { ctx.car._pitchS = 0; ctx.car._rollS = 0; }   // LITE: flat ride. follow: the glide phases through buildings, so corner probes would tilt the car off the road — keep it flat & level
    else if ((ctx.car._tiltTick = (ctx.car._tiltTick | 0) + 1) % (ctx.MOBILE ? 5 : 3) === 0 || ctx.car._pitchS == null) {
      const tF = ctx.ground.actorGroundY(ctx.car.x + fx * 1.4, ctx.car.z + fz * 1.4, ctx.car.groundY), tB = ctx.ground.actorGroundY(ctx.car.x - fx * 1.4, ctx.car.z - fz * 1.4, ctx.car.groundY);
      const tR = ctx.ground.actorGroundY(ctx.car.x + rxv * 0.9, ctx.car.z + rzv * 0.9, ctx.car.groundY), tL = ctx.ground.actorGroundY(ctx.car.x - rxv * 0.9, ctx.car.z - rzv * 0.9, ctx.car.groundY);
      ctx.car._pitchS = Math.atan2(tB - tF, 2.8); ctx.car._rollS = Math.atan2(tR - tL, 1.8);
    }
    const pitch = ctx.car._pitchS, roll = ctx.car._rollS;
    ctx.car.group.position.set(ctx.car.x, yC + 0.06, ctx.car.z);
    ctx.car.group.rotation.set(0, 0, 0);
    // point the body slightly into the slide so drifts read visually
    const driftYaw = clamp(Math.atan2(ctx.car.vlat || 0, Math.max(6, Math.abs(ctx.car.speed))) * 0.7, -0.5, 0.5);
    ctx.car.group.rotateY(ctx.car.yaw - Math.PI / 2 + driftYaw);
    ctx.car.group.rotateZ(-pitch + (ctx.car.pitchDyn || 0));   // terrain pitch + dynamic load-transfer dive/squat
    ctx.car.group.rotateX(roll);
    // AERIAL / OVERHEAD: blow the car up so it's easy to spot from way up high and more fun
    // — roughly street-sized on the map. Purely cosmetic: collision uses fixed radii, never
    // this scale. Lerp so cycling views doesn't pop; aerial floats highest so it gets biggest.
    const _camV = DRIVE_CAMS[ctx.camMode] || {};
    const _zoomGrow = clamp(Math.sqrt(Math.max(0.05, ctx.czoom)), 0.85, 2.2);   // car GROWS (within limits) as you zoom OUT so it stays findable from way up, and shrinks a touch up close
    const dispTarget = (_camV.aerial ? 4.4 : _camV.topdown ? 2.9 : 1.3) * _zoomGrow;
    ctx.car.dispScale = ctx.car.dispScale == null ? dispTarget : ctx.car.dispScale + (dispTarget - ctx.car.dispScale) * (1 - Math.exp(-dt * 6));
    ctx.car.group.scale.setScalar(ctx.car.dispScale);
    ctx.carXray.update(ctx.car, _camV, dt);
    const overhead = _camV.aerial || _camV.topdown;
    // On arrival, briefly ease the camera's look-ahead to 0 so the car frames DEAD-CENTRE
    // (the constant look-ahead otherwise leaves it offset toward the bottom even when stopped).
    const aheadScale = 1 - (ctx.arriveCenterT && now < ctx.arriveCenterT ? clamp((ctx.arriveCenterT - now) / 1400, 0, 1) : 0);
    ctx.carLocator.visible = overhead;
    if (overhead) {
      ctx.carLocator.position.set(ctx.car.x, yC + (_camV.aerial ? 13 : 8) + Math.abs(Math.sin(now * 0.004)) * 0.5, ctx.car.z);
      ctx.carLocator.scale.setScalar(_camV.aerial ? 1.25 : 0.9);
      if (ctx.carLocator.children[0]) ctx.carLocator.children[0].material.opacity = _camV.aerial ? 0.75 : 0.55;
      if (ctx.carLocator.children[1]) ctx.carLocator.children[1].material.opacity = _camV.aerial ? 0.5 : 0.34;
    }
    // collectible coins: spin + bob, picked up by driving over them
    ctx.coinGroundCursor = ctx.coins.length ? (ctx.coinGroundCursor + 1) % ctx.coins.length : 0;
    for (let i = 0; i < ctx.coins.length; i++) {
      const c = ctx.coins[i];
      c.mesh.visible = !c.got;
      if (c.got) continue;
      c.mesh.rotation.y += dt * 3.2;
      if (c.groundY == null || i === ctx.coinGroundCursor) c.groundY = ctx.ground.actorGroundY(c.x, c.z, c.groundY);
      const coinY = c.groundY != null ? c.groundY : terrainAt(c.x, c.z);
      c.mesh.position.y = coinY + 1.15 + Math.abs(Math.sin(now * 0.004 + c.x)) * 0.35;
      if (Math.hypot(ctx.car.x - c.x, ctx.car.z - c.z) < 3.4) {
        c.got = true; ctx.coinsGot++;
        ctx.score.spawnCoinBurst(c.x, c.z, coinY, now);
        const wasBest = !ctx.bestMs || (now - ctx.runStart) <= ctx.bestMs;
        ctx.score.collectCoin(now);
        if (ctx.coinsGot === ctx.coins.length) {
          ctx.toast('💛 All ' + ctx.coins.length + ' coins in ' + ctx.score.fmtTime(ctx.lastRunMs) + '! ' + (wasBest ? '🏆 New best!' : 'Best ' + ctx.score.fmtTime(ctx.bestMs)), 3600);
          if (ctx.ui.fx && !ctx.reduceMotion) { ctx.ui.fx.classList.add('arrive'); setTimeout(() => ctx.ui.fx && ctx.ui.fx.classList.remove('arrive'), 650); }
        }
      }
    }
    // tyre marks + smoke + screech while the tail is out (drift or handbrake) and moving
    const slipping = (Math.abs(ctx.car.vlat) > 6 || hb) && Math.abs(ctx.car.speed) > 5;
    if (slipping && now - ctx.lastSkidT > 26) {
      ctx.lastSkidT = now;
      const bx = ctx.car.x - fx * 1.5, bz = ctx.car.z - fz * 1.5;           // rear axle
      const rpx2 = Math.cos(ctx.car.yaw), rpz2 = -Math.sin(ctx.car.yaw);    // right vector
      ctx.score.spawnSkid(bx - rpx2 * 0.7, bz - rpz2 * 0.7, yC, ctx.car.yaw, now);
      ctx.score.spawnSkid(bx + rpx2 * 0.7, bz + rpz2 * 0.7, yC, ctx.car.yaw, now);
      if (ctx.FX.si % 2 === 0) ctx.score.spawnSmoke(bx, bz, yC, now, openRoad);
    }
    // ride the tyre-screech: louder the more the tail is out (and on the handbrake)
    if (ctx.audio.screech) ctx.audio.screech(slipping ? clamp((Math.abs(ctx.car.vlat) - 3) / 13, 0.18, 1) * (hb ? 1.1 : 1) : 0);
    // brake squeal: a tyre chirp on a hard stop, gated so it's silent when coasting/parked
    if (ctx.audio.brakeSqueech) ctx.audio.brakeSqueech((ctx.car.brakeAmt || 0) * clamp((Math.abs(ctx.car.speed) - 5) / 15, 0, 1));
    // DRIFT reward: a held slide glows the ✋ button + a 'DRIFT' chip, and every ~0.9 s of
    // sustained drift ticks the combo + trip score — the best mechanic finally pays out.
    const drifting = Math.abs(ctx.car.vlat) > 6 && Math.abs(ctx.car.speed) > 9;
    if (drifting !== ctx.driftState) { ctx.driftState = drifting; ctx.emit('drift', drifting); }
    if (drifting) {
      ctx.driftAccum += dt;
      if (ctx.driftAccum > 0.9) {
        ctx.driftAccum = 0;
        ctx.combo = (!ctx.comboExpired && now < ctx.comboExpire) ? ctx.combo + 1 : 1; ctx.comboExpire = now + 4000; ctx.comboExpired = false;
        ctx.tripScore += 30 + ctx.combo * 15; ctx.score.addBoost(0.09); ctx.score.comboFx(now); ctx.score.emitScore({});
      }
    } else ctx.driftAccum = 0;
    ctx.score.tickParticles(now, dt);
    ctx.poi.checkPOIs(now);
    ctx.poi.updateBeacons(now);
    // live rally clock (direct DOM, no React churn) + combo expiry
    if (ctx.ui.runTime) ctx.ui.runTime.textContent = ctx.score.fmtTime(ctx.runActive ? now - ctx.runStart : ctx.lastRunMs);
    if (!ctx.comboExpired && now > ctx.comboExpire) { ctx.comboExpired = true; ctx.combo = 0; ctx.score.emitScore({}); }
    // reverse tell-tales: 'R' in the speedo + the STOP pedal flips to REV
    const reversing = ctx.car.speed < -0.4;
    if (ctx.ui.rev) ctx.ui.rev.style.opacity = reversing ? '1' : '0';
    if (ctx.ui.brakeLbl && ctx.ui.brakeLbl.textContent !== (reversing ? 'REV' : 'STOP')) ctx.ui.brakeLbl.textContent = reversing ? 'REV' : 'STOP';
    // GEAR readout for the dash cluster: R reverse · P parked · N coasting · D driving.
    if (ctx.ui.gear) {
      const g = reversing ? 'R' : (Math.abs(ctx.car.speed) < 0.4 && throttle < 0.1) ? 'P' : (throttle > 0.05 ? 'D' : 'N');
      if (ctx.ui.gear.textContent !== g) { ctx.ui.gear.textContent = g; ctx.ui.gear.dataset.gear = g; }
    }
    if (ctx.ui.eta) {
      if (ctx.DEST) {
        const dd = Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z);
        const etaMs = dd / Math.max(9, Math.abs(ctx.car.speed)) * 1000;
        ctx.ui.eta.textContent = dd < 18 ? 'arriving…'
          : (dd > 950 ? (dd / 1000).toFixed(1) + ' km' : Math.round(dd) + ' m') + ' · ~' + ctx.score.fmtTime(etaMs);
      } else ctx.ui.eta.textContent = '';
    }
    if (ctx.navMarker) {
      ctx.navMarker.visible = ctx.inp2.navActive && !ctx.autoDrive;   // hide the finger ring during auto-drive
      if (ctx.navMarker.visible) {
        if (now - (ctx.navMarker.userData._gyT || 0) > 200) { ctx.navMarker.userData.groundY = ctx.ground.actorGroundY(ctx.inp2.navX, ctx.inp2.navZ, ctx.navMarker.userData.groundY); ctx.navMarker.userData._gyT = now; }   // ~5 Hz: the ground under the ring changes slowly
        ctx.navMarker.position.set(ctx.inp2.navX, (ctx.navMarker.userData.groundY || 0) + 0.16, ctx.inp2.navZ);
      } else { ctx.navMarker.userData.groundY = null; ctx.navMarker.userData._gyT = 0; }
    }
    // address guide: a continuous line along the actual ROUTE (every turn), draped on
    // the road just ahead of the car; + a pin at the destination when near.
    if (ctx.DEST) {
      ctx.nav.updateGuide(yC);
      const ddDest = Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z);
      ctx.destPin.visible = ddDest < 700;
      if (ctx.destPin.visible) {
        if (ctx.destPin.userData.groundY == null || now - (ctx.destPin.userData._gyT || 0) > 200) { ctx.destPin.userData.groundY = ctx.ground.actorGroundY(ctx.DEST.x, ctx.DEST.z, ctx.destPin.userData.groundY); ctx.destPin.userData._gyT = now; }   // ~5 Hz: a fixed destination doesn't move
        ctx.destPin.position.set(ctx.DEST.x, ctx.destPin.userData.groundY + 6 + Math.abs(Math.sin(now * 0.004)) * 0.6, ctx.DEST.z);
      }
    } else { ctx.guideLine.visible = false; ctx.destPin.visible = false; }
    // The flat aerial patch under the car read as an ugly disc (a different, lower-res
    // texture than the Google tiles). Keep the car riding the same sampled road
    // HEIGHT (actorGroundY), but leave the patch hidden so only the photoreal shows.
    if (ctx.groundPatch) ctx.groundPatch.visible = false;
    const spin = ctx.car.speed * dt / 0.37;
    const active = ctx.car.models[ctx.car.modelIdx];
    if (active) {
      // GLB vehicle: only the Ferrari has named wheel nodes; others ride static
      if (active.wheels) for (const w of active.wheels) w.rotation.x += spin;
    } else {
      // procedural fallback car
      for (const w of ctx.car.wheels) w.rotation.z -= spin;
      for (const f of ctx.car.fronts) f.rotation.y = ctx.car.steer * 1.6;
    }
    // Smoothed MAP-view heading (compass while following, car heading otherwise) for the overhead/aerial
    // framing + a gentle "race day" cinematic sweep that runs during autodrive/follow until the user
    // grabs the camera. Eased so it never shimmers and bows out smoothly when the user takes over.
    { let _d = ctx.follow.viewHeading() - ctx._viewYaw; while (_d > Math.PI) _d -= 2 * Math.PI; while (_d < -Math.PI) _d += 2 * Math.PI; ctx._viewYaw += _d * (1 - Math.exp(-dt * 3)); }
    const _cineWant = (!ctx._orbitUserSet && (ctx.autoDrive || ctx.followMode)) ? 1 : 0;
    ctx._cineAmt += (_cineWant - ctx._cineAmt) * (1 - Math.exp(-dt * 1.5));
    const _cineYaw = ctx._cineAmt * Math.sin(now * 0.00012) * 0.6;     // slow ±0.6 rad hero orbit
    const _cinePit = ctx._cineAmt * Math.sin(now * 0.00009) * 0.12;    // subtle crane
    if (ctx.showT > 0) {
      // showcase orbit on entry; any input skips it
      ctx.showT -= dt;
      const a = ctx.car.yaw + 2.4 + (2.8 - ctx.showT) * 1.35;
      let cx2 = ctx.car.x + Math.sin(a) * 6.6, cy2 = Math.max(yC + 1.7, ctx.ground.groundAt(cx2, ctx.car.z) + 1.2), cz2 = ctx.car.z + Math.cos(a) * 6.6;
      const g = ctx.cam.resolveCam(ctx.car.x, yC + 1.0, ctx.car.z, cx2, cy2, cz2); // don't orbit into real tiles
      cx2 = ctx.car.x + (cx2 - ctx.car.x) * g; cy2 = yC + 1.0 + (cy2 - yC - 1.0) * g; cz2 = ctx.car.z + (cz2 - ctx.car.z) * g;
      ctx.camera.position.set(cx2, cy2, cz2);
      ctx.camera.lookAt(ctx.car.x, yC + 0.7, ctx.car.z);
    } else if (DRIVE_CAMS[ctx.camMode].aerial) {
      // Explore's look while driving: the same high orbit framing (az/polar/range as
      // the page-load Explore view), just centred on the car. Drag orbits it, pinch
      // zooms, and the altitude is slow-smoothed so it floats like the aerial view.
      ctx.camera.up.set(0, 1, 0);
      const sp = clamp(Math.abs(ctx.car.speed) / feelRef, 0, 1);          // gentle speed breathe (keep the Explore feel)
      // HEADING-UP + FOLLOWS TURNS: orbit BEHIND the (smoothed) heading so the car's forward points away/up
      // — matches the heading-up minimap. camOrbit.yaw is the user's offset, kept RELATIVE to the car so it
      // holds as the car turns; the cinematic sweep runs until the user grabs the camera.
      const a = ctx._viewYaw + Math.PI + ctx.camOrbit.yaw + _cineYaw;
      const po = clamp(0.92 - (ctx.camOrbit.pitch + _cinePit) * 0.45, 0.18, 1.4);
      const r = (185 + sp * 38) * ctx.czoom;                             // float higher/further as you wind it out
      ctx.camGroundRef = ctx.camGroundRef == null ? yC : ctx.camGroundRef + (yC - ctx.camGroundRef) * Math.min(1, dt * 1.0);
      const camT = ctx._camT.set(ctx.car.x + r * Math.sin(po) * Math.sin(a), ctx.camGroundRef + r * Math.cos(po), ctx.car.z + r * Math.sin(po) * Math.cos(a));
      if (!ctx.camInit) { ctx.camV.copy(camT); ctx.camInit = true; }
      // track TIGHTER the faster you go so a 700 mph autodrive never outruns the orbit cam
      ctx.camV.lerp(camT, 1 - Math.exp(-(4.6 + clamp(Math.abs(ctx.car.speed) / 16, 0, 13)) * dt));
      // hard backstop: never let the camera trail the orbit target by more than ~45% of the
      // range, so a hard turn at top speed can't swing the car out of frame (invisible car).
      const lagMax = r * 0.45, dxc = ctx.camV.x - camT.x, dzc = ctx.camV.z - camT.z, lc = Math.hypot(dxc, dzc);
      if (lc > lagMax) { const f = lagMax / lc; ctx.camV.x = camT.x + dxc * f; ctx.camV.z = camT.z + dzc * f; }
      ctx.camera.position.copy(ctx.camV);
      ctx.camera.lookAt(ctx.car.x + fx * sp * 26 * aheadScale, ctx.camGroundRef + 1, ctx.car.z + fz * sp * 26 * aheadScale);   // bias the gaze where you're heading (→ centred on arrival)
      const fovT = 46 + 5 * sp;
      if (Math.abs(fovT - ctx.camera.fov) > 0.01) { ctx.camera.fov += (fovT - ctx.camera.fov) * (1 - Math.exp(-3 * dt)); ctx.camera.updateProjectionMatrix(); }   // skip the matrix rebuild once FOV has converged
    } else if (DRIVE_CAMS[ctx.camMode].topdown) {
      const CAM = DRIVE_CAMS[ctx.camMode];
      const sp = clamp(Math.abs(ctx.car.speed) / feelRef, 0, 1);          // sense of speed even from overhead
      // almost directly overhead, but offset a little behind and aimed a touch
      // forward so you can read the road ahead (not perfectly straight down).
      // At speed: float a touch higher, ease back, and push the look-ahead WAY
      // forward so the car slides toward the bottom of frame and you see the road
      // rushing up — the overhead read of velocity.
      const vfx = Math.sin(ctx._viewYaw), vfz = Math.cos(ctx._viewYaw);   // map-view forward (compass while following) — keeps this overhead view oriented like the minimap
      const camT = ctx._camT.set(ctx.car.x - vfx * (CAM.dist + sp * 4), yC + CAM.h * ctx.czoom + sp * 9, ctx.car.z - vfz * (CAM.dist + sp * 4));   // czoom = pure altitude (wide pinch range), speed-float added on top
      if (!ctx.camInit) { ctx.camV.copy(camT); ctx.camInit = true; }
      ctx.camV.lerp(camT, 1 - Math.exp(-(5 + clamp(Math.abs(ctx.car.speed) / 16, 0, 13)) * dt));   // keep up at top speed
      ctx.camera.position.copy(ctx.camV);
      ctx.camera.up.set(vfx, 0, vfz); // heading-up = same orientation as the minimap
      const spHiT = clamp((Math.abs(ctx.car.speed) - feelRef) / (feelRef * 2.7), 0, 1);
      const ahead = (CAM.ahead + sp * sp * 16 + spHiT * 14) * aheadScale;     // see further down the road flat-out (→ centred on arrival)
      ctx.camera.lookAt(ctx.car.x + vfx * ahead, yC, ctx.car.z + vfz * ahead);
      const fovT = 46 + 9 * sp + 12 * spHiT;                   // a real widen when truly flying
      if (Math.abs(fovT - ctx.camera.fov) > 0.01) { ctx.camera.fov += (fovT - ctx.camera.fov) * (1 - Math.exp(-3 * dt)); ctx.camera.updateProjectionMatrix(); }   // skip the matrix rebuild once FOV has converged
      if (!ctx.reduceMotion && spHiT > 0.1) { const r = spHiT * 0.04; ctx.camera.position.x += (Math.random() - 0.5) * r; ctx.camera.position.z += (Math.random() - 0.5) * r; }
    } else {
      const CAM = DRIVE_CAMS[ctx.camMode];
      ctx.camera.up.set(0, 1, 0);
      // free look: hold wherever you dragged, then auto-recenter behind the car shortly
      // after you let go — but HOLD the view for a while first so you can actually look
      // around / explore the scene (the old 600 ms snap made it feel impossible to look).
      // Recentre only after ~1.8 s of no look input, and ease back gently.
      // Free-look HOLDS far longer, then eases only YAW back behind the car (re-frame forward)
      // while PITCH stays where you set it — look up at the skyline / down at the road and it
      // sticks. The longer idle delay means a resting finger studying the view doesn't snap back.
      if (now - ctx.camOrbit.t > 2600) {
        ctx.camOrbit.yaw *= Math.exp(-dt * 0.9);                                       // slow yaw recentre
        ctx.camOrbit.pitch += (0.1 - ctx.camOrbit.pitch) * (1 - Math.exp(-dt * 0.35));     // drift pitch to a gentle rest, very slowly
      }
      const sp = clamp(Math.abs(ctx.car.speed) / feelRef, 0, 1);          // 0..1 of the FEEL range (~60 mph)
      // spHi keeps building ABOVE the feel range up to the real top (~180-220), so the
      // open-road blast the design invites actually reads as faster than a 40 mph cruise.
      const spHi = clamp((Math.abs(ctx.car.speed) - feelRef) / (feelRef * 2.7), 0, 1);
      const a = ctx.car.yaw + Math.PI + ctx.camOrbit.yaw - ctx.car.steer * 0.6 + (CAM.side || 0) + _cineYaw * 0.5;   // lead the camera into corners; CAM.side = a 3/4 above-and-to-the-side hero angle (Cruise); cine = gentle race-day sway during autodrive/follow
      const dist = (CAM.dist + sp * sp * 9 + spHi * 6) * ctx.czoom;       // sink the car back further when truly flying
      const h = (CAM.h + ctx.camOrbit.pitch * 4.5 + sp * 3) * Math.max(0.7, ctx.czoom);
      // hold a STATIC altitude (drone cams): slow-smooth the ground ref so terrain
      // rolls don't bob the high cam; the low Close cam snaps to the ground.
      ctx.camGroundRef = ctx.camGroundRef == null ? yC : ctx.camGroundRef + (yC - ctx.camGroundRef) * (1 - Math.exp(-dt * (CAM.drone ? 1.2 : 6)));
      const camT = ctx._camT.set(ctx.car.x + Math.sin(a) * dist, ctx.camGroundRef + h, ctx.car.z + Math.cos(a) * dist);
      if (!CAM.drone) {
        const g = ctx.cam.resolveCam(ctx.car.x, yC + 1.2, ctx.car.z, camT.x, camT.y, camT.z);
        // Boxed in by buildings (e.g. arriving on a tight residential street): pull the
        // camera in toward the car, but RISE as it closes so it looks DOWN at the car from
        // above instead of burying into the wall / staring at the car's own roof.
        if (g < 1) { const lift = (1 - g) * 7; camT.set(ctx.car.x + (camT.x - ctx.car.x) * g, yC + 1.2 + (camT.y - yC - 1.2) * g + lift, ctx.car.z + (camT.z - ctx.car.z) * g); }
      }
      if (!ctx.camInit) { ctx.camV.copy(camT); ctx.camInit = true; ctx._lookV = null; ctx._lookYS = null; ctx.camFloorRef = null; }
      ctx.camV.lerp(camT, 1 - Math.exp(-(4.6 + clamp(Math.abs(ctx.car.speed) / 16, 0, 13)) * dt));   // frame-rate-independent + keeps up at top speed
      // Anti-clip floor based on the CAR's road level (yC = actorGroundY, which is
      // overpass/canopy-skipped). A high groundAt() raycast at the camera's xz used to hit an
      // OVERPASS deck above and shove the camera up over it — hiding the car under an
      // underpass / when changing levels. Tracking the car's own level fixes that (and the
      // low-pass keeps photogrammetry bumps from popping the cam).
      ctx._camFloorRaw = yC + 1.3;
      ctx.camFloorRef = ctx.camFloorRef == null ? ctx._camFloorRaw : ctx.camFloorRef + (ctx._camFloorRaw - ctx.camFloorRef) * (1 - Math.exp(-dt * 2.2));   // softer low-pass → fewer cam pops on photoreal bumps
      if (ctx.camV.y < ctx.camFloorRef) ctx.camV.y = ctx.camFloorRef;
      ctx.camera.position.copy(ctx.camV);
      // WHIP: the look point isn't nailed to the car — it lags and carries a lateral
      // lead from the drift/steer, so on a hard corner the car slides toward the edge of
      // frame then snaps back. Sells corners far more than a rigid lookAt.
      // Scale the look-ahead with SPEED: parked/slow → look almost AT the car so it sits centred
      // (a fixed forward look-ahead dropped the car to the bottom of the steep cruise frame — "falling
      // behind the camera"); at speed it pushes forward so you read the road. Also lift the look point
      // toward the car's roof when slow so the car frames higher, not at its wheels.
      const lookAhead = (CAM.ahead * (0.32 + 0.68 * sp) + sp * 6) * aheadScale;
      const lookYRaw = yC + 1.0 + (1 - sp) * 0.9;
      ctx._lookYS = ctx._lookYS == null ? lookYRaw : ctx._lookYS + (lookYRaw - ctx._lookYS) * (1 - Math.exp(-dt * 4));   // smooth ONLY the vertical so road bumps don't pitch the whole view (x/z keep the snappy whip)
      const lookY = ctx._lookYS;
      const rpxL = Math.cos(ctx.car.yaw), rpzL = -Math.sin(ctx.car.yaw);
      const latLead = (ctx.car.vlat * 0.05 + ctx.car.steer * 2.0) * (1 - 0.3 * sp) * aheadScale;
      ctx._lookT.set(ctx.car.x + fx * lookAhead + rpxL * latLead, lookY, ctx.car.z + fz * lookAhead + rpzL * latLead);
      if (!ctx._lookV) ctx._lookV = ctx._lookT.clone(); else ctx._lookV.lerp(ctx._lookT, 1 - Math.exp(-7 * dt));
      ctx.camera.up.set(0, 1, 0);
      ctx.camera.lookAt(ctx._lookV);
      // asymmetric FOV: a stab of GO shoves the view wide FAST, then it relaxes slow.
      // The spHi term adds a second, smaller kick that only opens up at true top speed.
      const fovT = 46 + 30 * Math.pow(sp, 1.25) + 8 * spHi;           // ~76° at cruise top, ~84° flat out
      if (Math.abs(fovT - ctx.camera.fov) > 0.01) { ctx.camera.fov += (fovT - ctx.camera.fov) * (1 - Math.exp(-(fovT > ctx.camera.fov ? 6 : 2.2) * dt)); ctx.camera.updateProjectionMatrix(); }   // skip the matrix rebuild once FOV has converged
      if (!ctx.reduceMotion) {
        const roll = clamp(-ctx.car.steer * 2.0 - ctx.car.vlat * 0.012, -0.1, 0.1) * (0.4 + sp);   // Dutch-tilt into corners/drift
        ctx.camera.rotateZ(roll);
        const rumble = (clamp((sp - 0.55) / 0.45, 0, 1) * 0.5 + spHi * 0.5) * 0.06;        // grows past the feel cap when flat out
        if (rumble > 0.001) { ctx.camera.position.x += (Math.random() - 0.5) * rumble; ctx.camera.position.y += (Math.random() - 0.5) * rumble; }
      }
    }
    if (ctx.shakeMag > 0.01 && !ctx.reduceMotion) {                          // decaying collision shake
      ctx.camera.position.x += (Math.random() - 0.5) * ctx.shakeMag;
      ctx.camera.position.y += (Math.random() - 0.5) * ctx.shakeMag;
      ctx.camera.position.z += (Math.random() - 0.5) * ctx.shakeMag;
      ctx.shakeMag *= Math.exp(-dt * 9);
    } else ctx.shakeMag = 0;
    if (ctx.vehicleFill.visible) {
      ctx.vehicleFill.position.copy(ctx.camera.position);
      ctx.vehicleFill.position.y += 8;
      ctx.vehicleFillTarget.position.set(ctx.car.x, yC + 1.1, ctx.car.z);
      ctx.vehicleFillTarget.updateMatrixWorld();
    }
    ctx.tileClip.updateTileClip(ctx.car.x, yC, ctx.car.z, DRIVE_CAMS[ctx.camMode] || {});   // R8: with the camera now placed, cut tile geometry between it and the car (ALL views)
    if (ctx.ui.mph) ctx.ui.mph.textContent = Math.round(Math.abs(ctx.car.speed) * 2.237);
    {
      const f = clamp(Math.abs(ctx.car.speed) / feelRef, 0, 1);
      if (ctx.ui.speedBar) {                                 // speed-bar fill + colour band
        ctx.ui.speedBar.style.width = (f * 100).toFixed(1) + '%';
        ctx.ui.speedBar.style.background = f < 0.45 ? '#3ad17a' : f < 0.78 ? '#ffc21e' : '#ff5a3c';
      }
      if (ctx.ui.boostBar) {                                 // nitro meter (direct DOM, no React churn)
        ctx.ui.boostBar.style.width = (ctx.boost * 100).toFixed(0) + '%';
        const _bp = ctx.ui.boostBar.parentElement;           // null if the HUD unmounted mid-frame
        if (_bp) { _bp.classList.toggle('ready', ctx.boost > 0.25 && !boosting); _bp.classList.toggle('firing', boosting); }
      }
      if (ctx.ui.fx && !ctx.reduceMotion) {                      // speed streaks + vignette: build from ~18%, keep growing flat out
        const fHi = clamp((Math.abs(ctx.car.speed) - feelRef) / (feelRef * 2.7), 0, 1);
        const v = clamp((f - 0.18) / 0.62, 0, 1) * 0.82 + fHi * 0.18;
        ctx.ui.fx.style.setProperty('--spd', v.toFixed(2));
        ctx.ui.fx.style.setProperty('--ox', (50 - (ctx.car.steer + ctx.camOrbit.yaw * 0.4) * 16).toFixed(1) + '%');  // streaks flow from where you're heading
        ctx.ui.fx.classList.toggle('on', v > 0.01);
        ctx.ui.fx.classList.toggle('fast', v > 0.6);         // motion-blur the streaks only when truly flying
      }
    }
    ctx.audio.engineUpdate(ctx.car.speed, feelRef, throttle); // rev maps to the feel reference; load brightens it
    if (ctx.audio.musicSpeed) ctx.audio.musicSpeed(clamp(Math.abs(ctx.car.speed) / feelRef, 0, 1));   // the tune lifts on the blast
  }
  return { updateDrive, carHit };
}
