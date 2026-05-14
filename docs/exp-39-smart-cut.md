# Exp-39 · On-Device Smart-Cut (Long-form → Short-form)

## Goal

Convert a 1-hour podcast or interview into the top-N viral-candidate
short clips using only on-device inference: Whisper-tiny (exp-26)
produces a word-level transcript, then a scoring pass ranks candidate
clip windows on textual, audio-energy, and visual-motion signals. UI
surfaces the top 10 candidates with playable thumbnails and one-click
"send to timeline."

## App Location

`apps/exp-39-smart-cut/`

## Why This Matters — Competitive Edge

Opus Clip's entire business is the cloud-bound long-to-short pipeline.
Submagic, Riverside Magic Clips, Vidau ClipRemix are direct competitors.
Common user complaints across all three:

- 10–30 min processing time for a 1-hour podcast (sometimes hours at
  peak load — Opus Clip had a 4-day outage in late 2025).
- Users override 30–60 % of cuts because boundaries are opaque and slow
  to iterate.
- Per-minute pricing punishes long-form creators.
- Audio leaves the device, disqualifying for confidential interviews.

ReelForge's on-device equivalent wins on **latency** (results in seconds,
not minutes), **iteration speed** (re-score instantly with new prompts),
**privacy**, and **frame accuracy** (boundaries snap to word
boundaries from the transcript, not approximate cloud guesses).

See [`research-competitive-edge.md`](./research-competitive-edge.md) §39.

## Key APIs

| API | Where used |
|---|---|
| `onnxruntime-web` WebGPU EP | Whisper-tiny / Moonshine |
| WebCodecs `VideoDecoder` low-res | Mean-frame-difference motion signal |
| `AudioContext.decodeAudioData` | RMS / energy peaks (reuse exp-25) |
| Zustand store (exp-09) | Candidate list + selected timeline |
| `OffscreenCanvas` 2D | Animated word-by-word caption preview |

## Pipeline

```
source media
  ├─ exp-26 Whisper-tiny / Moonshine ─► word-level transcript with timestamps
  ├─ exp-25 audio-energy ─► RMS over 0.5s windows ─► z-scored energy peaks
  └─ low-res decode (240p, every 2s) ─► mean-frame-difference (motion peaks)

scoring per candidate window (45-90 s default):
  text_score    = signals in (questions, "the one thing", numbers, named entities, lists)
  audio_score   = mean z-energy in window minus surrounding 5 minutes
  motion_score  = mean motion in window minus surrounding 5 minutes
  novelty_score = uniqueness of token distribution vs whole-transcript baseline

ranked_score  = w_text * text_score + w_audio * audio_score
              + w_motion * motion_score + w_novelty * novelty_score
```

Boundaries snap to nearest sentence start/end from the transcript.

## Success Criteria

1. A 60-minute audio-only podcast (no video) yields a top-10 candidate
   list in **under 90 seconds total** on a mid-tier M-series laptop.
2. A 60-minute 1080p video adds < 30 s of motion-analysis overhead.
3. Candidate boundaries land within ±1 word of a sentence start / end
   in 95 %+ of cases (validated against a human-cut reference).
4. "Send to timeline" produces a frame-accurate clip; opens animated
   captions via exp-23 keyframes.
5. Zero outbound bytes during analysis.
6. Re-scoring with new weights (slider drag) updates the ranked list in
   under 100 ms (cached signals).

## Foot-guns

- Whisper-tiny is the latency-optimal model; quality is *just* good
  enough for English boundary detection. For other languages, switch to
  Moonshine (faster) or accept a quality hit.
- Word timestamps from Whisper are approximate (~80 ms jitter); refine
  via forced alignment if exp-26's aligner is present.
- Motion signal at 240p × 2-sec sampling is fine for talking-head
  content; cut sharply produced video (rapid B-roll) needs a denser
  sampling or you miss real visual peaks.
- Heuristic scoring is brittle — surface the per-signal sub-scores so
  power users can re-weight. A later optional cloud LLM rerank (with
  explicit per-clip user consent) is the v2 escape hatch; default
  experience must work entirely on-device.
- Don't auto-cut by default. Show the candidates, let the user pick.
  Opus Clip's biggest weakness is that it cuts for you.

## Demo

- Drop a 1-hour podcast file.
- Live transcript renders progressively (exp-26 streaming).
- Side panel: top-10 candidate clips with thumbnails, transcript
  preview, sub-score bars, and a "send to timeline" button.
- Weight sliders for text / audio / motion / novelty; re-ranks instantly.
- "Privacy check" lamp confirms zero outbound bytes (links to exp-37).
