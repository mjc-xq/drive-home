// manual_props.mjs — hand-placed PROP instances (basketball hoops, benches, ...) the bake re-applies
// every time, so the placement persists through regeneration. Mirrors manual_structures / manual_buildings:
// the edit lives in the TRACKED per-level sidecar exports/<slug>/data/manual_props.json.
//
// A prop sidecar entry is { glb, instances:[{x,z,rotY,scale?}] }:
//   glb       repo-relative path to a shared component GLB (e.g. exports/_shared/components/<name>.glb)
//   instances world-XZ placements. y is taken from terrainAt(x,z) so each instance sits on the surface;
//             rotY is degrees about +Y (0° keeps the component's own +Z facing +Z); scale defaults to 1.
//
// The component GLB is read with the SAME gltf-transform NodeIO the exporter already uses for photoreal,
// its node transforms are baked into world-space positions (so authored TRS/axis-conversion is honoured),
// then it is RECENTERED on its base footprint (XZ centroid of the lowest verts) and GROUNDED (minY -> 0)
// so the post/foot lands exactly on the placement point. Each instance becomes a discrete THREE.Mesh that
// REUSES one shared BufferGeometry per source primitive (cheap), grouped under a node `Props_<tag>` with
// every instance individually named `Prop_<tag>_<i>`.

function composeTRS(t, q, s) {                          // TRS -> column-major mat4 (matches the exporter)
  const [x, y, z, w] = q, [sx, sy, sz] = s;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
function mul4(a, b) {                                    // world = parent * local (column-major)
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// flatten a component doc to [{posWorld:Float32Array, uv:Float32Array|null, mat}] — node transforms baked in.
function flattenComponent(doc) {
  const out = [];
  const walk = (node, m) => {
    const world = mul4(m, composeTRS(node.getTranslation(), node.getRotation(), node.getScale()));
    const mesh = node.getMesh();
    if (mesh) for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute('POSITION'); if (!posAcc) continue;
      const uvAcc = prim.getAttribute('TEXCOORD_0');
      const idxAcc = prim.getIndices();
      const P = posAcc.getArray(), pc = posAcc.getElementSize(), nv = posAcc.getCount();
      const U = uvAcc ? uvAcc.getArray() : null, uc = uvAcc ? uvAcc.getElementSize() : 0;
      const idx = idxAcc ? idxAcc.getArray() : null;
      const triCount = idx ? idx.length / 3 : nv / 3;
      const wp = new Float32Array(nv * 3);
      for (let v = 0; v < nv; v++) {                    // bake world transform into vertex positions
        const x = P[v * pc], y = P[v * pc + 1], z = P[v * pc + 2];
        wp[v * 3] = world[0] * x + world[4] * y + world[8] * z + world[12];
        wp[v * 3 + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
        wp[v * 3 + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
      }
      const pos = new Float32Array(triCount * 9), uv = U ? new Float32Array(triCount * 6) : null;
      for (let t = 0; t < triCount; t++) {              // expand to a flat (unindexed) triangle soup
        const tri = idx ? [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]] : [t * 3, t * 3 + 1, t * 3 + 2];
        for (let k = 0; k < 3; k++) {
          const vi = tri[k];
          pos[t * 9 + k * 3] = wp[vi * 3]; pos[t * 9 + k * 3 + 1] = wp[vi * 3 + 1]; pos[t * 9 + k * 3 + 2] = wp[vi * 3 + 2];
          if (uv) { uv[t * 6 + k * 2] = U[vi * uc]; uv[t * 6 + k * 2 + 1] = U[vi * uc + 1]; }
        }
      }
      const mat = prim.getMaterial();
      out.push({ pos, uv, mat });
    }
    for (const c of node.listChildren()) walk(c, world);
  };
  for (const sc of doc.getRoot().listScenes()) for (const root of sc.listChildren()) walk(root, I4);
  return out;
}

// RECENTER on the base footprint (XZ centroid of verts within `band` of minY) + GROUND (minY -> 0).
// The base centroid (not the bbox centre) is the anchor so a hoop's POST foot — not the cantilevered
// backboard/rim — lands on the placement point. Mutates the prim positions in place.
function recenterAndGround(prims) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of prims) for (let i = 1; i < p.pos.length; i += 3) { minY = Math.min(minY, p.pos[i]); maxY = Math.max(maxY, p.pos[i]); }
  const band = minY + Math.max(0.02, (maxY - minY) * 0.04);   // lowest ~4% of the height = the foot/base
  let sx = 0, sz = 0, n = 0;
  for (const p of prims) for (let v = 0; v < p.pos.length; v += 3) {
    if (p.pos[v + 1] <= band) { sx += p.pos[v]; sz += p.pos[v + 2]; n++; }
  }
  const cx = n ? sx / n : 0, cz = n ? sz / n : 0;
  for (const p of prims) for (let v = 0; v < p.pos.length; v += 3) {
    p.pos[v] -= cx; p.pos[v + 1] -= minY; p.pos[v + 2] -= cz;
  }
  return { minY, maxY, baseXZ: [cx, cz] };
}

