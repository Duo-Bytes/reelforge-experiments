// Color-managed compositor.
//
// Pipeline per layer:
//   sample(texture_external) -> already in the source's RGB space (decoder
//   applied YCbCr->RGB), but still encoded with its native transfer function
//   (sRGB, BT.1886, PQ, HLG). We:
//     1. Apply inverse EOTF -> scene-linear RGB in source primaries
//     2. Multiply by primaries-matrix -> scene-linear RGB in target primaries
//     3. Tone-map if source peak > target peak (HDR->SDR)
//     4. Apply target OETF -> encoded RGB for output
//
// Uniform layout (std140, 64 bytes):
//   layerTransfer:    u32 array of 2 (bottom, top)        [16 bytes]
//   layerPrimaries:   u32 array of 2                       [16 bytes]
//   targetTransfer:   u32                                   [ 4 bytes]
//   targetPrimaries:  u32                                   [ 4 bytes]
//   toneMap:          u32                                   [ 4 bytes]
//   useTop:           u32                                   [ 4 bytes]
//   topAlpha:         f32                                   [ 4 bytes]
//   sourcePeakNits:   f32                                   [ 4 bytes]
//   targetPeakNits:   f32                                   [ 4 bytes]
//   _pad:             f32                                   [ 4 bytes]
//
// Transfer codes: 0 srgb, 1 bt709, 2 pq, 3 hlg, 4 linear
// Primaries:     0 bt709, 1 p3, 2 bt2020
export const COLOR_WGSL = /* wgsl */ `
struct Uniforms {
  layerTransfer: vec4u,     // x,y = bottom,top transfer codes
  layerPrimaries: vec4u,    // x,y = bottom,top primaries codes
  targetTransfer: u32,
  targetPrimaries: u32,
  toneMap: u32,             // 0 none, 1 reinhard, 2 hable
  useTop: u32,
  topAlpha: f32,
  sourcePeakNits: f32,
  targetPeakNits: f32,
  _pad: f32,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var bottomTex: texture_external;
@group(0) @binding(2) var topTex: texture_external;
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
  var o: VsOut;
  o.pos = vec4f(positions[vi], 0.0, 1.0);
  o.uv = uvs[vi];
  return o;
}

// --- Inverse EOTFs (encoded -> linear) ---

fn srgb_to_linear(c: vec3f) -> vec3f {
  let cutoff = step(vec3f(0.04045), c);
  let low = c / 12.92;
  let high = pow((c + 0.055) / 1.055, vec3f(2.4));
  return mix(low, high, cutoff);
}

fn bt709_to_linear(c: vec3f) -> vec3f {
  // BT.1886 with display gamma 2.4, matches Rec.709 reference.
  return pow(max(c, vec3f(0.0)), vec3f(2.4));
}

// SMPTE ST.2084 PQ, normalized to 10000 nits = 1.0
fn pq_to_linear(c: vec3f) -> vec3f {
  let m1 = 0.1593017578125;
  let m2 = 78.84375;
  let c1 = 0.8359375;
  let c2 = 18.8515625;
  let c3 = 18.6875;
  let cl = clamp(c, vec3f(0.0), vec3f(1.0));
  let p = pow(cl, vec3f(1.0 / m2));
  let num = max(p - vec3f(c1), vec3f(0.0));
  let den = vec3f(c2) - vec3f(c3) * p;
  return pow(num / den, vec3f(1.0 / m1));
}

// ARIB STD-B67 HLG, scene-referenced inverse OETF -> linear [0..12]
fn hlg_to_linear(c: vec3f) -> vec3f {
  let a = 0.17883277;
  let b = 0.28466892; // 1 - 4a
  let cc = 0.55991073; // 0.5 - a*ln(4a)
  let lo = (c * c) / 3.0;
  let hi = (exp((c - vec3f(cc)) / a) + vec3f(b)) / 12.0;
  let cutoff = step(vec3f(0.5), c);
  return mix(lo, hi, cutoff);
}

fn decode(c: vec3f, transfer: u32) -> vec3f {
  switch (transfer) {
    case 0u: { return srgb_to_linear(c); }
    case 1u: { return bt709_to_linear(c); }
    case 2u: { return pq_to_linear(c) * 10000.0; }   // -> absolute nits
    case 3u: { return hlg_to_linear(c) * 1000.0; }   // -> nits, HLG peak ref
    default: { return c; }                            // linear
  }
}

// --- OETFs (linear -> encoded) ---

fn linear_to_srgb(c: vec3f) -> vec3f {
  let cl = max(c, vec3f(0.0));
  let cutoff = step(vec3f(0.0031308), cl);
  let low = cl * 12.92;
  let high = 1.055 * pow(cl, vec3f(1.0 / 2.4)) - 0.055;
  return mix(low, high, cutoff);
}

fn linear_to_pq(c: vec3f) -> vec3f {
  let m1 = 0.1593017578125;
  let m2 = 78.84375;
  let c1 = 0.8359375;
  let c2 = 18.8515625;
  let c3 = 18.6875;
  let cl = clamp(c / 10000.0, vec3f(0.0), vec3f(1.0));
  let p = pow(cl, vec3f(m1));
  let num = vec3f(c1) + vec3f(c2) * p;
  let den = vec3f(1.0) + vec3f(c3) * p;
  return pow(num / den, vec3f(m2));
}

fn encode(c: vec3f, transfer: u32) -> vec3f {
  switch (transfer) {
    case 0u: { return linear_to_srgb(c); }
    case 1u: { return pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)); }
    case 2u: { return linear_to_pq(c); }
    default: { return c; }
  }
}

// --- Primaries conversion (3x3 matrices) ---
// All matrices are derived from CIE 1931 xy chromaticities + D65 whitepoint.

fn mat_bt709_to_xyz() -> mat3x3f {
  return mat3x3f(
    vec3f(0.4123908, 0.2126390, 0.0193308),
    vec3f(0.3575843, 0.7151687, 0.1191948),
    vec3f(0.1804808, 0.0721923, 0.9505322),
  );
}
fn mat_xyz_to_bt709() -> mat3x3f {
  return mat3x3f(
    vec3f( 3.2409699, -0.9692436,  0.0556301),
    vec3f(-1.5373832,  1.8759675, -0.2039770),
    vec3f(-0.4986108,  0.0415551,  1.0569715),
  );
}
fn mat_p3_to_xyz() -> mat3x3f {
  return mat3x3f(
    vec3f(0.4865709, 0.2289746, 0.0000000),
    vec3f(0.2656677, 0.6917385, 0.0451134),
    vec3f(0.1982173, 0.0792869, 1.0439443),
  );
}
fn mat_xyz_to_p3() -> mat3x3f {
  return mat3x3f(
    vec3f( 2.4934969, -0.8294889,  0.0358458),
    vec3f(-0.9313836,  1.7626641, -0.0761724),
    vec3f(-0.4027108,  0.0236247,  0.9568845),
  );
}
fn mat_bt2020_to_xyz() -> mat3x3f {
  return mat3x3f(
    vec3f(0.6369580, 0.2627002, 0.0000000),
    vec3f(0.1446169, 0.6779981, 0.0280727),
    vec3f(0.1688810, 0.0593017, 1.0609851),
  );
}
fn mat_xyz_to_bt2020() -> mat3x3f {
  return mat3x3f(
    vec3f( 1.7166512, -0.6666844,  0.0176399),
    vec3f(-0.3556708,  1.6164812, -0.0427706),
    vec3f(-0.2533663,  0.0157685,  0.9421031),
  );
}

fn primaries_to_xyz(p: u32) -> mat3x3f {
  switch (p) {
    case 1u: { return mat_p3_to_xyz(); }
    case 2u: { return mat_bt2020_to_xyz(); }
    default: { return mat_bt709_to_xyz(); }
  }
}

fn xyz_to_primaries(p: u32) -> mat3x3f {
  switch (p) {
    case 1u: { return mat_xyz_to_p3(); }
    case 2u: { return mat_xyz_to_bt2020(); }
    default: { return mat_xyz_to_bt709(); }
  }
}

fn convert_primaries(c: vec3f, srcP: u32, dstP: u32) -> vec3f {
  if (srcP == dstP) { return c; }
  let m = xyz_to_primaries(dstP) * primaries_to_xyz(srcP);
  return m * c;
}

// --- Tone mapping (HDR linear -> SDR linear) ---

fn tonemap_reinhard(c: vec3f, peak: f32) -> vec3f {
  // Extended Reinhard with white-point.
  let n = c * (vec3f(1.0) + c / vec3f(peak * peak));
  return n / (vec3f(1.0) + c);
}

fn tonemap_hable(c: vec3f) -> vec3f {
  // John Hable filmic curve (Uncharted 2).
  let A = 0.15; let B = 0.50; let C = 0.10;
  let D = 0.20; let E = 0.02; let F = 0.30;
  let W = 11.2;
  let curve = ((c * (A * c + vec3f(C * B)) + vec3f(D * E)) /
               (c * (A * c + vec3f(B))      + vec3f(D * F))) - vec3f(E / F);
  let whiteCurve =
    ((W * (A * W + C * B) + D * E) /
     (W * (A * W + B)      + D * F)) - E / F;
  return curve / vec3f(whiteCurve);
}

fn tonemap(c: vec3f) -> vec3f {
  // Convert absolute nits to a 0..N range relative to target peak.
  let rel = c / max(u.targetPeakNits, 1.0);
  switch (u.toneMap) {
    case 1u: { return tonemap_reinhard(rel, u.sourcePeakNits / u.targetPeakNits); }
    case 2u: { return tonemap_hable(rel * 2.0); }
    default: { return clamp(rel, vec3f(0.0), vec3f(1.0)); }
  }
}

// Per-layer pipeline: encoded RGB -> target encoded RGB.
fn process_layer(rgba: vec4f, transfer: u32, primaries: u32) -> vec4f {
  let lin = decode(rgba.rgb, transfer);
  let conv = convert_primaries(lin, primaries, u.targetPrimaries);
  var outLin = conv;

  // HDR-aware: if source uses an HDR transfer (PQ/HLG), tone map down for
  // SDR targets. For SDR-to-SDR, decode/encode pair already normalizes 0..1.
  let isHdrSrc = (transfer == 2u) || (transfer == 3u);
  let isHdrDst = (u.targetTransfer == 2u);
  if (isHdrSrc && !isHdrDst) {
    outLin = tonemap(conv);
  } else if (!isHdrSrc && isHdrDst) {
    // SDR diffuse white maps to 203 nits per ITU BT.2408.
    outLin = conv * 203.0;
  }

  let enc = encode(outLin, u.targetTransfer);
  return vec4f(enc, rgba.a);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let b = textureSampleBaseClampToEdge(bottomTex, samp, in.uv);
  let t = textureSampleBaseClampToEdge(topTex, samp, in.uv);

  let bp = process_layer(b, u.layerTransfer.x, u.layerPrimaries.x);
  let tp = process_layer(t, u.layerTransfer.y, u.layerPrimaries.y);

  if (u.useTop > 0u) {
    return mix(bp, tp, clamp(u.topAlpha, 0.0, 1.0));
  }
  return bp;
}
`;
