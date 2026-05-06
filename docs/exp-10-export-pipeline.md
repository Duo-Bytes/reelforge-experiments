# Exp-10 · Export Pipeline

## Goal

Export a multi-clip timeline composition to an MP4 file: WebGPU compositor renders each frame → `VideoEncoder` compresses it → muxer writes the container → user downloads from OPFS via `showSaveFilePicker()`. Benchmark both `mediabunny` and `mp4-muxer` and pick one.

---

## App Location

`apps/exp-10-export-pipeline/`

## Why This Matters in the Full NLE

Export is the most resource-intensive operation. Unlike playback (capped at 60fps, frames can be dropped), export must process every frame, in order, without dropping any. This experiment proves:
1. The WebGPU → VideoEncoder path works without memory leaks
2. The muxer writes a valid MP4 that plays in standard players
3. `encodeQueueSize` throttling prevents encoder saturation
4. Exporting to OPFS then offering a file download is the correct flow (not accumulating a huge ArrayBuffer in RAM)

---

## Key APIs

| API | Purpose |
|---|---|
| `VideoEncoder` | Compress `VideoFrame` objects → `EncodedVideoChunk` |
| `VideoEncoder.isConfigSupported(config)` | Check hardware encoder |
| `encoder.encodeQueueSize` | Throttle if > 5 |
| `encoder.flush()` | Force emit all pending chunks before muxer finalize |
| `new VideoFrame(canvas)` | Capture WebGPU OffscreenCanvas output as VideoFrame |
| `showSaveFilePicker()` | Native "Save As" dialog |
| `FileSystemWritableFileStream` | Stream OPFS file to user download |
| mediabunny | Primary muxer (no 2GB limit, TypeScript) |
| mp4-muxer | Comparison muxer (evaluate both) |

---

## Architecture

```
ExportWorker
│
├── Phase 1 — Setup
│   ├── Read timeline JSON from main thread
│   ├── Close VRAM frame cache (exp-06) to free GPU memory for encoder
│   └── Configure VideoEncoder + muxer
│
├── Phase 2 — Render Loop (uncapped, as fast as hardware allows)
│   For each frame timestamp T from t=0 to t=duration, step=1/fps:
│   ├── Get VideoFrame for each active clip at T from OPFS source (not proxy)
│   ├── Run WebGPU compositor at T (same WGSL pipeline as exp-04)
│   ├── Capture output: new VideoFrame(offscreenCanvas)
│   ├── encoder.encode(capturedFrame, { keyFrame: isKeyframeInterval })
│   ├── capturedFrame.close()
│   └── postMessage({ type: 'EXPORT_PROGRESS', percent })
│
├── Phase 3 — Finalize
│   ├── await encoder.flush()
│   ├── muxer.finalize()
│   └── postMessage({ type: 'EXPORT_DONE', opfsFileId })
│
└── Main Thread on EXPORT_DONE:
    └── showSaveFilePicker() → stream OPFS file to user
```

---

## Implementation Steps

### 1. Configure VideoEncoder for export

```ts
const exportConfig: VideoEncoderConfig = {
  codec: 'avc1.640028',       // H.264 High Profile — maximum compatibility
  width: 1920,
  height: 1080,
  bitrate: 8_000_000,          // 8Mbps — good quality for 1080p
  framerate: 30,
  latencyMode: 'quality',      // NOT 'realtime' — we want maximum quality, not low latency
  bitrateMode: 'variable',
}

// Rule of thumb for bitrate: 0.07 * fps * width * height / compression_factor
// For H.264 at 1080p30: 0.07 * 30 * 1920 * 1080 / ~50000 ≈ 8Mbps

const support = await VideoEncoder.isConfigSupported(exportConfig)
if (!support.supported) throw new Error('Export codec not supported')
```

### 2. Collect EncodedVideoChunks and feed to muxer

```ts
const chunks: EncodedVideoChunk[] = []
const muxerChunkMeta: EncodedVideoChunkMetadata[] = []

const encoder = new VideoEncoder({
  output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => {
    // DO NOT accumulate in memory if using streaming muxer
    // With mediabunny streaming target: muxer.addVideoChunk(chunk, meta)
    // With ArrayBufferTarget: accumulate (risky for long videos)
    muxer.addVideoChunk(chunk, meta)
  },
  error: (e) => { throw e },
})
encoder.configure(exportConfig)
```

### 3. The export render loop

```ts
const FPS = 30
const FRAME_DURATION_US = 1_000_000 / FPS
const GOP_INTERVAL = 2 * FPS  // keyframe every 2 seconds

let currentUs = 0

while (currentUs < totalDurationUs) {
  // Throttle: don't flood encoder queue
  while (encoder.encodeQueueSize > 5) {
    await new Promise(r => setTimeout(r, 1))
  }

  // Get source frames for all active clips at currentUs
  // (Use source file, not proxy — this is the export path)
  const activeClips = getActiveClipsAt(currentUs, timelineClips)
  const frames = await Promise.all(
    activeClips.map(clip => decodeSourceFrameAt(clip, currentUs))
  )

  // Run WebGPU compositor
  renderCompositorFrame(device, pipeline, frames, currentUs)
  // frames are closed inside renderCompositorFrame after submit

  // Capture output from OffscreenCanvas
  const outputFrame = new VideoFrame(offscreenCanvas, {
    timestamp: currentUs,
    duration: FRAME_DURATION_US,
  })

  const isKeyFrame = (currentUs / FRAME_DURATION_US) % GOP_INTERVAL === 0
  encoder.encode(outputFrame, { keyFrame: isKeyFrame })
  outputFrame.close()  // release immediately after encode() call

  self.postMessage({
    type: 'EXPORT_PROGRESS',
    percent: (currentUs / totalDurationUs) * 100,
  })

  currentUs += FRAME_DURATION_US
}

await encoder.flush()
```

