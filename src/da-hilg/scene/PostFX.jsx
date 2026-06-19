// PostFX — the post-processing / compositing pipeline for Da Hilg.
//
// ── Why this is hand-wired (not the <EffectComposer> drei component) ────────────────
// This game does NOT use R3F auto-render. CameraRig runs a useFrame at priority 10
// (which flips R3F into manual-render mode), and RenderLoop does the single manual
// render at priority 100 — AFTER the camera has been positioned. The drei
// <EffectComposer> installs its OWN useFrame at priority 1, which would render
// BEFORE the camera updates (one-frame lag) and would fight the priority-100 render.
//
// So instead we build a raw `postprocessing` EffectComposer here and hand it to
// RenderLoop via a shared ref. RenderLoop calls `composer.render(dt)` at priority
// 100 in place of `gl.render(scene, camera)` — exactly ONE render per frame, always
// after the camera. When PostFX is unmounted the ref clears and RenderLoop falls
// back to a plain gl.render, so the screen is never black either way.
//
// ── Tone mapping ───────────────────────────────────────────────────────────────────
// SceneEnv sets gl.toneMapping = ACESFilmic. With a composer that would double-apply
// (renderer tone-maps into the buffer, then the effect chain tone-maps again). So
// while the composer is live we switch the RENDERER to NoToneMapping and apply ACES
// ONCE at the end of the chain via ToneMappingEffect(ACES_FILMIC). The look is
// preserved; the math just moves into the composer where it belongs.

import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  SMAAEffect,
  SMAAPreset,
  BrightnessContrastEffect,
  HueSaturationEffect,
  VignetteEffect,
  ToneMappingEffect,
  ToneMappingMode,
  BlendFunction,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

// Shared handle: PostFX writes the live composer here; RenderLoop reads it and, if
// present, renders through it instead of gl.render. Plain module ref (per the
// refs-vs-atoms rule: per-frame truth is plain mutable, never React state).
export const postComposer = { current: null };

export default function PostFX() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  // Build the composer + full pass chain once. RenderPass draws the scene into the
  // composer's input buffer; N8AO grounds objects with contact shadow / AO; the final
  // EffectPass folds all screen-space effects into ONE fullscreen pass for speed.
  const composer = useMemo(() => {
    // HalfFloat buffers preserve highlight headroom so Bloom reads the actual bright
    // speculars/sun before tone mapping clamps them.
    const c = new EffectComposer(gl, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0, // SMAA handles AA; MSAA on a HalfFloat target is wasteful here.
    });
    c.addPass(new RenderPass(scene, camera));

    // ── Ambient occlusion (grounds objects, adds depth) ───────────────────────────
    // N8AO is a separate composer pass (it needs the depth/normal buffers). Tuned
    // gentle: a modest world-space radius and low-ish intensity so it reads as soft
    // contact shadow in crevices, not a dirty halo. gammaCorrection MUST be off — it
    // is a mid-chain pass, so the final ToneMappingEffect owns output color space;
    // leaving it on would gamma-encode twice and wash the AO out.
    const n8ao = new N8AOPostPass(scene, camera, size.width, size.height);
    n8ao.configuration.aoRadius = 1.6; // world units — small-object contact scale
    n8ao.configuration.distanceFalloff = 1.0;
    n8ao.configuration.intensity = 2.2; // subtle; default 5 is heavy
    n8ao.configuration.aoSamples = 16;
    n8ao.configuration.denoiseSamples = 8;
    n8ao.configuration.denoiseRadius = 12;
    n8ao.configuration.color = new THREE.Color(0x0a0c12); // cool, not pure black
    n8ao.configuration.gammaCorrection = false; // critical: not the last pass
    n8ao.configuration.halfRes = true; // big perf win, near-invisible at this strength
    c.addPass(n8ao);

    // ── Bloom (sun + bright speculars) ────────────────────────────────────────────
    // luminanceThreshold ~0.85 so only genuinely bright pixels (the emissive sun, hot
    // window/metal speculars) bloom — not the whole sunny scene. mipmapBlur gives a
    // soft, cheap, wide glow.
    const bloom = new BloomEffect({
      luminanceThreshold: 0.85,
      luminanceSmoothing: 0.25,
      mipmapBlur: true,
      intensity: 0.55, // gentle halo, not a haze
      radius: 0.7,
    });

    // ── Color grade (warm sunny push) ────────────────────────────────────────────
    // A hair of contrast for snap + a touch of brightness, then a small saturation
    // bump so the blue sky / green vegetation / warm facades pop without going garish.
    const grade = new BrightnessContrastEffect({ brightness: 0.015, contrast: 0.08 });
    const sat = new HueSaturationEffect({ hue: 0.0, saturation: 0.07 });

    // ── Vignette (soft focus pull) ────────────────────────────────────────────────
    const vignette = new VignetteEffect({
      offset: 0.32,
      darkness: 0.42,
      blendFunction: BlendFunction.NORMAL,
    });

    // ── Tone mapping (ACES, ONCE, at the end) ─────────────────────────────────────
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });

    // ── SMAA (antialiasing) LAST so it works on the final composited image ────────
    const smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });

    // One merged fullscreen pass: AO is already composited into the input buffer.
    c.addPass(new EffectPass(camera, bloom, grade, sat, vignette, tone, smaa));
    return c;
    // gl/scene/camera are stable for the app lifetime; size handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera]);

  // Keep the composer sized to the drawing buffer (size * dpr). gl.setPixelRatio is
  // owned by R3F (dpr={[1,2]}); we mirror the resulting drawing-buffer size so the
  // composed image is pixel-exact with the canvas.
  useEffect(() => {
    const dbs = gl.getDrawingBufferSize(new THREE.Vector2());
    composer.setSize(dbs.x, dbs.y);
  }, [composer, gl, size]);

  // While the composer is live, the RENDERER must NOT tone-map (the chain does ACES
  // once at the end). Save/restore so unmount returns to SceneEnv's renderer state.
  useEffect(() => {
    const prevTone = gl.toneMapping;
    gl.toneMapping = THREE.NoToneMapping;
    return () => {
      gl.toneMapping = prevTone;
    };
  }, [gl]);

  // Publish the composer for RenderLoop to drive, and dispose on unmount. RenderLoop
  // owns the single priority-100 render call; here we only register/teardown.
  useEffect(() => {
    postComposer.current = composer;
    return () => {
      if (postComposer.current === composer) postComposer.current = null;
      composer.dispose();
    };
  }, [composer]);

  return null;
}
