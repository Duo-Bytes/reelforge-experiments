# exp-10 · Export Pipeline

## Purpose

Render every frame of a composition through the **WebGPU compositor** in a worker, encode with `VideoEncoder`, mux into MP4, write to OPFS, then offer a native "Save As" download via `showSaveFilePicker`. Compare **mediabunny** against **mp4-muxer** side by side. Export is the most demanding operation — it must process every frame in order without dropping any (unlike playback which can skip).

## Architecture

```
Main Thread (page.tsx)
├── File input + width/height/fps/bitrate/muxer config
├── postMessage({EXPORT, file, width, height, fps, bitrate, muxer})
├── Status panel: stage / DEMUXED / PROGRESS / DONE
└── On DONE: navigator.storage.getDirectory() -> getFile(...) -> showSaveFilePicker()
              fallback: blob URL <a download>

export.worker.ts
├── 1. Demux source via mp4box (codec config + samples)
├── 2. Init WebGPU on OffscreenCanvas(W,H), pipeline + sampler + uniform buffer
├── 3. Source decoder: VideoDecoder; deliver-by-PTS pattern
│       - per requested target PTS: walk to GOP, feed in DTS order, await frame
├── 4. VideoEncoder.isConfigSupported({codec:"avc1.640028", W, H, bitrate, fps, "quality"})
├── 5. Muxer:
│       - mediabunny: Output({Mp4OutputFormat({fastStart:"in-memory"}), BufferTarget})
│                     EncodedVideoPacketSource("avc") -> output.addVideoTrack(...) -> output.start()
│                     encoder.output -> packetSource.add(EncodedPacket.fromEncodedChunk(chunk), meta)
│       - mp4-muxer:   new Muxer({target: ArrayBufferTarget(), video:{codec:"avc",W,H,frameRate}, fastStart:"in-memory"})
│                     encoder.output -> muxer.addVideoChunk(chunk, meta)
├── 6. Render loop (totalFrames = duration*fps):
│       - getSourceFrame(targetUs) via deliver-by-PTS decoder
│       - importExternalTexture(sourceFrame) -> bindGroup -> draw(6) -> submit
│       - sourceFrame.close()
│       - new VideoFrame(offscreenCanvas, {timestamp, duration})  ← AFTER submit
│       - encoder.encode(out, {keyFrame: i % (2*fps) === 0})
│       - out.close()
│       - throttle while encoder.encodeQueueSize > 5
├── 7. encoder.flush() + close(), source decoder close()
├── 8. mediabunny: await Promise.all(muxAwaits); await output.finalize() -> target.buffer
│    mp4-muxer:   muxer.finalize() -> target.buffer
└── 9. Write buffer to OPFS via SyncAccessHandle, post {DONE, fileName, bytes, frames, elapsedMs, muxer}
```

## Research notes

- **`new VideoFrame(offscreenCanvas)` MUST happen after `device.queue.submit`.** Capture the canvas before submit and you get the previous frame or garbage. Synchronously calling `submit` then constructing the VideoFrame on the next line works because Chrome's WebGPU implementation has finished the canvas swap by then; if it weren't synchronous we'd `await device.queue.onSubmittedWorkDone()`.
- **`fastStart: "in-memory"`** keeps the moov atom buffered in RAM and prepended on finalize so the output is web-streamable (moov before mdat). Trade-off: full mdat in RAM during export. For long files we'd switch to `fragmented` MP4. For the experiment, `in-memory` keeps output simple.
- **mp4-muxer 5.x is officially deprecated** in favor of mediabunny — npm warns on install. We still benchmark it because (a) it has a smaller API surface and (b) the doc explicitly asks for the comparison. mp4-muxer also has a 32-bit offset cap (~2GB total file size) — fails on large exports.
- **Mediabunny v1 muxer takes a `VideoSource`**, not raw `EncodedVideoChunk`. We adapt with `EncodedPacket.fromEncodedChunk(chunk)` and `packetSource.add(...)`. `add` returns a Promise we collect into `muxAwaits` and `Promise.all` before `output.finalize()`.
- **`latencyMode: "quality"`** on the encoder. `realtime` would prioritize low encoder delay over compression efficiency; for export we want the highest quality the encoder can give us at the chosen bitrate.
- **Keyframe interval of 2s** (`i % (2*fps) === 0`). Fine balance: too sparse = slow seek in players, too dense = larger file. 2s is the standard for streaming-friendly MP4.
- **GOP-aware source decode** is critical: per export-frame target PTS, find the keyframe at-or-before, feed in DTS order through the source decoder, await the matching PTS. Otherwise B-frames would arrive out of order and the muxer would reject them.
- **`encoder.encodeQueueSize > 5` throttle** the same as exp-07. Without it the encoder queue grows unbounded and the worker eats GB of RAM per minute of video.
- **Service-worker keep-alive** would prevent Chrome throttling the tab during long exports — out of scope here but planned for exp-12.
- **`showSaveFilePicker` requires user activation** and is gated behind a button click. The fallback blob-URL `<a download>` works without user activation but ignores any "Save As" dialog (browser default download path).
- **Free the VRAM cache before export** would normally happen in exp-12. Here the worker creates its own GPU device, so the cache from exp-06 (in a different worker) doesn't compete.

## Files

| File | Purpose |
|---|---|
| `src/workers/export.worker.ts` | Demux + decode + WebGPU + encode + muxer (both impls) + OPFS write |
| `src/shaders/composite.wgsl.ts` | Inherited from exp-04 (passthrough single-layer composite) |
| `src/lib/types.ts` | Inherited from exp-02 |
| `src/app/page.tsx` | Config form, progress UI, save dialog |

## Run

```bash
pnpm --filter exp-10-export-pipeline dev
```

## Success criteria

| Metric | Target |
|---|---|
| 30s 1080p export | < 120s (2× real-time) |
| Output plays in QuickTime / VLC / Chrome | manual |
| Output duration | within ±0.5s of source |
| No `VideoFrame` leaks during export | heap stable in DevTools |
| mediabunny vs mp4-muxer | both produce valid output; sizes within 5% |
