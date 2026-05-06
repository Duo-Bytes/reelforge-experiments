# Exp-07 · Proxy Workflow

## Goal

On file ingest, automatically transcode the source video to a 720p H.264 proxy file in OPFS using a background Web Worker. The editor uses the proxy for all timeline scrubbing. The original source file is used only during final export.

---

## App Location

`apps/exp-07-proxy-workflow/`

## Why This Matters in the Full NLE

Scrubbing a 4K HEVC file requires the hardware decoder to work very hard. Multiple 4K clips on a timeline simultaneously is infeasible for most machines. Proxy workflow solves this: the timeline always scrubs lightweight 720p H.264 proxies (fast to decode, small GOP), while export uses the full-resolution originals. This is standard practice in professional NLEs (Premiere Pro, DaVinci Resolve).

---

## Key APIs

| API | Purpose |
|---|---|
| `VideoDecoder` | Decode source frames (same as exp-03) |
| `VideoEncoder` | Encode frames to 720p H.264 proxy |
| `VideoEncoder.isConfigSupported(config)` | Check hardware encoder availability |
| `encoder.encodeQueueSize` | Backpressure — throttle input if > 5 |
| `encoder.flush()` | Force emit all pending EncodedVideoChunks |
| `VideoFrame.close()` | Release decoded source frame after encoding |
| mediabunny | Mux EncodedVideoChunks into MP4 container → OPFS |
| IndexedDB (`idb` library) | Store proxy metadata (sourceFileId → proxyFileId, status) |

---

## Architecture

```
ProxyWorker (starts automatically on file ingest)
│
├── Read source from OPFS (via OPFSModule, exp-01)
├── Demux source with mp4box.js (exp-02)
├── Decode each frame with VideoDecoder (exp-03 pattern)
├── Scale each VideoFrame to 720p
├── Encode with VideoEncoder (H.264, 720p, keyframeInterval: 1)
├── Feed EncodedVideoChunks to mediabunny muxer
├── Muxer writes directly to OPFS proxy file (via SyncAccessHandle)
├── Progress: postMessage({ type: 'PROXY_PROGRESS', percent }) to main thread
└── On complete:
    ├── Store proxy metadata in IndexedDB
    └── postMessage({ type: 'PROXY_READY', sourceFileId, proxyFileId })
```

---

## Implementation Steps

### 1. Configure the proxy VideoEncoder

```ts
const encoderConfig: VideoEncoderConfig = {
  codec: 'avc1.4d0028',   // H.264 High Profile, Level 4.0 — widely hardware-supported
  width: 1280,
  height: 720,
  bitrate: 2_000_000,      // 2Mbps — good quality at 720p
  framerate: 30,
  latencyMode: 'quality',  // 'realtime' for live encoding, 'quality' for export
  bitrateMode: 'variable',
  keyInterval: 1,          // EVERY FRAME IS A KEYFRAME
  // keyInterval: 1 creates a large file but allows instant seek at any frame
  // This is intentional for proxies — seek speed > file size
}

const support = await VideoEncoder.isConfigSupported(encoderConfig)
if (!support.supported) {
  // Fallback: try 'avc1.42001e' (H.264 Baseline) or 'vp8'
  throw new Error('H.264 encoding not supported')
}
```

**Why `keyInterval: 1`?**
A proxy with every frame as a keyframe can seek to ANY frame instantly — the decoder never needs to decode a preceding GOP. The file is ~3-5× larger than a normal H.264 file, but for a 720p proxy this is acceptable (30s clip → ~200MB proxy). If OPFS quota is tight, use `keyInterval: 15` (GOP of 0.5s at 30fps) and build a seek index for the proxy (same as exp-02 for the source).

### 2. Scale source frames to 720p

`VideoDecoder` emits `VideoFrame` objects at the source resolution (e.g., 3840×2160). We need to scale to 1280×720 before encoding. The cleanest way is to draw to an OffscreenCanvas:

```ts
const scaleCanvas = new OffscreenCanvas(1280, 720)
const scaleCtx = scaleCanvas.getContext('2d')!

function scaleFrame(sourceFrame: VideoFrame): VideoFrame {
  scaleCtx.drawImage(sourceFrame, 0, 0, 1280, 720)
  sourceFrame.close()  // release source immediately

  // Wrap the scaled canvas as a VideoFrame
  return new VideoFrame(scaleCanvas, {
    timestamp: sourceFrame.timestamp,
    duration: sourceFrame.duration,
  })
}
```

**Note:** `sourceFrame.timestamp` and `sourceFrame.duration` must be read BEFORE calling `frame.close()`. After close, these properties are undefined.

### 3. The encoding loop

