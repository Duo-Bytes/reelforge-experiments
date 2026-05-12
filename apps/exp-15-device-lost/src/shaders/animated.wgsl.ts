// Animated full-screen quad colored by a uniform time. Simple enough that
// the cost of re-creating it on every device loss is negligible, but still
// exercises pipeline + bind group + uniform buffer + storage buffer paths.
export const ANIMATED_WGSL = /* wgsl */ `
struct Uniforms {
  time: f32,
  hue: f32,
  recoveries: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> palette: array<vec4f>;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 6>(
    vec2f(-1.0,  1.0), vec2f(-1.0, -1.0), vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  var u2 = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
  );
  var o: VsOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = u2[vi];
  return o;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let t = u.time;
  let cx = 0.5 + 0.4 * cos(t * 0.7);
  let cy = 0.5 + 0.4 * sin(t * 0.9);
  let d = distance(in.uv, vec2f(cx, cy));
  let band = 0.5 + 0.5 * cos(d * 30.0 - t * 4.0);
  // Pick a palette slot from the storage buffer to prove that buffer was
  // re-created and re-uploaded after recovery.
  let idx = u32(in.uv.x * 4.0);
  let base = palette[idx];
  let g = vec4f(band, band * 0.6, 1.0 - band, 1.0);
  return mix(base, g, 0.6);
}
`;
