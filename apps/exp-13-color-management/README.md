# exp-13 · Color Management & HDR Pipeline

## Purpose

Composite a BT.709 SDR clip, a Display-P3 image, and an HDR10/PQ clip into a
single output with explicit transfer functions and primaries conversion, with
the target color space (sRGB SDR / Display-P3 SDR / HDR10 PQ) selectable at
runtime.

Without this, the existing exp-04 compositor implicitly assumes sRGB and
silently corrupts every non-Rec.709 source.

## Architecture

```
Main thread (page.tsx, "use client")
├── <video src=bottomClip> ─┐
│                            ├─ new VideoFrame(<video>) per rAF
├── <video src=topClip>    ─┘
│                              ↓ importExternalTexture
├── createImageBitmap(p3image, {colorSpaceConversion:"none"})
│                              ↓ (note below)
└── canvas#webgpu  ── context.configure({ colorSpace, toneMapping })

WGSL fragment (src/shaders/color.wgsl.ts):
  inverse EOTF  ───► linear RGB (source primaries)
                     │
  primaries 3×3 ───► linear RGB (target primaries)
                     │
  tone-map      ───► linear RGB (target peak)
                     │
  forward OETF  ───► encoded RGB for canvas
```

## Inputs

- **Bottom video.** Any MP4. The page calls `new VideoFrame(<video>)` and
  reads `VideoFrame.colorSpace.{primaries,transfer,matrix,fullRange}` to
  detect what the file actually is.
- **Top video.** Same. For HDR10 testing, use a 10-bit HEVC clip with PQ
  metadata (Apple sample HDR10, LG demo, or any iPhone Dolby Vision Profile 8
  re-encoded to HDR10).
- **Top image.** A PNG/JPEG. Pass a Display-P3 file. We use
  `createImageBitmap(file, { colorSpaceConversion: "none" })` to preserve the
  encoded values; the page assumes Display-P3 primaries with sRGB transfer.

## Transfer functions implemented in WGSL

| Code | Name | Notes |
|---|---|---|
| 0 | sRGB | piecewise, IEC 61966-2-1 |
| 1 | BT.1886 (≈BT.709) | gamma 2.4 |
| 2 | PQ (SMPTE ST.2084) | 10000-nit ref |
| 3 | HLG (ARIB STD-B67) | 1000-nit ref, scene-referenced |
| 4 | linear | pass-through |

## Primaries

- BT.709 / sRGB
- Display-P3 (D65, P3 primaries)
- BT.2020

Conversion is a single 3×3 matrix `xyz_to_dst * src_to_xyz`, computed inline
from CIE 1931 chromaticities + D65.

## Tone mapping (HDR→SDR only)

- `none` — clip to target peak
- `reinhard` — extended Reinhard with the source peak as white point
- `hable` — John Hable filmic (Uncharted 2)

SDR→HDR uses the BT.2408 recommendation of 203 nits diffuse white.

## Browser-level controls

In addition to the WGSL pipeline, the canvas itself supports:

- `GPUCanvasContext.configure({ colorSpace: "srgb" | "display-p3" })` — the
  surface the GPU writes to. Switching this changes which colors are
  reachable from the canvas.
- `GPUCanvasContext.configure({ toneMapping: { mode: "standard" | "extended" } })`
  — when set to `extended`, the canvas accepts > 1.0 floating point values
  and lets the OS/browser do the HDR mapping. Pair with an `rgba16float`
  swap chain in a future iteration.

## Success criteria

1. Loading three sources with different `VideoColorSpace` fields shows the
   correct `primaries / transfer / matrix / range` in the inspector — not
   "unknown".
2. Switching target between `sRGB SDR`, `Display-P3 SDR`, and `HDR10` causes
   visible changes (saturation expands moving to P3; on an HDR display
   highlights re-light moving to HDR10).
3. The same HDR clip looks reasonably exposed in SDR with Reinhard/Hable on
   (no clipped highlights, no purple cast).
4. Memory snapshot after 60 s of playback shows no growth — every
   `VideoFrame` and `GPUExternalTexture` is single-use per rAF.

## Known foot-guns

- `texture_external` samples must use `textureSampleBaseClampToEdge`, not
  `textureSample`.
- `device.importExternalTexture()` references are valid only until the next
  await — call it synchronously between `new VideoFrame()` and
  `queue.submit()`.
- `VideoFrame.colorSpace` fields can be `null` for sources with no tagged
  metadata. The page falls back to BT.709 SDR in that case; pre-tag your
  test clips for accurate results.
- ImageBitmap full-fidelity color handling (`colorSpace` getter) is still
  partial in Chrome — the page assumes the user-provided image is P3.
- `GPUCanvasConfiguration.toneMapping` requires Chrome 124+. The page passes
  it via a type widening so older builds simply ignore it.

## Running

```
pnpm --filter exp-13-color-management dev
```
