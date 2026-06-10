# Exp-26 · Speech-to-Text / Auto-Captions On-Device

## Goal

Prove the full on-device ASR pipeline that feeds the captions system
(exp-21): chunking, 16 kHz resampling via `OfflineAudioContext`, VAD,
model invocation, word-level timestamp output, virtualised transcript
display, and audio-playback-synced word highlighting. The **real**
model (Whisper-tiny / Moonshine-base) runs on-device now via
`@reelforge/asr` (Transformers.js → onnxruntime-web on the WebGPU EP,
WASM fallback) inside a Web Worker. Weights download once from the
Hugging Face hub and are cached on-device by Transformers.js (Cache
API) after the first run; audio never leaves the machine.

## App Location

`apps/exp-26-speech-to-text/`

## Why This Matters in the Full NLE

Captions are arguably the highest-leverage feature a browser editor
ships in 2026 — accessibility + virality. Cloud transcription has
privacy + cost issues; on-device transcription via WebGPU is now
fast enough on a mid-tier laptop (Moonshine reports 107 ms latency
vs Whisper Large V3's 11,286 ms on the same hardware). Picking
between models, quantisations, and inference backends is a real
engineering decision; this experiment runs the real model and keeps
the model choice behind one shared helper (`@reelforge/asr`) so
swapping Whisper-tiny ↔ Moonshine is a config change, not a rewrite.

## Key APIs

| API | Where used |
|---|---|
| `AudioContext.decodeAudioData` | Decode user file → `AudioBuffer` |
| `OfflineAudioContext` | Resample arbitrary sample-rate to 16 kHz mono |
| Chunking (manual) | 30-second windows with 1-second overlap |
| VAD (manual) | RMS-based gate to skip silent chunks |
| Transformers.js → `onnxruntime-web` (WebGPU EP, WASM fallback) | Real Whisper / Moonshine inference via `@reelforge/asr` |
| Cache API | Transformers.js caches downloaded weights on-device after first run |
| `Worker` | Real transcriber (`@reelforge/asr`) runs off main thread |

## Pipeline

1. **Ingest**. File picker accepts audio; `decodeAudioData` to a
   single-channel `AudioBuffer` at the source's native sample rate.
2. **Resample to 16k**. `new OfflineAudioContext({ length: ceil(dur *
   16000), sampleRate: 16000 })`, render the source through it, read
   `getChannelData(0)`. This is real, deterministic, and ~10× real-
   time on a laptop.
3. **VAD**. Compute RMS over 30 ms hops; mark chunks where ≥ 5% of
   hops exceed -45 dBFS as "voiced". Skip pure-silence chunks.
4. **Chunk**. Slice the 16k signal into 30 s windows with 1 s
   overlap. Send each window to a worker.
5. **Transcribe** (worker). The worker calls `@reelforge/asr`, which
   runs Whisper-tiny / Moonshine through Transformers.js on the
   onnxruntime-web WebGPU EP (WASM fallback). Whisper returns word-level
   timestamps via `return_timestamps: "word"`; Moonshine returns
   segment timestamps that are spread evenly across the span. The first
   run downloads the weights (~60–75 MB) from the HF hub; later runs
   load from the on-device cache.
6. **Stitch**. Deduplicate overlapping words across chunk boundaries
   (cheap edit-distance on the overlap).
7. **Display**. Virtualised list (only visible rows rendered); audio
   playback highlights the current word.

## Model selection

| Model | HF repo | Approx. size | Timestamps |
|---|---|---|---|
| Whisper-tiny (.en, q8 decoder) | `onnx-community/whisper-tiny.en` | ~75 MB | word-level |
| Moonshine-base | `onnx-community/moonshine-base-ONNX` | ~60 MB | segment-level |

The selector is live: changing it loads the corresponding repo through
`@reelforge/asr` on the next run (the worker reloads the pipeline when
the repo changes).

## UI

- File picker + "Use synthetic 10 s tone" fallback.
- Model selector (Whisper-tiny / Moonshine-base — both live).
- Progress bar + stage indicator (decode → resample → VAD → chunk →
  transcribe), surfacing the model-download progress on the first run.
- Word list (virtualised) with `[start–end] word` rows.
- Audio `<audio>` element playback; current word highlights as
  playhead crosses each timestamp.

## Success Criteria

1. A clip decodes, resamples to 16 kHz, VADs, chunks, and transcribes
   with the real Whisper-tiny / Moonshine model on the WebGPU EP; audio
   stays on-device and no audio bytes leave the origin.
2. Weights download once (~60–75 MB) on the first run and load from the
   on-device cache on subsequent runs (no re-download).
3. Playback word highlight tracks the current word from the model's
   word/segment timestamps as the playhead crosses each entry.

## Foot-guns

- `OfflineAudioContext` minimum sample rate is 8000 Hz; check before
  shipping with 8 kHz audio.
- Whisper-style models expect log-Mel features, not raw PCM — the
  feature extractor is part of the model package; do not roll your
  own.
- WebGPU EP for onnxruntime-web is not yet shipped in all browsers;
  detect and fall back to WASM EP.
- VAD on music is a different problem; this VAD targets speech.
- Word-level timestamps from Whisper require the `--word-timestamps`
  flag in the original; some quantised ports don't expose it.
