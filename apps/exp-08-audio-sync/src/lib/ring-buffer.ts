/**
 * Lock-free, single-producer-single-consumer ring buffer over SharedArrayBuffer.
 *
 * Layout (all little-endian):
 *   header[0]  Int32  writeFrames  — total frames written since start (monotonic)
 *   header[1]  Int32  readFrames   — total frames consumed by the worklet
 *   header[2]  Int32  underruns    — counter of zero-fill events in worklet
 *   data       Float32Array of FRAMES * CHANNELS interleaved samples
 */

export const RING_FRAMES = 1 << 14 // 16384 frames (~340 ms at 48 kHz)
export const CHANNELS = 2
export const HEADER_INTS = 4

export const HEADER_BYTES = HEADER_INTS * Int32Array.BYTES_PER_ELEMENT
export const DATA_BYTES = RING_FRAMES * CHANNELS * Float32Array.BYTES_PER_ELEMENT
export const TOTAL_BYTES = HEADER_BYTES + DATA_BYTES

export function createRingSAB(): SharedArrayBuffer {
  return new SharedArrayBuffer(TOTAL_BYTES)
}

export function headerView(sab: SharedArrayBuffer): Int32Array {
  return new Int32Array(sab, 0, HEADER_INTS)
}

export function dataView(sab: SharedArrayBuffer): Float32Array {
  return new Float32Array(sab, HEADER_BYTES, RING_FRAMES * CHANNELS)
}

/**
 * Write interleaved stereo PCM into the ring. Returns the number of frames actually
 * written (it may be less than pcm.length / CHANNELS if the consumer is too slow —
 * in that case the oldest data is overwritten and a writer-side overflow counter
 * could be raised, but for this experiment we accept overwrite to keep the audio
 * thread fed without dropping the producer).
 */
export function writeInterleaved(sab: SharedArrayBuffer, pcm: Float32Array): number {
  const header = headerView(sab)
  const data = dataView(sab)
  let writeFrames = Atomics.load(header, 0)
  const frames = pcm.length / CHANNELS
  for (let i = 0; i < frames; i++) {
    const base = (writeFrames % RING_FRAMES) * CHANNELS
    data[base] = pcm[i * CHANNELS]
    data[base + 1] = pcm[i * CHANNELS + 1]
    writeFrames++
  }
  Atomics.store(header, 0, writeFrames)
  return frames
}
