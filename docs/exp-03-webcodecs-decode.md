# Exp-03 · WebCodecs Decode

## Goal

Feed GOP byte ranges from exp-02's seek index into a `VideoDecoder`, receive `VideoFrame` objects, and render the frame at a specific target timestamp to a `<canvas>`. Prove frame-accurate seeking on a real 1080p H.264 file.

---

## App Location

`apps/exp-03-webcodecs-decode/`

## Why This Matters in the Full NLE

This is the core decode pipeline. Everything visual in the editor depends on being able to say "give me the frame at timestamp T" and get back a pixel-accurate `VideoFrame`. The HTML5 `<video>` element cannot do this — it snaps to keyframes. `VideoDecoder` gives us exact frames at any timestamp.

---

## Key APIs

| API | Purpose |
|---|---|
| `VideoDecoder.isConfigSupported(config)` | Check hardware support before configuring |
| `new VideoDecoder({ output, error })` | Create decoder with output frame callback |
| `decoder.configure(config)` | Set codec, dimensions, description bytes |
| `decoder.decode(chunk)` | Feed one `EncodedVideoChunk` |
| `decoder.flush()` | Force emit all buffered frames |
| `decoder.close()` | Release hardware decoder resources |
| `new EncodedVideoChunk({ type, timestamp, duration, data })` | Wrap raw sample bytes |
| `VideoFrame.close()` | **MANDATORY** — releases GPU texture memory |
| `decoder.decodeQueueSize` | Backpressure indicator — throttle if > 5 |

---

## Architecture

```
DecodeWorker
├── Receives: { type: 'SEEK', targetUs: number }
├── Calls DemuxModule.getSamplesForGOP(targetUs) → VideoSample[]
├── For each sample: reads bytes from OPFS via OPFSModule.readRange()
├── Feeds each sample into VideoDecoder.decode(EncodedVideoChunk)
├── In output callback: captures frame where frame.timestamp === targetUs
│   (closes all other frames immediately)
└── postMessage({ type: 'FRAME', frame }, [frame])  ← transfer, don't clone
```

---

## Implementation Steps

### 1. Check hardware support first

```ts
const config = {
  codec: 'avc1.640028',      // from exp-02 demuxer
  codedWidth: 1920,
  codedHeight: 1080,
  description: avcCBytes,    // Uint8Array from exp-02
}

const support = await VideoDecoder.isConfigSupported(config)
if (!support.supported) {
  throw new Error(`Codec not supported: ${config.codec}`)
}
```

Call this once at startup, not on every seek. If not supported, the experiment cannot continue (Chrome should support avc1 universally).

### 2. Initialize the VideoDecoder

```ts
let pendingFrames: VideoFrame[] = []
let targetTimestamp: number | null = null

const decoder = new VideoDecoder({
  output: (frame: VideoFrame) => {
    if (frame.timestamp === targetTimestamp) {
      // This is the frame we want — send it to main thread
      // Transfer the frame (not clone — VideoFrame is Transferable)
      self.postMessage({ type: 'FRAME', frame }, [frame as unknown as Transferable])
      targetTimestamp = null
    } else {
      // Not the target frame — close immediately to free GPU memory
      frame.close()
    }
  },
  error: (e: DOMException) => {
    console.error('VideoDecoder error:', e)
  },
})

decoder.configure(config)
```

**Important:** `VideoFrame` implements `Transferable`. To transfer it via `postMessage`, add it to the transfer array: `postMessage(msg, [frame])`. If you forget the transfer array, it's structured-cloned, which copies the pixel data to RAM — expensive and unnecessary.

### 3. Decode a GOP for a target timestamp

```ts
async function decodeFrameAt(targetUs: number) {
  targetTimestamp = targetUs
  const samples = getSamplesForGOP(targetUs)  // from exp-02 module

  for (const sample of samples) {
    // Throttle: don't flood the decoder queue
    while (decoder.decodeQueueSize > 5) {
      await new Promise(r => setTimeout(r, 1))
    }

    const bytes = opfsReadRange(sample.offset, sample.size)  // from exp-01 module

    decoder.decode(new EncodedVideoChunk({
      type: sample.isKeyframe ? 'key' : 'delta',
      timestamp: sample.timestamp,   // microseconds
      duration: sample.duration,     // microseconds
      data: bytes,
    }))
  }

  await decoder.flush()
  // After flush(), the output callback will have fired for every frame in the GOP
}
```

