# Exp-20 · Color Grading: 3D LUT Sampling + Primaries

## Goal

Load an industry-standard `.cube` 3D LUT (17/33/65-point) into a WebGPU
`texture_3d<f32>`, sample it with hardware trilinear filtering in WGSL,
and apply it to a reference image. Verify that the result is
qualitatively identical to a Resolve/Premiere render of the same LUT
applied to the same ramp, and that gamma is handled at the correct
stage of the pipeline.

## App Location

`apps/exp-20-lut-3d/`

## Why This Matters in the Full NLE

`.cube` is the universal LUT interchange format — every grade ever
exported by a colorist will arrive in this shape. "Apply a LUT" is
table-stakes for any NLE that wants creators to bring their own look.
The wrong gamma stage (encode before sample vs. after) silently
introduces double-encoded sRGB or crushed blacks; you can ship a "LUT
works" demo and still be totally wrong about the math.

## Key APIs

| API | Where used |
|---|---|
| `GPUDevice.createTexture({ dimension: "3d", format: "rgba16float" })` | LUT volume |
| `GPUQueue.writeTexture(... { width, height, depthOrArrayLayers })` | Upload the parsed cube |
| WGSL `textureSampleLevel(lut, samp, vec3<f32>(r,g,b), 0.0)` | Trilinear sample inside the cube |
| `GPUSampler { magFilter: "linear", minFilter: "linear" }` | Hardware trilinear |
| `File.text()` / hand-rolled parser | Read `.cube` text |

## Approach / Pipeline

1. Parse `.cube`:
   - Strip comments, find `LUT_3D_SIZE N`, optional `DOMAIN_MIN/MAX`.
   - Read N³ float triplets in B-major order (the `.cube` convention:
     R varies fastest, then G, then B).
   - Pad to RGBA in a `Float32Array` for upload (rgba16float wants 4
     channels).
2. Upload to a 3D texture, sized `N × N × N`, format `rgba16float`.
3. Draw two side-by-side quads: left = source ramp, right = source ramp
   sampled through the LUT.
4. The source ramp is procedural in WGSL: `uv.x` drives hue, `uv.y` drives
   value, so the whole gamut is exercised in one frame.
5. UI sliders/toggles:
   - LUT strength (mix between raw and graded).
   - "Apply in linear" vs. "apply in sRGB-encoded" — toggles `pow(x,
     2.2)` placement.

## Success Criteria

1. A built-in identity LUT produces a pixel-identical output (within
   16-bit float precision) to the input ramp.
2. A built-in "warm" LUT visibly tints the ramp; toggling strength to 0
   restores the input.
3. Loading a user `.cube` of any of {17, 33, 65} points renders without
   layout glitches; the detected `LUT_3D_SIZE` displays in the UI.
4. Toggling "apply in linear" vs. "apply encoded" produces a noticeable,
   different result — confirming the gamma stage actually matters.

## Foot-guns

- `.cube` B-major order trips everyone. The slowest-varying axis in the
  file is B, not R. Linearised index = `r + g*N + b*N*N`.
- Float textures need `EXT-color-buffer-float`-equivalent on WebGPU;
  `rgba16float` is the safest sampleable format with linear filtering.
- `DOMAIN_MIN`/`DOMAIN_MAX` default to `[0,0,0]`/`[1,1,1]`. Honour them
  before sampling — log/ACES LUTs use extended range.
- WebGPU samplers clamp to edge by default; that's correct for a LUT
  cube. `repeat` would wrap red→cyan at the boundary.
- Filtering a LUT in sRGB-encoded space then encoding again is the
  classic "double-gamma" bug — the toggle exists in this demo so you can
  see the failure mode on purpose.
- ΔE76 numerical verification against DaVinci output is *not* done here;
  the panel labels the qualitative result and leaves the colour-science
  audit for exp-13.
