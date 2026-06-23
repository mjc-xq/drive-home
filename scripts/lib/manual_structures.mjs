// manual_structures.mjs — hand-authored parametric STRUCTURES the bake re-applies every time, so the
// edit persists through regeneration (lives in the tracked exports/<slug>/manual_structures.json).
//
// type "shade": a flat solar/awning ROOF on corner POSTS, OPEN underneath (a gazebo/shade structure
// kids walk under). Footprint is in WORLD XZ (the same frame the master GLB uses). The roof is a single
// flat horizontal plane (a roof finds a level) just above the highest footprint corner; posts drop from
// the roof to the terrain at each corner (so it sits correctly on sloped ground).
//
// Adds node group `ShadeStructures` with meshes `Shade_<i>_roof` (solar-navy, glossy) + `Shade_<i>_posts`.

function pushBoxColumn(arr, x, z, r, y0, y1) {
  const c = [[-r, -r], [r, -r], [r, r], [-r, r]];
  const quad = (a, b) => { // two world XZ corners -> a vertical wall quad (y0..y1), both windings
    const [ax, az] = a, [bx, bz] = b;
    arr.push(ax, y0, az, bx, y0, bz, bx, y1, bz,  ax, y0, az, bx, y1, bz, ax, y1, az);
    arr.push(bx, y0, bz, ax, y0, az, ax, y1, az,  bx, y0, bz, ax, y1, az, bx, y1, bz);
  };
  for (let i = 0; i < 4; i++) quad([x + c[i][0], z + c[i][1]], [x + c[(i + 1) % 4][0], z + c[(i + 1) % 4][1]]);
}

function mesh(THREE, pos, rgb, name, rough, metal = 0) {
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ name: `${name}_mat`, color: new THREE.Color(rgb[0], rgb[1], rgb[2]), roughness: rough, metalness: metal, side: THREE.DoubleSide });
  const me = new THREE.Mesh(g, m); me.name = name; return me;
}

export function buildManualStructures({ THREE, scene, structures = [], terrainAt }) {
  const shades = structures.filter((s) => s && s.type === 'shade' && Array.isArray(s.footprint) && s.footprint.length >= 3);
  if (!shades.length) return { added: 0 };
  const grp = new THREE.Group();
  grp.name = 'ShadeStructures';
  grp.userData = { layer: 'structures', removable: true, note: 'solar/awning shade gazebos — open under, roof on posts' };
  shades.forEach((s, idx) => {
    const fp = s.footprint;
    const roofY = Math.max(...fp.map(([x, z]) => terrainAt(x, z))) + (s.roofClear ?? 3.0);
    // UV axes from the footprint edges so a (tiled) solar-panel texture aligns to the roof's own
    // long/short axes regardless of world rotation. `Shade_<i>_roof_mat` is matched by the exporter,
    // which attaches exports/<slug>/solar_panel.png (REPEAT) when s.texture is set.
    const U = [fp[1][0] - fp[0][0], fp[1][1] - fp[0][1]]; const Ul = Math.hypot(U[0], U[1]) || 1; U[0] /= Ul; U[1] /= Ul;
    const V = [fp[3][0] - fp[0][0], fp[3][1] - fp[0][1]]; const Vl = Math.hypot(V[0], V[1]) || 1; V[0] /= Vl; V[1] /= Vl;
    const TILE = s.tile ?? 2.6;
    const uvOf = (x, z) => [((x - fp[0][0]) * U[0] + (z - fp[0][1]) * U[1]) / TILE, ((x - fp[0][0]) * V[0] + (z - fp[0][1]) * V[1]) / TILE];
    const roof = [], roofUV = [];
    for (let i = 1; i < fp.length - 1; i++) {            // fan-triangulate the (convex) footprint
      const a = fp[0], b = fp[i], c = fp[i + 1];
      for (const p of [a, c, b]) { roof.push(p[0], roofY, p[1]); roofUV.push(...uvOf(p[0], p[1])); }            // top (up)
      for (const p of [a, b, c]) { roof.push(p[0], roofY - 0.14, p[1]); roofUV.push(...uvOf(p[0], p[1])); }     // underside
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(roof, 3));
    rg.setAttribute('uv', new THREE.Float32BufferAttribute(roofUV, 2));
    rg.computeVertexNormals();
    const rgb = s.roofColor || [0.10, 0.13, 0.30];        // solar navy (tints the texture, or stands alone)
    const rmat = new THREE.MeshStandardMaterial({ name: `Shade_${idx}_roof_mat`, color: new THREE.Color(rgb[0], rgb[1], rgb[2]), roughness: 0.22, metalness: 0.25, side: THREE.DoubleSide });
    const rm = new THREE.Mesh(rg, rmat); rm.name = `Shade_${idx}_roof`; grp.add(rm);
    const posts = [];
    const pr = s.postR ?? 0.16;
    for (const [x, z] of fp) pushBoxColumn(posts, x, z, pr, terrainAt(x, z), roofY - 0.12);
    const pm = mesh(THREE, posts, [0.32, 0.32, 0.34], `Shade_${idx}_posts`, 0.7);
    if (pm) grp.add(pm);
  });
  if (grp.children.length) scene.add(grp);
  return { added: shades.length, group: grp };
}

export default buildManualStructures;
