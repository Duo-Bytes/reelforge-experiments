# Exp-25 · Waveform Generation & Filmstrip Thumbnails

## Goal

Build the offline-on-ingest data products that make a timeline scroll
at any zoom level for free: multi-resolution audio peak data
(256/4096/65536-sample bins) computed in a worker and persisted to
OPFS, plus filmstrip thumbnail strips for video clips. Once written,
the editor never re-decodes for waveform or scrub thumbnails.

## App Location

`apps/exp-25-waveforms/`

## Why This Matters in the Full NLE

A timeline editor that re-reads audio buffers at every zoom level is
unusable on long clips. BBC's waveform-data.js standardised the
"min/max per bin, multiple resolutions" peak file format precisely
because the alternative — drawing from raw samples — does not scale.
For video, scrub-thumbnail strips ("filmstrips") let the user navigate
without decoding back to the most recent keyframe; they are
table-stakes UX and there is no built-in API.

## Key APIs

| API | Where used |
|---|---|
| `AudioContext.decodeAudioData` | Decode source audio to `Float32Array` |
| `Worker` (module worker) | Compute peaks off-main-thread |
| `OffscreenCanvas` + 2D context | Draw peaks at requested zoom |
| `navigator.storage.getDirectory()` (OPFS) | Persistent cache for peaks + thumbnails |
| `VideoDecoder` (WebCodecs) | Decode keyframes for filmstrip |
| `createImageBitmap(blob, { resizeWidth })` | GPU downscale to thumbnail size |

## Peak file format

```
header  { magic: u32, version: u16, channels: u16, sampleRate: u32,
          sampleCount: u32, lodCount: u16, binSizes: u16[lodCount] }
lod[i]  { binCount: u32, data: Int16Array  // [min0, max0, min1, max1, ...] }
```

Three LODs (bin sizes 256, 4096, 65536) cover everything from
zoomed-in single-sample inspection to a 30-minute project rendered to
~6000 columns. min/max are int16 — sufficient for pixel-accurate draws.

## Pipeline

1. **Decode**. `AudioContext.decodeAudioData` (or for the fallback,
   synthesise a 50 Hz → 4 kHz chirp via `OfflineAudioContext`).
2. **Hash + lookup OPFS**. SHA-256 over `(channelData[0], duration)`
   → `/waveforms/{hash}.peaks`. If present, mmap and skip step 3.
3. **Worker peak build**. Transfer the underlying `ArrayBuffer` into
   the worker. The worker walks the samples and writes 3 LOD arrays.
4. **Persist**. The worker writes the file to OPFS, posts back a
   handle.
5. **Render**. Main thread picks an LOD based on viewport seconds-per-
   pixel and draws min/max columns to a canvas. Pan with mouse drag.

## Filmstrip pipeline

For video input, decode at GOP keyframes only via `VideoDecoder` (skip
delta frames; speed > quality), downscale through
`createImageBitmap(frame, { resizeWidth: 160 })`, lay out as a row of
ImageBitmaps. Cache to OPFS as a single packed PNG sprite plus a JSON
manifest of timestamps. When no video input is provided, the app
generates a synthetic filmstrip from canvas gradients so the page is
interactive without user input.

## UI

- File picker (audio + video). Fallback button: "use synthetic
  source".
- Zoom slider (samples-per-pixel, logarithmic). Pan with click-drag.
- Canvas waveform that picks the right LOD automatically; readout of
  current LOD + bins read.
- Below: filmstrip canvas with per-thumb timestamps.
- Stats: decode time, peak-build time, OPFS bytes, redraw time per
  zoom change.

## Success Criteria

1. A 30-minute audio file builds peaks in under 4 s on a typical
   laptop (worker-side).
2. Zooming + panning a built waveform redraws in < 4 ms per frame.
3. Second page load with the same file is instant — peaks read from
   OPFS, no decode required.
4. Filmstrip scrubbing decodes only keyframes (verify via decoder
   stats); 1080p video produces a strip in seconds, not minutes.

## Foot-guns

- `decodeAudioData` runs on the main thread internally in many
  browsers — for very long files prefer streaming/WASM decode.
- Worker `Float32Array` transfer detaches the source buffer; if the
  main thread still needs the samples for playback, keep a copy or
  pass a `SharedArrayBuffer`.
- OPFS files are private to origin and not exposed to user; document
  this — users will expect them in Downloads.
- `createImageBitmap` `resizeQuality: "high"` is slower than
  `"medium"`; for filmstrips, `"medium"` is fine.
- Bin boundaries that don't align with channel boundaries cause subtle
  pixel-off-by-one on the last column; explicitly handle the tail.
