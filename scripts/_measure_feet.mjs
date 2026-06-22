// One-off: measure where each served character GLB's feet actually sit at REST.
// Reports lowest foot-JOINT world Y, lowest skinned MESH-vertex world Y (true sole,
// bind pose), and Hips rest Y. Grounded => lowest sole ~= 0.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder } from 'meshoptimizer';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'meshopt.decoder': MeshoptDecoder,
});

function trs(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [(1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
          (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
          (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
          t[0], t[1], t[2], 1];
}
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

for (const id of ['cece', 'mike', 'kelli', 'drew']) {
  const p = `public/da-hilg/${id}.glb`;
  const doc = await io.read(p);
  const root = doc.getRoot();
  const scene = root.listScenes()[0];
  // world matrix of every node
  const wmOf = new Map();
  const walk = (n, pa) => {
    const w = mul(pa, trs(n.getTranslation(), n.getRotation(), n.getScale()));
    wmOf.set(n, w);
    for (const c of n.listChildren()) walk(c, w);
  };
  for (const n of scene.listChildren()) walk(n, I);

  // lowest foot joint + hips
  const jointSet = new Set();
  for (const sk of root.listSkins()) for (const j of sk.listJoints()) jointSet.add(j);
  let jointMinY = Infinity, hipsY = null;
  for (const [n, w] of wmOf) {
    if (jointSet.has(n)) { if (w[13] < jointMinY) jointMinY = w[13]; if (n.getName() === 'Hips') hipsY = w[13]; }
  }

  // lowest skinned-mesh vertex at BIND pose (true sole): skin each vertex by its joints.
  let soleY = Infinity;
  for (const sk of root.listSkins()) {
    const joints = sk.listJoints();
    const ibmAcc = sk.getInverseBindMatrices();
    const jointW = joints.map((j) => wmOf.get(j));
    // skinned skeleton root node carries the mesh; find meshes that reference this skin
    for (const node of root.listNodes()) {
      if (node.getSkin() !== sk || !node.getMesh()) continue;
      for (const prim of node.getMesh().listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const jo = prim.getAttribute('JOINTS_0');
        const we = prim.getAttribute('WEIGHTS_0');
        if (!pos || !jo || !we || !ibmAcc) continue;
        const v = [0, 0, 0], ji = [0, 0, 0, 0], wt = [0, 0, 0, 0], ibm = [];
        for (let i = 0; i < pos.getCount(); i += 7) { // sample every 7th vertex (fast, enough for min-Y)
          pos.getElement(i, v); jo.getElement(i, ji); we.getElement(i, wt);
          let y = 0;
          for (let k = 0; k < 4; k++) {
            if (wt[k] <= 0) continue;
            ibmAcc.getElement(ji[k], ibm); // 16-float inverse bind
            const jw = jointW[ji[k]];
            // skinMat = jointWorld * inverseBind ; apply to vertex, take y
            const m = mul(jw, ibm);
            const yy = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
            y += yy * wt[k];
          }
          if (y < soleY) soleY = y;
        }
      }
    }
  }
  console.log(`${id.padEnd(6)} footJointMinY=${jointMinY.toFixed(3)}  soleVertMinY=${soleY.toFixed(3)}  HipsY=${hipsY?.toFixed(3)}`);
}
