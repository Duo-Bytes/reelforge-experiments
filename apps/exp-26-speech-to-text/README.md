# exp-26 · Speech-to-Text / Auto-Captions On-Device

## Purpose

Prove the **integration shape** of the on-device transcription
pipeline — chunking, 16 kHz resampling, VAD, virtualised transcript,
playback-synced word highlight — **without** paying the cost of
downloading a 100 MB+ Whisper model. The actual model invocation is
mocked; the audio plumbing is real.

## What's real

- `decodeAudioData` from a user-picked file.
- 16 kHz mono resampling via `OfflineAudioContext` (deterministic,
  ~10× real-time).
- RMS-based VAD over 30 ms hops.
- 30-second chunks with 1 s overlap.
- Word-list virtualised display.
- Audio playback with current-word highlight.
- Worker-based mock transcriber with simulated latency + progress.

## What's mocked

- `transcribeChunk` returns plausibly-timed fake words for the chunk
  duration (no model is invoked).
- Model selector ("Whisper-tiny" / "Moonshine-base") is inert.

To wire a real model, swap the mock in
`src/workers/transcribe.worker.ts` for an onnxruntime-web session
running Whisper-tiny / Moonshine on the WebGPU EP. The pipeline
contract (input: `Float32Array` @ 16k mono; output: `WordTimestamp[]`)
is fixed.

## File map

```
src/app/page.tsx                Pipeline UI, transport, word list
src/lib/resample.ts             OfflineAudioContext-based 16k mono
src/lib/vad.ts                  RMS-based voice activity detection
src/lib/chunk.ts                30s/1s window chunking
src/lib/synth.ts                Synthetic 10 s tone fallback
src/lib/types.ts                Shared types (WordTimestamp etc.)
src/workers/transcribe.worker.ts  Mock transcriber (replace with real)
```

## Running

```
pnpm --filter exp-26-speech-to-text dev
```

Pick an audio file or click "Use synthetic 10 s tone" → hit Run →
watch progress bar → words appear in the virtualised list → press
Play to hear playback with word highlight.

## Success criteria (scaffold)

- A 60 s clip resamples + VADs + mock-transcribes in < 2 s.
- Playback word highlight stays within 50 ms of the audible word.
- Replacing the mock with real ONNX should require touching exactly
  one function (`transcribeChunk` inside `transcribe.worker.ts`).

## Foot-guns

- `OfflineAudioContext` minimum sample rate is 8000 Hz.
- WebGPU EP for onnxruntime-web is not shipped everywhere; detect and
  fall back to WASM EP in production.
- Whisper expects log-Mel features, not raw PCM — feature extractor is
  part of the model package; do not roll your own.
