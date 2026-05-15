# exp-20 · Color Grading: 3D LUT Sampling + Primaries

## Purpose

De-risk the LUT-application pipeline for the NLE's colour engine. We load a
`.cube` 3D LUT, upload it to a `texture_3d<f32>` (`rgba16float`), sample with
hardware trilinear filtering in WGSL, and apply it to a procedural reference
ramp. The split-screen view shows the input on the left and the LUT-applied
output on the right.

## How to run

```
pnpm --filter exp-20-lut-3d dev
```

Requires Chrome/Edge with WebGPU enabled and a GPU that supports
`rgba16float` 3D textures with linear filtering (basically everything since
2023).

## What to look for

- The page boots straight into a built-in 33-point "warm" LUT — no file
  needed.
- The "Built-in identity (17)" button should produce an output that is
  pixel-identical (within 16-bit float precision) to the input.
- Drag a real `.cube` file from the colourist's deliverable into the file
  picker. 17 / 33 / 65 point sizes all work.
- Move the **strength** slider: at 0.0, the right half should match the
  left half. At 1.0 you see the full grade.
- Toggle **Apply in linear** with the warm LUT loaded. The toggled-off
  result is visibly more saturated / contrasty — that's the classic
  double-gamma bug; the LUT was authored against linear input, and applying
  it in sRGB-encoded space crushes mid-tones.
- The LUT info panel reports the detected `LUT_3D_SIZE`, title (from the
  `TITLE` line if present), and `DOMAIN_MIN/MAX`.

## Files

- `src/lib/cube.ts` — `.cube` parser, identity/warm LUT builders, round-trip
  serialiser.
- `src/lib/shaders.ts` — fullscreen-triangle vertex shader and the fragment
  shader that builds the ramp, samples the LUT, and renders the split view.
- `src/lib/gpu.ts` — WebGPU device/pipeline boilerplate plus a CPU `Float32`
  → `Float16` packer for the LUT upload.
- `src/app/page.tsx` — wires the UI controls to the GPU pipeline.

## Success bar

1. The built-in identity LUT renders a result that visually matches the
   input ramp.
2. Any of {17, 33, 65}-point `.cube` files load and render without
   geometry/layout glitches.
3. Strength 0 == raw source; strength 1 == full grade.
4. Toggling the gamma stage with the warm LUT produces a visibly different
   image — confirms the math actually pivots on the gamma decision.

## Known foot-guns

- `.cube` files store samples in B-major order (R varies fastest). Easy to
  transpose by accident and produce a "mirrored" LUT.
- `rgba16float` is the only sampleable + linear-filterable float texture
  format guaranteed by the WebGPU spec. `rgba32float` is unfilterable on
  most adapters.
- Linear filtering across a discretised LUT requires a half-texel inset on
  the sample coordinate — done in the WGSL `applyLut()` helper. Skipping
  it shifts results by half a cell at the cube boundaries.
- `DOMAIN_MIN`/`DOMAIN_MAX` of anything other than `[0,1]` (e.g., log
  curves, ACEScct) are honoured by the parser but not yet remapped before
  sampling — only standard-range LUTs render correctly today.
