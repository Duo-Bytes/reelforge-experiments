/**
 * Composites an image with a soft alpha mask over a solid background color.
 *
 * Bindings:
 *   0: linear sampler
 *   1: source texture (texture_2d<f32>)
 *   2: mask texture   (texture_2d<f32>)  ← R channel is alpha
 *   3: uniform { vec4f bgColor; vec4f flags }
 *      flags.x = useMask (0/1)
 *      flags.y = showMaskOnly (0/1)
 */
export const MASK_WGSL = /* wgsl */ `
struct Uniforms {
  bgColor: vec4f,
  flags: vec4f,
};

@group(0) @binding(0) var s: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var mask: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: Uniforms;

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
  let color = textureSample(src, s, in.uv);
  let m = textureSample(mask, s, in.uv).r;
  if (u.flags.y > 0.5) {
    return vec4f(m, m, m, 1.0);
  }
  if (u.flags.x > 0.5) {
    return vec4f(mix(u.bgColor.rgb, color.rgb, m), 1.0);
  }
  return color;
}
`;
