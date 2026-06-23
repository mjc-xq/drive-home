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
    const roof = [];
    for (let i = 1; i < fp.length - 1; i++) {            // fan-triangulate the (convex) footprint
      const a = fp[0], b = fp[i], c = fp[i + 1];
      roof.push(a[0], roofY, a[1], c[0], roofY, c[1], b[0], roofY, b[1]);             // top (up)
      roof.push(a[0], roofY - 0.14, a[1], b[0], roofY - 0.14, b[1], c[0], roofY - 0.14, c[1]); // underside
    }
    const posts = [];
    const pr = s.postR ?? 0.16;
    for (const [x, z] of fp) pushBoxColumn(posts, x, z, pr, terrainAt(x, z), roofY - 0.12);
    const rgb = s.roofColor || [0.10, 0.13, 0.30];        // solar navy
    const rm = mesh(THREE, roof, rgb, `Shade_${idx}_roof`, 0.22, 0.25);  // glossy panels
    if (rm) grp.add(rm);
    const pm = mesh(THREE, posts, [0.32, 0.32, 0.34], `Shade_${idx}_posts`, 0.7);
    if (pm) grp.add(pm);
  });
  if (grp.children.length) scene.add(grp);
  return { added: shades.length, group: grp };
}

export default buildManualStructures;
