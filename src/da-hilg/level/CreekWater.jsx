// <CreekWater> — a FLAT flowing-water surface for the San Lorenzo creek.
//
// THE PROBLEM THIS SOLVES
//   The authored creek meshes (Creek_SanLorenzo / Creek_FlowLines / Creek_Banks)
//   render as road-marker lines + brown sidewalk geometry, and the source water
//   mesh follows the terrain so the "water" climbs the hill. Real water is FLAT.
//   So instead of trying to fix the source mesh, we drop a single flat water plane
//   fitted to the creek's XZ footprint at its LOWEST Y (the true creek elevation)
//   and (optionally) hide the clutter meshes that overlap that footprint.
//
// SPACE
//   This component is mounted INSIDE Level.jsx's recenter <group> next to the
//   <primitive object={scene}/>, so it shares the scene's LOCAL (pre-recenter)
//   coordinate space. We therefore compute the creek bounds in that same local
//   space — by walking each Creek_* mesh's vertices through its matrix RELATIVE
//   to the scene root (matrixWorld of the mesh, with the scene's own world matrix
//   divided out). That is robust against KHR_mesh_quantization (the GLB stores
//   int16 positions with the real scale on the node matrix — exactly like
//   bakeCollider() in Level.jsx), where reading raw geometry bounds would be wrong.
//
// ANIMATION
//   The water material animates a uTime uniform in its OWN tiny render-only
//   useFrame. This is NOT the simulation — it never touches refs/physics — so it
//   is fine to run independently of GameSystems' single sim loop.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Names authored in the level GLB (confirmed in public/da-hilg/level.glb nodes).
const CREEK_MESH_NAMES = [
  'Creek_SanLorenzo',
  'Creek_Banks',
  'Creek_Rocks',
  'Creek_Reeds',
];

/**
 * Compute the creek's XZ footprint and minimum Y in the SCENE's local space.
 *
 * Walks every Creek_* mesh's vertices through `mesh.matrixWorld` then back into
 * scene-local space via the inverse of `scene.matrixWorld`. This mirrors
 * Level.bakeCollider(): the GLB's quantized int16 positions only become real
 * meters once multiplied by the node matrices, so we must go through the matrix
 * rather than read raw attribute bounds.
 *
 * @param {import('three').Object3D} scene loaded level scene (under recenter group ok)
 * @returns {null | {minX:number,maxX:number,minZ:number,maxZ:number,minY:number,centerX:number,centerZ:number,width:number,depth:number}}
 */
export function computeCreekBounds(scene) {
  if (!scene) return null;
  scene.updateWorldMatrix(true, true);

  const sceneInv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
  const v = new THREE.Vector3();
  const toLocal = new THREE.Matrix4();

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let found = 0;

  scene.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.name || '';
    if (!CREEK_MESH_NAMES.includes(name)) return;
    const pos = o.geometry?.attributes?.position;
    if (!pos) return;

    // mesh -> scene-local: localToScene = inverse(scene.world) * mesh.world
    toLocal.multiplyMatrices(sceneInv, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toLocal);
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.z < minZ) minZ = v.z;
      if (v.z > maxZ) maxZ = v.z;
      if (v.y < minY) minY = v.y;
    }
    found++;
  });

  if (!found || !isFinite(minX) || !isFinite(minY)) return null;

  return {
    minX, maxX, minZ, maxZ, minY,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    width: maxX - minX,
    depth: maxZ - minZ,
  };
}

// (hideCreekClutter removed: the single-surface level folds roads/sidewalks into the terrain
//  texture, so there are no floating RoadLines/Sidewalks meshes over the creek to hide.)

/** Find a mesh by exact name and set its visibility. Returns whether it matched. */
export function setMeshVisible(scene, name, visible) {
  let hit = false;
  scene?.traverse((o) => {
    if (o.isMesh && o.name === name) {
      o.visible = visible;
      hit = true;
    }
  });
  return hit;
}

