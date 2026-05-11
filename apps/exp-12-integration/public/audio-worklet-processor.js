/**
 * Ring-buffer-backed AudioWorkletProcessor.
 * Reads interleaved stereo float samples from SharedArrayBuffer written by
 * the audio decode worker. Emits silence on underrun (and bumps a counter
 * the main thread can read).
 *
 * SAB layout (matches src/lib/ringBuffer.ts):
 *   header: Int32Array(4) at byte 0
 *     [0] writeIndex (floats written, monotonic)
 *     [1] readIndex (floats read,    monotonic)
 *     [2] capacityFloats
 *     [3] underrunCounter
 *   data:   Float32Array(capacityFloats) starting at byte 16
 */

class RingBufferProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sab = options.processorOptions.sab;
    this.header = new Int32Array(sab, 0, 4);
    this.capacity = Atomics.load(this.header, 2);
    this.data = new Float32Array(sab, 16, this.capacity);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const left = out[0];
    const right = out[1] || out[0];
    const frames = left.length;

    let r = Atomics.load(this.header, 1);
    const w = Atomics.load(this.header, 0);
    const cap = this.capacity;

    let underrun = false;
    for (let i = 0; i < frames; i++) {
      if (r + 1 < w) {
        const baseL = r % cap;
        const baseR = (r + 1) % cap;
        left[i] = this.data[baseL];
        right[i] = this.data[baseR];
        r += 2;
      } else {
        left[i] = 0;
        right[i] = 0;
        underrun = true;
      }
    }

    Atomics.store(this.header, 1, r);
    if (underrun) Atomics.add(this.header, 3, 1);
    return true;
  }
}

registerProcessor("ring-buffer-processor", RingBufferProcessor);
