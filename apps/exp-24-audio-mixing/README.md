# exp-24 · Audio Mixing Graph

## Purpose

Build the per-track signal path that a real NLE mix bus needs:

```
Source ─ Gain ─ Pan ─ EQ(LS→P→P→HS) ─ Comp ─ Duck ─→ Master
```

…and prove the **sidechain ducker** can be built without
`DynamicsCompressorNode` (which has no sidechain input) by registering
an `AudioWorkletNode` inline via a Blob URL and feeding it RMS from an
`AnalyserNode` on the sidechain track.

Two tracks are generated procedurally at page load via
`OfflineAudioContext` — a 220 Hz sine (track 1) and a 4-note arpeggio
(track 2). No network deps, no file picker.

## What this scaffold shows

- Real Web Audio graph: `BufferSource → Gain → StereoPanner →
  Biquad×4 → DynamicsCompressor → Gain (duck) → Master`.
- 4-band EQ as four `BiquadFilterNode`s (low-shelf, peak, peak,
  high-shelf), each with frequency + gain UI.
- Per-track compressor with threshold / ratio / attack / release.
- Sidechain ducker as an inline-registered AudioWorklet processor
  driven by an a-rate `AudioParam` (`sidechainRms`).
- Per-track + master level meters drawn from `AnalyserNode`
  `getFloatTimeDomainData`, sampled every `requestAnimationFrame`.
- Latency readout: `baseLatency`, `outputLatency`.
- "Trigger duck" button to make ducking audible without staring at
  meters.

## File map

```
src/app/page.tsx          Track strips, transport, meters, latency
src/lib/test-tones.ts     Procedural test-tone generation
src/lib/mix-graph.ts      Graph wiring (per-track + master)
src/lib/ducker-worklet.ts Inline AudioWorklet processor source
```

## Running

```
pnpm --filter exp-24-audio-mixing dev
```

Then click the page once (autoplay gate) and hit Play. Drag knobs
freely — there should be no glitches.

## Known foot-guns

- Audio is gated behind a user gesture; the page starts in a paused
  state and the AudioContext is resumed on the first click of Play.
- `BiquadFilterNode` can ring at high Q on low sample rates; the UI
  clamps Q ≤ 18.
- The ducker uses RMS sampled at animation-frame rate (~60 Hz). For a
  production ducker, compute RMS inside the worklet itself from a
  shared `Float32Array`.
