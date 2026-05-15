/**
 * 30-second / 1-second-overlap chunking of 16 kHz mono PCM.
 */

import { isVoiced, vadHops } from "./vad";
import type { Chunk } from "./types";

const SAMPLE_RATE = 16_000;
const WINDOW_SEC = 30;
const OVERLAP_SEC = 1;

export function chunkAudio(pcm: Float32Array): Chunk[] {
  const windowSamples = WINDOW_SEC * SAMPLE_RATE;
  const stride = (WINDOW_SEC - OVERLAP_SEC) * SAMPLE_RATE;
  const chunks: Chunk[] = [];
  let index = 0;
  let offset = 0;
  while (offset < pcm.length) {
    const end = Math.min(offset + windowSamples, pcm.length);
    const slice = pcm.subarray(offset, end);
    const hops = vadHops(slice);
    chunks.push({
      index,
      pcm: new Float32Array(slice),
      startSec: offset / SAMPLE_RATE,
      durationSec: slice.length / SAMPLE_RATE,
      voiced: isVoiced(hops),
    });
    index += 1;
    if (end >= pcm.length) break;
    offset += stride;
  }
  return chunks;
}
