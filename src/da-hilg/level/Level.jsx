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
import { CreekWater, computeCreekBounds, setMeshVisible } from './CreekWater.jsx';
import { WindGrass } from './WindGrass.jsx';
import { InstanceCulling } from './InstanceCulling.jsx';

const LEVEL_SOURCE = LEVEL_URL;

// Texture slots worth anisotropic filtering (grazing-angle sharpness on roads,
// sidewalks, roofs, facades, terrain). Anisotropy is hardware-cheap; the pipeline
// leaves every map at the default 1, which smears ground planes seen edge-on.
const ANISO_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'];

/** Tune one mesh's material(s) so the neighborhood reads crisp + sunlit, not pale. */
// The single-surface level welds roads/sidewalks/curbs into the ONE terrain texture, so there
// are no coplanar paved ribbons draped on the terrain anymore — the old polygonOffset z-fight
// firefighting is obsolete and removed. The 'Terrain' node is just classified for anisotropy.
const isTerrain = (name) => name === 'Terrain' || name.startsWith('Terrain') || name === 'Satellite Ground';

function tuneMaterial(o, maxAniso) {
  const name = o.name || '';
  const isWindow = name.toLowerCase().includes('window');
  const isGlass = name.includes('windows') || isWindow;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  for (const m of mats) {
    if (!m) continue;
    if (m.map) m.map.colorSpace = THREE.SRGBColorSpace; // photo/colour maps are sRGB
    // Full anisotropic filtering so grazing surfaces (lawn, road texture) stay sharp.
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
    m.needsUpdate = true;
  }
}

const CREEK_SURROUND_COLORS = new Map([
  ['Creek_Banks', 0x5c4d34],
  ['Creek_Rocks', 0x787266],
  ['Creek_Reeds', 0x335f2b],
]);

