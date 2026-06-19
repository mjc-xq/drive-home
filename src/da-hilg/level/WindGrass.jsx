// <WindGrass> — a wind-swept instanced grass field that follows the player.
//
// TECHNIQUE (the well-known "instanced curved-blade" approach used by the popular
// three.js grass demos — Eddie Lee / James-grass / Ghibli-style fields):
//
//   • BLADE GEOMETRY — ONE tapered, multi-segment blade (not a flat rectangle):
//     a strip of SEGMENTS quads that narrows from a wide base to a single point at
//     the tip and carries a baked forward curve, so even a static blade reads as a
//     real curved leaf. Rendered DoubleSide so it shows from any angle. A `aHeight`
//     attribute (0 root → 1 tip) drives both the wind weight and the color gradient.
//     A rounded cross-section normal (bowed left→right) makes blades catch the sun
//     like a cylinder instead of a flat card, which kills the "paper cut-out" look.
//
//   • WIND — a pure vertex transform in a patched MeshStandardMaterial. A big slow
//     world-space GUST wave travels across the field (cos of world XZ + uTime) so
//     the whole lawn ripples in coherent bands, layered with a faster per-blade
//     flutter. Bend is quadratic in aHeight (stiff at the root, loose at the tip)
//     and the tip is pulled DOWN as it leans so blades arc rather than shear.
//
//   • COLOR — a root→tip gradient (dark, slightly desaturated soil-green at the base
//     → bright lively green at the tip) times a per-instance tint (hue + value
//     jitter) so no two blades match. An extra base AO term darkens the bottom ~15%
//     so the field grounds into the terrain instead of floating.
//
// CONTRACT — mounted in WORLD space by Level.jsx and FOLLOWS the active player: each
// render frame we copy activePlayer().motion.pos onto the mesh so the dense disc is
// always centered under the player's feet.
//
// PERF — ONE InstancedMesh (one draw call), castShadow=false, frustumCulled=false,
// no per-frame allocation. Wind is driven by a single uTime uniform advanced in a
// render-only useFrame (NOT the sim loop).

import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { activePlayer } from '../state/refs.js';

const SEGMENTS = 5; // quads up the blade; more = smoother curve, a touch more cost

/**
 * Build one tapered, gently-curved blade: a vertical strip of `SEGMENTS` quads that
 * narrows from `width` at the base to a point at the tip, with a baked forward bow.
 * Origin at the base, growing +Y. Carries:
 *   uv.y / aHeight  — 0 at root → 1 at tip (wind weight + color gradient)
 *   aSide           — −1 left edge, +1 right edge (rounds the normal across the blade)
 * Normals are authored (not computed) so each blade reads as a bowed leaf catching
 * light from the front, not a flat double-sided card.
 * @param {number} width base blade width (m)
 * @param {number} height blade height (m)
 */
