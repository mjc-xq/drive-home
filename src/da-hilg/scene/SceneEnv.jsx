// SceneEnv — the sky + lighting for Da Hilg. A genuinely BLUE gradient sky dome (a
// camera-following shader sphere, so it reads deep blue at the zenith → pale blue at
// the horizon regardless of view angle), the user's 3D sun model parked in the sky at
// the sun direction, a strong sun key light with shadows, a low cool fill, a gentle
// hemisphere, and ACES tone mapping. Offline-safe by design (no CDN / HDR download).

import { useThree, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, Suspense } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { useAtomValue } from 'jotai';
import { cameraRig } from '../state/refs.js';
import { perfModeAtom } from '../state/settingsAtoms.js';
import { deviceTier } from '../state/deviceTier.js';

// Sun direction for the KEY LIGHT (drives shadow angle + highlight alignment).
// Kept as-is so the carefully-tuned directional-light shadows don't shift.
const SUN_DIR = [90, 70, 50];
// Sun direction for the VISIBLE 3D model — DECOUPLED from the light so we can park
// the friendly sun where players actually look without moving the shadows. The
// camera looks toward -Z at spawn (yaw 0 → forward = -Z), so the old SUN_DIR put the
// model ~120° to the right and 34° up: technically in the sky, but never in the
// forward view, which is why it felt "missing". This points it forward-and-up
// (-Z forward, +Y up, a touch right) at ~28° elevation so it sits plainly in the
// upper-forward sky the moment you look ahead.
const SUN_MODEL_DIR = [28, 50, -85];
const FOG_COLOR = '#cfe2fb'; // matches the blue horizon so distance blends
const SUN_URL = '/da-hilg/sun3d.glb';
const SUN_DISTANCE = 320; // inside CAM_FAR (600); the model tracks the camera
const SUN_SCALE = 64; // world units — big & friendly (~17° across at this distance)

// ── Blue gradient sky dome ────────────────────────────────────────────────────────
// A camera-following BackSide sphere with a zenith→horizon blue gradient. depthTest/
// Write off + renderOrder -1000 makes it the background; everything draws over it.
const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  void main() {
    float t = pow(clamp(vDir.y * 1.15, 0.0, 1.0), 0.55);
    gl_FragColor = vec4(mix(uHorizon, uZenith, t), 1.0);
  }
