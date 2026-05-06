# Exp-08 · Audio Sync

## Goal

Decode the audio track of a video file using `AudioDecoder`, play it through an `AudioContext` + `AudioWorklet`, and synchronize video frames to the audio clock — accounting for `AudioContext.outputLatency` so that A/V sync is frame-perfect even with Bluetooth headphones.

---

## App Location

`apps/exp-08-audio-sync/`

## Why This Matters in the Full NLE

Video and audio are decoded separately. Video frames are stamped with discrete timestamps. Audio is a continuous stream. If we just run video rendering at 60fps and audio through AudioContext independently, they will drift — especially with Bluetooth audio, which adds 50–200ms of hardware latency. The `outputLatency` compensation loop ties the video playhead directly to the physical audio output moment.

---

## Key APIs

| API | Purpose |
|---|---|
| `AudioDecoder` | Decode encoded audio samples → `AudioData` objects |
| `AudioDecoder.isConfigSupported(config)` | Check codec support |
| `AudioData.close()` | Release audio buffer memory (mandatory) |
| `AudioContext` | Playback context — created on main thread with user gesture |
| `AudioContext.outputLatency` | Seconds of latency to speakers/headphones |
| `AudioContext.currentTime` | Master clock (in seconds, high precision) |
| `AudioWorkletNode` | Custom audio processor running on the audio thread |
| `SharedArrayBuffer` | Ring buffer between AudioWorker → AudioWorklet |
| `Atomics` | Lock-free ring buffer synchronization |

---

## Architecture

```
AudioWorker (dedicated worker)
├── Demux audio track (exp-02 pattern)
├── AudioDecoder → AudioData objects → PCM samples
└── Writes PCM to SharedArrayBuffer ring buffer (lock-free with Atomics)

Main Thread
├── AudioContext (requires user gesture to create)
├── AudioWorkletNode registered: 'ring-buffer-processor'
│   └── process(): reads from SharedArrayBuffer ring buffer, outputs PCM
└── Synchronization loop (driven by requestAnimationFrame):
    target_video_ts = (audioCtx.currentTime - audioCtx.outputLatency) * 1_000_000
    → request VideoFrame nearest to target_video_ts from render worker
```

**Why `currentTime - outputLatency`?**
`audioCtx.currentTime` reflects when samples were submitted to the audio graph. `outputLatency` is how long before those samples actually reach the speakers/headphones. The video frame that matches the audio currently audible is: `currentTime - outputLatency`. Without this, video lags behind audio by `outputLatency` (up to 200ms on Bluetooth).

---

## Implementation Steps

### 1. Require COOP/COEP headers (SharedArrayBuffer prerequisite)

`SharedArrayBuffer` requires the page to be cross-origin isolated. Verify `next.config.ts` has the headers from the README shared config. Verify by checking `crossOriginIsolated === true` in the browser console.

### 2. Create the ring buffer

```ts
// ring-buffer.ts — shared between AudioWorker and AudioWorklet

const RING_BUFFER_FRAMES = 4096  // ~93ms at 44100Hz — enough for any output latency
const CHANNELS = 2

// Layout: [writeIndex (Int32), readIndex (Int32), data (Float32Array)]
const HEADER_INTS = 2
const DATA_FLOATS = RING_BUFFER_FRAMES * CHANNELS
const BUFFER_BYTES = (HEADER_INTS * 4) + (DATA_FLOATS * 4)

export function createRingBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(BUFFER_BYTES)
}

export function writeToRingBuffer(sab: SharedArrayBuffer, pcm: Float32Array) {
  const header = new Int32Array(sab, 0, 2)
  const data = new Float32Array(sab, 8)
  let writeIdx = Atomics.load(header, 0)

  for (let i = 0; i < pcm.length; i++) {
    data[writeIdx % DATA_FLOATS] = pcm[i]
    writeIdx++
  }

  Atomics.store(header, 0, writeIdx)
}
```

The `AudioWorklet` processor reads from the same `SharedArrayBuffer` lock-free using `Atomics.load`.

### 3. AudioDecoder in the worker

```ts
// audio.worker.ts

const decoder = new AudioDecoder({
  output: (audioData: AudioData) => {
    // Copy PCM samples to ring buffer
    const pcm = new Float32Array(audioData.numberOfFrames * audioData.numberOfChannels)
    audioData.copyTo(pcm, { planeIndex: 0 })  // interleaved copy
    writeToRingBuffer(ringBuffer, pcm)
    audioData.close()  // MANDATORY
  },
  error: (e) => console.error('AudioDecoder error:', e),
})

const support = await AudioDecoder.isConfigSupported({
  codec: 'mp4a.40.2',       // AAC-LC — most common audio codec in MP4
  sampleRate: 44100,
  numberOfChannels: 2,
})
// Also check 'opus' for WebM sources

decoder.configure({
  codec: 'mp4a.40.2',
  sampleRate: 44100,
  numberOfChannels: 2,
  // description: aacDescription,  // required for AAC — extract from mp4box.js like avcC
})

// Feed encoded audio samples (from demuxer, same pattern as video)
for (const audioSample of audioSamples) {
  const bytes = opfsReadRange(audioSample.offset, audioSample.size)
  decoder.decode(new EncodedAudioChunk({
    type: audioSample.isKeyframe ? 'key' : 'delta',
    timestamp: audioSample.timestamp,
    duration: audioSample.duration,
    data: bytes,
  }))
}
await decoder.flush()
```

