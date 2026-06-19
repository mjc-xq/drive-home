// DaHilgApp — the root composition for the Da Hilg game. It does three things and
// nothing more:
//   1. Wraps BOTH the DOM HUD and the <Canvas> tree in <Provider store={daHilgStore}>
//      so they read/write one shared Jotai store (HUD via hooks, sim imperatively).
//   2. Mounts the DOM HUD (which owns the LoadingVeil / LockOverlay via atoms).
//   3. Wraps the Canvas in drei <KeyboardControls map={keyMap}> and installs the
//      pointer-lock + edge-key input hooks.
//
// Per-frame work lives entirely in <GameSystems> (inside <Scene>); this component
// is pure composition. No StrictMode anywhere up the tree (main.jsx).

import { Suspense, useEffect } from 'react';
import { Provider, useAtomValue } from 'jotai';
import { Canvas } from '@react-three/fiber';
import { KeyboardControls } from '@react-three/drei';
import * as THREE from 'three';

import { daHilgStore } from './state/store.js';
import { perfModeAtom } from './state/settingsAtoms.js';
import { deviceTier } from './state/deviceTier.js';
import { CAM_FOV, FP_NEAR, CAM_FAR, LEVEL_URL, CHARACTER_URL } from './constants.js';
import { DaHilgPreloader } from './loaders.js';
import { keyMap } from './input/keyMap.js';
import { usePointerLock } from './input/usePointerLock.js';
import { useEdgeKeys } from './input/useEdgeKeys.js';
import { useLevelMeta } from './level/levelMeta.js';
import { initNibblers } from './nibblers/index.js';

import SceneEnv from './scene/SceneEnv.jsx';
import Scene from './scene/Scene.jsx';
import PostFX from './scene/PostFX.jsx';
import { renderState } from './scene/RenderLoop.jsx';
import DaHilgHud from './hud/DaHilgHud.jsx';

/**
 * Wire WebGL context-loss recovery on the live renderer's canvas. iOS reclaims the GPU
 * on backgrounding / memory pressure / thermal events; without this the canvas goes
 * permanently black (RenderLoop would render on a dead context and throw). We
 * preventDefault the loss so the browser can restore, skip rendering while lost, and
 * clear the flag on restore (three re-initializes its GL state automatically).
 */
function onCanvasCreated({ gl }) {
  const canvas = gl.domElement;
  canvas.addEventListener(
    'webglcontextlost',
    (e) => {
      e.preventDefault();
      renderState.contextLost = true;
    },
    false,
  );
  canvas.addEventListener(
    'webglcontextrestored',
    () => {
      renderState.contextLost = false;
    },
    false,
  );
}

// Stable list of the KTX2-bearing GLBs to warm once the renderer is live.
const PRELOAD_URLS = [LEVEL_URL, ...Object.values(CHARACTER_URL)];

/**
 * Input hooks live in their own tiny component so they sit *inside* the Provider
 * (they read/write the shared store) but *outside* the Canvas (they bind window
 * listeners and own the pointer-lock lifecycle, not the R3F render loop).
 */
function InputLayer() {
  usePointerLock();
  useEdgeKeys();
  return null;
}

/**
 * Mounts the post-processing composer ONLY when performance mode is off. In perf mode
 * (the default) PostFX is absent, so RenderLoop falls back to a plain gl.render and we
 * skip the bloom/AO/SMAA passes entirely. Lives inside the Canvas (and the Provider) so
 * it can read the atom; toggling it cleanly mounts/unmounts the composer.
 */
function PostFXGate() {
  const perfMode = useAtomValue(perfModeAtom);
  return perfMode ? null : <PostFX />;
}

export default function DaHilgApp() {
  // Kick off the level-metadata fetch once. It populates the plain refs.levelMeta
  // singleton (offset/groundY/spawns), which unblocks the registry build, zone
  // placement, and the physics unpause. Side-effect only; the ref is read directly.
  useLevelMeta();

  // Reset the nibbler swarm to a clean state on mount (fresh load / HMR).
  useEffect(() => {
    initNibblers();
  }, []);

  return (
    <Provider store={daHilgStore}>
      {/* DOM HUD overlay — owns the loading veil / lock overlay via atoms. */}
      <DaHilgHud />

      {/* Desktop pointer-lock + edge-key verbs (Tab/V/E/1-3/Esc). */}
      <InputLayer />

      {/* Held movement keys are read transiently inside the sim via getKeys(). */}
      <KeyboardControls map={keyMap}>
        <Canvas
          shadows={{ type: THREE.PCFShadowMap }}
          dpr={[1, deviceTier.dprMax]}
          gl={{ powerPreference: 'high-performance', stencil: false }}
          onCreated={onCanvasCreated}
          camera={{ fov: CAM_FOV, near: FP_NEAR, far: CAM_FAR, position: [0, 1.6, 6] }}
        >
          <SceneEnv />
          {/* Warm the KTX2 level + character GLBs now the renderer exists. */}
          <DaHilgPreloader urls={PRELOAD_URLS} />
          <Suspense fallback={null}>
            <Scene />
          </Suspense>
          {/* Post-processing composer (only when performance mode is off). Mounts after
              the scene; publishes a composer that RenderLoop drives as the SOLE
              priority-100 render (composited). In perf mode RenderLoop plain-renders. */}
          <PostFXGate />
        </Canvas>
      </KeyboardControls>
    </Provider>
  );
}