function makeBladeGeometry(width = 0.05, height = 0.5) {
  const hw = width / 2;
  const pos = [];
  const uv = [];
  const height01 = []; // aHeight: 0 root → 1 tip
  const side = []; // aSide: −1 left, +1 right
  const norm = [];
  const idx = [];

  // Forward bow of the rest pose (how far the tip leans in +Z before wind). Small,
  // just enough that a still blade isn't a stiff vertical plank.
  const restCurve = height * 0.12;
  // How much the front face bows toward the viewer (rounds the lighting).
  const faceBow = 0.55;

  for (let s = 0; s <= SEGMENTS; s++) {
    const t = s / SEGMENTS; // 0 base → 1 tip
    const y = t * height;
    // Taper: full width at base, pinch to ~0 at the tip (quadratic so the point is sharp).
    const w = hw * (1 - t) * (1 - t * 0.25);
    const z = restCurve * t * t; // baked forward curve, accelerating toward the tip
    // Authored normal: mostly facing +Z, tilted back as the blade reclines so the lit
    // face follows the curve. (aSide bows it left/right per-vertex in the shader-free path.)
    const ny = restCurve * 2 * t; // d(z)/dt-ish — leans the normal back near the tip
    const nl = Math.hypot(0, ny, 1) || 1;

    // left vertex
    pos.push(-w, y, z);
    uv.push(0, t);
    height01.push(t);
    side.push(-1);
    norm.push(-faceBow / Math.hypot(faceBow, ny, 1), ny / nl, 1 / nl);
    // right vertex
    pos.push(w, y, z);
    uv.push(1, t);
    height01.push(t);
    side.push(1);
    norm.push(faceBow / Math.hypot(faceBow, ny, 1), ny / nl, 1 / nl);
  }

  // Stitch quads between successive rings (2 tris each), front-facing; DoubleSide
  // handles the back so we don't double the triangle count.
  for (let s = 0; s < SEGMENTS; s++) {
    const a = s * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    idx.push(a, c, b, b, c, d);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  g.setAttribute('aHeight', new THREE.Float32BufferAttribute(height01, 1));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setIndex(idx);
  return g;
}

/**
 * MeshStandardMaterial patched to (a) bend each blade by a traveling wind gust +
 * per-blade flutter, (b) round the per-vertex normal across the blade so it lights
 * like a cylinder, (c) shade root→tip with a per-instance tint and base AO, and
 * (d) CULL blades that fall on roads/sidewalks/driveways/buildings via a top-down
 * paved MASK texture (white = paved/building → collapse the blade to nothing).
 * Lit + fogged by the scene like everything else.
 * @param {THREE.Texture} [paveMask] top-down mask (white=paved). null = no culling.
 * @param {[number,number]} [maskMin] recentered-world XZ min the mask covers.
 * @param {[number,number]} [maskSize] recentered-world XZ size the mask covers.
 * @returns {THREE.MeshStandardMaterial}
 */
function makeGrassMaterial(paveMask = null, maskMin = [0, 0], maskSize = [1, 1]) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, // gradient + per-instance tint do the coloring
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    // Root (dark, slightly cool/desaturated) and tip (bright, lively) gradient ends.
    shader.uniforms.uRootColor = { value: new THREE.Color('#2b4a1e') };
    shader.uniforms.uTipColor = { value: new THREE.Color('#7fb24a') };
    // Paved/building mask (sampled per blade in the vertex stage to cull on roads).
    shader.uniforms.uPaveMask = { value: paveMask };
    shader.uniforms.uHasMask = { value: paveMask ? 1 : 0 };
    shader.uniforms.uMaskMin = { value: new THREE.Vector2(maskMin[0], maskMin[1]) };
    shader.uniforms.uMaskSize = { value: new THREE.Vector2(maskSize[0], maskSize[1]) };
    material.userData.shader = shader; // expose so useFrame can advance uTime

    // ── vertex header: instanced attrs + wind uniforms + varyings ──────────────
    shader.vertexShader = shader.vertexShader.replace(
      '#define STANDARD',
      /* glsl */ `#define STANDARD
        attribute float aHeight;  // 0 root → 1 tip (per blade vertex)
        attribute float aSide;    // −1 left edge, +1 right edge
        attribute float aPhase;   // per-instance wind phase (0..2π)
        attribute float aStiff;   // per-instance stiffness (0.7..1.3)
        attribute vec3  aTint;    // per-instance color multiplier
        uniform float uTime;
        uniform sampler2D uPaveMask;
        uniform float uHasMask;
        uniform vec2  uMaskMin;   // recentered-world XZ min the mask covers
        uniform vec2  uMaskSize;  // recentered-world XZ size the mask covers
        varying float vHeight;
        varying vec3  vTint;`,
    );

    // ── round the normal across the blade BEFORE three lights it ───────────────
    // Bow the front normal left↔right by aSide so the lit face curves like a tube.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      /* glsl */ `#include <beginnormal_vertex>
        objectNormal.x += aSide * 0.45;
        objectNormal = normalize(objectNormal);`,
    );

    // ── bend the blade in OBJECT space (instanceMatrix applies downstream) ─────
    // We displace `transformed` so the sway happens in the blade's own frame; three's
    // instancing chunk multiplies by instanceMatrix in <project_vertex>, so per-blade
    // world placement (position/yaw/scale) still applies on top.
    //
    // The instance's WORLD XZ feeds a slow large-wavelength gust so neighbors lean
    // together in traveling bands; a faster term adds per-blade flutter. Bend grows
    // with aHeight² (stiff root) and the tip dips (−Y) so the blade arcs, not shears.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
        vHeight = aHeight;
        vTint = aTint;
        #ifdef USE_INSTANCING
          vec2 wpos = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
        #else
          vec2 wpos = vec2(0.0);
        #endif
        // ── paved/building cull ──────────────────────────────────────────────
        // Map this blade's recentered-world XZ into the top-down mask UV and sample
        // it. White (paved/building/road) → collapse the WHOLE blade to a point at
        // the root so it's never rasterized (vertex-stage cull, no fragment discard).
        float kill = 0.0;
        if (uHasMask > 0.5) {
          vec2 muv = (wpos - uMaskMin) / uMaskSize;
          // The mask camera looks straight DOWN (−Y), so its image +Y maps to world
          // −Z; flip V to match world Z. Outside the mask (UV<0 or >1) stays grass.
          muv.y = 1.0 - muv.y;
          bool inside = muv.x > 0.0 && muv.x < 1.0 && muv.y > 0.0 && muv.y < 1.0;
          if (inside && texture2D(uPaveMask, muv).r > 0.5) kill = 1.0;
        }
        // Large slow traveling gust (coherent bands across the field).
        float gust = sin(dot(wpos, vec2(0.13, 0.11)) + uTime * 1.1);
        gust += 0.5 * sin(dot(wpos, vec2(-0.07, 0.19)) + uTime * 1.7);
        // Faster per-blade flutter so individual blades shimmer.
        float flutter = sin(uTime * 3.1 + aPhase) * 0.35;
        float wind = (gust * 0.6 + flutter) / aStiff;
        float w = aHeight * aHeight; // quadratic falloff: 0 at root → 1 at tip
        float bend = wind * w * 0.28;
        transformed.x += bend;
        transformed.z += bend * 0.45;
        transformed.y -= abs(bend) * 0.35; // arc: tip dips as it leans (no stretch)
        transformed *= (1.0 - kill); // culled blade: every vertex → root origin (zero size)`,
    );

    // ── fragment: root→tip gradient × per-instance tint + base AO ──────────────
    shader.fragmentShader = shader.fragmentShader.replace(
      '#define STANDARD',
      /* glsl */ `#define STANDARD
        uniform vec3 uRootColor;
        uniform vec3 uTipColor;
        varying float vHeight;
        varying vec3  vTint;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      /* glsl */ `#include <color_fragment>
        vec3 grad = mix(uRootColor, uTipColor, smoothstep(0.0, 1.0, vHeight));
        float ao = mix(0.55, 1.0, smoothstep(0.0, 0.18, vHeight)); // ground the base
        diffuseColor.rgb *= grad * vTint * ao;`,
    );
  };

  // One program per mask/no-mask variant (the cull branch differs by a uniform, but
  // keep distinct keys so a remount with vs without a mask never reuses the wrong one).
  material.customProgramCacheKey = () => (paveMask ? 'windGrassV3-masked' : 'windGrassV3');
  return material;
}

/**
 * Wind-swept instanced grass on a dense disc that follows the active player's feet.
 *
 * @param {Object} props
 * @param {number} [props.radius=18]   disc radius in meters (the lawn around you).
 * @param {number} [props.innerRadius=0.4] tiny clear ring at the player's feet.
 * @param {number} [props.count=40000] blade count (one InstancedMesh, one draw call).
 * @param {number} [props.groundY=0]   Y of the blade roots (recentered ground≈0).
 * @param {[number,number,number]} [props.center=[0,0,0]] disc center offset.
 * @param {number} [props.bladeHeight=0.4] nominal blade height (m, jittered).
 * @param {THREE.Texture} [props.paveMask] top-down paved/building mask (white=paved);
 *   blades over white are culled so grass never grows on roads/walks/driveways/buildings.
 * @param {[number,number]} [props.maskMin] recentered-world XZ min the mask covers.
 * @param {[number,number]} [props.maskSize] recentered-world XZ size the mask covers.
 */
export function WindGrass({
  radius = 18,
  innerRadius = 0.4,
  count = 40000,
  groundY = 0,
  center = [0, 0, 0],
  bladeHeight = 0.4,
  paveMask = null,
  maskMin = [0, 0],
  maskSize = [1, 1],
}) {
  const geometry = useMemo(() => makeBladeGeometry(0.05, bladeHeight), [bladeHeight]);
  const material = useMemo(
    () => makeGrassMaterial(paveMask, maskMin, maskSize),
    [paveMask, maskMin, maskSize],
  );

  // Build per-instance matrices + attributes once. Deterministic scatter via a tiny
  // PRNG so a remount looks identical (no React state needed).
  const mesh = useMemo(() => {
    const inst = new THREE.InstancedMesh(geometry, material, count);
    inst.castShadow = false;
    inst.receiveShadow = false;
    inst.frustumCulled = false; // the field is always around the player

    let seed = 1337;
    const rnd = () => {
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
      // Uniform-area scatter on the annulus [innerRadius, radius], with the inner ring
      // weighted denser (pow<1) so the lawn looks lushest right around the player.
      const t = Math.pow(rnd(), 0.85);
      const r = Math.sqrt(
        innerRadius * innerRadius + t * (radius * radius - innerRadius * innerRadius),
      );
      const a = rnd() * Math.PI * 2;
      pos.set(center[0] + Math.cos(a) * r, groundY, center[2] + Math.sin(a) * r);

      // Per-blade height + width jitter and a random yaw so the field never aligns.
      const hs = 0.65 + rnd() * 0.8;        // 0.65–1.45 height
      const ws = 0.8 + rnd() * 0.6;         // 0.8–1.4 width
      scl.set(ws, hs, ws);
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      m.compose(pos, q, scl);
      inst.setMatrixAt(i, m);

      phase[i] = rnd() * Math.PI * 2;
      stiff[i] = 0.7 + rnd() * 0.6;          // 0.7–1.3 (higher = stiffer)

      // Per-instance tint: small hue spread + value jitter around white so the
      // root→tip gradient stays in control but no two blades match.
      baseCol.setHSL(0.27 + (rnd() - 0.5) * 0.06, 0.15 + rnd() * 0.15, 0.85 + rnd() * 0.15);
      tint[i * 3 + 0] = baseCol.r;
      tint[i * 3 + 1] = baseCol.g;
      tint[i * 3 + 2] = baseCol.b;
    }
    inst.instanceMatrix.needsUpdate = true;

    geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    geometry.setAttribute('aStiff', new THREE.InstancedBufferAttribute(stiff, 1));
    geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));

    return inst;
  }, [geometry, material, count, radius, innerRadius, groundY, center]);

  // Advance wind time + keep the field centered on the active player's feet. The mesh
  // lives in WORLD space (mounted outside the level's recenter group), so motion.pos —
  // the player's recentered-world feet — maps straight onto mesh.position. Render-only
  // (priority left at default; this is NOT the sim loop).
  useFrame((_, dt) => {
    const sh = material.userData.shader;
    if (sh) sh.uniforms.uTime.value += dt;
    const p = activePlayer();
    if (p && p.motion) mesh.position.copy(p.motion.pos);
  });

  return <primitive object={mesh} />;
}

export default WindGrass;
