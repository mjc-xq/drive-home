// <WindGrass> — a wind-swept instanced grass field around the house.
//
// ONE InstancedMesh of cross-quad blades (two crossed quads per blade, so the
// field reads from every angle) scattered on a disc around the recenter origin.
// A MeshStandardMaterial patched via onBeforeCompile bends each blade by a
// time-scrolling noise: zero sway at the root, maximum at the tip, so the whole
// field ripples like wind. Per-instance height + color + phase variation keep it
// from looking like a stamped grid.
//
// SPACE
//   Mounted INSIDE Level.jsx's recenter <group>, this lives in the same local
//   space as the level scene — but the recentered scene puts the house at origin
//   and ground at y≈0, so a flat band of blades on a disc around origin sits on
//   the yard. groundY (default 0) clamps the blade roots to the ground plane; the
//   hill falls away outside the band so we keep the disc near the house.
//
// PERF
//   castShadow=false (a few thousand blades shadow-casting tanks fps), one draw
//   call, frustumCulled off (the field is always near the player). The wind is a
//   pure vertex transform driven by a single uTime uniform advanced in a tiny
//   render-only useFrame — NOT the sim loop.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { activePlayer } from '../state/refs.js';

/**
 * Build one blade's geometry: two crossed thin quads (a "+" footprint) so the
 * blade has presence from any view angle. Origin at the base, growing +Y.
 * A `aBlend` attribute (0 at root → 1 at tip) drives the wind bend weight.
 * @param {number} width blade width (m)
 * @param {number} height blade height (m)
 */
