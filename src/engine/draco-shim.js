import * as THREE from 'three';
import DracoDecoderModule from '../vendor/draco_decoder.js';

// Main-thread Draco decode, mirroring the official r128 worker logic.
// The Claude-app artifact webview blocks Workers, WASM and eval, so the stock
// DRACOLoader silently fails there — this shim is the reason the Ferrari
// loads at all. Keep it worker-free.
//
// r128's GLTFLoader passes no error callback to decodeDracoFile, so failures
// are surfaced through the assignable `onError` hook instead.
export const DracoShim = {
  _modP: null,
  onError: null,
  _mod() {
    if (!this._modP) this._modP = new Promise(res => { DracoDecoderModule({ onModuleLoaded: m => res(m) }); });
    return this._modP;
  },
  preload() { this._mod(); return this; },
  dispose() { return this; },
  decodeDracoFile(buffer, callback, attributeIDs, attributeTypes) {
    this._mod().then(draco => {
      const TYPES = { Float32Array, Int8Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array };
      const dt = AT => AT === Float32Array ? draco.DT_FLOAT32 : AT === Int8Array ? draco.DT_INT8 :
        AT === Int16Array ? draco.DT_INT16 : AT === Int32Array ? draco.DT_INT32 :
        AT === Uint8Array ? draco.DT_UINT8 : AT === Uint16Array ? draco.DT_UINT16 : draco.DT_UINT32;
      const decoder = new draco.Decoder();
      const db = new draco.DecoderBuffer();
      db.Init(new Int8Array(buffer), buffer.byteLength);
      const gt = decoder.GetEncodedGeometryType(db);
      let dg, st;
      if (gt === draco.TRIANGULAR_MESH) { dg = new draco.Mesh(); st = decoder.DecodeBufferToMesh(db, dg); }
      else { dg = new draco.PointCloud(); st = decoder.DecodeBufferToPointCloud(db, dg); }
      if (!st.ok() || dg.ptr === 0) throw new Error('draco decode: ' + st.error_msg());
      const geo = new THREE.BufferGeometry();
      for (const name in attributeIDs) {
        const tv = attributeTypes[name];
        const AT = typeof tv === 'string' ? TYPES[tv] : tv;
        const attr = decoder.GetAttributeByUniqueId(dg, attributeIDs[name]);
        const nc = attr.num_components(), np = dg.num_points(), nv = np * nc;
        const bl = nv * AT.BYTES_PER_ELEMENT;
        const ptr = draco._malloc(bl);
        decoder.GetAttributeDataArrayForAllPoints(dg, attr, dt(AT), bl, ptr);
        const arr = new AT(draco.HEAPF32.buffer, ptr, nv).slice();
        draco._free(ptr);
        geo.setAttribute(name, new THREE.BufferAttribute(arr, nc));
      }
      if (gt === draco.TRIANGULAR_MESH) {
        const ni = dg.num_faces() * 3, bl = ni * 4;
        const ptr = draco._malloc(bl);
        decoder.GetTrianglesUInt32Array(dg, bl, ptr);
        const idx = new Uint32Array(draco.HEAPF32.buffer, ptr, ni).slice();
        draco._free(ptr);
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
      }
      draco.destroy(dg); draco.destroy(db); draco.destroy(decoder);
      callback(geo);
    }).catch(e => {
      console.warn('draco shim failed', e);
      if (this.onError) this.onError(e);
    });
  }
};
