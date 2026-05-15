# Exp-26 · Speech-to-Text / Auto-Captions On-Device

## Goal

Prove the **integration shape** of an on-device ASR pipeline that
feeds the captions system (exp-21): chunking, 16 kHz resampling via
`OfflineAudioContext`, VAD, model invocation, word-level timestamp
output, virtualised transcript display, and audio-playback-synced
word highlighting. The actual model (Whisper-tiny / Moonshine-base)
is **mocked** in this scaffold to avoid a 100 MB download; the
audio-side plumbing is real.

## App Location

`apps/exp-26-speech-to-text/`

## Why This Matters in the Full NLE

Captions are arguably the highest-leverage feature a browser editor
ships in 2026 — accessibility + virality. Cloud transcription has
privacy + cost issues; on-device transcription via WebGPU is now
fast enough on a mid-tier laptop (Moonshine reports 107 ms latency
vs Whisper Large V3's 11,286 ms on the same hardware). Picking
between models, quantisations, and inference backends is a real
engineering decision; this experiment gets the integration plumbing
right so the model swap is one function.

## Key APIs

| API | Where used |
|---|---|
| `AudioContext.decodeAudioData` | Decode user file → `AudioBuffer` |
| `OfflineAudioContext` | Resample arbitrary sample-rate to 16 kHz mono |
| Chunking (manual) | 30-second windows with 1-second overlap |
| VAD (manual) | RMS-based gate to skip silent chunks |
| `onnxruntime-web` (WebGPU EP) | **TODO** — real inference backend |
| `Worker` | Mock transcriber runs off main thread |

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
5. **Transcribe** (worker). In the scaffold, the **MockTranscriber**
   returns plausible word timings: words placed every ~350 ms across
   the chunk's voiced regions. In production, replace this with
   onnxruntime-web running Whisper-tiny / Moonshine on the WebGPU EP.
6. **Stitch**. Deduplicate overlapping words across chunk boundaries
   (cheap edit-distance on the overlap).
7. **Display**. Virtualised list (only visible rows rendered); audio
   playback highlights the current word.

## Model selection (when wired up)

| Model | Approx. size | Latency notes |
|---|---|---|
| Whisper-tiny (int8) | ~75 MB | Solid baseline, slower than Moonshine |
| Whisper-base (int8) | ~145 MB | Better quality, ~2× slower |
| Moonshine-base | ~60 MB | 100× faster than Whisper-Large; new default |

Selector is wired in UI but inert in this scaffold.

## UI

- File picker + "Use synthetic 10 s tone" fallback.
- Model selector (Whisper-tiny / Moonshine-base — both inert).
- Run button → progress bar, ETA, stage indicator (decode → resample
  → VAD → transcribe).
- Word list (virtualised) with `[start–end] word` rows.
- Audio `<audio>` element playback; current word highlights as
  playhead crosses each timestamp.

## Success Criteria

1. A 60-second clip resamples + VADs + mock-transcribes in < 2 s.
2. Playback word highlight stays within 50 ms of the audible word
   (mock has known timestamps, so this is checkable).
3. Replacing the mock with a real ONNX-runtime backend should require
   touching exactly one function (`transcribeChunk`).

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