function tuneCreekSurrounds(scene) {
  scene.traverse((o) => {
    if (!o.isMesh || !CREEK_SURROUND_COLORS.has(o.name)) return;
    o.visible = true;
    const color = CREEK_SURROUND_COLORS.get(o.name);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const tuned = mats.map((m) => {
      if (!m) return m;
      const next = m.clone();
      if (next.color) next.color.setHex(color);
      if ('roughness' in next) next.roughness = 0.95;
      if ('metalness' in next) next.metalness = 0;
      next.needsUpdate = true;
      return next;
    });
    o.material = Array.isArray(o.material) ? tuned : tuned[0];
  });
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
    // The welded Terrain receives shadows (it's the ground); so does everything else here.
    o.receiveShadow = true;
    if (isTerrain(name)) o.frustumCulled = false; // one big ground surface — never frustum-cull it out
    // Buildings + the house cast shadows for form; the heavy terrain doesn't.
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

/** True for the BUILT meshes (owner house + neighborhood buildings) grass must not grow under.
 *  Roads/sidewalks/driveways are NOT here — those live in the painted paved_mask.png sidecar. */
function isBuilt(name) {
  if (!name) return false;
  return (
    name.startsWith('Buildings') || // Buildings group + Buildings_walls/_roofs
    name.startsWith('House_') ||    // owner-house walls/roof
    name === 'Doors' ||
    name.startsWith('Doors_') ||
    name.startsWith('GarageDoor')
  );
}

/**
 * Build the top-down grass-occlusion mask by COMPOSITING two sources into one render target:
 *
 *   1) the exporter's paved_mask.png sidecar (roads/sidewalks/curbs/driveways), painted over
 *      the DEM rect — the single-surface level folds those into the terrain texture, so this
 *      sidecar (NOT a render of road meshes, which no longer exist) is the source of truth; and
 *   2) the Buildings/House footprints, rendered WHITE on top so grass doesn't grow under them.
 *
 * White texels = NO grass. The grass vertex shader maps each blade's recentered-world XZ into
 * this texture (over the DEM rect's min/size) and collapses any blade that lands on white. The
 * camera/orientation match WindGrass's existing sampling (X→U, Z→V with the shader's V-flip), so
 * the sidecar PNG (loaded with the default flipY) and the building render line up by construction.
 *
 * Built once (no per-frame cost). Runs in the SAME recentered world space the grass lives in
 * (the level renders inside a <group position={recenter}>, so each mesh's matrixWorld is already
 * recentered). Returns null (grass occlusion off) if the sidecar/rect aren't available.
 *
 * @param {THREE.Object3D} scene the loaded (mounted, recentered) level scene
 * @param {THREE.WebGLRenderer} gl the live renderer
 * @param {THREE.Texture} pavedTex the loaded paved_mask.png texture (white = paved)
 * @param {{ min: [number,number], size: [number,number] }} rect recentered DEM rect (X,Z)
 * @returns {{ texture: THREE.Texture, min: [number,number], size: [number,number] } | null}
 */
function buildPaveMask(scene, gl, pavedTex, rect) {
  if (!pavedTex || !rect || !Array.isArray(rect.min) || !Array.isArray(rect.size)) return null;
  scene.updateWorldMatrix(true, true);

  const [minX, minZ] = rect.min;
  const [sizeX, sizeZ] = rect.size;
  if (!(sizeX > 0) || !(sizeZ > 0)) return null;
  const maxX = minX + sizeX;
  const maxZ = minZ + sizeZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  // The occlusion scene: a full-rect quad textured with the paved sidecar (the painted
  // roads/walks/driveways) + a WHITE copy of each Buildings/House mesh on top.
  const maskScene = new THREE.Scene();

  // 1) Paved sidecar as a ground-plane quad spanning the DEM rect. Drawn at the lowest Y so the
  //    building renders (above it) always win. The shader samples this exact mask UV later, but
  //    here we re-project it through the same top-down camera so it composites with the buildings.
  pavedTex.colorSpace = THREE.NoColorSpace;
  const pavedMat = new THREE.MeshBasicMaterial({ map: pavedTex });
  const pavedPlane = new THREE.Mesh(new THREE.PlaneGeometry(sizeX, sizeZ), pavedMat);
  // PlaneGeometry lies in XY; rotate it flat into XZ. After rot −90° about X, plane local +Y → +Z.
  pavedPlane.rotation.x = -Math.PI / 2;
  pavedPlane.position.set(cx, 0, cz);
  maskScene.add(pavedPlane);

  // 2) Buildings/House footprints in white, baked at their recentered world matrix.
  const built = [];
  const box = new THREE.Box3();
  const worldBox = new THREE.Box3();
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || !isBuilt(o.name)) return;
    const m = new THREE.Mesh(o.geometry, white);
    m.matrixAutoUpdate = false;
    m.matrix.copy(o.matrixWorld);
    m.renderOrder = 1; // composite above the paved plane
    maskScene.add(m);
    built.push(m);
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    worldBox.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    box.union(worldBox);
  });

  // Top-down orthographic camera over the DEM rect. up = −Z makes camera-right = world +X and
  // camera-up = world −Z, an un-mirrored top-down with V along world −Z (the shader flips V to
  // map world Z → V). Frustum is the exact rect so the rendered image == the sampled mask space.
  const yHi = isFinite(box.max.y) ? box.max.y + 50 : 200;
  const yLo = isFinite(box.min.y) ? box.min.y : -50;
  const cam = new THREE.OrthographicCamera(-sizeX / 2, sizeX / 2, sizeZ / 2, -sizeZ / 2, 0.1, (yHi - yLo) + 200);
  cam.position.set(cx, yHi, cz);
  cam.up.set(0, 0, -1);
  cam.lookAt(cx, yLo, cz);
  cam.updateMatrixWorld(true);

  // Non-square RT proportional to the rect so the mask isn't distorted (the shader maps by
  // rect size, not pixels, so aspect-correct or not it samples right — but keep it honest).
  const LONG = 2048;
  const aspect = sizeX / sizeZ;
  const rw = aspect >= 1 ? LONG : Math.max(4, Math.round(LONG * aspect));
  const rh = aspect >= 1 ? Math.max(4, Math.round(LONG / aspect)) : LONG;
  const rt = new THREE.WebGLRenderTarget(rw, rh, {
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

  pavedPlane.geometry.dispose();
  pavedMat.dispose();
  white.dispose();
  void built;
  return { texture: rt.texture, min: [minX, minZ], size: [sizeX, sizeZ] };
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

  // Photo-facade toggle: the SV photos are SEPARATE, flush quad meshes (the exporter names them
  // 'Buildings_facade_page*'; older builds used 'SVFacade_page*') riding on the wall plane with the
  // windowed-stucco wall recessed just behind them. Flip every facade-page node's visibility as a
  // group — ON (default) the photos show; OFF reveals the windowed stucco wall underneath (no
  // geometry goes missing). Re-runs when the toggle or scene changes.
  useEffect(() => {
    scene.traverse((o) => {
      const n = o.name || '';
      if (o.isMesh && (n.startsWith('Buildings_facade') || n.startsWith('SVFacade'))) o.visible = showFacades;
    });
  }, [scene, showFacades]);

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
      // Keep the creek banks/rocks/reeds visible but earth-toned; hide only the authored
      // water/flow clutter. CreekWater re-skins Creek_SanLorenzo as live flowing water.
      tuneCreekSurrounds(scene);
      setMeshVisible(scene, 'Creek_SanLorenzo', false);
      setMeshVisible(scene, 'Creek_FlowLines', false);
      onReadyRef.current?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [ready, scene, gl]);

  // Build the top-down grass-occlusion mask (so grass skips roads/walks/driveways from the
  // painted paved_mask.png sidecar + footprints under Buildings/House) LAZILY — only when
  // grass is enabled, its single consumer. Default play (grass OFF) never fetches the sidecar
  // PNG nor pays the one-time offscreen composite on the level-ready frame.
  const builtPaveRef = useRef(false);
  useEffect(() => {
    if (!ready || !showGrass || builtPaveRef.current) return;
    builtPaveRef.current = true;
    const maskUrl = levelMeta.pavedMask;
    const rect = levelMeta.pavedMaskRect;
    if (!maskUrl || !rect) return; // no sidecar this level → grass occlusion stays off (no mask)
    let cancelled = false;
    let loadedTex = null;
    new THREE.TextureLoader().load(
      maskUrl,
      (tex) => {
        if (cancelled) { tex.dispose(); return; }
        loadedTex = tex;
        // Compose the sidecar (roads/walks) with the Buildings/House footprints into one mask.
        setPaveMask(buildPaveMask(scene, gl, tex, rect));
        tex.dispose(); // the composite copied it into its own render target
        loadedTex = null;
      },
      undefined,
      (err) => console.warn('[Level] paved mask load failed:', err?.message ?? err),
    );
    return () => { cancelled = true; loadedTex?.dispose(); };
  }, [ready, showGrass, scene, gl]);

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
          count={62000}
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
