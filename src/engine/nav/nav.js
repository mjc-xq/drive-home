import { clamp } from '../coords.js';
import { terrainAt } from '../data.js';
import { fetchMapboxRoadBox, hasMapboxRoadToken } from './mapbox-roads.js';
// Map management: Google Maps SDK, routing + auto-drive rail, geocoding/search, live + procedural
// minimap, the OSM road graph, teleport/jump, the route guide ribbon, and the location label.
export function createNav(ctx) {
  function clearRouteRail() {
    ctx.car.railS = null;
    ctx.car.railSpeed = null;
    ctx.car.railEndT = 0;
    ctx._railRoute = null;
  }
  function loadMapsSDK() {
    if (window.google && window.google.maps && window.google.maps.DirectionsService) return Promise.resolve(window.google.maps);
    if (ctx._mapsSDK) return ctx._mapsSDK;
    const key = import.meta.env.VITE_GOOGLE_MAPS_KEY;
    if (!key) return Promise.reject(new Error('no key'));
    ctx._mapsSDK = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + key + '&libraries=places&loading=async';   // places = address autocomplete
      s.async = true; s.defer = true;
      s.onload = () => (window.google && window.google.maps) ? res(window.google.maps) : rej(new Error('maps unavailable'));
      s.onerror = () => rej(new Error('maps script failed'));
      document.head.appendChild(s);
    });
    return ctx._mapsSDK;
  }
  // Shift a centreline route into the correct travel lane (US = right-hand side) so the guide
  // line sits in the lane you actually drive, not on the centre divider — most noticeable on
  // wide/divided roads. Right-of-travel in this frame (x=east, z=south, north-up) is (-tz, tx)
  // for unit tangent t; endpoints reuse their neighbour's tangent.
  function laneOffsetRoute(pts, off) {
    if (!pts || pts.length < 2 || !off) return pts;
    const out = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      out[i] = { x: pts[i].x + (-tz) * off, z: pts[i].z + tx * off };
    }
    return out;
  }
  function fetchRoute(destLat, destLon) {
    const reqId = ++ctx.routeReqId;
    ctx.nav.loadMapsSDK().then(maps => {
      const o = ctx.geo.worldToGeo(ctx.car.x, ctx.car.z);
      new maps.DirectionsService().route(
        { origin: { lat: o.lat, lng: o.lon }, destination: { lat: destLat, lng: destLon }, travelMode: 'DRIVING' },
        (result, status) => {
          if (reqId !== ctx.routeReqId || !ctx.DEST || !ctx.DEST.geo ||
            Math.abs(ctx.DEST.geo.lat - destLat) > 1e-7 || Math.abs(ctx.DEST.geo.lon - destLon) > 1e-7) return;
          if (status === 'OK' && result.routes && result.routes[0]) {
            const route = result.routes[0];
            const stepPath = [];
            for (const leg of route.legs || []) for (const step of leg.steps || []) for (const p of step.path || []) stepPath.push(p);
            const src = stepPath.length ? stepPath : route.overview_path;
            const pts = src.map(p => { const w = ctx.geo.geoToWorld(p.lat(), p.lng()); return { x: w[0], z: w[1] }; });
            if (pts.length > 1) {
              ctx.ROUTE = ctx.nav.laneOffsetRoute(pts, ctx.LANE_OFFSET); ctx.routeIdx = 0;   // ride the correct lane, not the divider
              ctx.nav.snapDestinationToRouteEnd(ctx.ROUTE);
              ctx.nav.updateAreaRoads(performance.now(), true);   // warm OSM boxes along the route + destination in the background
              if (ctx.autoDrive && Math.abs(ctx.car.speed) < 6) ctx.nav.faceRouteStart();   // just set off / was holding → aim down the real route
              if (!ctx._quietRoute) ctx.toast('🗺️ Route ready — follow the line', 1500);
            }
          } else console.warn('[directions] no route:', status);
        }
      );
    }).catch(e => console.warn('[maps sdk] route unavailable, using straight line —', e && e.message));
  }
  function snapDestinationToRouteEnd(pts) {
    if (!ctx.DEST || !pts || pts.length < 2) return;
    const end = pts[pts.length - 1];
    const rawX = ctx.DEST.rawX == null ? ctx.DEST.x : ctx.DEST.rawX;
    const rawZ = ctx.DEST.rawZ == null ? ctx.DEST.z : ctx.DEST.rawZ;
    // Google geocodes addresses to parcels/rooftops, but cars need to arrive at
    // the drivable road endpoint. Keep the raw geo for retries; move the in-world
    // pin/arrival target to the route's curb-side finish when it is plausibly close.
    const maxSnap = ctx.DEST.celebrate ? 450 : 240;
    if (Math.hypot(end.x - rawX, end.z - rawZ) > maxSnap) return;
    ctx.DEST.rawX = rawX; ctx.DEST.rawZ = rawZ;
    ctx.DEST.x = end.x; ctx.DEST.z = end.z;
    ctx.destPin.userData.groundY = null;
  }
  // fromSearch = the player explicitly chose this place from the GO address search;
  // only THOSE arrivals earn the "Arrived" banner (a casual map tap does not).
  function setDestination(lat, lon, label, isChain, fromSearch, opts = {}) {
    ctx.follow.stopFollow();   // picking a new destination ends an active "follow me"
    const w = ctx.geo.geoToWorld(lat, lon);
    let seedRoute = null;
    if (opts.drive) {
      seedRoute = ctx.nav.localRoadRoute(ctx.car.x, ctx.car.z, w[0], w[1]);
      if (!seedRoute) {
        const np = ctx.roads.nearestRoadPoint(w[0], w[1]);
        if (np && np.d < 90) seedRoute = ctx.nav.localRoadRoute(ctx.car.x, ctx.car.z, np.x, np.z);
      }
    }
    ctx.DEST = { x: w[0], z: w[1], rawX: w[0], rawZ: w[1], label: label || 'Destination', geo: { lat, lon }, celebrate: (!!fromSearch || !!opts.celebrate) && !opts.quiet };   // geo kept so a failed route can self-retry
    ctx.ROUTE = seedRoute || null; ctx.routeIdx = 0;
    if (ctx.ROUTE) ctx.nav.snapDestinationToRouteEnd(ctx.ROUTE);
    ctx.destPin.userData.groundY = null;
    ctx.emit('dest', { label: ctx.DEST.label });
    ctx._quietRoute = !!opts.quiet;   // suppress the follow-up "Route ready" toast on quiet (follow-mode) re-routes
    if (!isChain && !opts.quiet) { const km = (Math.hypot(ctx.DEST.x - ctx.car.x, ctx.DEST.z - ctx.car.z) / 1000).toFixed(1); ctx.toast('📍 ' + ctx.esc(ctx.DEST.label) + ' · ' + km + ' km — routing…', 2200); }
    ctx.nav.fetchRoute(lat, lon);
    if (opts.drive) {
      ctx.autoDrive = true; ctx.inp2.navActive = false;
      ctx.emit('autodrive', true);
      ctx.nav.faceRouteStart();
    }
  }
  function clearDestination() {
    ctx.routeReqId++; ctx.DEST = null; ctx.ROUTE = null; ctx.routeIdx = 0; ctx.autoDrive = false; ctx.inp2.navActive = false;
    ctx.nav.clearRouteRail(); ctx.nav.clearRouteCaches();
    ctx.guideLine.visible = false; ctx.destPin.visible = false; ctx.destPin.userData.groundY = null;
    ctx.emit('dest', null); ctx.emit('autodrive', false);
  }
  // ---- address search (Google JS SDK — the Geocoder + Places run IN-BROWSER where the REST
  // Geocoding/Directions endpoints are CORS-blocked, which is why the old fetch box failed) ----
  function geocodeAddress(text) {
    return ctx.nav.loadMapsSDK().then(maps => new Promise((res, rej) => {
      new maps.Geocoder().geocode({ address: text }, (r, status) => {
        if (status === 'OK' && r && r[0]) { const l = r[0].geometry.location; res({ lat: l.lat(), lon: l.lng(), label: r[0].formatted_address }); }
        else rej(new Error('geocode ' + status));
      });
    }));
  }
  function geocodePOIs() {
    for (const p of ctx.POIS) {
      const addr = ctx.POI_ADDR[p.key];
      if (!addr) continue;
      ctx.nav.geocodeAddress(addr).then(g => {
        const w = ctx.geo.geoToWorld(g.lat, g.lon), ox = p.x, oz = p.z;
        p.x = w[0]; p.z = w[1]; p.lat = g.lat; p.lon = g.lon;
        const b = ctx.poiBeacons.find(x => x.poi.key === p.key); if (b) { b.mesh.position.x = p.x; b.mesh.position.z = p.z; b.mesh.userData.groundY = null; b.mesh.userData._gyT = 0; }
        const lb = ctx.poiLabels.find(x => x.poi.key === p.key); if (lb) { lb.spr.position.x = p.x; lb.spr.position.z = p.z; }
        for (const sp of ctx.crowdSpots) if (sp.zone === p.key) {
          const dx = p.x - ox, dz = p.z - oz;
          sp.rec.grp.position.x += dx; sp.rec.grp.position.z += dz;
          sp.rec.x += dx; sp.rec.z += dz;
          sp.rec.baseX += dx; sp.rec.baseZ += dz;
        }   // shift this POI's dancers with the corrected geocode location
      }).catch(() => { });
    }
  }
  function disposeMiniMap() {
    if (ctx._gmapDiv) ctx._gmapDiv.style.transform = '';   // drop any heading-up rotation so a re-mount starts clean
    if (ctx._gmapClick) { ctx._gmapClick.remove(); ctx._gmapClick = null; }
    if (ctx._gmapCar) { ctx._gmapCar.setMap(null); ctx._gmapCar = null; }
    if (ctx._gmapRoute) { ctx._gmapRoute.setMap(null); ctx._gmapRoute = null; }
    if (ctx._gmaps && ctx._gmap) ctx._gmaps.event.clearInstanceListeners(ctx._gmap);
    ctx._gmap = null; ctx._gmapDiv = null; ctx._gmapRouteFor = null; ctx._gmapOverviewUntil = 0;
  }
  function initMiniMap(div) {
    if (!div || ctx._gmapDiv === div) return;
    ctx.nav.disposeMiniMap();
    ctx._gmapDiv = div;
    div.style.transformOrigin = '50% 50%'; div.style.willChange = 'transform';   // spin the heading-up map about its centre (the car)
    ctx.nav.loadMapsSDK().then(maps => {
      if (ctx.disposed || ctx._gmapDiv !== div) return;
      ctx._gmaps = maps;
      const o = ctx.geo.worldToGeo(ctx.car.x, ctx.car.z);
      ctx._gmap = new maps.Map(div, {
        center: { lat: o.lat, lng: o.lon }, zoom: 12, disableDefaultUI: true,   // zoomed-out district view (~10 km across) so fast cross-town drives stay on the map
        gestureHandling: 'none', keyboardShortcuts: false, clickableIcons: false,
        styles: ctx.DARK_MAP_STYLE, backgroundColor: '#1b2027', isFractionalZoomEnabled: true,
      });
      ctx._gmapCar = new maps.Marker({ position: { lat: o.lat, lng: o.lon }, map: ctx._gmap, zIndex: 5,
        icon: { path: 'M0,-10 L7,8 L0,3 L-7,8 Z', fillColor: '#2D8CFF', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1.5, scale: 1.05, rotation: 0, anchor: new maps.Point(0, 0) } });
      ctx._gmapRoute = new maps.Polyline({ map: ctx._gmap, strokeColor: '#2D8CFF', strokeOpacity: 0.95, strokeWeight: 4, path: [], zIndex: 3 });
      // TAP-TO-DRIVE on the heading-up map: Google's own click→latLng is computed from the click's
      // offset within the container, which a CSS rotate()+scale() DISTORTS (taps land in the wrong
      // place). So handle the tap ourselves: undo the scale + rotation we applied, then convert the
      // map-local pixel offset to a world point via the live metres-per-pixel. Capture phase so it
      // beats any inner Google handler.
      const onTap = (e) => {
        if (!ctx._gmap) return;
        const r = div.getBoundingClientRect();
        const fcx = r.left + r.width / 2, fcy = r.top + r.height / 2;   // rotate/scale are about centre → bbox centre stays on the car
        const ox = (e.clientX - fcx) / ctx._gmapScale, oy = (e.clientY - fcy) / ctx._gmapScale;   // undo fill scale → layout px from centre
        const ar = ctx._gmapRot * Math.PI / 180, c = Math.cos(ar), s = Math.sin(ar);          // undo the heading-up rotation
        const mx = ox * c - oy * s, my = ox * s + oy * c;
        const ctr = ctx._gmap.getCenter(), lat = ctr.lat(), z = ctx._gmap.getZoom();
        const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);        // Web-Mercator metres per layout px
        const cw = ctx.geo.geoToWorld(lat, ctr.lng());   // anchor to the map's ACTUAL centre, not the car — during a route overview the view is fitBounds-centred, not on the car
        ctx.nav.setDriveTarget(cw[0] + mx * mpp, cw[1] + my * mpp);   // screen x→east(+x), screen y(down)→south(+z)
      };
      div.addEventListener('click', onTap, true);
      ctx._gmapClick = { remove: () => div.removeEventListener('click', onTap, true) };   // disposeMiniMap calls _gmapClick.remove()
    }).catch(() => { });
  }
  function updateMiniMap(now) {
    if (!ctx._gmap || now - ctx._gmapT < 200) return;   // ~5 Hz pan
    ctx._gmapT = now;
    const o = ctx.geo.worldToGeo(ctx.car.x, ctx.car.z);
    // HEADING-UP: spin the whole map so the car's heading points UP — oriented like the driver/user,
    // the way a phone GPS does. World is x=east, z=-north and car.yaw=atan2(east,-north), so the
    // compass bearing (cw from north) = 180°−yaw. We counter-rotate the map div by that bearing (and
    // scale up to fill the corners the rotation exposes), then point the car marker the same way so it
    // sits pointing straight up. During a route OVERVIEW the map isn't car-centred, so stay north-up.
    const bearing = 180 - ctx.follow.viewHeading() * 180 / Math.PI;   // viewHeading = COMPASS while following (map turns like the user), else the car heading
    const overview = now < ctx._gmapOverviewUntil;
    if (!overview) { const d = ((bearing - ctx._gmapHeading + 180) % 360 + 360) % 360 - 180; ctx._gmapHeading += d * 0.35; }   // smoothed, unwrapped → no shimmer / no 360° spin
    ctx._gmapRot = overview ? 0 : ctx._gmapHeading; ctx._gmapScale = overview ? 1 : 1.62;   // kept in sync with the transform below so the tap handler can invert it exactly
    if (ctx._gmapDiv) ctx._gmapDiv.style.transform = overview ? 'none' : `rotate(${(-ctx._gmapHeading).toFixed(2)}deg) scale(${ctx._gmapScale})`;
    if (ctx._gmapCar) {
      ctx._gmapCar.setPosition({ lat: o.lat, lng: o.lon });
      const ic = ctx._gmapCar.getIcon(); ic.rotation = overview ? bearing : ctx._gmapHeading; ctx._gmapCar.setIcon(ic);   // north-up: along bearing; heading-up: same as the div's counter-rotation → points UP
    }
    if (ctx._gmapRoute) {
      if (ctx.ROUTE && ctx.ROUTE.length && ctx._gmapRouteFor !== ctx.ROUTE) {
        ctx._gmapRouteFor = ctx.ROUTE;
        const pts = ctx.ROUTE.map(p => { const g = ctx.geo.worldToGeo(p.x, p.z); return { lat: g.lat, lng: g.lon }; });
        ctx._gmapRoute.setPath(pts);
        // ROUTE OVERVIEW: fit the whole start→finish into view for a few seconds when a new
        // route is set, then resume following the car (the user asked to see the full route).
        if (ctx._gmaps) { const b = new ctx._gmaps.LatLngBounds(); b.extend({ lat: o.lat, lng: o.lon }); for (const p of pts) b.extend(p); ctx._gmap.fitBounds(b, 12); ctx._gmapOverviewUntil = now + 3500; }
      } else if (!ctx.ROUTE && ctx._gmapRouteFor) { ctx._gmapRouteFor = null; ctx._gmapRoute.setPath([]); }
    }
    if (now >= ctx._gmapOverviewUntil) { ctx._gmap.setCenter({ lat: o.lat, lng: o.lon }); if (ctx._gmap.getZoom() !== 12) ctx._gmap.setZoom(12); }   // follow the car zoomed out (~10 km across); settle back to 12 after any route overview
  }
  function geocodePlaceId(placeId, fallbackLabel) {
    return ctx.nav.loadMapsSDK().then(maps => new Promise((res, rej) => {
      new maps.Geocoder().geocode({ placeId }, (r, status) => {
        if (status === 'OK' && r && r[0]) { const l = r[0].geometry.location; res({ lat: l.lat(), lon: l.lng(), label: fallbackLabel || r[0].formatted_address }); }
        else rej(new Error('geocode ' + status));
      });
    }));
  }
  function placeSuggest(text) {
    const q = (text || '').trim().replace(/\s+/g, ' ');
    if (q.length < 4) return Promise.resolve([]);
    const key = q.toLowerCase();
    if (ctx._acCache.has(key)) return Promise.resolve(ctx._acCache.get(key));
    return ctx.nav.loadMapsSDK().then(maps => new Promise(res => {
      if (!maps.places) { res([]); return; }
      if (!ctx._acSvc) ctx._acSvc = new maps.places.AutocompleteService();
      if (!ctx._acTok) ctx._acTok = new maps.places.AutocompleteSessionToken();
      ctx._acSvc.getPlacePredictions({ input: q, sessionToken: ctx._acTok }, (preds, status) => {
        const out = (status === 'OK' && preds) ? preds.slice(0, 4).map(p => ({ description: p.description, placeId: p.place_id })) : [];
        ctx._acCache.set(key, out);
        if (ctx._acCache.size > 40) ctx._acCache.delete(ctx._acCache.keys().next().value);
        res(out);
      });
    })).catch(() => []);
  }
  // Full post-teleport reset in ONE place: zero the car's motion, force a fresh ground
  // sample, and RE-SEAT every camera reference (camGroundRef/camFloorRef were the ones the
  // old jump paths forgot — leaving the orbit cam floating at the OLD altitude for seconds,
  // which read as "we lost the car"). Short cooldown so a bad landing still recovers fast.
  function settleAfterTeleport() {
    ctx.car.speed = 0; ctx.car.vlat = 0; ctx.car.steer = 0; ctx.car.assistRate = 0; ctx.car.revArmT = 0; ctx.car.groundY = null;
    ctx.camInit = false; ctx.camGroundRef = null; ctx.camFloorRef = null; ctx.inp2.navActive = false; ctx.recoverCooldown = 0.6; ctx._viewYaw = ctx.follow.viewHeading(); ctx._miniYaw = ctx.follow.viewHeading(); ctx._gmapHeading = ((180 - ctx.follow.viewHeading() * 180 / Math.PI) % 360 + 360) % 360;   // snap the overhead/aerial framing + BOTH minimaps to the new heading (no rotate-in after a jump/teleport)
  }
  function jumpTo(lat, lon, label) {
    ctx.follow.stopFollow();   // a teleport OWNS the car — end any live GPS follow (else its glide springs the car back). Mirrors setDestination/setDriveTarget/driveToMyLocation/exitDrive.
    const ox = ctx.car.x, oz = ctx.car.z;                         // origin for the road-end query (captured before we teleport)
    const w = ctx.geo.geoToWorld(lat, lon);
    ctx.car.x = w[0]; ctx.car.z = w[1];
    // Snap onto the local street graph when one is near (the generous radius matches the
    // tap-to-drive snap, so jumps inside the neighborhood land in the street like a drive).
    // Even if no road is "near", if the rooftop geocode dropped us INSIDE a building, nudge
    // to the nearest road so the car never lands wedged (can't move in any gear).
    const np = ctx.roads.nearestRoadPoint(ctx.car.x, ctx.car.z);
    const onLocalRoad = np && np.d < 90;
    if (onLocalRoad) { ctx.car.x = np.x; ctx.car.z = np.z; }
    else if (np && ctx.fn.insideBuilding(ctx.car.x, ctx.car.z)) { ctx.car.x = np.x; ctx.car.z = np.z; }
    if (ctx.fn.setPhotorealAnchor) ctx.fn.setPhotorealAnchor(lat, lon, ctx.car.x, ctx.car.z, label);
    ctx.nav.clearDestination();
    ctx.nav.settleAfterTeleport();
    ctx.toast('📍 Jumped to ' + ctx.esc(label || 'there'), 1500);
    // Far from the neighborhood there's no local road graph (osmRoadSegs still covers the OLD area), so
    // the geocode rooftop strands the car off-road and "Back to road" can't find anything until OSM
    // re-fetches. So: force an OSM fetch for the NEW area now AND ask Google for the curb (whichever lands
    // first snaps the car onto the road — see the _jumpSnap handler in updateAreaRoads + snapJumpToRoad).
    // The stamp (target + 8 s deadline) makes it single-use and self-expiring so it can never teleport the
    // car at some unrelated later moment if both fetches fail.
    if (!onLocalRoad) { ctx._jumpSnap = { x: ctx.car.x, z: ctx.car.z, until: performance.now() + 8000 }; ctx.nav.updateAreaRoads(performance.now(), true); ctx.nav.snapJumpToRoad(ox, oz, lat, lon, ++ctx.jumpReqId); }
  }
  // One-shot road-snap for a FAR jump: route origin→destination and move the car to the
  // route's final point — the same curb Drive-to arrives at. Bails if a newer jump fired or
  // the player has since set a destination, so it never yanks the car out from under them.
  function snapJumpToRoad(ox, oz, lat, lon, reqId) {
    ctx.nav.loadMapsSDK().then(maps => {
      const o = ctx.geo.worldToGeo(ox, oz);
      new maps.DirectionsService().route(
        { origin: { lat: o.lat, lng: o.lon }, destination: { lat, lng: lon }, travelMode: 'DRIVING' },
        (result, status) => {
          if (reqId !== ctx.jumpReqId || ctx.DEST || !ctx._jumpSnap || Math.abs(ctx.car.speed) >= 4) return;   // a newer jump/destination fired, OSM already snapped (flag consumed), or the user drove off — don't double-snap or yank a moving car
          if (status !== 'OK' || !result.routes || !result.routes[0]) return;
          const path = [];
          for (const leg of result.routes[0].legs || []) for (const step of leg.steps || []) for (const p of step.path || []) path.push(p);
          const src = path.length ? path : result.routes[0].overview_path;
          if (!src || !src.length) return;
          const end = src[src.length - 1], e = ctx.geo.geoToWorld(end.lat(), end.lng());
          ctx.car.x = e[0]; ctx.car.z = e[1];
          // de-wedge: if the route end still sits inside a footprint, slide to the nearest road
          const np = ctx.roads.nearestRoadPoint(ctx.car.x, ctx.car.z);
          if (np && (np.d < 90 || ctx.fn.insideBuilding(ctx.car.x, ctx.car.z))) { ctx.car.x = np.x; ctx.car.z = np.z; }
          if (ctx.fn.setPhotorealAnchor) ctx.fn.setPhotorealAnchor(end.lat(), end.lng(), ctx.car.x, ctx.car.z, 'Road');
          ctx._jumpSnap = null;   // Google curb landed first — consume the stamp so the OSM-fetch snap won't double-fire
          ctx.nav.settleAfterTeleport();   // re-seat camera/ground refs (was leaving camGroundRef stale → floating cam)
        }
      );
    }).catch(() => {});
  }
  // Destination by address / place — geocode then route there (and auto-drive on request).
  function setDestinationByText(text, drive) {
    return ctx.nav.geocodeAddress(text).then(g => { ctx.nav.setDestination(g.lat, g.lon, g.label, false, true, { drive, celebrate: true }); return g; });
  }
  function setDestinationByPlace(placeId, label, drive) {
    return ctx.nav.geocodePlaceId(placeId, label).then(g => { ctx._acTok = null; ctx.nav.setDestination(g.lat, g.lon, g.label, false, true, { drive, celebrate: true }); return g; });
  }
  function driveHome() {
    ctx.nav.setDestination(ctx.homeGeo.lat, ctx.homeGeo.lon, 'Home', false, true, { drive: true, celebrate: true });
    return Promise.resolve({ lat: ctx.homeGeo.lat, lon: ctx.homeGeo.lon, label: 'Home' });
  }
  function jumpHome() {   // TELEPORT home (the "Jump there" button) — driveHome() chauffeur-drives, which is wrong for Jump
    ctx.nav.jumpTo(ctx.homeGeo.lat, ctx.homeGeo.lon, 'Home');
    return Promise.resolve({ lat: ctx.homeGeo.lat, lon: ctx.homeGeo.lon, label: 'Home' });
  }
  function driveToLatLon(lat, lon, label, quiet) {
    ctx.nav.setDestination(lat, lon, label, false, true, { drive: true, celebrate: true, quiet });
    return Promise.resolve({ lat, lon, label: label || 'Destination' });
  }
  // Tap-to-drive from the minimap: set a raw world point as the destination and let
  // the robot drive there (no Google route needed for a nearby local point). Reuses
  // DEST + auto-drive, so the guide ribbon, pin, ETA and arrival all just work.
  // Aim the car down the START of the route so auto-drive sets off FORWARD instead of a
  // rough U-turn / spin-around (the user's idea: "when autodrive starts it can just point
  // the car in the right direction"). Snaps the heading toward the first route point a few
  // metres out (or the destination if a route isn't ready yet).
  function faceRouteStart() {
    let tx = null, tz = null;
    if (ctx.ROUTE && ctx.ROUTE.length) {
      let i = Math.max(0, ctx.routeIdx);
      while (i < ctx.ROUTE.length - 1 && Math.hypot(ctx.ROUTE[i].x - ctx.car.x, ctx.ROUTE[i].z - ctx.car.z) < 6) i++;
      tx = ctx.ROUTE[i].x; tz = ctx.ROUTE[i].z;
    } else if (ctx.DEST) { tx = ctx.DEST.x; tz = ctx.DEST.z; }
    if (tx == null || Math.hypot(tx - ctx.car.x, tz - ctx.car.z) < 1) return;
    ctx.car.yaw = Math.atan2(tx - ctx.car.x, tz - ctx.car.z);
    ctx.car.steer = 0; ctx.car.vlat = 0; ctx.car.assistRate = 0; ctx.camInit = false;   // re-settle the chase cam behind the new heading
  }
  function setDriveTarget(wx, wz) {
    ctx.follow.stopFollow();   // tapping the map to drive ENDS follow — else followMode stays true and its glide branch shadows the new route (tap looked dead). Covers both the canvas tap and the Google onTap.
    // ALWAYS follow a real ROAD path to the point — NEVER a straight line across the land.
    // Seed an instant on-road route from the local street graph so the car sets off at once,
    // and fetch the Google Directions path to refine/extend it. If neither is ready the car
    // simply HOLDS (idles) until a road route exists — it never cuts across the grass. Then
    // point the car down the route so it doesn't have to turn itself around.
    const g = ctx.geo.worldToGeo(wx, wz);
    let route = ctx.nav.localRoadRoute(ctx.car.x, ctx.car.z, wx, wz);
    if (!route) { const np = ctx.roads.nearestRoadPoint(wx, wz); if (np && np.d < 90) route = ctx.nav.localRoadRoute(ctx.car.x, ctx.car.z, np.x, np.z); }
    ctx.DEST = { x: wx, z: wz, rawX: wx, rawZ: wz, label: 'the map point', geo: g }; ctx.ROUTE = route || null; ctx.routeIdx = 0; ctx.destPin.userData.groundY = null;   // geo kept so a failed route can self-retry
    if (ctx.ROUTE) ctx.nav.snapDestinationToRouteEnd(ctx.ROUTE);
    ctx.nav.fetchRoute(g.lat, g.lon);                            // Google road path (async) → overwrites the seed when ready
    ctx.autoDrive = true; ctx.inp2.navActive = false;
    ctx.emit('dest', { label: ctx.DEST.label }); ctx.emit('autodrive', true);
    ctx.nav.faceRouteStart();
    ctx.toast(route ? '🤖 Cruising the streets' : '🗺️ Finding a road route…', 1200);
  }
  // Live nav target: a look-ahead point ~32 m along the route from the car (so the
  // guide ribbon + auto-drive follow the road smoothly instead of snapping between
  // dense waypoints). Falls back to the destination (straight line) with no route.
  function navTarget() {
    if (!ctx.ROUTE || ctx.routeIdx >= ctx.ROUTE.length) return ctx.DEST;
    // SPEED-SCALED look-ahead: tight at low speed so the car HUGS the route (sticks to
    // the road through turns), longer at speed for a smooth line. A fixed 32 m look-ahead
    // cut every corner.
    const look = clamp(Math.abs(ctx.car.speed) * 0.42, 11, 42);   // tight at low speed (HUGS corners), longer at speed so the chauffeur can anticipate the next bend far from home
    let acc = 0, px = ctx.car.x, pz = ctx.car.z;
    for (let i = ctx.routeIdx; i < ctx.ROUTE.length; i++) {
      acc += Math.hypot(ctx.ROUTE[i].x - px, ctx.ROUTE[i].z - pz); px = ctx.ROUTE[i].x; pz = ctx.ROUTE[i].z;
      if (acc >= look) return ctx.nav.laneOffset(i);
    }
    return ctx.DEST;
  }
  // LANE: aim ~1.7 m to the RIGHT of the route centreline so the car drives IN A LANE
  // instead of straddling the middle of the road (it follows the right perpendicular of the
  // local route direction). Only kicks in on faster/wider roads where lane-keeping reads.
  function laneOffset(i) {
    const a = ctx.ROUTE[Math.max(0, i - 1)], b = ctx.ROUTE[Math.min(ctx.ROUTE.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    // Lane offset only at highway speed, and SMALLER on the tight procedural
    // neighbourhood streets (onRoad mask, or within the ~340 m home block) so it
    // hugs the lane out on the wide real roads without scraping the curb in town.
    const narrow = ctx.onRoad(ctx.ROUTE[i].x, ctx.ROUTE[i].z) || Math.hypot(ctx.ROUTE[i].x, ctx.ROUTE[i].z) < 340;
    const off = clamp((Math.abs(ctx.car.speed) - 22) / 30, 0, 1) * (narrow ? 0.45 : 1.1);
    return { x: ctx.ROUTE[i].x + dz * off, z: ctx.ROUTE[i].z - dx * off };   // right perpendicular = (dz, -dx)
  }
  // distance along the route to the next real TURN (>~25° heading change) — lets the
  // chauffeur run FAST on long straights and only slow for corners/arrival.
  function distToNextTurn() {
    if (!ctx.ROUTE || ctx.routeIdx >= ctx.ROUTE.length - 1) return 40;
    let acc = 0, px = ctx.car.x, pz = ctx.car.z;
    let hx = ctx.ROUTE[ctx.routeIdx].x - px, hz = ctx.ROUTE[ctx.routeIdx].z - pz; let hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
    for (let i = ctx.routeIdx; i < ctx.ROUTE.length - 1 && acc < 500; i++) {
      acc += Math.hypot(ctx.ROUTE[i].x - px, ctx.ROUTE[i].z - pz); px = ctx.ROUTE[i].x; pz = ctx.ROUTE[i].z;
      let nx = ctx.ROUTE[i + 1].x - px, nz = ctx.ROUTE[i + 1].z - pz; const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
      if (hx * nx + hz * nz < 0.9) break;   // ~25°+ bend ahead
      hx = nx; hz = nz;
    }
    return acc;
  }
  function routeTotalLen() {
    if (!ctx.ROUTE) return 0;
    if (ctx._routeLenFor === ctx.ROUTE) return ctx._routeLen;
    ctx._routeLenFor = ctx.ROUTE; ctx._routeLen = 0;
    for (let i = 0; i < ctx.ROUTE.length - 1; i++) ctx._routeLen += Math.hypot(ctx.ROUTE[i + 1].x - ctx.ROUTE[i].x, ctx.ROUTE[i + 1].z - ctx.ROUTE[i].z);
    return ctx._routeLen;
  }
  function railArcAt(x, z) {   // arc-length (m from ROUTE[0]) of the nearest point on the route to (x,z)
    let bestS = 0, bd = 1e18, acc = 0;
    for (let i = 0; i < ctx.ROUTE.length - 1; i++) {
      const ax = ctx.ROUTE[i].x, az = ctx.ROUTE[i].z, vx = ctx.ROUTE[i + 1].x - ax, vz = ctx.ROUTE[i + 1].z - az, L = Math.hypot(vx, vz) || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / (L * L); t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t, pz = az + vz * t, d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bd) { bd = d; bestS = acc + t * L; }
      acc += L;
    }
    return bestS;
  }
  function railPointAt(s) {   // { x, z, yaw, i } at arc-length s along the route
    let acc = 0;
    for (let i = 0; i < ctx.ROUTE.length - 1; i++) {
      const ax = ctx.ROUTE[i].x, az = ctx.ROUTE[i].z, vx = ctx.ROUTE[i + 1].x - ax, vz = ctx.ROUTE[i + 1].z - az, L = Math.hypot(vx, vz) || 1;
      if (acc + L >= s || i === ctx.ROUTE.length - 2) {
        const t = clamp((s - acc) / L, 0, 1);
        return { x: ax + vx * t, z: az + vz * t, yaw: Math.atan2(vx, vz), i };
      }
      acc += L;
    }
    const last = ctx.ROUTE[ctx.ROUTE.length - 1], prev = ctx.ROUTE[ctx.ROUTE.length - 2];
    return { x: last.x, z: last.z, yaw: Math.atan2(last.x - prev.x, last.z - prev.z), i: ctx.ROUTE.length - 2 };
  }
  function autoDriveTargetSpeed(dDest) {
    const turn = ctx.nav.distToNextTurn();
    const straight = clamp((turn - 12) / 95, 0, 1);          // reach full speed on shorter straights
    const far = clamp((dDest - 35) / 220, 0, 1);
    const cruise = 34 + straight * 250 + far * 30;          // up to ~700 mph on a long open straight
    const approach = dDest < 85 ? clamp(14 + dDest * 0.52, 14, 54) : cruise;
    let s = Math.min(cruise, approach);
    // HARD turn cap: never go faster than you can comfortably slow for the next bend, scaled
    // by distance to it. Without this the chauffeur blasts a highway at 450 mph and overshoots
    // the onramp/exit, looping the interchange. ~40 u/s near a turn → ~400 on a long straight.
    s = Math.min(s, 16 + turn * 1.25);   // reuse the `turn` computed above — don't walk the route twice
    if (ctx.autoMaxMph) s = Math.min(s, ctx.autoMaxMph / 2.237);   // user's autodrive speed-limit slider (mph → world u/s)
    return s;
  }
  function toggleAutoDrive() { if (!ctx.DEST) return; ctx.autoDrive = !ctx.autoDrive; ctx.nav.clearRouteRail(); if (!ctx.autoDrive) ctx.inp2.navActive = false; else ctx.nav.faceRouteStart(); ctx.emit('autodrive', ctx.autoDrive); ctx.toast(ctx.autoDrive ? '🤖 Fast auto-drive ON' : 'Auto-drive off', 1100); }
  function updateLocationLabel(now) {
    if (ctx._geoBusy && now - ctx._geoT > 12000) ctx._geoBusy = false;   // watchdog: a Geocoder callback that never fires must not wedge the readout dead for the session
    if (ctx.mode !== 'drive' || ctx._geoBusy || now - ctx._geoT < 4000) return;
    if (ctx._geoLast && Math.hypot(ctx.car.x - ctx._geoLast.x, ctx.car.z - ctx._geoLast.z) < 140) return;
    ctx._geoT = now; ctx._geoLast = { x: ctx.car.x, z: ctx.car.z };
    const g = ctx.geo.worldToGeo(ctx.car.x, ctx.car.z);
    ctx._geoBusy = true;
    ctx.nav.loadMapsSDK().then(maps => {
      new maps.Geocoder().geocode({ location: { lat: g.lat, lng: g.lon } }, (res, status) => {
        ctx._geoBusy = false;
        if (status !== 'OK' || !res || !res.length) return;
        let route = '', locality = '', hood = '', state = '';
        for (const r of res) for (const c of (r.address_components || [])) {
          if (!route && c.types.includes('route')) route = c.short_name || c.long_name;
          if (!locality && c.types.includes('locality')) locality = c.long_name;            // the actual CITY (preferred)
          if (!hood && (c.types.includes('neighborhood') || c.types.includes('sublocality'))) hood = c.long_name;   // fallback only when there's no locality
          if (!state && c.types.includes('administrative_area_level_1')) state = c.short_name;
        }
        const place = [locality || hood, state].filter(Boolean).join(', ');
        const label = [route, place].filter(Boolean).join(' · ');
        if (label && label !== ctx._geoLabel) { ctx._geoLabel = label; ctx.emit('subline', label); }
      });
    }).catch(() => { ctx._geoBusy = false; });
  }
  // Fetch the REAL road network around/ahead of the car. Mapbox vector tiles are the fast
  // path (CDN, GET, service-worker-cacheable); Overpass remains a fallback when the token
  // is absent or a tile request fails. Drive keeps a rolling corridor cache: current box
  // first, then forward boxes based on speed. The steering loop only scans boxes near the
  // car (road-graph.js), so retaining recent boxes does not make stale data pull the car.
  function updateAreaRoads(now, force) {
    if (ctx.mode !== 'drive') return;
    if (Math.hypot(ctx.car.x, ctx.car.z) < 300) return;                                  // the hood's own roadSegs already cover here
    const R = 3500;                                                                   // each box is ~7 km square; corridor boxes cover high-speed travel
    const q = ctx._osmQueue || (ctx._osmQueue = []);
    const boxes = ctx._osmBoxes || (ctx._osmBoxes = []);
    if (force) q.length = 0;                                                         // jump/new route gets the next fetch slots, not stale old-heading jobs
    const covered = (x, z) =>
      boxes.some(b => Math.hypot(x - b.x, z - b.z) < b.r * 0.72) ||
      q.some(b => Math.hypot(x - b.x, z - b.z) < b.r * 0.72);
    const enqueue = (x, z, priority = false) => {
      if (covered(x, z)) return;
      const job = { x, z, r: R };
      if (priority) q.unshift(job); else q.push(job);
    };
    enqueue(ctx.car.x, ctx.car.z, force);
    const speed = Math.abs(ctx.car.speed || 0);
    const step = R * 1.05;
    const queueLimit = 14;
    const enqueueRouteCorridor = () => {
      if (!ctx.ROUTE || ctx.ROUTE.length < 2) return false;
      let acc = 0, nextAt = 0, px = ctx.car.x, pz = ctx.car.z;
      const horizon = Math.max(clamp(speed * 80, R * 2, 50000), R * 4);
      for (let i = Math.max(0, ctx.routeIdx || 0); i < ctx.ROUTE.length && acc <= horizon && q.length < queueLimit; i++) {
        const p = ctx.ROUTE[i], segLen = Math.hypot(p.x - px, p.z - pz);
        acc += segLen; px = p.x; pz = p.z;
        if (acc >= nextAt) { enqueue(p.x, p.z); nextAt += step; }
      }
      const end = ctx.ROUTE[ctx.ROUTE.length - 1];
      if (end) enqueue(end.x, end.z);                                                // always warm the destination curb too
      return true;
    };
    const hasRoute = enqueueRouteCorridor();
    if (!force) {
      let sx = Math.sin(ctx.car.yaw || 0), sz = Math.cos(ctx.car.yaw || 0);
      if (ctx.followMode && ctx._followGeo) {
        const dx = ctx._followGeo.x - ctx.car.x, dz = ctx._followGeo.z - ctx.car.z, dl = Math.hypot(dx, dz);
        if (dl > 3) { sx = dx / dl; sz = dz / dl; }
      } else if (!hasRoute && ctx.DEST) {
        const dx = ctx.DEST.x - ctx.car.x, dz = ctx.DEST.z - ctx.car.z, dl = Math.hypot(dx, dz);
        if (dl > 3) { sx = dx / dl; sz = dz / dl; enqueue(ctx.DEST.x, ctx.DEST.z); }
      }
      const horizon = clamp(speed * 75, speed > 35 ? R * 1.2 : 0, 45000);              // more ahead than behind; current box covers behind
      for (let d = step; d <= horizon && q.length < queueLimit; d += step) enqueue(ctx.car.x + sx * d, ctx.car.z + sz * d);
    }
    if (ctx._osmFetching || !q.length) return;                                        // one fetch at a time
    if (!force && now - ctx._osmT < 1200) return;                                      // do not hammer public Overpass mirrors
    const job = q.shift();
    ctx._osmFetching = true; ctx._osmT = now;
    const fx = job.x, fz = job.z;
    const finishFetch = () => { ctx._osmFetching = false; if (ctx._osmQueue && ctx._osmQueue.length) setTimeout(() => ctx.nav.updateAreaRoads(performance.now(), false), 0); };
    const recordRoadBox = (segs, source, extra = {}) => {
      boxes.push({ x: fx, z: fz, r: R, segs, t: performance.now(), source, ...extra });
      ctx._osmBoxes = boxes
        .filter(b => performance.now() - b.t < 300000 && Math.hypot(ctx.car.x - b.x, ctx.car.z - b.z) < R * 9)
        .slice(-8);
      ctx.osmRoadSegs = ctx._osmBoxes.flatMap(b => b.segs);
      ctx._osmCenter = { x: fx, z: fz, source }; ctx._osmRadius = R;
      if (!segs.length) return;
      // A far jump left the car off-road; now that we have THIS area's roads, snap it on — but ONLY if
      // it's still the SAME stopped, hands-off car the jump dropped (not following, no destination, still
      // near the jump target, within the deadline). Consume the stamp on the FIRST road-data landing either
      // way so it can never leak into a later drive.
      if (ctx._jumpSnap) {
        const j = ctx._jumpSnap; ctx._jumpSnap = null;
        if (!ctx.followMode && !ctx.DEST && Math.abs(ctx.car.speed) < 4 && performance.now() < j.until && Math.hypot(ctx.car.x - j.x, ctx.car.z - j.z) < 60) {
          const np = ctx.roads.nearestRoadPoint(ctx.car.x, ctx.car.z); if (np && np.d < 250) { ctx.car.x = np.x; ctx.car.z = np.z; ctx.nav.settleAfterTeleport(); ctx.toast('🛣️ On the road', 900); }
        }
      }
    };
    const fetchOverpass = () => {
      const cs = [ctx.geo.worldToGeo(fx - R, fz - R), ctx.geo.worldToGeo(fx + R, fz - R), ctx.geo.worldToGeo(fx - R, fz + R), ctx.geo.worldToGeo(fx + R, fz + R)];
      const lats = cs.map(c => c.lat), lons = cs.map(c => c.lon);
      const s = Math.min(...lats).toFixed(6), n = Math.max(...lats).toFixed(6), w = Math.min(...lons).toFixed(6), e = Math.max(...lons).toFixed(6);
      const query = `[out:json][timeout:25];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${s},${w},${n},${e});out geom;`;
      const body = 'data=' + encodeURIComponent(query);
      const tryMirror = (mi) => {
        if (mi >= ctx.OVERPASS_MIRRORS.length) { finishFetch(); return; }   // all mirrors down: keep the last roads, retry later/next box
        const url = ctx.OVERPASS_MIRRORS[(ctx._osmMirror + mi) % ctx.OVERPASS_MIRRORS.length];
        // Hard 12 s cap per mirror: an overloaded Overpass host hangs ~48 s before its 504, which would
        // pin _osmFetching and starve the road graph. Abort early and fall through to the next mirror.
        const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 12000);
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: ac.signal })
          .then(r => { clearTimeout(to); return r.ok ? r.json() : Promise.reject(r.status); })
          .then(data => {
            if (ctx.disposed) { finishFetch(); return; }   // engine torn down while this 12 s fetch was in flight — don't write dead ctx / emit to an unmounted React tree
            const segs = [];
            for (const el of (data.elements || [])) {
              const g = el.geometry; if (el.type !== 'way' || !g || g.length < 2) continue;
              for (let i = 0; i < g.length - 1; i++) {
                const a = ctx.geo.geoToWorld(g[i].lat, g[i].lon), b = ctx.geo.geoToWorld(g[i + 1].lat, g[i + 1].lon);
                segs.push([[a[0], a[1]], [b[0], b[1]]]);
              }
            }
            recordRoadBox(segs, 'osm');
            ctx._osmMirror = (ctx._osmMirror + mi) % ctx.OVERPASS_MIRRORS.length;   // stick with the mirror that worked
            finishFetch();
          })
          .catch(() => { clearTimeout(to); tryMirror(mi + 1); });   // this host is throttling/down — fall through to the next mirror
      };
      tryMirror(0);
    };
    const mapboxOk = hasMapboxRoadToken() && performance.now() >= (ctx._mapboxRoadDisabledUntil || 0);
    if (mapboxOk) {
      fetchMapboxRoadBox(ctx, fx, fz, R)
        .then(result => {
          if (ctx.disposed) { finishFetch(); return; }
          if (result && result.segs.length) {
            recordRoadBox(result.segs, 'mapbox', { zoom: result.zoom, tileCount: result.tileCount });
            finishFetch();
          } else if (force || ctx._jumpSnap || ctx.DEST || ctx.followMode) fetchOverpass();
          else { recordRoadBox([], 'mapbox', result ? { zoom: result.zoom, tileCount: result.tileCount } : {}); finishFetch(); }
        })
        .catch(e => {
          if (e && (e.status === 401 || e.status === 403)) ctx._mapboxRoadDisabledUntil = performance.now() + 60000;
          else if (e && e.status === 429) ctx._mapboxRoadDisabledUntil = performance.now() + 15000;
          fetchOverpass();
        });
    } else fetchOverpass();
  }
  // Local street fallback for minimap/tap auto-drive. Google Directions handles real
  // address trips; this keeps nearby "drive there" pins on neighborhood roads instead
  // of aiming a straight line across yards.
  function localRoadRoute(sx, sz, dx, dz) {
    if (!ctx.roadSegs.length) return null;
    const nodes = [], byKey = new Map(), edges = [];
    const segPts = ctx.roadSegs.map(() => []);
    const keyOf = (x, z) => Math.round(x * 10) / 10 + ',' + Math.round(z * 10) / 10;
    const addNode = (x, z) => {
      const key = keyOf(x, z);
      let id = byKey.get(key);
      if (id == null) { id = nodes.length; byKey.set(key, id); nodes.push({ x, z }); edges[id] = []; }
      return id;
    };
    const project = (x, z) => {
      let best = null, bd = 1e18;
      for (let i = 0; i < ctx.roadSegs.length; i++) {
        const s = ctx.roadSegs[i], ax = s[0][0], az = s[0][1], bx = s[1][0], bz = s[1][1];
        const vx = bx - ax, vz = bz - az, L2 = vx * vx + vz * vz || 1;
        let t = ((x - ax) * vx + (z - az) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + vx * t, pz = az + vz * t, d = (px - x) * (px - x) + (pz - z) * (pz - z);
        if (d < bd) { bd = d; best = { seg: i, t, x: px, z: pz, d: Math.sqrt(d) }; }
      }
      return best;
    };
    const start = project(sx, sz), finish = project(dx, dz);
    if (!start || !finish || start.d > 90 || finish.d > 90) return null;   // generous snap so taps near a road still route
    for (let i = 0; i < ctx.roadSegs.length; i++) {
      const s = ctx.roadSegs[i];
      segPts[i].push({ id: addNode(s[0][0], s[0][1]), t: 0 });
      segPts[i].push({ id: addNode(s[1][0], s[1][1]), t: 1 });
    }
    const sid = addNode(start.x, start.z), fid = addNode(finish.x, finish.z);
    segPts[start.seg].push({ id: sid, t: start.t });
    segPts[finish.seg].push({ id: fid, t: finish.t });
    const link = (a, b) => {
      if (a === b) return;
      const na = nodes[a], nb = nodes[b], w = Math.hypot(nb.x - na.x, nb.z - na.z);
      edges[a].push([b, w]); edges[b].push([a, w]);
    };
    for (let i = 0; i < segPts.length; i++) {
      const pts = segPts[i].sort((a, b) => a.t - b.t);
      for (let k = 0; k < pts.length - 1; k++) link(pts[k].id, pts[k + 1].id);
    }
    const dist = Array(nodes.length).fill(Infinity), prev = Array(nodes.length).fill(-1), used = Array(nodes.length).fill(false);
    dist[sid] = 0;
    for (let n = 0; n < nodes.length; n++) {
      let u = -1, bd = Infinity;
      for (let i = 0; i < nodes.length; i++) if (!used[i] && dist[i] < bd) { bd = dist[i]; u = i; }
      if (u < 0 || u === fid) break;
      used[u] = true;
      for (const [v, w] of edges[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
    }
    if (!isFinite(dist[fid])) return null;
    const out = [];
    for (let u = fid; u >= 0; u = prev[u]) { out.push({ x: nodes[u].x, z: nodes[u].z }); if (u === sid) break; }
    return out.length > 1 ? out.reverse() : null;
  }
  function clearRouteCaches() {
    ctx._routeLenFor = null; ctx._routeLen = 0;
    ctx._routeYFor = null; ctx._routeY = [];
  }
  function guideHeightAt(i) {
    if (ctx._routeYFor !== ctx.ROUTE) { ctx._routeYFor = ctx.ROUTE; ctx._routeY = []; }
    const p = ctx.ROUTE[i], tA = terrainAt(p.x, p.z), nowMs = performance.now();
    let rec = ctx._routeY[i];
    if (!rec || (!rec.confirmed && nowMs >= (rec.retryAt || 0))) {
      const base = rec ? rec.y : tA;
      let y = ctx.ground.rawTileY(p.x, p.z, base + 8);
      if (y == null && rec) y = ctx.ground.rawTileY(p.x, p.z, base + 24);
      if (y == null && !rec) y = ctx.ground.rawTileY(p.x, p.z);
      if (y != null) {
        const inHood = p.x * p.x + p.z * p.z <= 330 * 330;
        rec = { y: inHood ? clamp(y, tA - 2, tA + 2) : y, confirmed: true, retryAt: 0 };
      } else if (!rec) rec = { y: tA, confirmed: false, retryAt: nowMs + 350 };
      else rec.retryAt = nowMs + 350;
      ctx._routeY[i] = rec;
    }
    return rec.y;
  }
  function updateGuide(yC) {
    // Rebuild EVERY frame (no move-throttle) so the ribbon GLIDES forward instead of
    // stepping in 1.5 m jumps. It's cheap now: the per-point road heights are cached, so a
    // frame is just interpolation + a tiny 540-float VBO upload — no per-frame raycasts.
    // start the ribbon ~6 m AHEAD of the car so the line never tints the car itself.
    const raw = [[ctx.car.x + Math.sin(ctx.car.yaw) * 6, ctx.car.z + Math.cos(ctx.car.yaw) * 6, yC]];
    if (ctx.ROUTE && ctx.routeIdx < ctx.ROUTE.length) {
      let acc = 0, px = ctx.car.x, pz = ctx.car.z;
      for (let i = ctx.routeIdx; i < ctx.ROUTE.length && acc < 170; i++) { acc += Math.hypot(ctx.ROUTE[i].x - px, ctx.ROUTE[i].z - pz); raw.push([ctx.ROUTE[i].x, ctx.ROUTE[i].z, ctx.nav.guideHeightAt(i)]); px = ctx.ROUTE[i].x; pz = ctx.ROUTE[i].z; }
    } else { ctx.guideLine.visible = false; return; }   // ONLY ever follow a real road ROUTE — never a straight line across the land
    // resample to ~5 m steps, carrying the draped height through so each cross-section sits
    // on the road surface (interpolated between cached route-point heights).
    const pts = [raw[0]];
    for (let i = 1; i < raw.length && pts.length < ctx.GUIDE_N; i++) {
      const a = pts[pts.length - 1], b = raw[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.min(ctx.GUIDE_N - pts.length, Math.round(L / 5)));
      for (let s = 1; s <= steps; s++) { const t = s / steps; pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
    }
    if (pts.length < 2) { ctx.guideLine.visible = false; return; }
    const hw = 1.55;
    for (let i = 0; i < ctx.GUIDE_N; i++) {
      const k = Math.min(i, pts.length - 1), p = pts[k];
      const pp = pts[Math.max(0, k - 1)], pn = pts[Math.min(pts.length - 1, k + 1)];
      let tx = pn[0] - pp[0], tz = pn[1] - pp[1]; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const nx = -tz, nz = tx, y = p[2] + 0.38, o = i * 6;
      ctx.guidePos[o] = p[0] + nx * hw; ctx.guidePos[o + 1] = y; ctx.guidePos[o + 2] = p[1] + nz * hw;
      ctx.guidePos[o + 3] = p[0] - nx * hw; ctx.guidePos[o + 4] = y; ctx.guidePos[o + 5] = p[1] - nz * hw;
    }
    ctx.guideGeo.attributes.position.needsUpdate = true;
    ctx.guideGeo.setDrawRange(0, (Math.min(pts.length, ctx.GUIDE_N) - 1) * 6);   // only the built segments
    ctx.guideLine.visible = true;
  }
  // 2D minimap (HEADING-UP, centred on the car): roads, house, destination + line, car. The map
  // rotates so the car's forward is always "up" — oriented like the driver / user, the way a phone
  // GPS does. A small N tick shows where north is; tapMinimap inverts the SAME rotation so taps land.
  // `g` = the canvas 2D context (renamed from `ctx` so it doesn't shadow the engine ctx —
  // the procedural minimap reads engine state via ctx.* and draws via g.*).
  function drawMinimap(g, w, h) {
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, range = 620, scale = (w / 2) / range;   // wider view to match the live map zoom-out
    let _d = ctx.follow.viewHeading() - ctx._miniYaw; while (_d > Math.PI) _d -= 2 * Math.PI; while (_d < -Math.PI) _d += 2 * Math.PI;
    ctx._miniYaw += _d * 0.2;                                                  // ease the map's rotation (viewHeading = compass while following) so jitter doesn't shimmer the whole map
    const ca = Math.cos(ctx._miniYaw), sa = Math.sin(ctx._miniYaw);
    const toPx = (wx, wz) => { const dx = wx - ctx.car.x, dz = wz - ctx.car.z; return [cx + (-dx * ca + dz * sa) * scale, cy + (-dx * sa - dz * ca) * scale]; };   // heading-up rotation: forward → screen-up
    g.lineWidth = 1.4; g.strokeStyle = 'rgba(255,255,255,0.55)'; g.beginPath();
    for (const s of ctx.roadSegs) {
      const a = toPx(s[0][0], s[0][1]), b = toPx(s[1][0], s[1][1]);
      if ((a[0] < -10 && b[0] < -10) || (a[0] > w + 10 && b[0] > w + 10) || (a[1] < -10 && b[1] < -10) || (a[1] > h + 10 && b[1] > h + 10)) continue;
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    }
    g.stroke();
    const hp = toPx(0, 0); g.fillStyle = '#4ea1ff'; g.beginPath(); g.arc(hp[0], hp[1], 3, 0, 7); g.fill();
    g.fillStyle = '#ffcb2e';                            // uncollected coins
    for (const c of ctx.coins) { if (c.got) continue; const p = toPx(c.x, c.z); if (p[0] > 0 && p[0] < w && p[1] > 0 && p[1] < h) { g.beginPath(); g.arc(p[0], p[1], 2, 0, 7); g.fill(); } }
    // neighbourhood landmarks — your 5 real places. On-map = dot; off-map = clamped to
    // the edge as a "that way" hint. Pink = still to find, green = found.
    for (const poi of ctx.POIS) {
      const p = toPx(poi.x, poi.z);
      const m = 7, edge = p[0] < m || p[0] > w - m || p[1] < m || p[1] > h - m;
      const px = clamp(p[0], m, w - m), py = clamp(p[1], m, h - m);
      const found = ctx.poiFound.has(poi.key);
      g.fillStyle = found ? '#3ad17a' : '#ff5ad0';
      g.beginPath(); g.arc(px, py, edge ? 2.6 : 3.4, 0, 7); g.fill();
      if (!found && !edge) { g.strokeStyle = 'rgba(255,90,208,0.8)'; g.lineWidth = 1.3; g.beginPath(); g.arc(px, py, 5.4, 0, 7); g.stroke(); }
    }
    if (ctx.DEST) {
      // draw the route from the CAR forward (not from ROUTE[0]) so the already-driven
      // part doesn't whip around the car-centred map during auto-drive.
      g.strokeStyle = '#2f8bff'; g.lineWidth = 2.6; g.lineJoin = 'round'; g.beginPath();
      g.moveTo(cx, cy);
      if (ctx.ROUTE && ctx.ROUTE.length > 1) for (let i = Math.max(0, ctx.routeIdx); i < ctx.ROUTE.length; i++) { const p = toPx(ctx.ROUTE[i].x, ctx.ROUTE[i].z); g.lineTo(p[0], p[1]); }
      else { const dp = toPx(ctx.DEST.x, ctx.DEST.z); g.lineTo(dp[0], dp[1]); }
      g.stroke();
      const dp = toPx(ctx.DEST.x, ctx.DEST.z);
      g.fillStyle = '#ffc21e'; g.beginPath(); g.arc(Math.max(5, Math.min(w - 5, dp[0])), Math.max(5, Math.min(h - 5, dp[1])), 4, 0, 7); g.fill();
    }
    // CAR: on a heading-up map the car always points straight UP (forward).
    g.fillStyle = '#d94f1e'; g.beginPath();
    g.moveTo(cx, cy - 7); g.lineTo(cx + 4, cy + 5); g.lineTo(cx - 4, cy + 5);
    g.closePath(); g.fill();
    // NORTH tick: world north (-z) maps to screen dir (-sin, cos) of the map heading — so the user can
    // still orient even as the whole map spins under them.
    const nlen = Math.min(cx, cy) - 8, nNx = cx - sa * nlen, nNy = cy + ca * nlen;
    g.fillStyle = 'rgba(255,255,255,0.92)'; g.font = 'bold 9px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', nNx, nNy);
  }
  return { loadMapsSDK, laneOffsetRoute, fetchRoute, snapDestinationToRouteEnd, setDestination, clearDestination, geocodeAddress, geocodePOIs, geocodePlaceId, placeSuggest, disposeMiniMap, initMiniMap, updateMiniMap, settleAfterTeleport, jumpTo, snapJumpToRoad, setDestinationByText, setDestinationByPlace, driveHome, jumpHome, driveToLatLon, faceRouteStart, setDriveTarget, navTarget, laneOffset, distToNextTurn, routeTotalLen, railArcAt, railPointAt, autoDriveTargetSpeed, toggleAutoDrive, clearRouteRail, clearRouteCaches, updateLocationLabel, updateAreaRoads, localRoadRoute, guideHeightAt, updateGuide, drawMinimap };
}
