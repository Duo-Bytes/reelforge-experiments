# exp-39-smart-cut · On-Device Smart-Cut (Long-form → Short-form)

## Purpose

Edge experiment for the privacy-first, in-browser NLE. Attacks: **Opus Clip, Submagic, Riverside Magic Clips**.

Why this edge is real, the full design, success criteria, and foot-guns
are documented in [`docs/exp-39-smart-cut.md`](../../docs/exp-39-smart-cut.md). Broader
competitive context: [`docs/research-competitive-edge.md`](../../docs/research-competitive-edge.md).

## Run

```bash
pnpm --filter exp-39-smart-cut dev
```

## Status

v2 — real signals, all on-device:

- **Transcript:** Whisper-tiny via Transformers.js (onnxruntime-web,
  WebGPU EP, wasm fallback) in `src/workers/transcribe.worker.ts`.
  Word-level timestamps; model caches after first download.
- **Audio:** 0.5 s RMS energy windows from `decodeAudioData`.
- **Motion:** mean absolute luma frame-difference sampled from the
  decoded video (one sample per energy window); audio-only inputs
  contribute a flat-zero motion signal.
- **Scoring:** generic engagement text score (hook phrases, curiosity
  words, numbers, speech density) + audio + motion + novelty, reweighted
  live from the cached signals.

Remaining: snap boundaries to sentence edges; replace the `<video>`
seek sampler with a low-res WebCodecs decode; "send to timeline"
(exp-09) + animated captions (exp-23).
