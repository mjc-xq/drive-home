const SEE_THROUGH_FRAGMENT_PARS = `
uniform float dahillSeeThroughOpacity;

float dahillSeeThroughBayer4(vec2 p) {
  vec2 q = floor(mod(p, 4.0));
  float x = q.x;
  float y = q.y;
  float v = 0.0;
  if (y < 0.5) {
    if (x < 0.5) v = 0.0;
    else if (x < 1.5) v = 8.0;
    else if (x < 2.5) v = 2.0;
    else v = 10.0;
  } else if (y < 1.5) {
    if (x < 0.5) v = 12.0;
    else if (x < 1.5) v = 4.0;
    else if (x < 2.5) v = 14.0;
    else v = 6.0;
  } else if (y < 2.5) {
    if (x < 0.5) v = 3.0;
    else if (x < 1.5) v = 11.0;
    else if (x < 2.5) v = 1.0;
    else v = 9.0;
  } else {
    if (x < 0.5) v = 15.0;
    else if (x < 1.5) v = 7.0;
    else if (x < 2.5) v = 13.0;
    else v = 5.0;
  }
  return (v + 0.5) / 16.0;
}

void dahillApplySeeThrough() {
  if (dahillSeeThroughOpacity >= 0.999) return;
  if (dahillSeeThroughBayer4(gl_FragCoord.xy) > dahillSeeThroughOpacity) discard;
}
`;

function patchMaterial(source) {
  if (!source) return source;
  const material = source.clone();
  const opacity = { value: 1 };
  material.userData.dahillSeeThroughOpacity = opacity;
  material.onBeforeCompile = shader => {
    shader.uniforms.dahillSeeThroughOpacity = opacity;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SEE_THROUGH_FRAGMENT_PARS}`)
      .replace('#include <alphatest_fragment>', 'dahillApplySeeThrough();\n#include <alphatest_fragment>');
  };
  material.customProgramCacheKey = () => 'dahill-see-through-v1';
  return material;
}

export function createSeeThrough({ minOpacity = 0.12, fadeOut = 18, fadeIn = 10 } = {}) {
  const active = new Set();

  function ensure(mesh) {
    if (!mesh || mesh.userData.dahillSeeThrough) return mesh && mesh.userData.dahillSeeThrough;
    const isArray = Array.isArray(mesh.material);
    const source = isArray ? mesh.material : [mesh.material];
    const materials = source.map(patchMaterial);
    mesh.material = isArray ? materials : materials[0];
    const state = { opacity: 1, target: 1, materials };
    mesh.userData.dahillSeeThrough = state;
    return state;
  }

  function beginSample(occluders) {
    for (const mesh of active) {
      const state = mesh.userData.dahillSeeThrough;
      if (state) state.target = 1;
    }
    if (occluders) {
      for (const mesh of occluders) if (mesh && !mesh.userData.permaHidden) mesh.visible = true;
    }
  }

  function fade(mesh) {
    if (!mesh || mesh.userData.permaHidden) return;
    const state = ensure(mesh);
    if (!state) return;
    mesh.visible = true;
    state.target = minOpacity;
    active.add(mesh);
  }

  function update(dt) {
    const done = [];
    for (const mesh of active) {
      const state = mesh.userData.dahillSeeThrough;
      if (!state) { done.push(mesh); continue; }
      const speed = state.target < state.opacity ? fadeOut : fadeIn;
      const a = dt > 0 ? 1 - Math.exp(-dt * speed) : 1;
      state.opacity += (state.target - state.opacity) * a;
      if (Math.abs(state.opacity - state.target) < 0.003) state.opacity = state.target;
      for (const mat of state.materials) {
        const uniform = mat && mat.userData && mat.userData.dahillSeeThroughOpacity;
        if (uniform) uniform.value = state.opacity;
      }
      if (state.target >= 1 && state.opacity >= 0.999) done.push(mesh);
    }
    for (const mesh of done) active.delete(mesh);
  }

  function occludedCount() {
    let n = 0;
    for (const mesh of active) {
      const state = mesh.userData.dahillSeeThrough;
      if (state && state.target < 1) n++;
    }
    return n;
  }

  return { beginSample, fade, update, occludedCount };
}