### 4. mediabunny muxer setup (OPFS streaming)

```ts
import { Muxer, StreamTarget } from 'mediabunny'

// Write directly to OPFS — never accumulate full file in RAM
const root = await navigator.storage.getDirectory()
const exportHandle = await root.getFileHandle('export_output.mp4', { create: true })
const syncHandle = await exportHandle.createSyncAccessHandle()
let writeOffset = 0

const muxer = new Muxer({
  target: new StreamTarget({
    write: (data: Uint8Array, position: number) => {
      syncHandle.write(data, { at: position })
    },
    close: () => {
      syncHandle.flush()
      syncHandle.close()
    },
  }),
  video: {
    codec: 'avc',
    width: 1920,
    height: 1080,
    frameRate: 30,
  },
  fastStart: 'in-memory',  // buffer moov in RAM, write mdat streaming
  // 'in-memory' keeps the moov (metadata) in RAM while mdat streams to disk
  // On finalize(), moov is prepended to the OPFS file
  // This is the web-optimized layout (moov before mdat)
})
```

**Note on `fastStart`:** Without `fastStart: 'in-memory'`, mediabunny writes mdat first and moov at the end. The file is valid but not streamable. With `'in-memory'`, the moov is buffered in RAM during encoding (typically <10MB for metadata) and written at the front when `muxer.finalize()` is called.

### 5. mp4-muxer comparison

Build an identical pipeline using `mp4-muxer`:

```ts
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

const muxerTarget = new ArrayBufferTarget()
const muxer = new Muxer({
  target: muxerTarget,
  video: { codec: 'avc', width: 1920, height: 1080 },
  fastStart: 'in-memory',
})
// After encoder.flush() + muxer.finalize():
const { buffer } = muxerTarget
// Write entire buffer to OPFS
```

**mp4-muxer limitation:** 2GB file size cap (uses 32-bit offsets internally). For videos longer than ~30 minutes at 8Mbps, this fails. mediabunny handles larger files. For this experiment (short test clips), both should work.

### 6. Offer the file for download

```ts
// Main thread, called after EXPORT_DONE message:

async function downloadExport(opfsFileId: string) {
  const root = await navigator.storage.getDirectory()
  const fileHandle = await root.getFileHandle(opfsFileId)
  const file = await fileHandle.getFile()

  // Use showSaveFilePicker for a native "Save As" dialog
  try {
    const saveHandle = await showSaveFilePicker({
      suggestedName: 'export.mp4',
      types: [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }],
    })
    const writable = await saveHandle.createWritable()
    await file.stream().pipeTo(writable)
  } catch (e) {
    // User cancelled — fallback to blob URL download
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = 'export.mp4'
    a.click()
    URL.revokeObjectURL(url)
  }
}
```

---

## Performance: Source Decode During Export

The export loop re-decodes source files (not proxies). For a 1080p H.264 source at 30fps, the decoder must emit 30 frames per second. If it can't keep up (complex codec, slow device), the export takes longer than real-time. This is acceptable — export is not real-time.

If the source is 4K HEVC, decoding 30fps may saturate the hardware decoder. In this case, export on a per-frame basis becomes a bottleneck. Future optimization: batch-decode GOPs and cache them during export.

---

## Service Worker for Tab Keep-Alive

During long exports, Chrome may throttle the background tab and slow down the export loop. Add a service worker that prevents throttling:

```js
// public/sw.js
self.addEventListener('install', e => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(clients.claim()))
// A minimal service worker just needs to exist — its presence prevents tab throttling
```

Register in the Next.js app and show the user a warning: "Keep this tab in focus for fastest export."

---

## Known Pitfalls

**`new VideoFrame(canvas)` must be called AFTER `device.queue.submit()`.**
If you capture the canvas before the GPU has finished writing to it, you get the previous frame (or garbage). Always `await device.queue.onSubmittedWorkDone()` or just ensure the render call is synchronous before capturing.

**Closing the frame cache during export.**
The VRAM cache (exp-06) holds GPUTextures. The VideoEncoder also needs GPU memory. On low-VRAM devices, running both simultaneously causes `GPUOutOfMemory`. At export start, call `vramCache.clear()` to free all cached textures.

**`encoder.flush()` must complete before `muxer.finalize()`.**
`flush()` returns a Promise. Await it — don't call `finalize()` on the next tick.

**`EncodedVideoChunk` timestamp monotonicity.**
The muxer requires chunks to arrive in monotonically increasing timestamp order. Since we encode frame-by-frame in order, this is guaranteed. But if you ever parallelize encoding, be careful.

---

## Success Criteria

| Metric | Target |
|---|---|
| 30s 1080p 2-track timeline → MP4 | Completes without crash |
| Output MP4 plays in VLC, Chrome, QuickTime | Visual verification |
| Output MP4 has correct duration | Within ±0.5 seconds |
| A/V sync in output file | ≤ 1 frame off |
| No VideoFrame leaks during export | Heap stable |
| Export time for 30s clip | < 120 seconds (2× real-time or faster) |
| mediabunny vs mp4-muxer comparison | Documented: API, output size, any failures |

---

## Feeds Into

- **Exp-12** uses the export pipeline directly — the export button in the integration app triggers this worker
