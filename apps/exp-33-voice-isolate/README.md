# exp-33-voice-isolate · On-Device Voice Isolation / Denoise

## Purpose

Edge experiment for the privacy-first, in-browser NLE. Attacks: **Descript Studio Sound; Adobe Enhance Speech**.

Why this edge is real, the full design, success criteria, and foot-guns
are documented in [`docs/exp-33-voice-isolate.md`](../../docs/exp-33-voice-isolate.md). Broader
competitive context: [`docs/research-competitive-edge.md`](../../docs/research-competitive-edge.md).

## Run

```bash
pnpm --filter exp-33-voice-isolate dev
```

## Status

v2 — real on-device denoise via **RNNoise** (`@jitsi/rnnoise-wasm`), the
production RNN speech denoiser used by Discord/Jitsi. The sync build
inlines the wasm as base64, so nothing is fetched and no audio leaves
the machine. Pipeline: `decodeAudioData` → 48 kHz mono resample
(`OfflineAudioContext`) → 480-sample frame loop through RNNoise in a
worker → dry/wet STFT spectrograms + A/B playback + denoised-WAV
download. Reports RMS level reduction (dB) and mean per-frame speech
probability.

Upgrade path: **DeepFilterNet3** ONNX on the WebGPU EP for higher
quality — it needs a bespoke ERB / complex-spectrogram feature pipeline
with stateful GRUs, a larger effort than the RNNoise baseline.
