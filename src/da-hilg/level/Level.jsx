// <Level> — loads the neighborhood GLB, recenters it to origin/ground≈0, hides the
// authored Collision_*/LOD_* proxies, tunes the visual materials (so facades aren't
// washed out), builds ONE fixed trimesh collider from the Collision_* proxies, and
// mounts the flowing creek water + wind-swept grass inside the recenter group.
//
// Subtleties: the GLB uses KHR_mesh_quantization (real scale on node matrices), so
// the collider is baked from each Collision_* mesh's full matrixWorld (denormalized
// via fromBufferAttribute) and mounted at identity. Everything gates on
// levelMeta.loaded so the recenter offset is real first.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import { useDaHilgGLTF } from '../loaders.js';
import { levelMeta } from '../state/refs.js';
import { LEVEL_URL } from '../constants.js';
import { showFacadesAtom, showWaterAtom, showGrassAtom } from '../state/settingsAtoms.js';
import { CreekWater, computeCreekBounds, hideCreekClutter, setMeshVisible } from './CreekWater.jsx';
import { WindGrass } from './WindGrass.jsx';
import { InstanceCulling } from './InstanceCulling.jsx';

const LEVEL_SOURCE = LEVEL_URL;

// Texture slots worth anisotropic filtering (grazing-angle sharpness on roads,
// sidewalks, roofs, facades, terrain). Anisotropy is hardware-cheap; the pipeline
// leaves every map at the default 1, which smears ground planes seen edge-on.
const ANISO_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'];

/** Tune one mesh's material(s) so the neighborhood reads crisp + sunlit, not pale. */
// Paved ground ribbons drape directly on the terrain and z-fight with it on slopes. A
// negative polygon offset makes them consistently WIN the depth test, so they never flicker
// or let the landscape poke through — and it does so without a big geometric lift (which
// floats the ribbons off the ground and leaves gaps under their edges).
const isPavedGround = (name) =>
  /^(Roads|Driveways|Sidewalks|Crosswalks|RoadCurbs|RoadLines)/.test(name);
// Terrain rendered single-sided shows the sky/black through any back-facing slope triangle;
// double-siding fills those without a re-export.
const isTerrain = (name) => name === 'Terrain' || name.startsWith('Terrain') || name === 'Satellite Ground';

function tuneMaterial(o, maxAniso) {
  const name = o.name || '';
  const isWindow = name.toLowerCase().includes('window');
  const isGlass = name.includes('windows') || isWindow;
  const paved = isPavedGround(name);
  const terrain = isTerrain(name);
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  for (const m of mats) {
    if (!m) continue;
    if (m.map) m.map.colorSpace = THREE.SRGBColorSpace; // photo/colour maps are sRGB
    // Full anisotropic filtering so grazing surfaces (lawn, road, sidewalk) stay sharp.
    for (const slot of ANISO_SLOTS) {
      const t = m[slot];
      if (t && t.anisotropy !== maxAniso) {
        t.anisotropy = maxAniso;
        t.needsUpdate = true;
      }
    }
    if ('roughness' in m) m.roughness = isGlass ? 0.2 : 0.92;
    if ('metalness' in m) m.metalness = isGlass ? 0.45 : 0.0;
    if (m.emissive) m.emissive.setScalar(0); // kill any baked-in glow that washes it out
    if (paved) {
      // GENTLE bias: just enough to win the depth test against the terrain at coincident
      // points, but small so a road dipping slightly below the terrain on a slope does NOT
      // bleed its dark asphalt over a wide band (the small geometric lift does the rest).
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -1;
    }
    void terrain; // (terrain double-side reverted — heightfield normals already face up)
    m.needsUpdate = true;
  }
}

