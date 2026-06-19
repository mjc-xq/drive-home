// makeVatMaterial(assets) — a MeshStandardMaterial patched via onBeforeCompile to
// drive the entire horde's animation on the GPU from a Vertex Animation Texture.
// Every vertex is displaced by sampling uVatPos at (aVertexId, clipRow + frame);
// the normal is sampled the same way. This is the canonical
// webgl_gpgpu_birds_gltf recipe adapted to an InstancedMesh on three 0.184.
//
// Per-instance attributes (InstancedBufferAttributes the renderer adds):
//   aPhase (float) 0..1 clip cursor, aClip (float) which band, aTint (vec3) color.
// The vertex id comes from a baked float attribute `aVertexId` when
// meta.aVertexId==='attribute', else gl_VertexID (WebGL2 / GLSL3 — always available
// under R3F). The proxy here bakes _VERTEXID, so swarmGeometry aliases it to
// aVertexId and we read the attribute.
//
// CRITICAL three.js instancing detail: <begin_vertex> writes object-space
// `transformed`; three's instancing chunk multiplies by instanceMatrix AFTER, in
// <project_vertex>. So we write OBJECT space and must NOT multiply by instanceMatrix
// ourselves. Likewise objectNormal is object-space; <defaultnormal_vertex> (which
// follows <beginnormal_vertex>) applies instance/model normal matrices.

import * as THREE from 'three';

// Read the vertex id from gl_VertexID, or from the baked `aVertexId` attribute.
// swarmGeometry ALWAYS guarantees an `aVertexId` float attribute (aliasing the
// proxy's baked _VERTEXID, or synthesizing 0..N-1), so the attribute path is the
// robust default and works on any GLSL version. We only fall back to gl_VertexID
// if the meta declares it AND we trusted there were no attribute — but since the
// attribute is guaranteed, we always use it. Kept as a single decision point so a
// future attribute-less bake can flip this by reading meta.aVertexId.
function useGlVertexId(/* meta */) {
  return false; // always read the guaranteed `aVertexId` attribute
}

/**
 * Build the patched MeshStandardMaterial for the swarm.
 * @param {{posTex:THREE.Texture, nrmTex:THREE.Texture, meta:Object}} assets
 * @returns {THREE.MeshStandardMaterial}
 */
