# exp-25 · Waveforms & Filmstrip Thumbnails

## Purpose

Multi-resolution audio peak data generated in a worker, persisted to
OPFS, redrawn at any zoom without re-decoding. Plus a filmstrip
section for video clips.

## Peak format

| LOD | Bin size | Bytes / sec @ 48 kHz |
|---|---|---|
| 0   | 256       | ~750 |
| 1   | 4096      | ~47 |
| 2   | 65536     | ~3 |

Each bin stores `(min, max)` as Int16. The viewport picks the LOD
whose bin size is closest to the current samples-per-pixel.

## File map

```
src/app/page.tsx           Canvas waveform + filmstrip + zoom/pan
src/lib/peak-format.ts     Header packing / unpacking
src/lib/opfs.ts            Read/write OPFS helpers
src/lib/synth.ts           Synthetic chirp + filmstrip generators
src/lib/draw.ts            Canvas drawing (peaks + filmstrip)
src/workers/peaks.worker.ts  Compute LOD bins off-main
```

## What this shows

- File picker for audio. Fallback: 30 s chirp 50 Hz → 4 kHz synthesised
  via `OfflineAudioContext` so the page is interactive without input.
- Hash → OPFS lookup, then worker peak-build. Transfer ownership of
  the `Float32Array` buffer to the worker.
- Three LODs. UI zoom slider picks one automatically.
- Pan with mouse drag.
- Filmstrip: synthetic gradient strip (or, when a video is picked,
  WebCodecs decode at keyframes → `createImageBitmap` downscale).

## Running

```
pnpm --filter exp-25-waveforms dev
```

## Stats shown

- Decode time (ms).
- Peak-build time (ms, worker round trip).
- OPFS bytes written.
- Redraw time per zoom change (ms).

## Foot-guns

- `Float32Array.buffer` transferred to a worker detaches the source.
  If you need playback, copy first.
- Bin boundaries on the last bin: the tail is partial; handle
  explicitly or the right-edge pixel of the waveform jitters during
  zoom.
- OPFS is private to origin; users don't see it in Finder/Explorer.
