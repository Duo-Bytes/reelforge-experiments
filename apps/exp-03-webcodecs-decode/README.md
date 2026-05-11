# exp-03 · WebCodecs Decode

## Purpose

Feed GOP byte ranges from the exp-02 seek index into a `VideoDecoder` and emit a `VideoFrame` at any **arbitrary PTS** — not just at keyframes (HTML5 `<video>` snaps to keyframes; we need pixel-accurate seeks for editor scrubbing). Also stress-test the decoder under random seek pressure.

## Architecture

```
Main Thread (page.tsx)
├── File input -> postMessage({type:"LOAD", file}) -> decode worker
├── Slider / preset buttons -> postMessage({type:"SEEK", reqId, targetUs})
├── Stress button -> postMessage({type:"STRESS", iterations:100})
└── On {type:"FRAME"} -> ctx.drawImage(frame, 0, 0); frame.close()  # MANDATORY

decode.worker.ts
├── LOAD:
│   ├── mp4box demux as in exp-02 -> samples + codec config
│   ├── VideoDecoder.isConfigSupported(...) check
│   ├── new VideoDecoder({output: handleFrame, error}) + decoder.configure(...)
│   └── post LOADED with sampleCount, keyframeCount, durationUs, elapsedMs
├── SEEK(targetUs):
│   ├── binary search samplesByPts -> targetIdx
│   ├── walk to GOP boundary (preceding keyframe .. next keyframe)
│   ├── filter samplesByDts to GOP set (feed in DTS order, NOT PTS order)
│   ├── single block-read: file.slice(minOff, maxOff).arrayBuffer()  # one I/O
│   ├── for each sample: throttle while decodeQueueSize>5; decoder.decode(EncodedVideoChunk)
│   ├── decoder.flush()  # async; returns BEFORE final output callbacks fire
│   └── handleFrame: if frame.timestamp === targetTimestampUs -> postMessage(frame, [frame])
│                    else -> frame.close()
└── STRESS: 100 random seeks via internal Promise loop, report median/p95/peakQueueSize
```

## Research notes

- **`VideoFrame.close()` is mandatory.** Each `VideoFrame` holds a GPU texture. Forget to close and the tab dies after a few hundred seeks. Close every non-target frame in the output callback and the target frame after `drawImage`.
- **`flush()` resolves before all frames emit.** Don't `await flush()` and assume frames have arrived. Use a sentinel match on `frame.timestamp === targetTimestampUs` instead.
- **PTS vs DTS.** B-frames have `cts !== dts`. Feed in DTS order (sample array file order), but tag each `EncodedVideoChunk.timestamp = ptsUs` so output frames are addressable by PTS.
- **`description` bytes** must be the raw `avcC`/`hvcC` body. Wrong format = `EncodedVideoChunk is not decodable` on first keyframe. exp-02 already serializes correctly.
- **`decodeQueueSize > 10` saturates the decoder.** Throttle by yielding `setTimeout(0)` while `> 5`.
- **Block-read optimization.** Reading per-sample via OPFS would mean N small `read()` calls per seek. We instead compute `minOffset..maxOffset` for the GOP and slice once — single ArrayBuffer, then `subarray()` per sample. ~10× faster for typical GOPs.
- **Long GOPs are unavoidable on the source.** A 250-frame GOP at 30fps means seeking to T+8s from a keyframe requires decoding 8s of delta frames first. Proxy generation (exp-07) sets `keyframeInterval: 1` on the proxy to fix scrubbing.
- **VideoFrame is Transferable.** Always include in `postMessage` transfer list — otherwise structured-clone copies pixels to RAM.

## Files

| File | Purpose |
|---|---|
| `src/lib/types.ts` | shared with exp-02 (`VideoSample`, `CodecConfig`, `GopRange`) |
| `src/workers/decode.worker.ts` | demux + VideoDecoder + GOP block-read + stress loop |
| `src/app/page.tsx` | seek slider, presets, canvas render, last-seek + stress panels |

## Run

```bash
pnpm --filter exp-03-webcodecs-decode dev
```

## Success criteria

| Metric | Target |
|---|---|
| Cold seek to arbitrary timestamp | < 500ms |
| Seek directly to a keyframe | < 100ms |
| 200 seeks, no `VideoFrame` leaks | heap stable in DevTools |
| `decoder.decodeQueueSize` never > 8 | reported in UI |
| Frame visually matches expected timestamp | manual |