`;

function GradientSky() {
  const ref = useRef(null);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uZenith: { value: new THREE.Color('#1f6fe0') },
          uHorizon: { value: new THREE.Color('#cfe2fb') },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }),
    [],
  );
  useFrame(({ camera }) => {
    if (ref.current) ref.current.position.copy(camera.position);
  });
  return (
    <mesh ref={ref} material={material} renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[12, 24, 16]} />
    </mesh>
  );
}

// ── The 3D sun model ──────────────────────────────────────────────────────────────
// Loaded from the user's sun.glb, parked far along SUN_DIR (camera-following so it
// sits at "infinity"), made emissive so it glows, and slowly spinning for life.
function SunModel() {
  const gltf = useGLTF(SUN_URL);
  const ref = useRef(null);
  // Park the visible sun along SUN_MODEL_DIR (forward-and-up), NOT the light's SUN_DIR.
  const ndir = useMemo(() => new THREE.Vector3(...SUN_MODEL_DIR).normalize(), []);
  const scene = useMemo(() => {
    const s = gltf.scene.clone(true);
    s.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        // The baked sun texture is a noisy, low-sample bake squashed to 512px — it read as a
        // SPLOTCHY sun. A sun looks better as a clean, smooth, self-lit disc, so drop every
        // baked map and glow off a flat warm colour instead. The geometry still gives the
        // sun/ray silhouette; only the blotchy surface detail goes away.
        m.map = null;
        if ('emissiveMap' in m) m.emissiveMap = null;
        if ('normalMap' in m) m.normalMap = null;
        if ('roughnessMap' in m) m.roughnessMap = null;
        if ('metalnessMap' in m) m.metalnessMap = null;
        if ('aoMap' in m) m.aoMap = null;
        if (m.color) m.color.set('#ffd86b');
        if (m.emissive) {
          m.emissive.set('#ffcf5a');
          m.emissiveIntensity = 1.8;
        }
        m.toneMapped = false;
        m.fog = false;
        m.depthWrite = false;
        m.needsUpdate = true;
      }
    });
    return s;
  }, [gltf]);

  useFrame(({ camera }, dt) => {
    const g = ref.current;
    if (!g) return;
    g.position.copy(camera.position).addScaledVector(ndir, SUN_DISTANCE);
    g.rotation.y += dt * 0.15; // slow spin
  });

  return (
    <group ref={ref} scale={SUN_SCALE} renderOrder={-999}>
      <primitive object={scene} />
    </group>
  );
}

export default function SceneEnv() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const perfMode = useAtomValue(perfModeAtom);

  // Performance mode skips the sun shadow pass entirely (~5 ms/frame). Toggling the
  // shadow map on/off changes material programs, so force a one-time recompile of the
  // scene materials when it flips (rare, user-initiated). Defaults to perf ON → off.
  useEffect(() => {
    gl.shadowMap.enabled = !perfMode;
    gl.shadowMap.needsUpdate = true;
    scene.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) m.needsUpdate = true;
    });
  }, [gl, scene, perfMode]);

  // DEV-only inspection handle (stripped from production). Handy in playtesting.
  useEffect(() => {
    if (import.meta.env && import.meta.env.DEV) {
      window.__dh = { gl, scene, camera, cameraRig };
    }
  }, [gl, scene, camera]);

  // ACES filmic tone mapping. PostFX, when mounted, switches the RENDERER to
  // NoToneMapping and applies ACES ONCE at the end of its effect chain (so the look
  // is identical but not double-applied). This stays as the source of truth / the
  // fallback when PostFX is absent. Exposure 1.05 gives the sunny look a touch more
  // lift without clipping facades.
  useEffect(() => {
    const prevTone = gl.toneMapping;
    const prevExp = gl.toneMappingExposure;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.12;
    return () => {
      gl.toneMapping = prevTone;
      gl.toneMappingExposure = prevExp;
    };
  }, [gl]);

  return (
    <>
      {/* Blue gradient sky + the 3D sun (both offline, no download). */}
      <GradientSky />
      <Suspense fallback={null}>
        <SunModel />
      </Suspense>

      {/* Distance fog — only the far property edges haze, sky-matched. */}
      <fog attach="fog" args={[FOG_COLOR, 260, 580]} />

      {/* Sky/ground bounce — warm-blue sky over a sun-warmed ground. Lifted from 0.34
          so shadowed faces and the undersides of characters keep real fill (the AO
          pass re-darkens crevices, so this can be generous without going flat). */}
      {/* Near-neutral sky bounce: the strongly-blue sky tint (#cfe1ff) was washing the
          up-facing aerial terrain teal. A warmer-neutral sky lets the ground read as its
          real satellite colour while still giving fill. */}
      <hemisphereLight args={['#e8ece6', '#6b6346', 0.5]} />

      {/* The sun: strong warm key with crisp shadows — gives form to the neighborhood
          and the characters. Brighter (3.2) and a hair warmer for a midday-sun read.
          three 0.184 dropped PCFSoftShadowMap (it falls back to PCF anyway), and the
          soft VSM path costs ~20 ms/frame here (the whole static neighborhood blurred
          every frame → ~35 fps), so the Canvas uses PCFShadowMap: a large 4k map keeps
          the hard sun shadows fine-edged at ~58 fps. shadow.radius is a no-op on PCF. */}
      <directionalLight
        position={SUN_DIR}
        intensity={3.2}
        color="#fff1d6"
        castShadow
        shadow-mapSize-width={deviceTier.shadowSize}
        shadow-mapSize-height={deviceTier.shadowSize}
        shadow-camera-near={1}
        shadow-camera-far={400}
        shadow-camera-left={-150}
        shadow-camera-right={150}
        shadow-camera-top={150}
        shadow-camera-bottom={-150}
        shadow-bias={-0.00025}
        shadow-normalBias={0.045}
      />

      {/* Cool sky fill from the opposite side so shadowed faces keep shape and a
          believable cool bounce. Up from 0.55 → 0.8 so back/shadow faces of the
          characters read instead of going muddy. */}
      <directionalLight position={[-70, 45, -40]} intensity={0.55} color="#c6d0dc" />

      {/* Character key-flatter: a gentle, low warm fill aimed roughly down the sunny
          side, kept soft so it lifts the skinned characters (who otherwise read
          underlit against the bright env) without blowing them out or casting a
          second shadow. No shadow, low intensity, generous falloff via distance. */}
      <directionalLight position={[40, 30, 60]} intensity={0.45} color="#fff4e6" />

      {/* Minimal ambient so deep shadows aren't crushed to pure black. Slightly up
          (0.12 → 0.16) now that AO restores contact darkness in the composited pass. */}
      <ambientLight intensity={0.22} />
    </>
  );
}

useGLTF.preload(SUN_URL);
