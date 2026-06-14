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
  if (!ng.attributes.normal) ng.computeVertexNormals();
  return ng;
}

// Pig: a Sketchfab export carrying ground/backdrop planes too. Drop the planes,
// keep the body + eye meshes, paint the body (densest mesh) near-black while
// leaving the eyes their own colour, then normalize to ~1.2 units long sitting
// on the ground. `yaw` rotates the model so its nose runs with its motion.
export function loadPigPrototype(url, yaw, onReady) {
  new GLTFLoader().load(url, gltf => {
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    // drop flat scene cruft (ground/backdrop planes)
    root.traverse(o => { if (o.isMesh && /plane|ground|floor|backdrop/i.test(o.name)) o.userData._drop = true; });
    let body = null, bodyN = -1;
    root.traverse(o => { if (o.isMesh && !o.userData._drop) { const n = o.geometry.attributes.position.count; if (n > bodyN) { bodyN = n; body = o; } } });
    if (!body) return;
    const proto = new THREE.Group();
    root.traverse(o => {
      if (!o.isMesh || o.userData._drop) return;
      const m = new THREE.Mesh(bakedGeom(o), o.material.clone());
      if (o === body) { m.material.color && m.material.color.setHex(0x141210); m.material.map = null; m.material.metalness = 0; m.material.roughness = 0.66; }
      m.castShadow = true;
      proto.add(m);
    });
    // normalize the whole pig (body + eyes) as one unit
    const box = new THREE.Box3().setFromObject(proto), size = new THREE.Vector3(); box.getSize(size);
    const s = 1.2 / (Math.max(size.x, size.z) || 1);
    const inner = new THREE.Group();
    while (proto.children.length) inner.add(proto.children[0]);
    inner.scale.setScalar(s);
    inner.position.set(-((box.min.x + box.max.x) / 2) * s, -box.min.y * s, -((box.min.z + box.max.z) / 2) * s);
    proto.add(inner);
    proto.rotation.y = yaw;                          // model-facing correction
    onReady(proto);
  }, undefined, err => console.warn('pig model failed, keeping fallback', err));
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
    if (!parts.length) return;
    const geo = merge(parts);                        // model is already Y-up
    geo.computeBoundingBox();
    const bb = geo.boundingBox, size = new THREE.Vector3(); bb.getSize(size);
    const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
    geo.translate(-cx, -bb.min.y, -cz);
    geo.scale(0.34 / (size.y || 1), 0.34 / (size.y || 1), 0.34 / (size.y || 1));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 });
    onReady(geo, mat);
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
      if (!o.isMesh) return;
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
    if (variants.length) onReady(variants);
  }, undefined, err => console.warn('veg model failed, keeping fallback', err));
}
