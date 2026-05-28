# exp-26 · Speech-to-Text / Auto-Captions On-Device

## Purpose

End-to-end on-device transcription — chunking, 16 kHz resampling, VAD,
virtualised transcript, playback-synced word highlight — with **real**
Whisper-tiny / Moonshine inference running locally on the WebGPU EP.
Audio never leaves the machine.

## What's real

- `decodeAudioData` from a user-picked file.
- 16 kHz mono resampling via `OfflineAudioContext` (deterministic,
  ~10× real-time).
- RMS-based VAD over 30 ms hops + 30-second / 1 s-overlap chunk stats.
- Real transcription via **Transformers.js** (`@huggingface/transformers`,
  which wraps onnxruntime-web) on the WebGPU EP, wasm fallback. Model
  weights download once and cache on-device via the Cache API.
- Word-level timestamps from Whisper's cross-attention alignment
  (`return_timestamps: "word"`); Moonshine falls back to segment-level
  timing distributed across words.
- Word-list virtualised display + audio playback with current-word
  highlight.

## Models

| Selector | HF repo | Word timestamps |
|---|---|---|
| Whisper-tiny | `onnx-community/whisper-tiny.en` | yes (alignment) |
| Moonshine-base | `onnx-community/moonshine-base-ONNX` | distributed |

## File map

```
src/app/page.tsx                Pipeline UI, transport, word list
src/lib/resample.ts             OfflineAudioContext-based 16k mono
src/lib/vad.ts                  RMS-based voice activity detection
src/lib/chunk.ts                30s/1s window chunking (stats)
src/lib/synth.ts                Synthetic 10 s tone fallback
src/lib/types.ts                Shared types (WordTimestamp etc.)
src/workers/transcribe.worker.ts  Transformers.js ASR on WebGPU EP
```

## Running

```
pnpm --filter exp-26-speech-to-text dev
```

Pick an audio file (or click "Use synthetic 10 s tone") → first run
downloads + caches the model (progress bar shows download %) → words
appear in the virtualised list → press Play to hear playback with
word highlight.

## Success criteria

- First run downloads the model once; later runs load from Cache API.
- Playback word highlight stays within 50 ms of the audible word.
- Zero audio bytes leave the origin (inspect DevTools Network).

## Foot-guns

- `OfflineAudioContext` minimum sample rate is 8000 Hz.
- WebGPU EP is not shipped everywhere; Transformers.js falls back to
  the wasm EP automatically.
- Whisper expects log-Mel features, not raw PCM — Transformers.js'
  feature extractor handles this; do not roll your own.
- The synthetic tone has no speech, so it transcribes to little/nothing
  — it only exercises plumbing. Use a real voice clip to see words.