export function makeVatMaterial(assets) {
  const { posTex, nrmTex, meta } = assets;

  const material = new THREE.MeshStandardMaterial({
    roughness: 1,
    metalness: 0,
  });
  // The proxy has no useful UVs/atlas for v1 — characters differ by aTint only.

  const vertCount = meta.vertCount;
  const rows = meta.rows;
  const clips = meta.clips || {};
  const band = (name, fallbackRow) =>
    clips[name] ? clips[name].row : fallbackRow;
  const bandFrames = (name) =>
    clips[name] ? clips[name].frames : meta.frameCount || 1;

  // Clip-row table indexed by aClip (0 idle | 1 run | 2 jump | 3 emote), matching
  // the CLIP_* constants. Read starting rows + per-clip frame counts from meta.
  const clipRow = new THREE.Vector4(
    band('idle', 0),
    band('run', 0),
    band('jump', 0),
    band('emote', 0),
  );
  const clipFrames = new THREE.Vector4(
    bandFrames('idle'),
    bandFrames('run'),
    bandFrames('jump'),
    bandFrames('emote'),
  );

  const posMin = meta.posMin || [0, 0, 0];
  const posMax = meta.posMax || [1, 1, 1];
  const nrmMin = meta.nrmMin || [-1, -1, -1];
  const nrmMax = meta.nrmMax || [1, 1, 1];

  const glVid = useGlVertexId(meta);

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uVatPos = { value: posTex };
    shader.uniforms.uVatNrm = { value: nrmTex };
    shader.uniforms.uRows = { value: rows };
    shader.uniforms.uVertCount = { value: vertCount };
    shader.uniforms.uPosMin = { value: new THREE.Vector3().fromArray(posMin) };
    shader.uniforms.uPosMax = { value: new THREE.Vector3().fromArray(posMax) };
    shader.uniforms.uNrmMin = { value: new THREE.Vector3().fromArray(nrmMin) };
    shader.uniforms.uNrmMax = { value: new THREE.Vector3().fromArray(nrmMax) };
    shader.uniforms.uClipRow = { value: clipRow };
    shader.uniforms.uClipFrames = { value: clipFrames };

    // The vertex id source: a baked attribute or gl_VertexID.
    const vidDecl = glVid
      ? 'float vatVid = float(gl_VertexID);'
      : 'attribute float aVertexId;';
    const vidExpr = glVid ? 'vatVid' : 'aVertexId';

    // ── Vertex header: instanced attrs + VAT uniforms + a tint varying ──────
    shader.vertexShader = shader.vertexShader.replace(
      '#define STANDARD',
      /* glsl */ `#define STANDARD
        attribute float aPhase;
        attribute float aClip;
        attribute vec3  aTint;
        ${glVid ? '' : vidDecl}
        uniform sampler2D uVatPos;
        uniform sampler2D uVatNrm;
        uniform float uRows;
        uniform float uVertCount;
        uniform vec3  uPosMin;
        uniform vec3  uPosMax;
        uniform vec3  uNrmMin;
        uniform vec3  uNrmMax;
        uniform vec4  uClipRow;
        uniform vec4  uClipFrames;
        varying vec3  vTint;

        // Pick the clip band's starting row + frame count by aClip (0..3).
        float nibClipRow(float c) {
          if (c < 0.5) return uClipRow.x;
          if (c < 1.5) return uClipRow.y;
          if (c < 2.5) return uClipRow.z;
          return uClipRow.w;
        }
        float nibClipFrames(float c) {
          if (c < 0.5) return uClipFrames.x;
          if (c < 1.5) return uClipFrames.y;
          if (c < 2.5) return uClipFrames.z;
          return uClipFrames.w;
        }`,
    );

    // ── begin_vertex: sample VAT position → object-space `transformed` ──────
    // Keep the stock chunk first (so USE_ALPHAHASH's vPosition still works), then
    // overwrite `transformed`. DO NOT multiply by instanceMatrix — the instancing
    // chunk does that downstream.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
        ${glVid ? vidDecl : ''}
        float nibU = (${vidExpr} + 0.5) / uVertCount;
        float nibCr = nibClipRow(aClip);
        float nibCf = nibClipFrames(aClip);
        float nibFrame = nibCr + floor(aPhase * nibCf);
        float nibV = (nibFrame + 0.5) / uRows;
        vec3 nibPosSample = texture2D(uVatPos, vec2(nibU, nibV)).xyz;
        transformed = mix(uPosMin, uPosMax, nibPosSample);
        vTint = aTint;`,
    );

    // ── beginnormal_vertex: sample VAT normal → object-space objectNormal ────
    // Same (u,v); unpack to -1..1 via the normal bounds. <defaultnormal_vertex>
    // (which follows) applies the normal/instance matrices.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      /* glsl */ `#include <beginnormal_vertex>
        ${glVid ? vidDecl : ''}
        float nibNU = (${vidExpr} + 0.5) / uVertCount;
        float nibNCr = nibClipRow(aClip);
        float nibNCf = nibClipFrames(aClip);
        float nibNFrame = nibNCr + floor(aPhase * nibNCf);
        float nibNV = (nibNFrame + 0.5) / uRows;
        vec3 nibNrmSample = texture2D(uVatNrm, vec2(nibNU, nibNV)).xyz;
        objectNormal = normalize(mix(uNrmMin, uNrmMax, nibNrmSample));`,
    );

    // ── fragment: tint the diffuse by the per-instance color ────────────────
    shader.fragmentShader = shader.fragmentShader.replace(
      '#define STANDARD',
      '#define STANDARD\nvarying vec3 vTint;',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n\tdiffuseColor.rgb *= vTint;',
    );
  };

  // One program for the whole horde regardless of per-instance data.
  material.customProgramCacheKey = () => 'nibblerVAT';

  return material;
}
