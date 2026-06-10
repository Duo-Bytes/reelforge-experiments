// WGSL shaders for the LUT demo.
//
// The vertex stage emits a single fullscreen triangle with a uv in [0,1]^2.
// The fragment stage builds a procedural ramp from uv, optionally encodes
// to sRGB, samples the LUT, optionally decodes from sRGB, and lerps
// against the un-graded source by `strength`.
//
// Split-screen: uv.x < 0.5 shows the raw source, uv.x >= 0.5 shows the
// LUT-applied output. The 0.5 column draws a thin divider.

export const FULLSCREEN_VS = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  // Fullscreen triangle covering the viewport.
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  let xy = p[vi];
  var out: VsOut;
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  // uv is 0..1 across the visible quad. y is flipped so 0 is at the top.
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
  return out;
}
`;

export const LUT_FS = /* wgsl */ `
struct Params {
  strength: f32,        // 0..1 mix between source and graded
  applyInLinear: f32,   // 1.0 = decode sRGB before sample, encode after; 0.0 = sample in encoded space
  lutSize: f32,         // N. Used to clamp into the half-texel margin.
  _pad: f32,
  // DOMAIN_MIN / DOMAIN_MAX from the .cube header. The input colour is
  // remapped into [0,1]^3 by (rgb - domainMin)/(domainMax - domainMin)
  // before the texture lookup. Stored as vec4 (xyz used, w padding) so the
  // host can write a tightly-packed Float32Array with std140 alignment.
  domainMin: vec4<f32>,
  domainMax: vec4<f32>,
};

@group(0) @binding(0) var lutTex: texture_3d<f32>;
@group(0) @binding(1) var lutSamp: sampler;
@group(0) @binding(2) var<uniform> params: Params;

// sRGB transfer (decode) — per IEC 61966-2-1.
fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  let cutoff = step(vec3<f32>(0.04045), c);
  let low = c / 12.92;
  let high = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
  return mix(low, high, cutoff);
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  let cc = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  let cutoff = step(vec3<f32>(0.0031308), cc);
  let low = cc * 12.92;
  let high = 1.055 * pow(cc, vec3<f32>(1.0 / 2.4)) - 0.055;
  return mix(low, high, cutoff);
}

// Procedural reference ramp. We want every primary + greyscale covered.
fn rampColor(uv: vec2<f32>) -> vec3<f32> {
  // Top half: hue sweep at full saturation.
  // Bottom half: greyscale + R/G/B bars.
  let band = floor(uv.y * 4.0);
  if (band < 1.0) {
    // Hue sweep.
    let h = uv.x;
    let c = vec3<f32>(
      abs(fract(h + 0.0) * 6.0 - 3.0) - 1.0,
      abs(fract(h + 2.0 / 3.0) * 6.0 - 3.0) - 1.0,
      abs(fract(h + 1.0 / 3.0) * 6.0 - 3.0) - 1.0,
    );
    return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  } else if (band < 2.0) {
    return vec3<f32>(uv.x);   // greyscale
  } else if (band < 3.0) {
    return vec3<f32>(uv.x, 0.0, 0.0);
  } else {
    if (uv.x < 0.5) {
      return vec3<f32>(0.0, (uv.x * 2.0), 0.0);
    } else {
      return vec3<f32>(0.0, 0.0, (uv.x - 0.5) * 2.0);
    }
  }
}

// Remap an input colour into [0,1] cubed LUT space using the .cube domain.
// Mirrors the pure TS helper domainNormalize in lib/cube.ts. A zero-width
// axis collapses to 0 instead of producing NaN.
fn domainNormalize(rgb: vec3<f32>) -> vec3<f32> {
  let span = params.domainMax.xyz - params.domainMin.xyz;
  let safeSpan = select(span, vec3<f32>(1.0), span == vec3<f32>(0.0));
  let uvw = (rgb - params.domainMin.xyz) / safeSpan;
  // A genuinely zero-width axis maps everything to 0.
  return select(uvw, vec3<f32>(0.0), span == vec3<f32>(0.0));
}

fn applyLut(rgb: vec3<f32>) -> vec3<f32> {
  // First remap the input through the LUT's DOMAIN_MIN/MAX into [0,1]^3,
  // then sample. Texture filtering already clamps to edge.
  // We bias the coords by half a texel so we land on cell centres — this is
  // the standard fix for sampling a discretised LUT with linear filtering.
  let uvw = domainNormalize(rgb);
  let N = params.lutSize;
  let scale = (N - 1.0) / N;
  let bias = 0.5 / N;
  let c = clamp(uvw, vec3<f32>(0.0), vec3<f32>(1.0)) * scale + vec3<f32>(bias);
  return textureSampleLevel(lutTex, lutSamp, c, 0.0).rgb;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let src = rampColor(uv);

  // Decide whether to decode sRGB before LUT sampling.
  var inSpace: vec3<f32> = src;
  if (params.applyInLinear > 0.5) {
    inSpace = srgbToLinear(src);
  }
  var graded = applyLut(inSpace);
  if (params.applyInLinear > 0.5) {
    graded = linearToSrgb(graded);
  }
  let mixed = mix(src, graded, params.strength);

  // Split-screen layout.
  let isRight = step(0.5, uv.x);
  let final = mix(src, mixed, isRight);

  // Divider line at uv.x == 0.5.
  let edge = smoothstep(0.499, 0.5, uv.x) - smoothstep(0.5, 0.501, uv.x);
  let withDivider = mix(final, vec3<f32>(1.0), edge * 0.6);

  return vec4<f32>(withDivider, 1.0);
}
`;
