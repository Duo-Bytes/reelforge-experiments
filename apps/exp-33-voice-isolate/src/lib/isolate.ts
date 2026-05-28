// STFT spectrogram + A/B metrics for exp-33.
//
// The actual denoise runs in workers/denoise.worker.ts (RNNoise WASM).
// Decode/resample/WAV live in @reelforge/audio; this module handles the
// dry/wet visualisation + level-reduction metric.

import { decodeToMono } from "@reelforge/audio";

export { encodeWav } from "@reelforge/audio";

const FFT_SIZE = 512;
const HOP = 256;
const TARGET_RATE = 48000; // RNNoise operates at 48 kHz.

export type SpectrumRow = { mag: Float32Array };

/** Decode any container to 48 kHz mono Float32 — the RNNoise input rate. */
export function decodeTo48kMono(file: File): Promise<{
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
}> {
  return decodeToMono(file, TARGET_RATE);
}

export function analyzeAB(
  dry: Float32Array,
  wet: Float32Array,
): { drySpec: SpectrumRow[]; wetSpec: SpectrumRow[]; reductionDb: number } {
  const drySpec = stft(dry);
  const wetSpec = stft(wet);
  return { drySpec, wetSpec, reductionDb: rmsReductionDb(dry, wet) };
}

/** RMS level reduction in dB (dry vs wet). Positive = quieter output. */
function rmsReductionDb(dry: Float32Array, wet: Float32Array): number {
  const rms = (xs: Float32Array): number => {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[i] * xs[i];
    return Math.sqrt(s / Math.max(1, xs.length));
  };
  const d = rms(dry);
  const w = rms(wet);
  if (w === 0 || d === 0) return 0;
  return 20 * Math.log10(d / w);
}

function stft(samples: Float32Array): SpectrumRow[] {
  const rows: SpectrumRow[] = [];
  const window = hann(FFT_SIZE);
  // Cap the number of columns so multi-minute clips don't blow up the
  // naive DFT; stride proportionally to cover the whole signal.
  const frameCount = Math.max(1, Math.floor((samples.length - FFT_SIZE) / HOP));
  const maxCols = 512;
  const stride = Math.max(1, Math.ceil(frameCount / maxCols));
  for (let f = 0; f < frameCount; f += stride) {
    const i = f * HOP;
    const frame = new Float32Array(FFT_SIZE);
    for (let j = 0; j < FFT_SIZE; j++) frame[j] = samples[i + j] * window[j];
    rows.push({ mag: dftMagnitudes(frame) });
  }
  return rows;
}

// Naive DFT. Fine for visualisation; replace with a real FFT for production.
function dftMagnitudes(frame: Float32Array): Float32Array {
  const n = frame.length;
  const bins = n / 2;
  const out = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      re += frame[t] * Math.cos(ang);
      im += frame[t] * Math.sin(ang);
    }
    out[k] = Math.sqrt(re * re + im * im) / n;
  }
  return out;
}

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}