// ── Flowing-water ShaderMaterial (three 0.184) ───────────────────────────────
// Two layers of scrolling value-noise drive a fake normal + a flow highlight; a
// fresnel term brightens the grazing edge; alpha is higher at the rim so the
// plane melts into the banks. Lit cheaply (no scene lights needed): a fixed sun
// dir gives a soft specular streak. Vertex/fragment are GLSL3-safe on R3F.
function makeWaterMaterial({ shallow, deep, flowDir, flowSpeed }) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uShallow: { value: new THREE.Color(shallow) },
      uDeep: { value: new THREE.Color(deep) },
      uFlowDir: { value: new THREE.Vector2(flowDir[0], flowDir[1]) },
      uFlowSpeed: { value: flowSpeed },
      uSunDir: { value: new THREE.Vector3(0.4, 0.85, 0.3).normalize() },
      uOpacity: { value: 0.82 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vViewDir;     // surface -> camera, view space
      varying vec3 vNormalV;     // base up normal, view space
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mv.xyz);
        vNormalV = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      varying vec3 vViewDir;
      varying vec3 vNormalV;
      uniform float uTime;
      uniform vec3  uShallow;
      uniform vec3  uDeep;
      uniform vec2  uFlowDir;
      uniform float uFlowSpeed;
      uniform vec3  uSunDir;
      uniform float uOpacity;

      // cheap value noise
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){
        vec2 i = floor(p); vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i + vec2(0,0)), hash(i + vec2(1,0)), u.x),
                   mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
      }

      void main() {
        // Two noise layers scrolling along the flow direction at different rates.
        vec2 flow = normalize(uFlowDir + 1e-4) * uFlowSpeed * uTime;
        vec2 uvA = vUv * 9.0  + flow;
        vec2 uvB = vUv * 18.0 - flow * 1.7;
        float nA = noise(uvA);
        float nB = noise(uvB);
        float ripple = (nA * 0.65 + nB * 0.35);

        // Derive a perturbed normal from the ripple gradient (finite difference).
        float e = 0.04;
        float gx = noise(uvA + vec2(e,0.0)) - noise(uvA - vec2(e,0.0));
        float gy = noise(uvA + vec2(0.0,e)) - noise(uvA - vec2(0.0,e));
        vec3 n = normalize(vNormalV + vec3(gx, gy, 0.0) * 0.6);

        // Fresnel: brighten + thin the alpha at grazing angles (rim glow).
        float fres = pow(1.0 - max(dot(normalize(vViewDir), n), 0.0), 3.0);

        // Soft specular streak from a fixed sun (no scene lights needed).
        vec3 h = normalize(uSunDir + normalize(vViewDir));
        float spec = pow(max(dot(n, h), 0.0), 60.0);

        vec3 col = mix(uDeep, uShallow, ripple);
        col += fres * 0.35;                 // rim brightening
        col += spec * vec3(1.0, 1.0, 0.95); // sun glint
        float alpha = clamp(uOpacity + fres * 0.15, 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Flat flowing water fitted to the creek footprint at its lowest elevation.
 *
 * @param {Object} props
 * @param {import('three').Object3D} [props.scene] level scene; Creek_* meshes are
 *   located by name to compute bounds. Ignored if explicit `bounds` are given.
 * @param {ReturnType<typeof computeCreekBounds>} [props.bounds] explicit footprint.
 * @param {number} [props.yOffset=0.06] raise the plane slightly above the min Y so
 *   it sits just over the creek bed (avoid z-fighting with rocks/banks).
 * @param {[number,number]} [props.flowDir] XZ flow direction; default follows the
 *   longer footprint axis (down-creek).
 * @param {number} [props.flowSpeed=0.06]
 * @param {string} [props.shallow='#7fd6c4'] crest color.
 * @param {string} [props.deep='#1b6e7a'] trough color.
 */
export function CreekWater({
  scene,
  flowDir = [1, 0],
  flowSpeed = 0.06,
  shallow = '#7fd6c4',
  deep = '#1b6e7a',
}) {
  const material = useMemo(
    () => makeWaterMaterial({ shallow, deep, flowDir, flowSpeed }),
    [shallow, deep, flowDir, flowSpeed],
  );
  const matRef = useRef(material);
  matRef.current = material;

  // Apply the flowing-water material to the ACTUAL creek-surface mesh. The San Lorenzo
  // creek winds across the whole block at varying elevations (0.5 → ~10 m, it climbs the
  // hill) — a single flat plane at the min-Y is a giant sheet buried under the terrain
  // (the old bug: no water visible). The authored Creek_SanLorenzo surface already
  // follows the channel, so we just re-skin it as water + reveal it (Level hides the
  // FlowLines/Banks clutter). Restore on unmount so toggling water off reverts cleanly.
  useEffect(() => {
    if (!scene) return undefined;
    const restore = [];
    scene.traverse((o) => {
      if (o.isMesh && o.name === 'Creek_SanLorenzo') {
        restore.push([o, o.material, o.visible, o.renderOrder]);
        o.material = material;
        o.visible = true;
        o.renderOrder = 1;
      }
    });
    return () => {
      for (const [o, mat, vis, ro] of restore) {
        o.material = mat;
        o.visible = vis;
        o.renderOrder = ro;
      }
    };
  }, [scene, material]);

  useFrame((_, dt) => {
    // Render-only clock — never touches the sim.
    matRef.current.uniforms.uTime.value += dt;
  });

  return null;
}

export default CreekWater;
