# Exp-14 · WebCodecs Backpressure & VideoFrame Lifetime Bench

## Goal

Sustain decode → GPU upload → close at 4K60 without growing VRAM, with
explicit `decodeQueueSize` watermarks and a deliberate-leak harness that
proves what happens when the discipline is dropped.

## App Location

`apps/exp-14-backpressure/`

## Why This Matters in the Full NLE

Two failure modes destroy WebCodecs pipelines at scale:

1. **Decoder traffic jam.** Demuxer feeds `decoder.decode()` faster than
   the decoder drains; `decodeQueueSize` climbs; latency explodes.
2. **VideoFrame VRAM leak.** Every VideoFrame holds GPU memory. Dropping
   the JS reference doesn't reclaim it — you must call `.close()`. A
   single missed close in an error or cancel path leaks until OOM.

This experiment isolates both as toggleable harnesses.

## Key APIs

| API | Where used |
|---|---|
| `VideoDecoder.decodeQueueSize` | Read queue depth; pause feed when above HWM |
| `VideoFrame.close()` | Release GPU memory; close-mode toggle |
| `performance.memory.usedJSHeapSize` | Chrome-only JS heap measurement |

## Architecture

```
Main (page.tsx) → BenchWorker
  ├── mp4box demux → samplesByDts[]
  ├── VideoDecoder, prefer-hardware
  ├── feed loop:
  │     if backpressure: await while decodeQueueSize >= HWM
  │     decoder.decode(EncodedVideoChunk(s))
  ├── output(frame):
  │     decoded++; outstanding++
  │     if close-mode: frame.close(); outstanding--
  │     else: leak (drop ref without close)
  └── setInterval(200ms) → postMessage METRICS
```

## Controls

- **Backpressure on/off.** HWM 4–8 recommended.
- **Close mode: close vs leak.** Watch outstanding-frame count and Chrome
  Task Manager GPU memory column.
- **Iterations.** Loop the file N times.

## Success Criteria

1. backpressure=on, close=close: sustained real-time playback;
   `peakQueueSize ≤ HWM`; outstanding ≤ HWM; flat JS heap over 60 s.
2. backpressure=off, close=close: short clips work; long ones show queue
   climbing without bound.
3. leak=on: outstanding grows monotonically; Chrome Task Manager GPU
   memory grows steadily; reload to reclaim.

## Foot-guns

- `frame.close()` must be unconditional in every output path including
  error, abort, cache eviction, hot-reload.
- Awaiting in the output callback runs after Chrome has expired any
  external-texture binding; close in the callback.
- Hot-reload during dev can re-instantiate workers — terminate
  explicitly in `useEffect` cleanup.
