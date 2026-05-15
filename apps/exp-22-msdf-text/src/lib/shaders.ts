// WGSL shaders for the MSDF / SDF text demo.
//
// We feed the GPU one quad per glyph. Each instance stores:
//   - pixel-space quad rect (x0,y0,x1,y1) relative to the layout origin
//   - atlas UV rect (u0,v0,u1,v1)
//
// The vertex shader uses @builtin(vertex_index) to pick a corner of the
// quad. The fragment shader samples the SDF, takes fwidth(dist) to get a
// per-pixel filter width, then smoothsteps around the 0.5 isovalue.

export const TEXT_VS = /* wgsl */ `
struct Uniforms {
  // 2x3 affine matrix packed as two vec4<f32>:
  //   [a, c, tx,  b]      -> mat = | a c tx |
  //   [d, ty, _, _]                 | b d ty |
  m0: vec4<f32>,
  m1: vec4<f32>,
  viewport: vec2<f32>,
  _pad: vec2<f32>,
};

struct InstanceIn {
  @location(0) quad: vec4<f32>,   // x0, y0, x1, y1 in pixel-space
  @location(1) uvr:  vec4<f32>,   // u0, v0, u1, v1
};

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  inst: InstanceIn,
) -> VsOut {
  // Corner table: 0,1,2 then 2,1,3 — two triangles per quad. We use 6
  // vertices per instance via vertexCount=6.
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
  );
  let c = corners[vi];

  let x = mix(inst.quad.x, inst.quad.z, c.x);
  let y = mix(inst.quad.y, inst.quad.w, c.y);
  let px = vec2<f32>(x, y);

  // Apply 2x3 affine: [a c tx; b d ty]
  let a = u.m0.x; let bb = u.m0.w;
  let cc = u.m0.y; let d = u.m1.x;
  let tx = u.m0.z; let ty = u.m1.y;
  let world = vec2<f32>(a * px.x + cc * px.y + tx, bb * px.x + d * px.y + ty);

  // Map pixel space to clip space.
  let ndc = vec2<f32>(
    (world.x / u.viewport.x) * 2.0 - 1.0,
    1.0 - (world.y / u.viewport.y) * 2.0,
  );

  var o: VsOut;
  o.pos = vec4<f32>(ndc, 0.0, 1.0);
  o.uv = vec2<f32>(mix(inst.uvr.x, inst.uvr.z, c.x), mix(inst.uvr.y, inst.uvr.w, c.y));
  return o;
}
`;

export const TEXT_FS = /* wgsl */ `
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let d = textureSample(atlas, samp, uv).r;
  // fwidth() gives screen-space rate of change of d. At larger zoom, d
  // changes more slowly per pixel — smoothstep width shrinks accordingly
  // so the edge stays a single-pixel-wide ramp.
  let w = max(fwidth(d), 0.0001);
  let alpha = smoothstep(0.5 - w, 0.5 + w, d);
  // White text on transparent — main app blends over a backdrop.
  return vec4<f32>(vec3<f32>(1.0), alpha);
}
`;

// Debug shader that renders the atlas directly as greyscale.
export const ATLAS_VIEW_VS = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );
  let xy = p[vi];
  var o: VsOut;
  o.pos = vec4<f32>(xy, 0.0, 1.0);
  o.uv = vec2<f32>((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
  return o;
}
`;

export const ATLAS_VIEW_FS = /* wgsl */ `
@group(0) @binding(0) var atlas: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let d = textureSample(atlas, samp, uv).r;
  return vec4<f32>(d, d, d, 1.0);
}
`;