function makeBladeGeometry(width = 0.05, height = 0.55) {
  const hw = width / 2;
  // One quad: 4 verts, 2 tris. Positions in XY (we duplicate + rotate for the cross).
  const quadPos = [
    -hw, 0, 0,
     hw, 0, 0,
     hw, height, 0,
    -hw, height, 0,
  ];
  const quadUv = [0, 0, 1, 0, 1, 1, 0, 1];
  const quadIdx = [0, 1, 2, 0, 2, 3];

  const pos = [];
  const uv = [];
  const idx = [];
  // root→tip blend per vertex (used by the wind shader); matches quad vert order.
  const blend = [];
  let base = 0;

  // Two copies: the second rotated 90° about Y to make the cross.
  for (let q = 0; q < 2; q++) {
    const rot = q === 1;
    for (let i = 0; i < 4; i++) {
      let x = quadPos[i * 3 + 0];
      const yv = quadPos[i * 3 + 1];
      let z = quadPos[i * 3 + 2];
      if (rot) { const t = x; x = z; z = -t; } // rotate XZ 90°
      pos.push(x, yv, z);
      uv.push(quadUv[i * 2 + 0], quadUv[i * 2 + 1]);
      blend.push(yv / height); // 0 at base, 1 at tip
    }
    for (let k = 0; k < quadIdx.length; k++) idx.push(quadIdx[k] + base);
    base += 4;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aBlend', new THREE.Float32BufferAttribute(blend, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * MeshStandardMaterial patched to (a) bend blades by wind and (b) tint by a
 * per-instance color. Lit by the scene like everything else.
 * @returns {THREE.MeshStandardMaterial}
 */
function makeGrassMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,        // tint comes from per-instance aTint
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide, // thin blades, both faces visible
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    material.userData.shader = shader; // expose so useFrame can advance uTime

    // ── header: instanced attrs + wind uniforms + a tint varying ──────────────
    shader.vertexShader = shader.vertexShader.replace(
      '#define STANDARD',
      /* glsl */ `#define STANDARD
        attribute float aBlend;   // 0 root → 1 tip (per blade vertex)
        attribute float aPhase;   // per-instance wind phase (0..2π)
        attribute float aStiff;   // per-instance stiffness (0.6..1.2)
        attribute vec3  aTint;    // per-instance color
        uniform float uTime;
        varying vec3 vTint;`,
    );

    // ── begin_vertex: bend the OBJECT-space position before instancing ────────
    // We must displace `transformed` (object space) — three's instancing chunk
    // multiplies by instanceMatrix downstream in <project_vertex>, so the blade
    // sways in its OWN local frame and the per-instance world placement still
    // applies. Bend is quadratic in aBlend (stiff near root, loose at tip).
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
        float windT = uTime * 1.6 + aPhase;
        // two octaves so the sway isn't a clean sine
        float sway = sin(windT) * 0.7 + sin(windT * 2.3 + 1.7) * 0.3;
        float bend = sway * aBlend * aBlend * 0.35 / aStiff;
        transformed.x += bend;
        transformed.z += bend * 0.6;
        vTint = aTint;`,
    );

    // ── fragment: tint diffuse by the per-instance color ──────────────────────
    shader.fragmentShader = shader.fragmentShader.replace(
      '#define STANDARD',
      '#define STANDARD\nvarying vec3 vTint;',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n\tdiffuseColor.rgb *= vTint;',
    );
  };

  // One program regardless of per-instance data.
  material.customProgramCacheKey = () => 'windGrass';
  return material;
}

/**
 * Wind-swept instanced grass on a disc around the recenter origin (the yard).
 *
 * @param {Object} props
 * @param {number} [props.radius=90]  disc radius in meters (cluster near house).
 * @param {number} [props.innerRadius=8] keep a clear ring right at the house.
 * @param {number} [props.count=14000] blade count (8k–20k is the sweet spot).
 * @param {number} [props.groundY=0]  Y of the blade roots (recentered ground≈0).
 * @param {[number,number,number]} [props.center=[0,0,0]] disc center (recentered).
 * @param {number} [props.bladeHeight=0.55] nominal blade height (m, jittered).
 */
export function WindGrass({
  radius = 90,
  innerRadius = 8,
  count = 14000,
  groundY = 0,
  center = [0, 0, 0],
  bladeHeight = 0.55,
}) {
  const geometry = useMemo(() => makeBladeGeometry(0.05, bladeHeight), [bladeHeight]);
  const material = useMemo(() => makeGrassMaterial(), []);

  // Build per-instance matrices + attributes once. Deterministic-ish scatter via
  // a tiny PRNG so a remount looks identical (no React-state needed).
  const { mesh } = useMemo(() => {
    const inst = new THREE.InstancedMesh(geometry, material, count);
    inst.castShadow = false;
    inst.receiveShadow = false;
    inst.frustumCulled = false; // the field is always around the player

    let seed = 1337;
    const rnd = () => {
      // xorshift-ish deterministic rng in [0,1)
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return ((seed >>> 0) % 100000) / 100000;
    };

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();

    const phase = new Float32Array(count);
    const stiff = new Float32Array(count);
    const tint = new Float32Array(count * 3);

    const baseCol = new THREE.Color();
    for (let i = 0; i < count; i++) {
      // Uniform-area scatter on the annulus [innerRadius, radius].
      const t = rnd();
      const r = Math.sqrt(
        innerRadius * innerRadius + t * (radius * radius - innerRadius * innerRadius),
      );
      const a = rnd() * Math.PI * 2;
      pos.set(center[0] + Math.cos(a) * r, groundY, center[2] + Math.sin(a) * r);

      // Per-blade scale (height jitter) + random yaw so blades don't align.
      const hs = 0.7 + rnd() * 0.7;          // 0.7–1.4 height
      const ws = 0.8 + rnd() * 0.5;          // 0.8–1.3 width
      scl.set(ws, hs, ws);
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      m.compose(pos, q, scl);
      inst.setMatrixAt(i, m);

      phase[i] = rnd() * Math.PI * 2;
      stiff[i] = 0.6 + rnd() * 0.6;          // 0.6–1.2

      // Green with hue/lightness jitter (yellow-green → deep green).
      baseCol.setHSL(0.25 + (rnd() - 0.5) * 0.05, 0.55 + rnd() * 0.2, 0.32 + rnd() * 0.18);
      tint[i * 3 + 0] = baseCol.r;
      tint[i * 3 + 1] = baseCol.g;
      tint[i * 3 + 2] = baseCol.b;
    }
    inst.instanceMatrix.needsUpdate = true;

    // Attach per-instance attributes the shader reads.
    geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    geometry.setAttribute('aStiff', new THREE.InstancedBufferAttribute(stiff, 1));
    geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));

    return { mesh: inst };
  }, [geometry, material, count, radius, innerRadius, groundY, center]);

  // Advance wind time + keep the field centered on the active player's feet, so the
  // grass is always dense around the player AND at their actual ground level (the
  // yard sits on a hill well above the terrain MIN, so a fixed-Y disc would bury it).
  // Render-only (not the sim loop). The mesh lives in WORLD space (mounted outside the
  // level's recenter group), so motion.pos — the player's recentered-world feet — maps
  // straight onto mesh.position.
  useFrame((_, dt) => {
    const sh = material.userData.shader;
    if (sh) sh.uniforms.uTime.value += dt;
    const p = activePlayer();
    if (p && p.motion) mesh.position.copy(p.motion.pos);
  });

  return <primitive object={mesh} />;
}

export default WindGrass;
