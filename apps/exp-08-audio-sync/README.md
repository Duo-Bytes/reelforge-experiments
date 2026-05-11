# exp-08 · Audio Sync

## Purpose

Decode audio with `AudioDecoder`, push samples to a **lock-free SharedArrayBuffer ring buffer**, drain through an `AudioWorkletProcessor` into the `AudioContext` graph, and derive the **video sync target** from `currentTime − outputLatency`. Without that compensation, Bluetooth headphones (50–200ms hardware latency) make the picture lead the sound by an entire frame or more.

## Architecture

```
Main Thread (page.tsx)
├── createRingBuffer() -> SharedArrayBuffer (header[4 ints] + interleaved stereo float data)
├── User-gesture click -> new AudioContext({latencyHint:"interactive"})
│                       -> ctx.audioWorklet.addModule("/audio-worklet-processor.js")
│                       -> new AudioWorkletNode("ring-buffer-processor", {processorOptions:{sab}})
│                       -> node.connect(ctx.destination)
├── Worker.postMessage({type:"START", file, sab})
└── rAF tick: read ctx.outputLatency + ctx.currentTime + ringStats(sab)
              -> videoTargetUs = (currentTime − outputLatency) * 1e6  [if compensate]
              -> shows fill-frames + underrun count

audio.worker.ts
├── Mediabunny: Input({source: BlobSource(file)}) -> getPrimaryAudioTrack()
├── track.getDecoderConfig() -> AudioDecoderConfig (codec, sampleRate, channels, description)
├── AudioDecoder.isConfigSupported(cfg)
├── new AudioDecoder({output:(audioData) => ...})
├── EncodedPacketSink(track) -> getFirstPacket / getNextPacket loop in DECODE order
├── decoder.decode(pkt.toEncodedAudioChunk())  # mediabunny -> WebCodecs bridge
├── output handler:
│     ├── data.copyTo(planar[ch], {planeIndex: ch, format: "f32-planar"})
│     ├── interleave to stereo Float32Array (mono -> duplicate)
│     ├── ringWrite(sab, interleaved)        # Atomics.store on writeIndex
│     └── data.close()                       # MANDATORY
└── decoder.flush() + close() on END

src/lib/ringBuffer.ts (SPSC, lock-free)
├── header: Int32Array(4) at byte 0
│     [0] writeIndex (floats written)  ← producer
│     [1] readIndex  (floats read)     ← consumer
│     [2] capacityFloats
│     [3] underrunCounter              ← bumped by reader on starvation
└── data: Float32Array(capacityFloats) at byte 16, INTERLEAVED stereo

public/audio-worklet-processor.js (must live in public/)
├── extends AudioWorkletProcessor
├── reads SAB constructed from processorOptions.sab (no module imports inside!)
├── process(_, outputs):
│     for each frame: if (r+1 < w) read 2 floats from data[r%cap], data[(r+1)%cap]
│                     else underrun -> emit silence + Atomics.add(header[3], 1)
│     Atomics.store(header[1], r)
└── return true  // keep alive
```

## Research notes

- **`crossOriginIsolated === true`** is mandatory for `SharedArrayBuffer`. The COOP+COEP headers in `next.config.ts` provide this; UI surfaces the boolean so you can confirm before clicking play.
- **`AudioContext` requires a user gesture.** Created inside the play-button click handler, then `await ctx.resume()` if `state === "suspended"`. Created on mount = `suspended` forever.
- **`AudioWorklet` modules cannot use ESM imports.** They are loaded via `audioCtx.audioWorklet.addModule(absolute_url)` and run in a special scope where only globals exist. Putting the file in `public/` and serving by absolute path is the canonical pattern.
- **Mediabunny → WebCodecs bridge** for audio: `EncodedPacket.toEncodedAudioChunk()`. Avoids re-implementing AAC `esds` extraction by hand.
- **AudioData is planar f32 by default.** `data.copyTo(buf, {planeIndex: ch, format: "f32-planar"})` copies one channel. Interleaving to stereo afterwards keeps the SAB layout simple.
- **Mono → stereo duplication** to keep the SAB layout fixed at 2 channels. The worklet always reads pairs.
- **SPSC ring buffer with `Atomics.load/store` only.** No CAS needed because exactly one writer (worker) and one reader (worklet) thread touch each index. Capacity = 16384 frames (~341ms @ 48kHz) gives a comfortable cushion vs typical Bluetooth latency.
- **Underrun = silence + counter bump**, not stall. The audio device must keep producing samples at line rate; emitting zeros is preferable to popping. Underrun counter is read each rAF and surfaces in the UI.
- **`outputLatency` is the spec-friendly number for sync** — it's the device's reported latency from `currentTime` to actual sound output. Subtract it from `currentTime` to find the PTS that should be on screen *now*.
- **Toggle the compensation checkbox at runtime** to feel the difference: the displayed video target jumps by exactly `outputLatency`. Bluetooth headphones make the difference visible.
- **`AudioData.close()` is mandatory.** Each AudioData holds an audio buffer; un-closed buffers fill RAM and the tab eventually OOMs.

## Files

| File | Purpose |
|---|---|
| `src/lib/ringBuffer.ts` | SAB layout + `ringWrite` / `ringStats` / `resetRing` (Atomics) |
| `src/workers/audio.worker.ts` | mediabunny demux + AudioDecoder + interleave + ringWrite |
| `public/audio-worklet-processor.js` | AudioWorkletProcessor reading the SAB into output channels |
| `src/app/page.tsx` | crossOriginIsolated badge, play/stop, sync-clock readout, compensate toggle |
| `next.config.ts` | COOP / COEP (required for SAB) |

## Run

```bash
pnpm --filter exp-08-audio-sync dev
```

## Success criteria

| Metric | Target |
|---|---|
| Audio plays without crackles | manual listen |
| A/V drift wired headphones | ≤ 1 frame (33ms) |
| A/V drift Bluetooth headphones | ≤ 1 frame (with compensation ON) |
| Compensation OFF on Bluetooth | visible drift, proves the loop works |
| `AudioData.close()` on every sample | no growing heap after 5 min |
| Ring underruns during normal playback | 0 |
