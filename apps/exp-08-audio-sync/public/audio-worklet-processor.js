// Runs on the audio rendering thread. Cannot use ES module imports.
// Layout must match src/lib/ring-buffer.ts:
//   header[0] = writeFrames
//   header[1] = readFrames
//   header[2] = underruns
//   data      = Float32, interleaved stereo, length = RING_FRAMES * 2

const RING_FRAMES = 1 << 14
const CHANNELS = 2
const HEADER_BYTES = 4 * 4

class RingBufferProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const sab = options.processorOptions.sab
    this.header = new Int32Array(sab, 0, 4)
    this.data = new Float32Array(sab, HEADER_BYTES, RING_FRAMES * CHANNELS)
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const L = out[0]
    const R = out[1] ?? out[0]
    const writeFrames = Atomics.load(this.header, 0)
    let readFrames = Atomics.load(this.header, 1)
    let underruns = Atomics.load(this.header, 2)

    const n = L.length
    for (let i = 0; i < n; i++) {
      if (readFrames < writeFrames) {
        const base = (readFrames % RING_FRAMES) * CHANNELS
        L[i] = this.data[base]
        R[i] = this.data[base + 1]
        readFrames++
      } else {
        L[i] = 0
        if (R !== L) R[i] = 0
        underruns++
      }
    }

    Atomics.store(this.header, 1, readFrames)
    Atomics.store(this.header, 2, underruns)
    return true
  }
}

registerProcessor('ring-buffer-processor', RingBufferProcessor)