### 4. AudioWorklet processor

```js
// public/audio-worklet-processor.js
// This file must be served from public/ — AudioWorklet cannot use module imports

class RingBufferProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.sab = options.processorOptions.sharedArrayBuffer
    this.header = new Int32Array(this.sab, 0, 2)
    this.data = new Float32Array(this.sab, 8)
    this.readIdx = 0
  }

  process(inputs, outputs) {
    const output = outputs[0]
    const writeIdx = Atomics.load(this.header, 0)
    const available = writeIdx - this.readIdx

    const L = output[0]
    const R = output[1] || output[0]

    for (let i = 0; i < L.length; i++) {
      if (this.readIdx < writeIdx) {
        const base = (this.readIdx * 2) % this.data.length
        L[i] = this.data[base]
        R[i] = this.data[base + 1]
        this.readIdx++
      } else {
        // Buffer underrun — output silence
        L[i] = 0
        R[i] = 0
      }
    }

    Atomics.store(this.header, 1, this.readIdx)
    return true  // keep processor alive
  }
}

registerProcessor('ring-buffer-processor', RingBufferProcessor)
```

### 5. Initialize AudioContext (main thread, user gesture required)

```ts
// Must be called inside a button click handler — not on mount
async function startAudio(sab: SharedArrayBuffer) {
  const audioCtx = new AudioContext({ sampleRate: 44100 })

  await audioCtx.audioWorklet.addModule('/audio-worklet-processor.js')

  const workletNode = new AudioWorkletNode(audioCtx, 'ring-buffer-processor', {
    processorOptions: { sharedArrayBuffer: sab },
    outputChannelCount: [2],
  })

  workletNode.connect(audioCtx.destination)
  return audioCtx
}
```

### 6. A/V sync loop

```ts
// In the render worker (or main thread rAF loop)

function syncLoop() {
  const targetUs = (audioCtx.currentTime - audioCtx.outputLatency) * 1_000_000
  renderWorker.postMessage({ type: 'SEEK', timestampUs: targetUs })
  requestAnimationFrame(syncLoop)
}
```

On Bluetooth: `outputLatency` is typically 0.1–0.2 seconds. On wired headphones or built-in speakers: 0.003–0.02 seconds. The compensation is critical for Bluetooth users.

---

## AAC Description Bytes

AAC audio in MP4 requires a codec description, just like video. From mp4box.js:

```ts
// Navigate: trak → mdia → minf → stbl → stsd → mp4a → esds
const esds = trak.mdia.minf.stbl.stsd.entries[0].esds
const aacDescription = new Uint8Array(esds.data)  // AudioSpecificConfig bytes
```

Without the description, `AudioDecoder.configure()` will throw for AAC streams.

---

## Known Pitfalls

**`AudioContext` requires a user gesture.**
Chrome blocks `new AudioContext()` (or starts it in `suspended` state) if called without a user interaction. Always call `audioCtx.resume()` inside a button click handler. Check `audioCtx.state === 'running'` before starting playback.

**`AudioWorklet` module path must be absolute from the public root.**
`audioCtx.audioWorklet.addModule('/audio-worklet-processor.js')` — the file must be at `public/audio-worklet-processor.js`. Module imports inside AudioWorklet scripts are not supported in Chrome as of 2024.

**Ring buffer underrun.**
If the `AudioDecoder` is slower than real-time (unlikely for AAC but possible on a slow device), the ring buffer empties and the worklet outputs silence, causing audio glitches. Mitigate by pre-buffering 2× `outputLatency` worth of audio before starting playback.

**`outputLatency` is approximate.**
It's the hardware's reported latency, not a measured round-trip. On some Bluetooth drivers, it under-reports by 20–50ms. Accept this — it's better than no compensation.

**Sync drift over long playback.**
`audioCtx.currentTime` is driven by the audio clock (extremely stable, crystal oscillator). Video frame rendering is driven by `requestAnimationFrame` (vsync-based). Over a long video, small mismatches can accumulate. The A/V sync loop re-anchors every frame — but if the video decoder is slow (cache miss), the video frame shown may be slightly ahead of audio. Accept up to ±1 frame (33ms at 30fps) as within spec.

---

## Success Criteria

| Metric | Target |
|---|---|
| Audio plays without gaps or crackles | Visual waveform + subjective listening |
| A/V sync — wired speakers | ≤ 1 frame off (33ms at 30fps) |
| A/V sync — Bluetooth headphones | ≤ 1 frame off |
| `outputLatency` compensation active | Verify: disable compensation and observe visible sync drift |
| `AudioData.close()` called on every sample | No growing heap after 5 minutes |
| Ring buffer never underruns during normal playback | "Underruns: 0" shown in UI |

---

## Feeds Into

- **Exp-12** integration: the A/V sync loop becomes the master playback clock that drives both the render worker and the audio worklet
