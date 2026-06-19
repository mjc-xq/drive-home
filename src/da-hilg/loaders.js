// Da Hilg GLB loading — meshopt geometry + KTX2 textures, fully offline.
//
// drei's useGLTF already attaches three's built-in MeshoptDecoder (useMeshopt). For
// the KTX2 (Basis Universal) textures our asset pipeline now emits, we additionally
// attach a KTX2Loader pointed at the LOCAL basis transcoder in public/da-hilg/basis —
// no CDN, so the game still loads offline. We pass useDraco=false because every Da
// Hilg GLB is meshopt-only (this also avoids drei's default gstatic DRACO decoder).
//
// KTX2Loader.detectSupport(renderer) needs the live WebGLRenderer, which only exists
// inside the Canvas. So the loader is a lazy singleton and detectSupport runs once
// with the first gl we see. Module-scope useGLTF.preload would run WITHOUT a renderer
// and fail to transcode, so we preload from <DaHilgPreloader/> (mounted in the Canvas)
// instead of at import time.

import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { KTX2Loader } from 'three-stdlib';

const TRANSCODER_PATH = '/da-hilg/basis/'; // public/da-hilg/basis (local, offline)

let _ktx2 = null;
let _detected = false;

/** Lazy singleton KTX2Loader; detectSupport runs once against the live renderer. */
function ktx2For(gl) {
  if (!_ktx2) _ktx2 = new KTX2Loader().setTranscoderPath(TRANSCODER_PATH);
  if (!_detected) {
    _ktx2.detectSupport(gl);
    _detected = true;
  }
  return _ktx2;
}

/** extendLoader that wires the KTX2 loader onto drei's GLTFLoader. */
const extendFor = (gl) => (loader) => loader.setKTX2Loader(ktx2For(gl));

/**
 * useGLTF for Da Hilg assets — meshopt + KTX2, no DRACO/CDN. Accepts a url or array
 * (drei returns one result per entry for arrays). Use this for EVERY GLB that may
 * carry KTX2 textures (the level + the four characters).
 */
export function useDaHilgGLTF(url) {
  const gl = useThree((s) => s.gl);
  const extend = useMemo(() => extendFor(gl), [gl]);
  return useGLTF(url, false, true, extend);
}

/**
 * Warm drei's cache for the given URLs once the renderer is live (so KTX2 transcodes).
 * Mount ONE of these inside the Canvas. `urls` should be a stable array.
 */
export function DaHilgPreloader({ urls }) {
  const gl = useThree((s) => s.gl);
  const extend = useMemo(() => extendFor(gl), [gl]);
  useEffect(() => {
    for (const u of urls) useGLTF.preload(u, false, true, extend);
  }, [extend, urls]);
  return null;
}