/** Hide the collision/LOD proxies, tune visual materials, set shadow flags. */
function processScene(scene, maxAniso) {
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.name || '';
    if (name.startsWith('Collision_') || name.startsWith('LOD_')) {
      o.visible = false; // physics-only / duplicate
      return;
    }
    o.frustumCulled = true;
    o.receiveShadow = true;
    // Buildings + the house cast shadows for form; the heavy terrain/roads don't.
    o.castShadow = name.startsWith('House') || name.startsWith('Buildings');
    tuneMaterial(o, maxAniso);
  });
}

/**
 * Bake the Collision_* proxies into one (vertices, indices) trimesh in recentered
 * world space. Collision_Trees is EXCLUDED so the player can walk past street trees
 * (an invisible-tree-barrier along the sidewalks). Reads via fromBufferAttribute +
 * matrixWorld so the int16/quantized positions denormalize + scale correctly.
 */
function bakeCollider(scene) {
  scene.updateWorldMatrix(true, true);
  const positions = [];
  const indices = [];
  let base = 0;
  const v = new THREE.Vector3();
  // Track the walkable XZ extent (recentered world) → the map boundary.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

  scene.traverse((o) => {
    const name = o.name || '';
    if (!o.isMesh || !name.startsWith('Collision_')) return;
    if (name === 'Collision_Trees') return; // walk past trees — don't wall the sidewalks
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      positions.push(v.x, v.y, v.z);
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.z < minZ) minZ = v.z;
      if (v.z > maxZ) maxZ = v.z;
    }
    const idx = o.geometry.index;
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + base);
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(i + base);
    }
    base += pos.count;
  });

  const bounds =
    minX < maxX && minZ < maxZ ? { minX, maxX, minZ, maxZ } : null;
  return { vertices: new Float32Array(positions), indices: new Uint32Array(indices), bounds };
}

/**
 * True for the "paved/built" meshes the player walks ON but grass must NOT grow on:
 * roads, road-lines, curbs, sidewalks, walkways, driveways, the owner house, the
 * neighborhood buildings, their doors/garage doors, and the photo roofs. Terrain,
 * ground, creek, trees, shrubs, fences, grass clumps, and the flat SVFacade photo
 * planes are NOT here — grass is fine on/around those.
 */
function isPavedOrBuilt(name) {
  if (!name) return false;
  return (
    name.startsWith('Buildings') || // Buildings group + Buildings_* parts
    name.startsWith('House_') ||    // owner-house walls/roof/trim/windows
    name === 'Doors' ||
    name.startsWith('GarageDoor') ||
    name.startsWith('Roofs_photo') ||
    name.startsWith('Roof Photo') ||
    name.startsWith('Driveways') ||
    name === 'RoadCurbs' ||
    name === 'RoadLines' ||
    name === 'Roads' ||
    name === 'Sidewalks' ||
    name === 'Walkways'
  );
}

/**
 * Render a ONE-TIME top-down paved/building MASK for the grass shader to sample.
 *
 * We gather every paved/built mesh (see isPavedOrBuilt), draw each as flat WHITE on a
 * BLACK clear from an orthographic camera looking straight down over the level's XZ
 * footprint, into an offscreen render target. White texels = NO grass. The grass
 * vertex shader maps each blade's recentered-world XZ into this texture and collapses
 * any blade that lands on white. Built once (no per-frame cost).
 *
 * Runs in the SAME recentered world space the grass lives in: the level renders inside
 * a <group position={recenter}>, so each mesh's matrixWorld is already recentered —
 * we render with those world matrices and a camera in that space, no offset math.
 *
 * @param {THREE.Object3D} scene the loaded (mounted, recentered) level scene
 * @param {THREE.WebGLRenderer} gl the live renderer
 * @returns {{ texture: THREE.Texture, min: [number,number], size: [number,number] } | null}
 */
