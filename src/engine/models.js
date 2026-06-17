import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { merge } from './geom.js';

// Loads downloaded GLBs (plain, no Draco) and normalizes them to the game's
// scale/orientation so they can drop into the procedural critter system.
// Both loaders fail soft: on any error the procedural fallback simply stays.

// World-bake a mesh's geometry (so authored node transforms are applied), then
// hand back a clean non-indexed copy with normals.
function bakedGeom(mesh) {
  const g = mesh.geometry.clone();
  g.applyMatrix4(mesh.matrixWorld);
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng !== g) g.dispose();
  if (!ng.attributes.normal) ng.computeVertexNormals();
  return ng;
}
function disposeSource(root) {
  root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) if (m && m.dispose) m.dispose();
  });
}

// Animated critter (pig / duck / iguana): a rigged Sketchfab export with a walk
// (or basking) clip. Keep the live skinned hierarchy + its AnimationClips intact
// so each spawned critter can play the cycle; just drop any ground/backdrop
// planes and normalize the rig so its longest horizontal axis is `length` units,
// centered in x/z and sitting on the ground. `yaw` turns the model so its nose
// runs with its motion. Hands back { proto, animations } — the caller deep-clones
// `proto` per critter (SkeletonUtils) and drives a mixer on each clone.
export function loadAnimalModel(url, { yaw = 0, length = 1 }, onReady) {
  new GLTFLoader().load(url, gltf => {
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    // drop flat scene cruft: named ground/backdrop planes AND degenerate alpha-card
    // sheets (one bbox axis ~0) — e.g. the iguana's center-plane dorsal frill, which
    // reads as a stray white sheet on the ground under the game's un-managed pipeline.
    const cruft = [];
    root.traverse(o => {
      if (!o.isMesh) return;
      if (/plane|ground|floor|backdrop/i.test(o.name)) { cruft.push(o); return; }
      o.geometry.computeBoundingBox();
      const s = new THREE.Vector3(); o.geometry.boundingBox.getSize(s);
      const a = [s.x, s.y, s.z].sort((p, q) => p - q);
      if (a[2] > 0 && a[0] < 0.01 * a[2]) cruft.push(o);   // planar sheet
    });
    for (const o of cruft) o.parent && o.parent.remove(o);
    let hasMesh = false; root.traverse(o => { if (o.isMesh) { hasMesh = true; o.castShadow = true; o.frustumCulled = false; } });
    if (!hasMesh) { console.warn('animal GLB had no usable mesh, keeping fallback', url); disposeSource(root); return; }
    // normalize: longest horizontal axis -> `length`, centered in x/z, on the ground.
    // Nested so model-facing yaw (outer) stays clean of the scale+offset (inner) —
    // and SkeletonUtils.clone copies the whole transformed rig.
    const box = new THREE.Box3().setFromObject(root), size = new THREE.Vector3(); box.getSize(size);
    const s = length / (Math.max(size.x, size.z) || 1);
    const inner = new THREE.Group();
    inner.add(root);
    inner.scale.setScalar(s);
    inner.position.set(-((box.min.x + box.max.x) / 2) * s, -box.min.y * s, -((box.min.z + box.max.z) / 2) * s);
    const proto = new THREE.Group();
    proto.add(inner);
    proto.rotation.y = yaw;                          // model-facing correction
    onReady({ proto, animations: gltf.animations || [] });
  }, undefined, err => console.warn('animal model failed, keeping fallback', url, err));
}

// Poop emoji: 4 parts (brown body + black/white eyes + mouth). Merge into one
// vertex-colored geometry (so a single InstancedMesh keeps the face), bring it
// from the file's Z-up to Y-up, and shrink to ~0.34 units tall on the ground.
export function loadPoopGeometry(url, onReady) {
  new GLTFLoader().load(url, gltf => {
    gltf.scene.updateMatrixWorld(true);
    const parts = [];
    gltf.scene.traverse(o => {
      if (!o.isMesh) return;
      const g = bakedGeom(o);
      const color = (o.material && o.material.color) ? o.material.color.clone() : new THREE.Color(0x6b4a2a);
      parts.push({ g, color });
    });
    if (!parts.length) { console.warn('poop GLB had no meshes, keeping fallback', url); disposeSource(gltf.scene); return; }
    const geo = merge(parts);                        // model is already Y-up
    geo.computeBoundingBox();
    const bb = geo.boundingBox, size = new THREE.Vector3(); bb.getSize(size);
    const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
    geo.translate(-cx, -bb.min.y, -cz);
    geo.scale(0.34 / (size.y || 1), 0.34 / (size.y || 1), 0.34 / (size.y || 1));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 });
    onReady(geo, mat);
    disposeSource(gltf.scene);
  }, undefined, err => console.warn('poop model failed, keeping fallback', err));
}

// Vegetation: returns the named tree/bush variants from veg.glb, each as a
// centered, base-on-ground geometry + its (unlit, alpha-masked) material, so the
// engine can instance them at the procedural tree points. Native sizes are kept
// (the caller scales per-instance to a metric height).
export function loadVegetation(url, onReady) {
  new GLTFLoader().load(url, gltf => {
    gltf.scene.updateMatrixWorld(true);
    const variants = [];
    gltf.scene.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const geo = bakedGeom(o);
      geo.computeBoundingBox();
      const bb = geo.boundingBox, size = new THREE.Vector3(); bb.getSize(size);
      geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
      const mat = o.material.clone();           // unlit forest atlas (KHR_materials_unlit)
      mat.alphaTest = 0.5; mat.transparent = false; mat.depthWrite = true;
      mat.side = THREE.DoubleSide; mat.toneMapped = false;
      if (mat.map) mat.map.colorSpace = THREE.NoColorSpace;
      variants.push({ name: o.name, geom: geo, mat, height: size.y || 1, bush: /bush/i.test(o.name) });
    });
    if (variants.length) { onReady(variants); disposeSource(gltf.scene); }
    else { console.warn('veg GLB had no variant meshes, keeping fallback', url); disposeSource(gltf.scene); }
  }, undefined, err => console.warn('veg model failed, keeping fallback', err));
}
