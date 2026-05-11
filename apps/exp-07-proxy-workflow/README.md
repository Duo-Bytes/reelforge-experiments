# exp-07 · Proxy Workflow

## Purpose

Auto-transcode every ingested source video to a **720p H.264 keyframe-per-frame** proxy in OPFS. The editor scrubs the lightweight proxy on the timeline; the original source stays around in OPFS and is only re-decoded at full resolution during final export. This is how every professional NLE (Premiere, Resolve) handles 4K HEVC media — the browser version inherits the same trick.

## Architecture

```
Main Thread (page.tsx)
├── Pick MP4 -> {INGEST, file, fileId}
├── Display source metadata; "transcode" button -> {TRANSCODE, fileId}
├── Live progress bar + IndexedDB proxy list
└── delete -> {RESET, fileId}

proxy.worker.ts
├── INGEST(file, fileId):
│   ├── Stream-copy source into OPFS via FileSystemSyncAccessHandle (8MB chunks)
│   ├── mp4box demux: codec config, samplesByDts, samplesByPts, durationUs
│   ├── Cache state in `sources: Map<fileId, SourceState>`
│   └── post {INGESTED, ...stats}
├── TRANSCODE(fileId):
│   ├── new VideoDecoder({...src.config})  # source decoder
│   ├── VideoEncoder.isConfigSupported({codec:"avc1.4d0028", 1280x720, 2Mbps})
│   ├── new Output({format: Mp4OutputFormat({fastStart:"in-memory"}), target: BufferTarget})
│   ├── new EncodedVideoPacketSource("avc")
│   ├── output.addVideoTrack(packetSource, {frameRate: targetFps}); await output.start()
│   ├── new VideoEncoder({output: chunk -> packetSource.add(EncodedPacket.fromEncodedChunk(chunk), meta)})
│   ├── OffscreenCanvas(1280, 720) + 2d ctx with {alpha: false} for scaling
│   ├── For each sample (DTS order):
│   │     - throttle decoder & encoder if queueSize > 5
│   │     - file.slice(offset, offset+size).arrayBuffer()
│   │     - decoder.decode(EncodedVideoChunk)
│   │     - drain decoder output -> drawImage(srcFrame, 0, 0, 1280, 720)
│   │                              -> srcFrame.close()
│   │                              -> new VideoFrame(canvas, {timestamp, duration})
│   │                              -> encoder.encode(scaled, {keyFrame: true})
│   │                              -> scaled.close()
│   ├── decoder.flush() -> drain remaining; encoder.flush(); both close()
│   ├── await Promise.all(muxAwaits); output.finalize()
│   ├── Write target.buffer to OPFS as `proxy_<fileId>` via SyncAccessHandle
│   ├── idb.put("proxies", {sourceFileId, proxyFileId, width, height, bitrate, fps, durationUs, proxyBytes, encodedFrames, createdAt})
│   └── post {DONE, meta, elapsedMs}
└── LIST / RESET -> IndexedDB ops + OPFS removeEntry
```

## Research notes

- **Mediabunny v1 muxer is `Output { format: Mp4OutputFormat, target: BufferTarget }`** plus a track source like `EncodedVideoPacketSource("avc")`. Per-packet add via `packetSource.add(EncodedPacket, meta)` — the meta from the first emitted EncodedVideoChunk carries the `decoderConfig.description` bytes the muxer needs. `output.start()` before the first add; `output.finalize()` after all adds settle.
- **`fastStart: "in-memory"`** keeps the moov box at the front of the MP4 — required for fast seek on the proxy. The trade-off is the entire output buffers in RAM; acceptable for short proxies but for long files we'd switch to `"reserve"` + a streaming target.
- **`{ keyFrame: true }` on every `encoder.encode()` call** forces every frame to be an I-frame regardless of the encoder's `keyInterval` config. Some browsers ignore the config-level option, so we set it per-call. Resulting proxy is 3–5× larger than a normal H.264 file but seeks instantly to any frame — for editor scrubbing the storage trade is correct.
- **Read VideoFrame metadata BEFORE `frame.close()`.** `timestamp` and `duration` become undefined after close. We capture them in locals first.
- **`encodeQueueSize > 5` throttle.** Same backpressure pattern as decode (exp-03).
- **Encoder + decoder share hardware.** Some integrated GPUs only support one hardware encoder at a time. In the full editor we'll pause the proxy worker during user-initiated export (exp-10).
- **`EncodedPacket.fromEncodedChunk(chunk)`** wraps a WebCodecs `EncodedVideoChunk` for mediabunny without copying bytes — chunk's data buffer is referenced.
- **Source bytes via `file.slice().arrayBuffer()` per sample** is acceptable for the experiment but slower than a single block-read. Production would block-read by GOP.
- **Metadata schema in IndexedDB** keys on `sourceFileId` so app startup can detect "proxy exists, skip". Includes `proxyBytes` for quota planning.

## Files

| File | Purpose |
|---|---|
| `src/workers/proxy.worker.ts` | INGEST + TRANSCODE + LIST + RESET; mp4box + WebCodecs + mediabunny + idb |
| `src/lib/types.ts` | Shared types from exp-02 |
| `src/app/page.tsx` | Ingest + transcode + progress + IDB proxy list |

## Run

```bash
pnpm --filter exp-07-proxy-workflow dev
```

## Success criteria

| Metric | Target |
|---|---|
| 30s 1080p H.264 source -> 720p proxy | < 90s |
| Proxy seekable instantly at any frame | manual: seek to first / 500th / last |
| Proxy plays without artifact | manual visual spot-check |
| Proxy metadata visible in `idb` | yes, listed in UI |
| Main-thread CPU during transcode | < 2% (all in worker) |
