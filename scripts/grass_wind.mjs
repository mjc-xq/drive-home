// Shared "grass in the wind" builder for BOTH neighborhood exporters
// (export_stylized_glb.mjs and export_property_glb.mjs) so the two stay in sync.
//
// Adds a single named parent group `Grass_Wind` to the THREE scene, scatters
// low-poly grass-blade clumps (`GrassClump_0000`, `GrassClump_0001`, ...) across
// open ground, and returns a looping `GrassWind` THREE.AnimationClip that sways
// every clump about its local Z axis with a per-clump, position-derived phase
// offset so a gust appears to sweep across the field. Pass the returned clip to
// GLTFExporter.parseAsync({ animations: [clip] }) so it ships inside the GLB and
// auto-plays in any viewer (Blender, three.js, Quick Look) - no engine shader.
//
// IMPORTANT: the RNG draw order here is byte-for-byte the stylized exporter's
// original inline block, so a caller sharing a seeded `rand()` gets identical
// downstream placement (trees, shrubs). Keep it that way if you edit this.
//
//   const { clip, count } = buildGrassWind({
//     THREE, scene, rand, terrainAt, cropHalf,
//     openGround: (x, z) => inPatch(x, z) && !onBuilding(x, z)
//                           && distToLines(x, z, roadLines, 5.5) >= 5.5,
//   });
export function buildGrassWind({
  THREE, scene, rand, terrainAt, openGround, cropHalf,
  grid = 9,            // metres between candidate clumps
  maxClumps = 520,     // keep the GLB lean
  skipChance = 0.45,   // thin the grid so the field reads natural, not gridded
}) {
  function bladeClumpGeometry() {
    // a few crossed quads, pivot at the base (y=0), ~0.55 m tall
    const pos = [], col = [];
    const base = new THREE.Color(0x4f8a30), tip = new THREE.Color(0x9fd45f);
    const blades = 5;
    for (let bI = 0; bI < blades; bI++) {
      const ang = (bI / blades) * Math.PI * 2 + rand() * 0.6;
      const r = 0.06 + rand() * 0.10, hgt = 0.42 + rand() * 0.30, lean = 0.06 + rand() * 0.05;
      const bx = Math.cos(ang) * r, bz = Math.sin(ang) * r, wdt = 0.035;
      const px = -Math.sin(ang) * wdt, pz = Math.cos(ang) * wdt;     // blade-width axis
      const tx = bx + Math.cos(ang) * lean, tz = bz + Math.sin(ang) * lean;
      // two tris forming a tapered blade
      const A = [bx - px, 0, bz - pz], B = [bx + px, 0, bz + pz], T = [tx, hgt, tz];
      for (const [v, c] of [[A, base], [B, base], [T, tip]]) { pos.push(...v); col.push(c.r, c.g, c.b); }
      for (const [v, c] of [[B, base], [A, base], [T, tip]]) { pos.push(...v); col.push(c.r, c.g, c.b); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  }

  const grassMat = new THREE.MeshStandardMaterial({ name: 'Grass_mat', vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const grassGroup = new THREE.Group(); grassGroup.name = 'Grass_Wind';
  scene.add(grassGroup);

  // scatter clumps on open ground only (off roads/sidewalks/buildings, near grade)
  const clumpNodes = [];
  for (let z = -cropHalf; z <= cropHalf && clumpNodes.length < maxClumps; z += grid) {
    for (let x = -cropHalf; x <= cropHalf && clumpNodes.length < maxClumps; x += grid) {
      const jx = x + (rand() - 0.5) * grid * 0.8, jz = z + (rand() - 0.5) * grid * 0.8;
      if (!openGround(jx, jz) || rand() < skipChance) continue;
      const clump = new THREE.Mesh(bladeClumpGeometry(), grassMat);
      clump.name = `GrassClump_${String(clumpNodes.length).padStart(4, '0')}`;
      const s = 1.4 + rand() * 1.8;                // clump footprint scale
      clump.scale.set(s, 1.2 + rand() * 1.3, s);
      clump.position.set(jx, terrainAt(jx, jz), jz);
      clump.rotation.y = rand() * Math.PI * 2;
      grassGroup.add(clump);
      clumpNodes.push(clump);
    }
  }

  // Build the looping wind animation: each clump sways about its local Z axis.
  // Sample a sine sweep at keyframes; phase offset by position -> travelling gust.
  let clip = null;
  if (clumpNodes.length) {
    const PERIOD = 3.0, KEYS = 13;                                   // 3 s loop
    const times = Array.from({ length: KEYS }, (_, k) => k / (KEYS - 1) * PERIOD);
    const tracks = [];
    const axis = new THREE.Vector3(0, 0, 1), q = new THREE.Quaternion();
    for (const clump of clumpNodes) {
      const phase = (clump.position.x * 0.05 + clump.position.z * 0.03);  // gust sweep
      const amp = 0.13 + rand() * 0.06;                                   // sway radians
      const vals = [];
      for (let k = 0; k < KEYS; k++) {
        const t = times[k] / PERIOD * Math.PI * 2;
        const ang = Math.sin(t + phase) * amp + Math.sin(t * 2.3 + phase) * amp * 0.25;
        q.setFromAxisAngle(axis, ang);
        vals.push(q.x, q.y, q.z, q.w);
      }
      // bind by node UUID so the exporter resolves the right node regardless of name
      tracks.push(new THREE.QuaternionKeyframeTrack(`${clump.uuid}.quaternion`, times.slice(), vals));
    }
    clip = new THREE.AnimationClip('GrassWind', PERIOD, tracks);
  }
  return { clip, count: clumpNodes.length };
}
