# Exp-24 · Audio Mixing Graph (Gain/Pan/EQ/Compression/Ducking)

## Goal

Build a real multi-track mix bus in the browser: per-track gain, stereo
pan, 4-band EQ, dynamics compressor, and sidechain ducking — all running
glitch-free in the audio thread under a normal 60 fps render load.
Demonstrate that the Web Audio graph is enough for the mixer the
timeline needs (exp-08 covers sync, not mixing).

## App Location

`apps/exp-24-audio-mixing/`

## Why This Matters in the Full NLE

A timeline editor without a mixer is a toy. Real NLEs need per-clip
gain automation, voice-over ducking under music, simple corrective EQ,
and a global limiter on the master bus. `DynamicsCompressorNode` does
not expose a true sidechain input — so ducking needs an
`AudioWorkletNode` that reads the sidechain RMS and drives a gain on
the target track. Once that pattern is proven, the same shape extends
to any custom DSP (de-esser, gate, limiter) running in WASM.

## Key APIs

| API | Where used |
|---|---|
| `AudioContext` / `OfflineAudioContext` | Live graph + offline test-tone generation |
| `AudioBufferSourceNode` | Per-track playback source |
| `GainNode`, `StereoPannerNode` | Per-track gain + pan |
| `BiquadFilterNode` x4 | 4-band EQ: lowshelf / peaking / peaking / highshelf |
| `DynamicsCompressorNode` | Per-track compressor |
| `AnalyserNode` + `getFloatTimeDomainData` | Sidechain RMS + level meters |
| `AudioWorkletNode` (inline Blob URL) | Sidechain ducker DSP processor |
| `AudioContext.baseLatency` / `outputLatency` | Latency readout |

## Pipeline (per track)

```
BufferSource ─ Gain(automation) ─ Pan ─ EQ(LS→P→P→HS) ─ Comp ─ DuckGain ─→ Master ─ Limiter ─ Destination
                                                                              │
Sidechain track ─ Analyser ─ (worklet pulls RMS) ─ modulates ─────────────────┘
```

Test tones are generated procedurally at page load using
`OfflineAudioContext` (220 Hz sine for track 1; a four-note chord
arpeggio for track 2). Zero network dependencies.

## AudioWorklet Ducker

The processor is registered inline via a Blob URL — avoids any extra
worker file plumbing. The processor consumes a control parameter
`sidechainRms` (a-rate `AudioParam`) and outputs `1 - clamp(rms * k, 0, 1)`
shaped by attack/release time-constants. The host updates the param
from the main thread once per animation frame by sampling the
sidechain analyser.

## UI

- Two columns of track strips: gain knob, pan slider, four EQ band
  cells (freq + gain), compressor threshold/ratio/attack/release.
- Master strip with limiter + master gain.
- Transport: play, pause, stop, loop.
- A "Trigger duck" button pulses the sidechain modulation to make the
  effect audible without staring at meters.
- Level meters (per-track + master) drawn from `requestAnimationFrame`
  reading `AnalyserNode.getFloatTimeDomainData`.
- Latency readout: `baseLatency`, `outputLatency`, audio render
  quantum.

## Success Criteria

1. No xruns or audible glitches while dragging knobs on two tracks
   simultaneously.
2. Sidechain duck is audibly correct (target track gain drops when
   sidechain is loud) and parameters (threshold/attack/release) behave
   monotonically.
3. Master output stays under 0 dBFS true peak with the limiter on
   regardless of source gain.
4. Total round-trip latency under 30 ms on a typical laptop.

## Foot-guns

- `DynamicsCompressorNode` has no sidechain input. Anything labeled
  "ducking" must be implemented as an AudioWorklet or via gain
  automation driven from main-thread RMS.
- `AnalyserNode.getFloatTimeDomainData` is a snapshot; without
  sufficient sampling rate (every animation frame at most) the RMS
  envelope can miss transients.
- AudioWorklet code runs in a separate realm — you cannot share
  closures. Pass config via `AudioWorkletNode` constructor options or
  `port.postMessage`.
- `AudioContext` must be resumed after a user gesture; Chrome blocks
  autoplay aggressively.
- `BiquadFilterNode` is one IIR per channel; resonant peaks at low
  sample rates can be unstable. Clamp Q ≤ 18.
