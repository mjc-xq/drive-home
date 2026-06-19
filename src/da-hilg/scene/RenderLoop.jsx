// RenderLoop — the manual render pass.
//
// R3F renders the scene automatically ONLY while no useFrame uses a numeric
// priority. Our CameraRig runs at priority 10 (so it positions the camera after
// the sim), which switches R3F into manual-render mode and makes rendering OUR
// responsibility. This component does exactly that, at the highest priority, so
// it runs after the sim (default priority 0) and the camera (priority 10).

import { useFrame } from '@react-three/fiber';

export default function RenderLoop() {
  useFrame(({ gl, scene, camera }) => {
    gl.render(scene, camera);
  }, 100);
  return null;
}
