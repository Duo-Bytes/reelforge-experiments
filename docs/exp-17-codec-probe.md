# Exp-17 · Codec Coverage & Hardware-Accel Probe

## Goal

Probe `VideoDecoder.isConfigSupported` and
`VideoEncoder.isConfigSupported` for the full matrix of codec ×
resolution × bit-depth × hardware-acceleration preference. Produce a
capability profile that the rest of the app branches on (proxy required?
software fallback? feature hidden?). Include `navigator.gpu` adapter
info.

## App Location

`apps/exp-17-codec-probe/`

## Why This Matters in the Full NLE

UA strings and `MediaSource.isTypeSupported` are both wrong for
WebCodecs. `isConfigSupported` is the only honest answer. HEVC/AV1/VP9
coverage is a per-OS minefield; the proxy workflow (exp-07) silently
depends on knowing what the machine can do.

## Key APIs

| API | Where used |
|---|---|
| `VideoDecoder.isConfigSupported(config)` | Decode capability probe |
| `VideoEncoder.isConfigSupported(config)` | Encode capability probe |
| `hardwareAcceleration: "prefer-hardware" / "prefer-software" / "no-preference"` | Per-axis HW preference |
| `navigator.gpu.requestAdapter().info` | Vendor / architecture / device / description |

## Matrix

- 15 codec strings (H.264 baseline/main/high/high4K, HEVC main 3.1/4/5/main10, VP9 P0/P0-4K/P2-10b, AV1 main/4K/10b, VVC)
- 3 resolutions (720p, 1080p, 4K UHD)
- 3 hardware preferences
- 2 sides (decode + encode)

= 270 probes per run. Serial execution; the GPU process throttles
parallel `isConfigSupported` calls anyway.

## Capability Profile

The page reduces the matrix to a small boolean profile:

```ts
type CapabilityProfile = {
  canIngestH264 | HEVC | HEVCHDR | VP9 | AV1: boolean;
  canEncodeH264HW | HEVCHW | AV1HW: boolean;
  canExport4K: boolean;
  proxyRequiredForHEVC: boolean;   // can decode but not HW-encode
  recommendedProxyCodec: "AV1" | "HEVC" | "H.264";
};
```

This is what the rest of the app reads at startup; UI/proxy logic
branches on these flags.

## Success Criteria

1. All 270 probes complete without crashing the tab.
2. The profile matches what you know about the current hardware.
3. Downloading the JSON and re-running on another machine produces a
   clean diff — both UAs agree on what works.

## Foot-guns

- Chrome HEVC support varies by OS version *and* build flag; expose with
  `--enable-features=PlatformHEVCDecoderSupport` in dev.
- `isConfigSupported: true` does not guarantee runtime success on every
  bitstream — wrap the first `decoder.configure()` in try/catch.
- "prefer-hardware" is a hint; the UA may still pick software. Probe
  both prefs to learn what actually maps where.
- VVC (H.266) is generally software-only as of 2026.
