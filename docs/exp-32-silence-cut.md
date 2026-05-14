# Exp-32 · On-Device Silence & Filler-Word Removal

## Goal

Run a voice-activity detection (VAD) model in `onnxruntime-web` on the
WebGPU execution provider over a 60-minute mono podcast and produce a
frame-accurate edit decision list (EDL) of silence + filler regions that
the timeline state (exp-09) consumes as ripple-delete edits — entirely
on-device.

## App Location

`apps/exp-32-silence-cut/`

## Why This Matters — Competitive Edge

Descript's "Remove Silences" and "Filler Word Removal" are the single
most-cited features keeping creators on a $19–$50/mo subscription. Every
podcast minute uploads to Descript's servers before the model runs.

For legal depositions, medical interviews, journalism source recordings,
and enterprise compliance audio, that upload is **disqualifying**.
On-device inference removes the objection entirely while matching the
feature.

See [`research-competitive-edge.md`](./research-competitive-edge.md) §32.

## Key APIs

| API | Where used |
|---|---|
| `onnxruntime-web` WebGPU EP | Silero-VAD-v5 inference |
| `AudioContext.decodeAudioData` / `AudioDecoder` (WebCodecs) | Source decode |
| `OfflineAudioContext` | 16-kHz mono resample (VAD input rate) |
| `AudioWorkletNode` | Live-preview pass-through with EDL gating |
| Timeline ripple-delete action (exp-09) | Apply cuts |

## Pipeline

```
WAV/MP3/AAC/MP4 source
  └─ decodeAudioData / AudioDecoder ─► Float32Array (source rate)
       └─ OfflineAudioContext ─► Float32Array (16 kHz mono)
            └─ Window into 30 ms hops (480 samples)
                 └─ Silero-VAD ONNX inference (WebGPU EP)
                      └─ per-frame P(speech) ∈ [0,1]
                           └─ hysteresis + min-segment-duration filter
                                └─ EDL: [{startSec, endSec, kind: "silence"}]
```

Filler-word pass (deferred to v2): use a forced-aligner against an
on-device Whisper transcript (exp-26) and classify "um", "uh", "you
know", "like" by token + duration heuristic.

## Success Criteria

1. A 60-minute 48-kHz stereo source produces a full EDL in **under 30 s**
   on a mid-tier M-series MacBook (Apple Silicon WebGPU EP).
2. Network panel shows **zero outbound bytes** during analysis.
3. EDL drives an exp-09 ripple-delete and the resulting timeline plays
   without audible cut artifacts at default 150 ms crossfade.
4. Heap snapshot after 5 consecutive 60-min runs shows no growth — the
   ONNX session is warm-cached and re-used.
5. A toggle compares output against a known-good ground-truth EDL
   produced by a desktop Whisper+VAD reference; word-error-rate of
   silence boundaries < 50 ms on 95 % of edges.

## Foot-guns

- Silero-VAD model file is ~2 MB ONNX; cache via the Cache API on first
  load. Re-use the cache-key pattern from exp-11 (background removal).
- WebGPU EP cold-start: first inference run is dominated by shader
  compile. Run a 1-second warm-up against silence before the real pass.
- 30 ms hop windows produce 200,000 inferences for a 60-min file. Batch
  N hops per dispatch (N ≈ 32 fits on most GPUs) to amortize launch
  overhead.
- Stereo → mono downmix must average channels, not pick L (drops the
  mic-on-right podcaster).
- Hysteresis on the speech-probability mask is essential — the raw mask
  flickers every 30 ms and produces sub-frame cuts.

## Demo

- Drag a podcast `.mp3` into the page.
- Live waveform (exp-25) overlaid with red bars where the EDL marks
  silence.
- "Apply" button rewrites the timeline state and starts playback from
  the first kept segment.
- Show inference time and outbound-byte count (always 0).
