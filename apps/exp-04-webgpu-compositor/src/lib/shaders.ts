/**
 * Combined WGSL: full-screen quad vertex shader + two-layer external-texture
 * compositor fragment shader.
 *
 * The fragment shader samples two `texture_external` bindings (the second may
 * be the same texture if only one layer is active — its alpha is gated by a
 * uniform). Output is straight-alpha over the clear color.
 */
export const COMPOSITOR_WGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  // Two triangles covering the entire clip space, with matching UVs.
  // Using arrays here so we don't need a vertex buffer.
  var positions = array<vec2f, 6>(
    vec2f(-1.0,  1.0), vec2f(-1.0, -1.0), vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
  );
  var out: VSOut;
  out.position = vec4f(positions[vi], 0.0, 1.0);
  out.uv = uvs[vi];
  return out;
}

struct Mix {
  /** alpha applied to top layer */
  topAlpha: f32,
  /** 1.0 if a top layer is present, 0.0 otherwise */
  hasTop: f32,
  /** packed: scale of the top quad relative to the canvas */
  topScale: f32,
  _pad0: f32,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex0: texture_external;
@group(0) @binding(2) var tex1: texture_external;
@group(0) @binding(3) var<uniform> mix_uniform: Mix;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let base = textureSampleBaseClampToEdge(tex0, samp, in.uv);
  if (mix_uniform.hasTop < 0.5) {
    return base;
  }
  // Top layer is rendered scaled in the upper-right quadrant of the canvas
  // (a picture-in-picture style layout) using the topScale uniform.
  let s = mix_uniform.topScale;
  let pip = (in.uv - vec2f(1.0 - s, 0.0)) / s;
  let inPip = pip.x >= 0.0 && pip.x <= 1.0 && pip.y >= 0.0 && pip.y <= 1.0;
  if (!inPip) {
    return base;
  }
  let top = textureSampleBaseClampToEdge(tex1, samp, pip);
  let outA = top.a * mix_uniform.topAlpha;
  return vec4f(mix(base.rgb, top.rgb, outA), 1.0);
}
`
