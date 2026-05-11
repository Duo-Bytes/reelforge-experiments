/**
 * Renders a cached frame from a `texture_2d<f32>` (RGBA8 stored in VRAM).
 * Distinct from exp-04's external-texture pipeline because cached frames are
 * normal sampled textures — `textureSampleBaseClampToEdge` is only valid on
 * `texture_external`.
 */
export const CACHED_WGSL = /* wgsl */ `
@group(0) @binding(0) var s: sampler;
@group(0) @binding(1) var t: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
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
  return textureSample(t, s, in.uv);
}
`;
