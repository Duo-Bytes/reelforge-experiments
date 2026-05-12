# exp-14 · WebCodecs Backpressure & VideoFrame Lifetime Bench

## Purpose

Two failure modes destroy every WebCodecs pipeline at scale:

1. **Decoder traffic jam** — demuxer feeds `decoder.decode()` faster than
   the decoder drains; `decodeQueueSize` climbs unboundedly; per-frame
   latency explodes.
2. **VideoFrame VRAM leak** — every `VideoFrame` holds GPU memory. Dropping
   the JS reference doesn't reclaim it; you must call `.close()`. A missed
   close in any error/cancel/cache-eviction path silently leaks until OOM.

This experiment isolates both as toggleable harnesses and measures the
result.

## Architecture

```
Main (page.tsx)
└── BenchWorker (workers/bench.worker.ts)
    ├── mp4box demux              → samplesByDts[]
    ├── VideoDecoder              ← prefer-hardware
    ├── for s in samplesByDts:
    │     if backpressure:
    │         while decodeQueueSize >= HWM: await microtask
    │     decoder.decode(EncodedVideoChunk(s))
    ├── output(frame):
    │     decoded++; outstanding++
    │     if closeMode == close: frame.close(); closed++; outstanding--
    │     else: leak (drop ref without close)
    └── setInterval(200ms) → postMessage METRICS
                              { decoded, closed, outstanding,
                                currentQueueSize, peakQueueSize,
                                rollingFps, jsHeapMb }
```

## Controls

- **Backpressure on/off.**
  - On: pause feeding when `decodeQueueSize >= highWaterMark`. Recommended
    HWM in production: 4–8.
  - Off: spin-feed everything as fast as `decode()` returns.
- **Close mode.**
  - `close()` — correct discipline. `outstanding` stays low.
  - `leak` — deliberately drops the frame without calling `.close()`.
    `outstanding` grows unboundedly, JS heap usually doesn't reflect it
    (GPU memory is opaque to V8) — watch Chrome Task Manager → GPU process.
- **High-water mark / iterations.** Loop the file N times to extend the
  measurement window.

## Live metrics

- `decoded` — total frames the decoder has emitted
- `closed` — number that have been explicitly `.close()`d
- `outstanding = decoded - closed` — alive VideoFrames in memory
- `currentQueueSize` — `decoder.decodeQueueSize` right now
- `peakQueueSize` — max ever observed
- `rollingFps` — frames decoded in the last second
- `avgDecodeIntervalMs` — mean inter-output spacing
- `jsHeapMb` — `performance.memory.usedJSHeapSize` (Chrome only)
- sparkline charts queue depth (gray) + outstanding (orange) over time

## Success criteria

1. **backpressure=on, close=close** sustains real-time playback (rolling fps
   ≥ source fps) with `peakQueueSize ≤ HWM` and `outstanding ≤ HWM`. JS heap
   is flat over a 60-s run.
2. **backpressure=off, close=close** still works on short clips but
   `peakQueueSize` climbs unbounded on long ones; latency from feed to
   output grows.
3. **leak=on** shows `outstanding` growing monotonically with `decoded`,
   regardless of backpressure setting. The Chrome Task Manager (Shift+Esc)
   GPU process memory column grows steadily and is recovered only by
   reloading the tab.

## Known foot-guns this exposes

- `frame.close()` discipline must be unconditional in every output path —
  including errors, aborts, cache eviction, hot-reload, and effects
  cleanup.
- `await` in the decoder's output callback runs after Chrome has already
  expired any external-texture reference; close frames in that callback.
- Hot-reload during dev can re-instantiate workers without terminating the
  previous one — terminate explicitly in the cleanup return of every
  `useEffect`.

## Running

```
pnpm --filter exp-14-backpressure dev
```
