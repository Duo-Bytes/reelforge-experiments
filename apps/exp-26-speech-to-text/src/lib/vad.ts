/**
 * Very lightweight RMS-based VAD for exp-26.
 *
 * Computes RMS over 30 ms hops on 16 kHz mono PCM. A chunk is
 * considered "voiced" if at least 5% of its hops exceed the threshold.
 * This is good enough to skip pure-silence chunks; real production
 * VAD (Silero, WebRTC) is a more involved drop-in.
 */

const HOP_MS = 30;
const SAMPLE_RATE = 16_000;
const THRESHOLD_DBFS = -45;
const VOICED_FRACTION = 0.05;

export type VadHops = Float32Array;

export function vadHops(pcm: Float32Array): VadHops {
  const hopSamples = Math.floor((HOP_MS / 1000) * SAMPLE_RATE);
  const hopCount = Math.floor(pcm.length / hopSamples);
  const out = new Float32Array(hopCount);
  for (let h = 0; h < hopCount; h += 1) {
    let sum = 0;
    const start = h * hopSamples;
    for (let i = 0; i < hopSamples; i += 1) {
      const v = pcm[start + i]!;
      sum += v * v;
    }
    out[h] = Math.sqrt(sum / hopSamples);
  }
  return out;
}

export function isVoiced(hops: VadHops): boolean {
  const thresholdLin = 10 ** (THRESHOLD_DBFS / 20);
  let voicedHops = 0;
  for (let i = 0; i < hops.length; i += 1) {
    if (hops[i]! > thresholdLin) voicedHops += 1;
  }
  return voicedHops >= hops.length * VOICED_FRACTION;
}

/** Returns indices (in seconds) where the signal is voiced. Used to
 * place mock words on the timing axis. */
export function voicedRegions(hops: VadHops): { startSec: number; endSec: number }[] {
  const regions: { startSec: number; endSec: number }[] = [];
  const thresholdLin = 10 ** (THRESHOLD_DBFS / 20);
  let inRegion = false;
  let regionStart = 0;
  for (let i = 0; i < hops.length; i += 1) {
    const isHigh = hops[i]! > thresholdLin;
    if (isHigh && !inRegion) {
      inRegion = true;
      regionStart = i;
    } else if (!isHigh && inRegion) {
      inRegion = false;
      regions.push({
        startSec: (regionStart * HOP_MS) / 1000,
        endSec: (i * HOP_MS) / 1000,
      });
    }
  }
  if (inRegion) {
    regions.push({
      startSec: (regionStart * HOP_MS) / 1000,
      endSec: (hops.length * HOP_MS) / 1000,
    });
  }
  return regions;
}
