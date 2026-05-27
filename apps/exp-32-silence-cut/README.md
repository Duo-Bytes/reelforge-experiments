# exp-32-silence-cut · On-Device Silence & Filler-Word Removal

## Purpose

Edge experiment for the privacy-first, in-browser NLE. Attacks: **Descript Remove Silences + Filler Word Removal**.

Why this edge is real, the full design, success criteria, and foot-guns
are documented in [`docs/exp-32-silence-cut.md`](../../docs/exp-32-silence-cut.md). Broader
competitive context: [`docs/research-competitive-edge.md`](../../docs/research-competitive-edge.md).

## Run

```bash
pnpm --filter exp-32-silence-cut dev
```

## Status

v2 — Silero-VAD ONNX (v5, ~2.2 MB) loads via `onnxruntime-web` WebGPU
EP with a wasm fallback, cached in the `reelforge-models-v1` Cache API
bucket. Audio decode resamples to 16 kHz mono via `OfflineAudioContext`;
the worker streams 512-sample (32 ms) hops through a stateful LSTM and
emits per-hop speech probabilities. `silenceFromVadProbabilities`
converts the probability stream to silence segments via Schmitt-trigger
hysteresis + a min-silence-duration filter. An energy-RMS detector
remains selectable as a fallback. Filler-word classification still
depends on exp-26 transcripts.