```ts
const encoder = new VideoEncoder({
  output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => {
    muxer.addVideoChunk(chunk, meta)  // feed to mediabunny
  },
  error: (e) => console.error('Encoder error:', e),
})

encoder.configure(encoderConfig)

// Decode and encode all frames
for (const sample of allSamples) {
  // Throttle encoder — don't let queue grow unbounded
  while (encoder.encodeQueueSize > 5) {
    await new Promise(r => setTimeout(r, 1))
  }

  const sourceFrame = await decodeFrameAt(sample.timestamp)  // exp-03 pattern
  const scaledFrame = scaleFrame(sourceFrame)
  encoder.encode(scaledFrame, { keyFrame: true })  // force keyframe every frame
  scaledFrame.close()

  self.postMessage({
    type: 'PROXY_PROGRESS',
    percent: (sample.timestamp / totalDurationUs) * 100
  })
}

await encoder.flush()
// After flush, all EncodedVideoChunks have been passed to the muxer output callback
muxer.finalize()  // write moov atom / finalize MP4
```

### 4. Mux with mediabunny to OPFS

```ts
import { Muxer, ArrayBufferTarget } from 'mediabunny'
// Check mediabunny's API for writing directly to OPFS SyncAccessHandle
// If mediabunny supports a streaming target, use that to avoid loading full file in RAM

const muxer = new Muxer({
  target: new ArrayBufferTarget(),  // or OPFS streaming target if available
  video: {
    codec: 'avc',
    width: 1280,
    height: 720,
    frameRate: 30,
  },
})

// On encoder output:
muxer.addVideoChunk(chunk, meta)

// After encoder.flush():
muxer.finalize()

// Write result to OPFS
const proxyId = `proxy_${sourceFileId}`
const root = await navigator.storage.getDirectory()
const handle = await root.getFileHandle(proxyId, { create: true })
const syncHandle = await handle.createSyncAccessHandle()
const { buffer } = muxer.target as ArrayBufferTarget
syncHandle.write(new Uint8Array(buffer), { at: 0 })
syncHandle.flush()
syncHandle.close()
```

If mediabunny supports a streaming OPFS target (write chunks as they're produced instead of buffering everything), use that to avoid holding the entire proxy MP4 in RAM.

### 5. Store proxy metadata in IndexedDB

```ts
import { openDB } from 'idb'

const db = await openDB('reelforge', 1, {
  upgrade(db) {
    db.createObjectStore('proxies', { keyPath: 'sourceFileId' })
  },
})

await db.put('proxies', {
  sourceFileId,
  proxyFileId: proxyId,
  status: 'ready',
  width: 1280,
  height: 720,
  durationUs: totalDurationUs,
  createdAt: Date.now(),
})
```

On app startup, check this store to know which files already have proxies (skip re-transcoding).

---

## Known Pitfalls

**`keyInterval` vs `keyFrame` parameter.**
Some browsers ignore `keyInterval` in the `VideoEncoderConfig` (it's not in all spec versions). As a fallback, pass `{ keyFrame: true }` on every `encoder.encode()` call explicitly, which overrides the config-level setting.

**Concurrent encoder limitation.**
Some devices (especially integrated GPUs) only support one hardware `VideoEncoder` instance at a time. If the export pipeline (exp-10) creates a second encoder while the proxy worker is running, one of them will fail with `OperationError`. The proxy worker should be paused during export.

**`VideoFrame` from `OffscreenCanvas` timestamp.**
`new VideoFrame(canvas, { timestamp, duration })` — if you forget `timestamp`, the frame gets timestamp 0 and the muxer produces a corrupt file. Always pass timestamp and duration explicitly.

**mediabunny API is newer and less documented.**
If you hit blockers, fall back to `mp4-muxer` for this experiment. mp4-muxer's API is `new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', ... } })` and it works similarly. Document which library you used and why.

**Proxy size.**
A 30-second 1080p source file with keyframe-per-frame proxy at 720p 2Mbps = approximately 7.5MB per second = 225MB for 30s. Warn users if OPFS quota is insufficient.

---

## Success Criteria

| Metric | Target |
|---|---|
| 30s 1080p H.264 source → 720p proxy | < 90 seconds |
| Proxy is seekable instantly at ANY frame | Verified: seek to frame 1, frame 500, last frame |
| Proxy plays without artifact | Visual spot-check on 5 random frames |
| Proxy metadata in IndexedDB | Readable with `idb` |
| ProxyWorker runs entirely in background | Main thread shows < 2% CPU during transcoding |

---

## Feeds Into

- **Exp-10** export pipeline: after compositing with proxy frames, swap proxy VideoSamples for source VideoSamples to re-decode at full resolution for the final encode
- **Exp-12** uses proxy availability from IndexedDB to decide which file to decode during timeline scrubbing