function buildPaveMask(scene, gl) {
  scene.updateWorldMatrix(true, true);

  // Collect paved/built meshes + accumulate their recentered-world XZ bounds.
  const meshes = [];
  const box = new THREE.Box3();
  const worldBox = new THREE.Box3();
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!isPavedOrBuilt(o.name)) return;
    meshes.push(o);
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    worldBox.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    box.union(worldBox);
  });
  if (!meshes.length || !isFinite(box.min.x)) return null;

  // Pad the bounds so blades right at a road edge still sample cleanly, then SQUARE
  // it (equal world-units per texel on both axes keeps the mask undistorted).
  const pad = 4;
  let minX = box.min.x - pad;
  let minZ = box.min.z - pad;
  let maxX = box.max.x + pad;
  let maxZ = box.max.z + pad;
  const span = Math.max(maxX - minX, maxZ - minZ);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  minX = cx - span / 2;
  maxX = cx + span / 2;
  minZ = cz - span / 2;
  maxZ = cz + span / 2;

  // Mask scene: a white copy of each paved/built mesh, baked at its world matrix.
  const maskScene = new THREE.Scene();
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  for (const o of meshes) {
    const m = new THREE.Mesh(o.geometry, white);
    m.matrixAutoUpdate = false;
    m.matrix.copy(o.matrixWorld);
    maskScene.add(m);
  }

  // Top-down orthographic camera: looks straight DOWN the −Y axis over the (squared)
  // footprint. up = −Z makes the camera basis camera-right = world +X and camera-up =
  // world −Z, so the rendered image is an un-mirrored top-down with V running along
  // world −Z (the shader flips V to map world Z → V). The frustum is symmetric about
  // the camera (centered at cx,cz), so half-span on each side.
  const SIZE = 2048; // ~0.25 m / texel over a ~470 m span — fine for road edges
  const half = span / 2;
  const cam = new THREE.OrthographicCamera(
    -half, half, half, -half, // left, right, top, bottom in camera-local axes
    0.1, box.max.y - box.min.y + 200,
  );
  cam.position.set(cx, box.max.y + 50, cz);
  cam.up.set(0, 0, -1);
  cam.lookAt(cx, box.min.y, cz);
  cam.updateMatrixWorld(true);

  const rt = new THREE.WebGLRenderTarget(SIZE, SIZE, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    generateMipmaps: false,
  });

  // Render once on a black clear, then restore renderer state.
  const prevTarget = gl.getRenderTarget();
  const prevClear = gl.getClearColor(new THREE.Color()).getHex();
  const prevAlpha = gl.getClearAlpha();
  gl.setRenderTarget(rt);
  gl.setClearColor(0x000000, 1);
  gl.clear(true, true, true);
  gl.render(maskScene, cam);
  gl.setRenderTarget(prevTarget);
  gl.setClearColor(prevClear, prevAlpha);

  white.dispose();
  return { texture: rt.texture, min: [minX, minZ], size: [maxX - minX, maxZ - minZ] };
}

/**
 * @param {Object} props
 * @param {() => void} [props.onReady] called once the collider is built
 */