// material colour from a gltf-transform Material (baseColorFactor), with a neutral fallback.
function colorOf(THREE, mat) {
  const f = mat && mat.getBaseColorFactor ? mat.getBaseColorFactor() : null;
  return f ? new THREE.Color(f[0], f[1], f[2]) : new THREE.Color(0.8, 0.8, 0.8);
}

export async function buildManualProps({ THREE, scene, props = [], terrainAt, ROOT, io, existsSync, path }) {
  let total = 0, instTotal = 0;
  for (const entry of props) {
    if (!entry || !entry.glb || !Array.isArray(entry.instances) || !entry.instances.length) continue;
    const glbPath = path.isAbsolute(entry.glb) ? entry.glb : path.join(ROOT, entry.glb);
    if (!existsSync(glbPath)) { console.warn(`  ! manual prop GLB missing: ${entry.glb}`); continue; }

    const doc = await io.read(glbPath);
    const prims = flattenComponent(doc);
    if (!prims.length) { console.warn(`  ! manual prop has no geometry: ${entry.glb}`); continue; }
    recenterAndGround(prims);                            // post foot at local (0,0,0), backboard facing +Z

    const tag = path.basename(entry.glb).replace(/\.glb$/i, '').replace(/[^a-zA-Z0-9]+/g, '_');
    const grp = new THREE.Group();
    grp.name = `Props_${tag}`;
    grp.userData = { layer: 'props', removable: true, note: `hand-placed ${tag} instances (manual_props.json)` };

    // one shared BufferGeometry + Material per source primitive (instances reuse them via separate Meshes)
    const shared = prims.map((p, pi) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(p.pos), 3));
      if (p.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(Array.from(p.uv), 2));
      g.computeVertexNormals();
      const m = new THREE.MeshStandardMaterial({ name: `Prop_${tag}_part${pi}_mat`, color: colorOf(THREE, p.mat), roughness: 0.8, metalness: 0.05, side: THREE.FrontSide });
      return { g, m };
    });

    entry.instances.forEach((inst, i) => {
      const x = +inst.x, z = +inst.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      const y = terrainAt(x, z);
      const rotY = THREE.MathUtils.degToRad(+inst.rotY || 0);   // about +Y; 0° keeps component +Z facing +Z
      const scale = Number.isFinite(+inst.scale) ? +inst.scale : 1;
      const node = new THREE.Group();
      node.name = `Prop_${tag}_${i}`;
      node.position.set(x, y, z);
      node.rotation.set(0, rotY, 0);
      node.scale.set(scale, scale, scale);
      shared.forEach(({ g, m }, pi) => { const me = new THREE.Mesh(g, m); me.name = `${node.name}_p${pi}`; node.add(me); });
      grp.add(node);
      instTotal++;
    });

    if (grp.children.length) { scene.add(grp); total++; }
  }
  return { added: total, instances: instTotal };
}

export default buildManualProps;