### 4. Render the VideoFrame to canvas on the main thread

```tsx
// In the 'use client' page component
workerRef.current.onmessage = (e) => {
  if (e.data.type === 'FRAME') {
    const frame: VideoFrame = e.data.frame
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
    frame.close()  // MANDATORY — release GPU texture
  }
}
```

### 5. Build the UI

- File picker → ingest to OPFS → demux
- Slider: "Seek to frame" (0 to totalFrames)
- Canvas: shows the decoded frame
- Metrics display: decode latency (time from SEEK message to FRAME received), `decodeQueueSize` peak
- "Stress test" button: seek to 100 random timestamps and log median latency

---

## Handling B-Frames (DTS vs PTS)

Some H.264 files use B-frames. In this case:
- **DTS (Decode Time Stamp)**: order in which frames must be fed to the decoder
- **PTS (Presentation Time Stamp / CTS)**: order in which frames are displayed to the user

The `EncodedVideoChunk.timestamp` field must be the **PTS** (what you want to display). The samples must be fed to `decoder.decode()` in **DTS order**.

From exp-02, `VideoSample.timestamp` is PTS. The DTS order is the order they appear in the OPFS file (the file stores samples in DTS order). So feed them in array order, but use PTS for the `timestamp` field.

To match the output frame to the target, compare `frame.timestamp` (which is the PTS you passed in) to `targetUs`.

---

## Known Pitfalls

**`frame.close()` is not optional.**
Every `VideoFrame` emitted by the decoder occupies GPU texture memory. If you fail to close frames, the browser will run out of GPU memory after a few hundred seeks and crash the tab. Close every frame in the output callback — immediately after use.

**`decoder.flush()` is async and resolves BEFORE the last output callback fires.**
`await decoder.flush()` does NOT mean all frames have been emitted when the promise resolves. It means the decoder has processed all queued chunks. The output callbacks fire asynchronously. To know when the target frame arrived, use the `targetTimestamp` sentinel in the output callback (as shown above), not a promise from `flush()`.

**Never call `decoder.decode()` after `decoder.flush()` resolves on the same decoder instance.**
After `flush()`, the decoder is idle but still configured. You can call `decode()` again for the next seek. But if you call `decoder.close()` between seeks, you must call `configure()` again. For the hot seek path, keep the decoder open and reuse it.

**`description` field format.**
The `description` in `decoder.configure()` must be the raw `avcC`/`hvcC` box body as a `Uint8Array` — NOT base64, NOT the full box with its 8-byte size+type header. Getting this wrong causes a `DOMException: EncodedVideoChunk is not decodable` on the first keyframe.

**`decodeQueueSize` > 10 causes decoder saturation.**
If you feed frames faster than the hardware decoder processes them, the queue grows and eventually the decoder throws. Keep `decodeQueueSize < 5` by inserting a `setTimeout(0)` yield before each `decode()` call when the queue is high.

**GOP size.**
Long GOPs (e.g., 250 frames at 30fps = 8+ seconds) mean seeking to a point 7 seconds after a keyframe requires decoding 7 seconds worth of delta frames before emitting the target frame. During proxy generation (exp-07), we fix this by encoding proxies with `keyframeInterval: 1`. For the source file, this is unavoidable — it's a hardware limitation.

---

## Success Criteria

| Metric | Target |
|---|---|
| Seek to frame at any timestamp (cold, no cache) | < 500ms |
| Seek to keyframe specifically | < 100ms |
| No VideoFrame leaks after 200 seeks | Heap stable in DevTools |
| Frame at target timestamp visually correct | Manual verification |
| `decoder.decodeQueueSize` never exceeds 8 | Logged in UI |

---

## Feeds Into

- **Exp-04** takes the `VideoFrame` from this experiment and imports it as a WebGPU `texture_external`
- **Exp-06** wraps the decode call from this experiment inside a 3-tier cache
- **Exp-07** uses a `VideoDecoder` instance (same pattern) to read source frames for proxy transcoding
- **Exp-08** applies the same `AudioDecoder` pattern for audio
