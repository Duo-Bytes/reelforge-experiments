# Exp-13 · Color Management & HDR Pipeline

## Goal

Composite a BT.709 SDR clip, a Display-P3 image, and an HDR10/PQ HEVC clip
into a single output with explicit transfer functions and primaries
conversion, with the target color space (sRGB SDR / Display-P3 SDR / HDR10)
selectable at runtime.

## App Location

`apps/exp-13-color-management/`

## Why This Matters in the Full NLE

The existing exp-04 compositor implicitly assumes sRGB-encoded inputs. An
iPhone HDR10/PQ clip lands in that pipeline as garbage greens and crushed
shadows. Without an explicit color pipeline, none of the export targets
(sRGB SDR for web, Display-P3 for Apple, HDR10 for TV) is correct.

## Key APIs

| API | Where used |
|---|---|
| `new VideoFrame(<video>)` | Construct a VideoFrame from a playing `<video>` to read `colorSpace` |
| `VideoFrame.colorSpace.{primaries, transfer, matrix, fullRange}` | Source color metadata |
| `GPUCanvasContext.configure({ colorSpace, toneMapping })` | Output canvas color space + browser HDR mapping (Chrome 124+) |
| `device.importExternalTexture({ source })` | Zero-copy VideoFrame → WGSL `texture_external` |
| `createImageBitmap(file, { colorSpaceConversion: "none" })` | Load a P3 image without sRGB conversion |

## Architecture

```
Main thread (page.tsx)
├── <video src=bottomClip> → new VideoFrame() per rAF
├── <video src=topClip>    → new VideoFrame() per rAF
├── createImageBitmap(p3image, {colorSpaceConversion:"none"})
└── canvas#webgpu → context.configure({ colorSpace, toneMapping })

WGSL fragment (src/shaders/color.wgsl.ts):
  inverse EOTF (sRGB/BT.1886/PQ/HLG) → linear in source primaries
  primaries 3×3                       → linear in target primaries
  tone-map (Reinhard / Hable / none) → linear at target peak
  forward OETF                        → encoded for canvas
```

## Success Criteria

1. The detected `VideoFrame.colorSpace` is shown for every loaded source
   (not "unknown").
2. Switching target between sRGB SDR / Display-P3 SDR / HDR10 produces
   visible differences (saturation expands toward P3, highlights re-light
   toward HDR10 on an HDR display).
3. An HDR10/PQ clip stays well-exposed in SDR with Reinhard or Hable —
   no clipped highlights or purple cast.
4. 60-s playback shows no memory growth: every VideoFrame and external
   texture is single-use per rAF.

## Foot-guns

- `texture_external` must be sampled with `textureSampleBaseClampToEdge`.
- `importExternalTexture` expires at the next `await`; create and submit
  synchronously.
- `VideoFrame.colorSpace` fields can be `null` for untagged sources —
  default to BT.709 SDR.
- `GPUCanvasConfiguration.toneMapping` requires Chrome 124+; the code
  feeds it via a widened type so older builds ignore it.
