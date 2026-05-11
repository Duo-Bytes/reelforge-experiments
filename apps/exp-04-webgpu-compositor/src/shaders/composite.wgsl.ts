// Single-shader compositor: vertex draws a full-screen quad, fragment samples
// up to two external (VideoFrame) textures and mixes them by uniform alpha.
//
// `texture_external` samples must use `textureSampleBaseClampToEdge` —
// `textureSample` is rejected by the WGSL validator for external textures.
//
// Uniform layout (16-byte aligned, std140-like):
//   topAlpha:  f32   ← 0..1 alpha of the top layer
//   useTop:    f32   ← 0 = bottom only, 1 = blend
//   _pad0/_pad1: f32 (alignment)
export const COMPOSITE_WGSL = /* wgsl */ `
struct Uniforms {
  topAlpha: f32,
  useTop: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var videoSampler: sampler;
@group(0) @binding(1) var videoTexture0: texture_external;
@group(0) @binding(2) var videoTexture1: texture_external;
@group(0) @binding(3) var<uniform> u: Uniforms;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  // Two CCW triangles covering the clip space.
  var positions = array<vec2f, 6>(
    vec2f(-1.0,  1.0), vec2f(-1.0, -1.0), vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
  );
  var out: VsOut;
  out.pos = vec4f(positions[vi], 0.0, 1.0);
  out.uv = uvs[vi];
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let bottom = textureSampleBaseClampToEdge(videoTexture0, videoSampler, in.uv);
  let top = textureSampleBaseClampToEdge(videoTexture1, videoSampler, in.uv);
  if (u.useTop > 0.5) {
    return mix(bottom, top, clamp(u.topAlpha, 0.0, 1.0));
  }
  return bottom;
}
`;