export function Level({ onReady }) {
  const { scene } = useDaHilgGLTF(LEVEL_SOURCE);
  const gl = useThree((s) => s.gl);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  // In-game graphics toggles (pause-menu settings).
  const showFacades = useAtomValue(showFacadesAtom);
  const showWater = useAtomValue(showWaterAtom);
  const showGrass = useAtomValue(showGrassAtom);

  const [ready, setReady] = useState(levelMeta.loaded);
  useEffect(() => {
    if (ready) return;
    const id = setInterval(() => {
      if (levelMeta.loaded) {
        setReady(true);
        clearInterval(id);
      }
    }, 30);
    return () => clearInterval(id);
  }, [ready]);

  // Hide proxies/LOD + tune materials once (full anisotropy from the live GPU caps).
  useMemo(() => processScene(scene, gl.capabilities.getMaxAnisotropy()), [scene, gl]);

  const offset = levelMeta.offset || [0, 0, 0];
  const recenter = [-offset[0], -offset[1], -offset[2]];

  // After the visual mounts under the recenter group: bake the collider, compute
  // the creek footprint, and hide the road-line clutter overlapping the creek.
  const [collider, setCollider] = useState(null);
  const [creekBounds, setCreekBounds] = useState(null);
  const [paveMask, setPaveMask] = useState(null);
  const didBuildLevelRef = useRef(false);
  useEffect(() => {
    if (!ready || didBuildLevelRef.current) return;
    const raf = requestAnimationFrame(() => {
      if (didBuildLevelRef.current) return;
      didBuildLevelRef.current = true;
      const baked = bakeCollider(scene);
      setCollider(baked);
      if (baked.bounds) levelMeta.bounds = baked.bounds; // map boundary (walkable XZ extent)
      const b = computeCreekBounds(scene);
      setCreekBounds(b);
      if (b) hideCreekClutter(scene, b);
      // Hide the authored creek SOURCE meshes — Creek_FlowLines reads as road-marker
      // lines and Creek_Banks/Creek_SanLorenzo as brown sidewalk / hill-climbing water.
      // CreekWater re-skins Creek_SanLorenzo as flowing water; keep Rocks + Reeds as
      // decoration. SanLorenzo starts hidden here so it's invisible when water is OFF.
      setMeshVisible(scene, 'Creek_FlowLines', false);
      setMeshVisible(scene, 'Creek_Banks', false);
      setMeshVisible(scene, 'Creek_SanLorenzo', false);
      onReadyRef.current?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [ready, scene, gl]);

  // Build the top-down paved/building mask (so grass skips roads/walks/driveways/
  // buildings) LAZILY — only when grass is enabled, its single consumer. Default play
  // (grass OFF) never pays this 2048² offscreen render on the level-ready frame.
  const builtPaveRef = useRef(false);
  useEffect(() => {
    if (!ready || !showGrass || builtPaveRef.current) return;
    builtPaveRef.current = true;
    setPaveMask(buildPaveMask(scene, gl));
  }, [ready, showGrass, scene, gl]);

  // Facade toggle: show/hide the Street View photo facades as a group. Names survive
  // the meshopt build, so we gate by SVFacade*. No-op until the export carries them.
  useEffect(() => {
    if (!ready) return;
    scene.traverse((o) => {
      if (o.isMesh && (o.name || '').startsWith('SVFacade')) o.visible = showFacades;
    });
  }, [scene, ready, showFacades]);

  if (!ready) return null;

  return (
    <>
      <group position={recenter}>
        <primitive object={scene} />
        {/* Flat flowing water at the low creek elevation (toggleable "fancy water"). */}
        {showWater && creekBounds && <CreekWater scene={scene} />}
      </group>
      {/* Wind-swept grass — WORLD space, follows the player's feet (toggleable).
          Dense disc of tapered curved blades; innerRadius tiny so it reaches the player.
          Gated on paveMask so blades never flash on roads before the mask is ready; the
          shader culls any blade that lands on a road/walk/driveway/building. */}
      {showGrass && paveMask && (
        <WindGrass
          radius={38}
          innerRadius={0.4}
          count={85000}
          bladeHeight={0.22}
          paveMask={paveMask.texture}
          maskMin={paveMask.min}
          maskSize={paveMask.size}
        />
      )}
      {/* Per-instance frustum + distance culling for the tree InstancedMeshes — only
          draw the trees actually on screen / nearby (trees are ~85% of the triangles). */}
      <InstanceCulling scene={scene} />
      {collider && (
        <RigidBody type="fixed" colliders={false}>
          <TrimeshCollider args={[collider.vertices, collider.indices]} />
        </RigidBody>
      )}
    </>
  );
}

// (Preloading happens in <DaHilgPreloader/> inside the Canvas — KTX2 needs the live
// renderer, which a module-scope useGLTF.preload wouldn't have.)

export default Level;
