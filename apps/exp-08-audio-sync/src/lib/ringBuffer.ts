/**
 * Lock-free SPSC ring buffer over SharedArrayBuffer.
 *
 * Layout:
 *   header: Int32Array(4) at byte 0
 *     [0] writeIndex (mono-incremented, modulo capacity in data ops)
 *     [1] readIndex
 *     [2] capacityFloats     (channels * frames)
 *     [3] underrunCounter    (incremented by reader on starvation)
 *   data:   Float32Array(capacityFloats) starting at byte 16, INTERLEAVED stereo
 *
 * Producer: AudioWorker. Consumer: AudioWorklet processor (single thread each).
 * Atomics.load/store on the indices is enough for SPSC; no CAS needed.
 */

export const HEADER_INTS = 4;
export const DEFAULT_FRAMES = 1 << 14; // 16384 frames @ 48kHz ~ 341 ms
export const DEFAULT_CHANNELS = 2;

export function bufferBytesFor(frames: number, channels: number): number {
  return HEADER_INTS * 4 + frames * channels * 4;
}

export function createRingBuffer(
  frames = DEFAULT_FRAMES,
  channels = DEFAULT_CHANNELS,
): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(bufferBytesFor(frames, channels));
  const header = new Int32Array(sab, 0, HEADER_INTS);
  Atomics.store(header, 2, frames * channels); // capacityFloats
  return sab;
}

/** Worker: write interleaved float samples. Drops oldest if reader is too slow. */
export function ringWrite(sab: SharedArrayBuffer, samples: Float32Array): void {
  const header = new Int32Array(sab, 0, HEADER_INTS);
  const capacity = Atomics.load(header, 2);
  const data = new Float32Array(sab, HEADER_INTS * 4, capacity);
  let w = Atomics.load(header, 0);
  for (let i = 0; i < samples.length; i++) {
    data[w % capacity] = samples[i];
    w++;
  }
  Atomics.store(header, 0, w);
}

/** Reader: report current write/read counters + underrun count. */
export function ringStats(sab: SharedArrayBuffer): {
  writeIndex: number;
  readIndex: number;
  capacityFloats: number;
  underruns: number;
  fillFrames: number;
} {
  const header = new Int32Array(sab, 0, HEADER_INTS);
  const w = Atomics.load(header, 0);
  const r = Atomics.load(header, 1);
  const capacity = Atomics.load(header, 2);
  const underruns = Atomics.load(header, 3);
  const fillFloats = Math.max(0, w - r);
  // Stereo: 2 floats per frame
  return {
    writeIndex: w,
    readIndex: r,
    capacityFloats: capacity,
    underruns,
    fillFrames: Math.floor(fillFloats / 2),
  };
}

export function resetRing(sab: SharedArrayBuffer): void {
  const header = new Int32Array(sab, 0, HEADER_INTS);
  Atomics.store(header, 0, 0);
  Atomics.store(header, 1, 0);
  Atomics.store(header, 3, 0);
}
