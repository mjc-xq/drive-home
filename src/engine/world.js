import * as THREE from 'three';
import { merge, gablePrism, footprintGeom, splitTops, makeRand } from './geom.js';
import { buildRoadMask } from './roadmask.js';

// Builds every static thing in the scene from scene.json. Returns the handles
// the engine needs for gameplay (collision boxes, road lookup, house, spawn
// points, labels...). Order matters: buildings must exist before trees
// (blocked() reads bldBoxes) and before the yard (frontPt reads house).
export function buildWorld(scene, renderer, { S, C, W, uvAt, terrainAt, SREC, GRID_ANG, aerialUrl }) {
  const rand = makeRand(1840);
  const T = S.terrain, TN = T.n, TH = T.half, TSTEP = (2 * TH) / (TN - 1);

  const aerialTex = new THREE.TextureLoader().load(aerialUrl);
  aerialTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  aerialTex.minFilter = THREE.LinearMipmapLinearFilter;
  const aerialMat = new THREE.MeshStandardMaterial({ map: aerialTex, roughness: 1, side: THREE.DoubleSide });

  // ---------- terrain ----------
  {
    const pos = [], uv = [], idx = [];
    for (let j = 0; j < TN; j++) for (let i = 0; i < TN; i++) {
      const e = -TH + i * TSTEP, n = TH - j * TSTEP, y = T.h[j * TN + i];
      const wx = e - C[0], wz = -(n - C[1]);
      pos.push(wx, y, wz);
      const t = uvAt(wx, wz); uv.push(t[0], t[1]);
    }
    for (let j = 0; j < TN - 1; j++) for (let i = 0; i < TN - 1; i++) {
      const a = j * TN + i, b = a + 1, c = a + TN, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, aerialMat);
    m.receiveShadow = true; scene.add(m);
  }

  // ---------- creek ----------
  let creekPtsW = null;
  if (S.creek) {
    creekPtsW = S.creek.p.map(W);
    const pts = creekPtsW;
    const pos = [], idx = []; let vi = 0; const hw = 1.6, lift = 0.25;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], q = pts[Math.min(k + 1, pts.length - 1)], o = pts[Math.max(k - 1, 0)];
      let dx = q[0] - o[0], dz = q[1] - o[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const nx = -dz, nz = dx;
      for (const s of [1, -1]) {
        const x = p[0] + nx * hw * s, z = p[1] + nz * hw * s;
        pos.push(x, terrainAt(x, z) + lift, z);
      }
      if (k > 0) idx.push(vi - 2, vi - 1, vi, vi, vi - 1, vi + 1);
      vi += 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: 0x3c6472, roughness: .35, metalness: .1, transparent: true, opacity: .78, side: THREE.DoubleSide
    })));
  }

  // ---------- streets (crisp ribbons over the aerial) ----------
  function buildRoads(filter, lift, color, op) {
    const pos = [], idx = []; let vi = 0;
    for (const r of S.roads) {
      if (!filter(r)) continue;
      const pts = [];
      for (let k = 0; k < r.p.length - 1; k++) {
        const [ax, az] = W(r.p[k]), [bx, bz] = W(r.p[k + 1]);
        const d = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.round(d / 5));
        for (let s = 0; s < steps; s++) pts.push([ax + (bx - ax) * s / steps, az + (bz - az) * s / steps]);
        if (k === r.p.length - 2) pts.push([bx, bz]);
      }
      if (pts.length < 2) continue;
      const hw = r.w / 2;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k], q = pts[Math.min(k + 1, pts.length - 1)], o = pts[Math.max(k - 1, 0)];
        let dx = q[0] - o[0], dz = q[1] - o[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        const nx = -dz, nz = dx;
        pos.push(p[0] + nx * hw, terrainAt(p[0] + nx * hw, p[1] + nz * hw) + lift, p[1] + nz * hw);
        pos.push(p[0] - nx * hw, terrainAt(p[0] - nx * hw, p[1] - nz * hw) + lift, p[1] - nz * hw);
        if (k > 0) idx.push(vi - 2, vi - 1, vi, vi, vi - 1, vi + 1);
        vi += 2;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: .96, side: THREE.DoubleSide, transparent: true, opacity: op }));
    m.receiveShadow = true; scene.add(m);
  }
  buildRoads(r => r.k === 'residential' || r.k === 'tertiary', 0.18, 0x76777b, 0.92);
  buildRoads(r => r.k === 'service', 0.13, 0xa39f96, 0.85);

  const { onRoad } = buildRoadMask(S.roads, W);

  // ---------- buildings ----------
  const FACADE = [];
  const WIN_C = new THREE.Color(0x39414c), DOOR_C = new THREE.Color(0x4a3b2e), HDOOR_C = new THREE.Color(0xd94f1e);
  const GARAGE_C = new THREE.Color(0xcfc8b8);
  function addFacades(poly, base, wallH, isHouse) {
    let cx = 0, cz = 0; for (const p of poly) { cx += p[0]; cz += p[1]; } cx /= poly.length; cz /= poly.length;
    const ground = base + 0.5;
    const rows = [ground + 1.85];
    if (wallH > 6.2) rows.push(ground + 4.7);
    if (wallH > 9.2) rows.push(ground + 7.5);
    let bestEdge = -1, bestLen = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L > bestLen) { bestLen = L; bestEdge = i; }
    }
    // garage door beside the front door on larger non-house homes
    const garageW = 2.7;
    const hasGarage = !isHouse && bestLen >= 10 && rand() < 0.65;
    const garageOff = hasGarage ? (rand() < 0.5 ? -1 : 1) * (garageW / 2 + 1.6) : 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 3.6) continue;
      const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
      let ox = dz, oz = -dx;
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      if (ox * (mx - cx) + oz * (mz - cz) < 0) { ox = -ox; oz = -oz; }
      const yaw = Math.atan2(ox, oz);
      const n = Math.min(6, Math.floor((L - 1.8) / 2.3));
      const start = (L - (n - 1) * 2.3) / 2;
      for (const ry of rows) {
        if (ry + 0.6 > base + wallH) continue;
        for (let k = 0; k < n; k++) {
          const d = start + k * 2.3;
          if (i === bestEdge && ry === rows[0]) {
            if (Math.abs(d - L / 2) < 1.0) continue; // leave room for the door
            if (hasGarage && Math.abs(d - (L / 2 + garageOff)) < garageW / 2 + 0.55) continue;
          }
          const g = new THREE.PlaneGeometry(0.95, 1.15).toNonIndexed();
          g.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw));
          g.translate(a[0] + dx * d + ox * 0.07, ry, a[1] + dz * d + oz * 0.07);
          FACADE.push({ g, color: WIN_C });
        }
      }
      if (i === bestEdge) {
        const g = new THREE.PlaneGeometry(1.0, 2.05).toNonIndexed();
        g.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw));
        g.translate(mx + ox * 0.07, ground + 1.03, mz + oz * 0.07);
        FACADE.push({ g, color: isHouse ? HDOOR_C : DOOR_C });
        if (hasGarage) {
          const gg = new THREE.PlaneGeometry(garageW, 2.0).toNonIndexed();
          gg.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw));
          gg.translate(a[0] + dx * (L / 2 + garageOff) + ox * 0.07, ground + 1.0, a[1] + dz * (L / 2 + garageOff) + oz * 0.07);
          FACADE.push({ g: gg, color: GARAGE_C });
        }
      }
    }
  }

  const ctxWalls = [], ctxTops = [];
  const house = { meshes: [], roof: null, bbox: null, baseY: 0 };
  const wallBase = new THREE.Color(0xe6dfd2);
  const bldBoxes = [];
  const WHITE = new THREE.Color(1, 1, 1);
  for (const b of S.buildings) {
    const poly = b.p.map(W);
    let cx = 0, cz = 0; for (const p of poly) { cx += p[0]; cz += p[1]; } cx /= poly.length; cz /= poly.length;
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (const p of poly) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]); }
    const base = terrainAt(cx, cz) - 0.5;
    const gabled = !!b.r;
    const wallH = (gabled ? Math.max(2.4, b.h * 0.8) : b.h) + 0.5;
    bldBoxes.push([minx - 0.4, maxx + 0.4, minz - 0.4, maxz + 0.4, base + wallH + 3]);
    const ex = footprintGeom(b.p, wallH, W).toNonIndexed(); ex.translate(0, base, 0);
    const parts = splitTops(ex);
    const roofGs = [];
    if (gabled) for (const r of b.r) {
      let [rcx, rcy, w, d, deg] = r;
      let L = w, Sp = d, ang = deg * Math.PI / 180;
      if (d > w) { L = d; Sp = w; ang += Math.PI / 2; }
      const rise = Math.min(2.6, Math.max(0.85, Sp * 0.30));
      const g = gablePrism(L, Sp, wallH - 0.04, rise, 0.45);
      g.applyMatrix4(new THREE.Matrix4().makeRotationY(ang));
      const [wx, wz] = W([rcx, rcy]);
      g.translate(wx, base, wz);
      roofGs.push(g);
    }
    addFacades(poly, base, wallH, !!b.house);
    if (b.house) {
      house.bbox = [minx, maxx, minz, maxz]; house.baseY = base; house.c = [cx, cz];
      house.wallH = wallH; house.rects = b.r;
      const wm = new THREE.Mesh(parts.side, new THREE.MeshStandardMaterial({ color: 0xf7f0e3, roughness: .8 }));
      wm.castShadow = wm.receiveShadow = true; scene.add(wm); house.meshes.push(wm);
      const rg = roofGs.length ? merge(roofGs.map(g => ({ g, color: WHITE }))) : parts.top;
      const rm = new THREE.Mesh(rg, new THREE.MeshStandardMaterial(
        { color: 0xdf5524, roughness: .62, emissive: 0x3a1205, emissiveIntensity: .4, side: THREE.DoubleSide, transparent: true }));
      rm.castShadow = true; scene.add(rm); house.meshes.push(rm); house.roof = rm;
    } else {
      const wc = wallBase.clone().offsetHSL((rand() - 0.5) * 0.015, (rand() - 0.5) * 0.04, (rand() - 0.5) * 0.05);
      ctxWalls.push({ g: parts.side, color: wc });
      ctxTops.push({ g: parts.top, color: WHITE });
      for (const g of roofGs) ctxTops.push({ g, color: WHITE });
    }
  }
  {
    const wallsMesh = new THREE.Mesh(merge(ctxWalls),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9 }));
    wallsMesh.castShadow = wallsMesh.receiveShadow = true; scene.add(wallsMesh);
    const topsMesh = new THREE.Mesh(merge(ctxTops, uvAt), aerialMat);
    topsMesh.castShadow = topsMesh.receiveShadow = true; scene.add(topsMesh);
    const facMesh = new THREE.Mesh(merge(FACADE),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .35, metalness: .15 }));
    scene.add(facMesh);
  }

  // ---------- interior (dollhouse) ----------
  const floorY = house.baseY + 0.62;
  function rectXform(rect) {
    const [rcx, rcy, w, d, deg] = rect, ang = deg * Math.PI / 180;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    return {
      w, d, ang,
      pt(lx, ly) { // local (x along w, y along d) -> world [x,z]
        const e = rcx + lx * ca - ly * sa, n = rcy + lx * sa + ly * ca;
        return W([e, n]);
      }
    };
  }
  const FURN = [];
  const boxAt = (xf, lx, ly, yaw, w, h, d, y, color) => {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw + xf.ang));
    const [wx, wz] = xf.pt(lx, ly);
    g.translate(wx, y + h / 2, wz);
    FURN.push({ g, color: new THREE.Color(color) });
  };
  const cylAt = (xf, lx, ly, r, h, y, color, seg = 10) => {
    const g = new THREE.CylinderGeometry(r, r, h, seg).toNonIndexed();
    const [wx, wz] = xf.pt(lx, ly);
    g.translate(wx, y + h / 2, wz);
    FURN.push({ g, color: new THREE.Color(color) });
  };
  const PART = [];
  const wallSeg = (xf, x0, y0, x1, y1) => {
    const [ax, az] = xf.pt(x0, y0), [bx, bz] = xf.pt(x1, y1);
    const L = Math.hypot(bx - ax, bz - az);
    const g = new THREE.BoxGeometry(L, 2.3, 0.12).toNonIndexed();
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.atan2(-(bz - az), bx - ax)));
    g.translate((ax + bx) / 2, floorY + 1.15, (az + bz) / 2);
    PART.push({ g, color: new THREE.Color(0xf2ece0) });
  };
  if (house.rects && house.rects.length >= 3) {
    const R = house.rects.map(rectXform);
    R.sort((a, b) => b.w * b.d - a.w * a.d);
    const [big, mid, sm] = R; // big: living+kitchen | mid: 2 bedrooms | sm: bed/bath
    for (const xf of R) {
      const g = new THREE.BoxGeometry(xf.w - 0.25, 0.1, xf.d - 0.25).toNonIndexed();
      g.applyMatrix4(new THREE.Matrix4().makeRotationY(xf.ang));
      const [wx, wz] = xf.pt(0, 0);
      g.translate(wx, floorY, wz);
      FURN.push({ g, color: new THREE.Color(0xc9a87c) });
    }
    // ----- big wing: living + kitchen/dining -----
    {
      const xf = big, w = xf.w, d = xf.d, split = -d * 0.08;
      wallSeg(xf, -w / 2, split, -w / 2 + (w - 1.1) / 2, split);
      wallSeg(xf, w / 2 - (w - 1.1) / 2, split, w / 2, split);
      const lyC = (split + d / 2) / 2;
      boxAt(xf, 0, d / 2 - 0.85, 0, 2.6, 0.75, 0.95, floorY, 0x8d9da6);
      boxAt(xf, 0, d / 2 - 1.55, 0, 2.6, 0.42, 0.55, floorY, 0x9fafb8);
      boxAt(xf, -1.65, d / 2 - 1.3, 0, 0.8, 0.6, 0.8, floorY, 0x8d9da6);
      boxAt(xf, 0, lyC + 0.1, 0, 1.2, 0.34, 0.7, floorY, 0xb08968);
      boxAt(xf, 0, split + 0.45, 0, 1.8, 0.5, 0.42, floorY, 0x6b5a48);
      boxAt(xf, 0, split + 0.32, 0, 1.6, 0.9, 0.08, floorY + 0.55, 0x1c1c1f);
      boxAt(xf, 0.1, lyC + 0.05, 0.4, 3.4, 0.04, 2.3, floorY, 0xd9c6a5);
      const ky = -d / 2;
      boxAt(xf, 0, ky + 0.34, 0, w - 0.7, 0.92, 0.62, floorY, 0xe8e4da);
      boxAt(xf, -w / 2 + 0.36, (split + ky) / 2, Math.PI / 2, (split - ky) - 1.4, 0.92, 0.62, floorY, 0xe8e4da);
      boxAt(xf, -w / 2 + 0.4, split - 0.9, 0, 0.75, 1.8, 0.7, floorY, 0xb9babd);
      cylAt(xf, 0.7, (split + ky) / 2 + 0.2, 0.75, 0.06, floorY + 0.72, 0xb08968);
      cylAt(xf, 0.7, (split + ky) / 2 + 0.2, 0.07, 0.72, floorY, 0x6b5a48);
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + 0.4;
        boxAt(xf, 0.7 + Math.cos(a) * 1.15, (split + ky) / 2 + 0.2 + Math.sin(a) * 1.15, -a, 0.42, 0.45, 0.42, floorY, 0x7d6a55);
      }
    }
    // ----- mid wing: two bedrooms -----
    {
      const xf = mid, w = xf.w, d = xf.d;
      wallSeg(xf, -w / 2, 0, -w / 2 + (w - 1.0) / 2, 0);
      wallSeg(xf, w / 2 - (w - 1.0) / 2, 0, w / 2, 0);
      for (const s of [1, -1]) {
        const cy = s * d / 4;
        boxAt(xf, 0, cy + s * (d / 4 - 1.25), 0, 1.7, 0.55, 2.1, floorY, 0xf0e9dc);
        boxAt(xf, 0, cy + s * (d / 4 - 0.55), 0, 1.5, 0.18, 0.6, floorY + 0.55, 0xd94f1e);
        boxAt(xf, 1.15, cy + s * (d / 4 - 0.6), 0, 0.5, 0.5, 0.45, floorY, 0x8a7460);
        boxAt(xf, -1.15, cy + s * (d / 4 - 0.6), 0, 0.5, 0.5, 0.45, floorY, 0x8a7460);
        boxAt(xf, -w / 2 + 0.4, cy - s * 0.6, Math.PI / 2, 1.5, 1.0, 0.55, floorY, 0x9c8468);
      }
    }
    // ----- small wing: bedroom + bath -----
    {
      const xf = sm, w = xf.w, d = xf.d;
      const split = -d * 0.18;
      wallSeg(xf, -w / 2, split, -w / 2 + (w - 0.95) / 2, split);
      wallSeg(xf, w / 2 - (w - 0.95) / 2, split, w / 2, split);
      boxAt(xf, 0, d / 2 - 1.3, 0, 1.5, 0.55, 2.0, floorY, 0xf0e9dc);
      boxAt(xf, 0, d / 2 - 0.6, 0, 1.3, 0.18, 0.55, floorY + 0.55, 0x5d7d86);
      boxAt(xf, w / 2 - 0.4, d / 2 - 2.6, 0, 0.5, 1.5, 0.5, floorY, 0x9c8468);
      boxAt(xf, -w / 2 + 0.5, split - 0.7, 0, 0.75, 0.55, 0.85, floorY, 0xffffff);
      cylAt(xf, -w / 2 + 0.5, split - 0.55, 0.26, 0.1, floorY + 0.55, 0xffffff, 12);
      boxAt(xf, w / 2 - 0.55, split - 0.65, 0, 0.9, 0.85, 0.55, floorY, 0xe8e4da);
      boxAt(xf, 0.05, -d / 2 + 0.55, 0, w - 1.3, 0.55, 0.85, floorY, 0xffffff);
    }
  }
  const interiorGroup = new THREE.Group();
  if (FURN.length) {
    const fm = new THREE.Mesh(merge(FURN), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .85 }));
    const pm = new THREE.Mesh(merge(PART), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9 }));
    fm.receiveShadow = pm.receiveShadow = true;
    interiorGroup.add(fm, pm);
  }
  scene.add(interiorGroup);

  // ---------- yard extras ----------
  let COMPOST = null;
  let frontPt = null, frontDir = null;
  {
    let best = 1e9;
    for (const rr of S.roads) {
      if (rr.n !== 'Dahill Lane') continue;
      for (let k = 0; k < rr.p.length; k++) {
        const w = W(rr.p[k]); const d = Math.hypot(w[0] - house.c[0], w[1] - house.c[1]);
        if (d < best) {
          best = d; frontPt = w;
          const w2 = W(rr.p[Math.min(k + 1, rr.p.length - 1)]);
          frontDir = [w2[0] - w[0], w2[1] - w[1]];
          const L = Math.hypot(...frontDir) || 1; frontDir = [frontDir[0] / L, frontDir[1] / L];
        }
      }
    }
    if (frontPt) {
      const toHouse = [house.c[0] - frontPt[0], house.c[1] - frontPt[1]];
      const L = Math.hypot(...toHouse); const u = [toHouse[0] / L, toHouse[1] / L];
      const yard = [];
      // mailbox at curb
      const mx = frontPt[0] + u[0] * 3.2, mz = frontPt[1] + u[1] * 3.2, my = terrainAt(mx, mz);
      let g = new THREE.BoxGeometry(0.08, 1.05, 0.08).toNonIndexed(); g.translate(mx, my + 0.52, mz); yard.push({ g, color: new THREE.Color(0x6b5a48) });
      g = new THREE.BoxGeometry(0.5, 0.26, 0.3).toNonIndexed(); g.translate(mx, my + 1.15, mz); yard.push({ g, color: new THREE.Color(0xd94f1e) });
      // patio behind the house
      const px = house.c[0] + u[0] * ((house.bbox[1] - house.bbox[0]) / 2 + 3.4), pz = house.c[1] + u[1] * ((house.bbox[3] - house.bbox[2]) / 2 + 3.4);
      g = new THREE.BoxGeometry(4.6, 0.12, 3.4).toNonIndexed();
      g.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.atan2(-u[1], u[0])));
      g.translate(px, terrainAt(px, pz) + 0.12, pz); yard.push({ g, color: new THREE.Color(0xb9b2a4) });
      // two bins by the side (the green one is the compost target)
      for (let i = 0; i < 2; i++) {
        g = new THREE.BoxGeometry(0.55, 0.95, 0.55).toNonIndexed();
        const bx = house.bbox[0] - 1.2, bz = house.c[1] + i * 0.8 - 0.4;
        g.translate(bx, terrainAt(bx, bz) + 0.48, bz);
        if (i) COMPOST = [bx, bz];
        yard.push({ g, color: new THREE.Color(i ? 0x3a5a3c : 0x44484e) });
      }
      const ym = new THREE.Mesh(merge(yard), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9 }));
      ym.castShadow = true; scene.add(ym);
    }
  }

  // ---------- animal sanctuary structures ----------
  {
    const sanct = [];
    const addBox = (cx, cz, yaw, w, h, d, y, color) => {
      const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
      g.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw));
      g.translate(cx, y + h / 2, cz);
      sanct.push({ g, color: new THREE.Color(color) });
    };
    const gPrism = (cx, cz, yaw, L, Sp, y0, rise, ov, color) => {
      const g = gablePrism(L, Sp, 0, rise, ov);
      g.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw));
      g.translate(cx, y0, cz);
      sanct.push({ g, color: new THREE.Color(color) });
    };
    // shed (iguana) — tucked against the house's south corner
    {
      const [x, z] = SREC.shed, y = terrainAt(x, z) - 0.15;
      addBox(x, z, GRID_ANG, 2.6, 2.0, 2.2, y, 0x8a6f54);
      gPrism(x, z, GRID_ANG, 2.6, 2.2, y + 2.0, 0.55, 0.25, 0x4a5d3f);
      // door + basking step on the yard-facing side (away from the house)
      const sn = [Math.sin(GRID_ANG), Math.cos(GRID_ANG)];
      addBox(x + sn[0] * 1.13, z + sn[1] * 1.13, GRID_ANG, 0.9, 1.5, 0.06, y + 0.05, 0xf0ece2);
      addBox(x + sn[0] * 1.55, z + sn[1] * 1.55, GRID_ANG, 1.0, 0.1, 0.7, y, 0x9a7c5a);
      bldBoxes.push([x - 1.8, x + 1.8, z - 1.6, z + 1.6, y + 3.2]);
    }
    // duck structure — middle yard, blue-gray roof
    {
      const [x, z] = SREC.coop, y = terrainAt(x, z) - 0.15;
      addBox(x, z, GRID_ANG, 3.0, 1.15, 2.4, y, 0xb9ae98);
      gPrism(x, z, GRID_ANG, 3.0, 2.4, y + 1.15, 0.85, 0.3, 0x7d93a0);
      addBox(x, z - 1.7, GRID_ANG, 0.9, 0.08, 1.4, y + 0.18, 0x9a7c5a); // ramp
      bldBoxes.push([x - 1.9, x + 1.9, z - 1.7, z + 1.7, y + 2.6]);
    }
    // barn (pigs) — near the creek
    {
      const [x, z] = SREC.barn, y = terrainAt(x, z) - 0.2;
      addBox(x, z, GRID_ANG, 5.0, 2.5, 4.0, y, 0x9e3b2e);
      gPrism(x, z, GRID_ANG, 5.0, 4.0, y + 2.5, 1.3, 0.4, 0x6b6f76);
      // white door on the pen-facing face (the handoff version had its offsets
      // zeroed out, which buried the door inside the barn volume)
      const n1 = [Math.sin(GRID_ANG), Math.cos(GRID_ANG)];
      const sgn = Math.sign(n1[0] * (SREC.pen[0] - x) + n1[1] * (SREC.pen[1] - z)) || 1;
      addBox(x + n1[0] * 2.01 * sgn, z + n1[1] * 2.01 * sgn, GRID_ANG, 1.4, 1.7, 0.1, y + 0.1, 0xf0ece2);
      bldBoxes.push([x - 3, x + 3, z - 2.6, z + 2.6, y + 4.4]);
    }
    const sm = new THREE.Mesh(merge(sanct), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .92 }));
    sm.castShadow = sm.receiveShadow = true; scene.add(sm);
  }

  // ---------- trees ----------
  const treePts = [];
  function blocked(x, z) {
    // onRoad covers ALL roads — without it a tree offset from one street can
    // land in the middle of a crossing street
    if (onRoad(x, z)) return true;
    for (const bb of bldBoxes) if (x > bb[0] - 1.2 && x < bb[1] + 1.2 && z > bb[2] - 1.2 && z < bb[3] + 1.2) return true;
    for (const k of ['pen', 'coop', 'shed', 'barn'])
      if (Math.hypot(x - SREC[k][0], z - SREC[k][1]) < (k === 'pen' ? 7 : 4.5)) return true;
    return Math.hypot(x, z) > 318;
  }
  for (const r of S.roads) {
    if (r.k !== 'residential' && r.k !== 'tertiary') continue;
    let acc = 16, side = 1;
    for (let k = 0; k < r.p.length - 1; k++) {
      const [ax, az] = W(r.p[k]), [bx, bz] = W(r.p[k + 1]);
      const segL = Math.hypot(bx - ax, bz - az); let dx = (bx - ax) / segL, dz = (bz - az) / segL, t = 0;
      while (acc < segL - t) {
        t += acc; acc = 24 + rand() * 16; side = -side;
        const off = r.w / 2 + 4.2 + rand() * 4;
        const x = ax + dx * t - dz * off * side, z = az + dz * t + dx * off * side;
        if (!blocked(x, z)) treePts.push([x, z, 0.75 + rand() * 0.7]);
      }
      acc -= (segL - t);
    }
  }
  if (creekPtsW) {
    let acc = 6, side = 1;
    for (let k = 0; k < creekPtsW.length - 1; k++) {
      const [ax, az] = creekPtsW[k], [bx, bz] = creekPtsW[k + 1];
      const segL = Math.hypot(bx - ax, bz - az); let dx = (bx - ax) / segL, dz = (bz - az) / segL, t = 0;
      while (acc < segL - t) {
        t += acc; acc = 9 + rand() * 9; side = -side;
        const off = 3.5 + rand() * 5.5;
        const x = ax + dx * t - dz * off * side, z = az + dz * t + dx * off * side;
        if (!blocked(x, z)) treePts.push([x, z, 1.0 + rand() * 0.8]);
      }
      acc -= (segL - t);
    }
  }
  {
    const hb = house.bbox, hc = house.c;
    let placed = 0;
    for (let a = 0; a < 14 && placed < 3; a++) {
      const ang = a * 2.7 + 0.6, rr = 10 + (a % 3) * 2.5;
      const x = hc[0] + Math.cos(ang) * rr, z = hc[1] + Math.sin(ang) * rr;
      if (!(x > hb[0] - 1.5 && x < hb[1] + 1.5 && z > hb[2] - 1.5 && z < hb[3] + 1.5) && !blocked(x, z)) {
        treePts.push([x, z, 1.0 + rand() * 0.4]); placed++;
      }
    }
  }
  {
    const trunkG = new THREE.CylinderGeometry(0.14, 0.22, 2.3, 5);
    const canG = new THREE.IcosahedronGeometry(1.5, 0); canG.scale(1, 1.3, 1);
    const trunk = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x6e5340, roughness: 1 }), treePts.length);
    const canA = new THREE.InstancedMesh(canG, new THREE.MeshStandardMaterial({ color: 0x5e7d47, roughness: .95, flatShading: true }), Math.ceil(treePts.length / 2));
    const canB = new THREE.InstancedMesh(canG, new THREE.MeshStandardMaterial({ color: 0x4c6b40, roughness: .95, flatShading: true }), Math.floor(treePts.length / 2));
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Sc = new THREE.Vector3(), Pp = new THREE.Vector3();
    let ia = 0, ib = 0;
    treePts.forEach((p, i) => {
      const y = terrainAt(p[0], p[1]), s = p[2];
      Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * 6.28);
      M.compose(Pp.set(p[0], y + 1.05 * s, p[1]), Q, Sc.set(s, s, s)); trunk.setMatrixAt(i, M);
      M.compose(Pp.set(p[0], y + (2.3 + 1.2) * s, p[1]), Q, Sc.set(s, s, s));
      if (i % 2 === 0) canA.setMatrixAt(ia++, M); else canB.setMatrixAt(ib++, M);
    });
    for (const m of [trunk, canA, canB]) { m.instanceMatrix.needsUpdate = true; m.castShadow = true; scene.add(m); }
  }

  // ---------- house ring + labels ----------
  const hbx = house.bbox;
  const ringR = Math.max(hbx[1] - hbx[0], hbx[3] - hbx[2]) / 2 + 5;
  let ringY = 0;
  for (let a = 0; a < 12; a++) ringY = Math.max(ringY, terrainAt(house.c[0] + Math.cos(a / 12 * 6.28) * ringR, house.c[1] + Math.sin(a / 12 * 6.28) * ringR));
  const ring = new THREE.Mesh(new THREE.RingGeometry(ringR, ringR + 1.1, 56),
    new THREE.MeshBasicMaterial({ color: 0xd94f1e, transparent: true, opacity: .65, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(house.c[0], ringY + 0.6, house.c[1]);
  scene.add(ring);

  function makeTag(text, big, poppy) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128;
    const cx = cv.getContext('2d');
    cx.font = `700 ${big ? 72 : 54}px 'Bricolage Grotesque', system-ui, sans-serif`;
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.shadowColor = 'rgba(250,247,240,.95)'; cx.shadowBlur = 16;
    cx.fillStyle = poppy ? '#c84518' : '#3b362d';
    cx.fillText(text, 256, 66);
    const t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter;
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  }
  const labelSprites = [];
  function buildLabels() {
    const houseTag = makeTag('1840', true, true);
    houseTag.scale.set(26, 6.5, 1);
    houseTag.position.set(house.c[0], house.baseY + 14, house.c[1]);
    scene.add(houseTag); labelSprites.push(houseTag);
    if (creekPtsW) {
      const ct = makeTag(S.creek.n.toUpperCase(), false, false);
      ct.scale.set(40, 10, 1); ct.material.opacity = .78;
      let best = 1e9, bi = 0;
      creekPtsW.forEach((p, i) => { const d = Math.hypot(p[0] - house.c[0], p[1] - house.c[1]); if (d < best) { best = d; bi = i; } });
      const li = Math.min(creekPtsW.length - 1, bi + 8);
      ct.position.set(creekPtsW[li][0], terrainAt(creekPtsW[li][0], creekPtsW[li][1]) + 10, creekPtsW[li][1]);
      scene.add(ct); labelSprites.push(ct);
    }
    const byName = {};
    for (const r of S.roads) {
      if (!r.n) continue;
      let len = 0; for (let k = 0; k < r.p.length - 1; k++) { const a = W(r.p[k]), b = W(r.p[k + 1]); len += Math.hypot(b[0] - a[0], b[1] - a[1]); }
      if (!byName[r.n] || byName[r.n].len < len) byName[r.n] = { len, r };
    }
    const names = Object.keys(byName).sort((a, b) => byName[b].len - byName[a].len).slice(0, 7);
    if (!names.includes('Dahill Lane') && byName['Dahill Lane']) names.push('Dahill Lane');
    for (const n of names) {
      const r = byName[n].r;
      let x, z;
      if (n === 'Dahill Lane' && frontPt) { x = frontPt[0]; z = frontPt[1]; }
      else { const m = W(r.p[Math.floor(r.p.length / 2)]); x = m[0]; z = m[1]; }
      const sp = makeTag(n.toUpperCase(), false, n === 'Dahill Lane');
      sp.scale.set(34, 8.5, 1);
      sp.position.set(x, terrainAt(x, z) + 5.5, z);
      sp.material.opacity = n === 'Dahill Lane' ? 0.95 : 0.7;
      scene.add(sp); labelSprites.push(sp);
    }
  }
  // Wait for Bricolage Grotesque so the sprite tags render in the right face.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(buildLabels).catch(buildLabels);
  else buildLabels();

  return {
    aerialMat, onRoad, house, bldBoxes, treePts, creekPtsW,
    frontPt, frontDir, COMPOST, ring, interiorGroup, labelSprites
  };
}
