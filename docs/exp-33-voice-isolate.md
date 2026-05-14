# Exp-33 · On-Device Voice Isolation / Denoise

## Goal

Run a real-time speech enhancement model (DeepFilterNet3 ONNX on WebGPU,
or RNNoise WASM as fallback) over the timeline's audio output and prove
clean A/B toggle, offline render-to-OPFS, and no upload.

## App Location

`apps/exp-33-voice-isolate/`

## Why This Matters — Competitive Edge

Descript Studio Sound is the most-quoted reason users pay $35/mo+ to
Descript. Adobe Enhance Speech is a separate browser product that
requires audio upload to Adobe servers. Both are cloud-only.

Shipping a free, on-device, in-editor equivalent collapses the value
prop of both products for the privacy-sensitive segment (podcasters who
record sources under NDA, journalists, legal interviewers, enterprise).

See [`research-competitive-edge.md`](./research-competitive-edge.md) §33.

## Key APIs

| API | Where used |
|---|---|
| `onnxruntime-web` WebGPU EP | DeepFilterNet3 inference |
| `AudioWorkletNode` | Real-time pass over the mix bus |
| `OfflineAudioContext` | Faster-than-realtime render to OPFS |
| WGSL STFT compute pass (optional) | Spectrogram for the AB visualizer |
| `AudioContext.outputLatency` | A/V re-sync compensation |

## Pipeline

```
mix-bus float32 (48 kHz stereo)
  └─ AudioWorkletNode (process buffer 480 samples)
       └─ post to model worker (transferable Float32Array)
            └─ DeepFilterNet3 / RNNoise ─► clean Float32Array
                 └─ post back to worklet ─► output buffer
                      └─ optional dry/wet mix (slider)
                           └─ AudioContext destination
```

Offline render path: `OfflineAudioContext` at file length, model called
in batches; result encoded by exp-10 export pipeline.

## Success Criteria

1. 1-minute noisy field recording, denoised in **under 10 s** offline on
   a mid-tier laptop. Live mode runs without underrun glitches at
   `baseLatency + 20 ms`.
2. Network panel: zero outbound bytes.
3. Heap snapshot after 5 × 1-min runs: no growth.
4. Quantitative SNR improvement of ≥ 12 dB on a stationary-noise test
   clip; PESQ ≥ 3.0 on speech-in-noise reference.
5. A/B toggle latency under 100 ms (worker swap, not session reload).

## Foot-guns

- DeepFilterNet3 ONNX is ~25 MB; reuse the exp-11 model cache + show a
  one-time download dialog with a progress bar.
- WebGPU EP keeps a `GPUDevice` per session; if exp-15 (device-lost
  recovery) fires, the worker must rebuild before the next dispatch.
- Worklet → worker round-trip is not free: structured-clone is fine for
  Float32Array up to ~10 ms windows, but use `SharedArrayBuffer` ring
  buffer for sub-5 ms target latency.
- Output-side `AudioContext.outputLatency` must be added back to the A/V
  sync calculation (exp-08).
- Dry-wet crossfade has to be sample-accurate — a 16-sample ramp avoids
  clicks.

## Demo

- Load a "messy" field clip from the public corpus.
- Toggle Dry / Wet — show before/after spectrogram side-by-side
  (`OffscreenCanvas` 2D, rendered from a WGSL STFT or a JS FFT).
- "Render to OPFS" writes a cleaned WAV file; download via
  `showSaveFilePicker`.
- Outbound byte counter, always 0.
