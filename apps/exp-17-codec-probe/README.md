# exp-17 · Codec Coverage & Hardware-Accel Probe

## Purpose

Produce a capability profile of the current machine: which codecs decode,
which encode, which only with software fallback, what bit depths, what
resolutions, and what the GPU adapter actually is. The rest of the app
branches on this profile at startup — proxy required? AV1 hardware
fallback? HEVC export hidden?

`isConfigSupported()` is the only honest answer. UA strings and feature
detection by `MediaSource.isTypeSupported` are both wrong for WebCodecs.

## Matrix

| Axis | Values |
|---|---|
| Codec family | H.264 (4 profiles), HEVC (4 profiles), VP9 (3), AV1 (3), VVC (1) |
| Resolution | 720p, 1080p, 4K UHD |
| Bit depth | 8 / 10 (per codec row) |
| Hardware preference | prefer-hardware, prefer-software, no-preference |
| Side | decode + encode |

15 codecs × 3 resolutions × 3 hw prefs × 2 sides = 270 probes per run.

## Output

- Live table with per-row decoder/encoder support (or thrown error).
- Capability profile boolean summary:
  - `canIngestH264` / `HEVC` / `HEVCHDR` / `VP9` / `AV1`
  - `canEncodeH264HW` / `HEVCHW` / `AV1HW`
  - `canExport4K`
  - `proxyRequiredForHEVC` — true if you can decode HEVC but can't encode
    it in hardware (the proxy workflow has to re-encode to a codec the
    user can later export).
  - `recommendedProxyCodec` — AV1 > HEVC > H.264 by hardware availability.
- WebGPU `adapter.info` — vendor / architecture / device / description.
- "Download JSON" button exports the entire profile as a single document
  for telemetry capture.

## Reading the results

Common shapes:

- **Most Apple Silicon + recent Intel**: full H.264 + HEVC decode/encode
  HW, VP9 decode HW, AV1 decode HW (M3+) but encode software-only.
- **NVIDIA Ampere+**: AV1 encode HW also available.
- **Linux Chrome**: HEVC frequently missing entirely; AV1 software.
- **Older AMD**: VP9 decode HW absent.

## Success criteria

1. All 270 probes finish without crashing the tab.
2. The capability profile matches what you know about the current
   hardware (sanity check, no automation).
3. Downloading the JSON and pasting into a colleague's machine running
   the same probe produces a diff with no false positives — both
   builds agree on what works.

## Known foot-guns

- Chrome ships HEVC behind an `OSSupportsHEVC()` check that varies by OS
  version *and* by build flags. Set `--enable-features=PlatformHEVCDecoderSupport`
  in dev to expose more.
- `isConfigSupported` returns the *user-agent's idea* of support — Chrome
  may say `supported: true` but the actual decoder can still fail with
  a specific bitstream (uncommon profiles, level mismatch). Always wrap
  the first decoder.configure() in a try/catch.
- VVC (H.266) is generally software-only as of mid-2026.
- "prefer-hardware" is a hint; the UA may still pick software. Probe
  both prefs to learn what actually maps where.

## Running

```
pnpm --filter exp-17-codec-probe dev
```
