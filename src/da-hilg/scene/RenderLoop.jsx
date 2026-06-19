// RenderLoop — the manual render pass (the SINGLE render site).
//
// R3F renders the scene automatically ONLY while no useFrame uses a numeric
// priority. Our CameraRig runs at priority 10 (so it positions the camera after
// the sim), which switches R3F into manual-render mode and makes rendering OUR
// responsibility. This component does exactly that, at the highest priority, so
// it runs after the sim (default priority 0) and the camera (priority 10).
//
// Post-processing: when <PostFX> is mounted it publishes a live `postComposer`.
// If present we render THROUGH it (composer.render(dt) draws RenderPass(scene,
// camera) + the effect chain straight to the canvas) instead of gl.render. This
// is the same single priority-100 render call — just composited — so there is
// always EXACTLY one render per frame and the screen is never black, whether or
// not PostFX is mounted.

import { useFrame } from '@react-three/fiber';
import { postComposer } from './PostFX.jsx';

// Shared render flag. iOS Safari drops the WebGL context on backgrounding / memory
// pressure / thermal throttling; rendering on a lost context throws and leaves the
// canvas permanently black. DaHilgApp's onCreated wires webglcontextlost/restored to
// flip this, and we simply skip the render while lost — three re-initializes its GL
// state on 'webglcontextrestored' (we preventDefault the loss to allow that), so the
// screen recovers on its own instead of staying black until a full reload.
export const renderState = { contextLost: false };

export default function RenderLoop() {
  useFrame(({ gl, scene, camera }, dt) => {
    if (renderState.contextLost) return;
    const composer = postComposer.current;
    if (composer) composer.render(dt);
    else gl.render(scene, camera);
  }, 100);
  return null;
}
