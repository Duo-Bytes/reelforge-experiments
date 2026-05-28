// Audio decode + STFT spectrogram + A/B metrics for exp-33.
//
// The actual denoise runs in workers/denoise.worker.ts (RNNoise WASM).
// This module only handles decode/resample to the model's 48 kHz mono
// input and the dry/wet visualisation + level-reduction metric.

const FFT_SIZE = 512;
const HOP = 256;
const TARGET_RATE = 48000; // RNNoise operates at 48 kHz.

export type SpectrumRow = { mag: Float32Array };

/** Decode any container to 48 kHz mono Float32 — the RNNoise input rate. */
export async function decodeTo48kMono(file: File): Promise<{
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
}> {
  const buf = await file.arrayBuffer();
  const tmp = new AudioContext();
  const decoded = await tmp.decodeAudioData(buf.slice(0));
  await tmp.close();

  const offline = new OfflineAudioContext(
    1,
    Math.max(1, Math.ceil(decoded.duration * TARGET_RATE)),
    TARGET_RATE,
  );
  const src = offline.createBufferSource();
  src.buffer = decoded;
  if (decoded.numberOfChannels === 1) {
    src.connect(offline.destination);
  } else {
    const merger = offline.createGain();
    merger.gain.value = 1 / decoded.numberOfChannels;
    src.connect(merger);
    merger.connect(offline.destination);
  }
  src.start();
  const rendered = await offline.startRendering();
  return {
    samples: rendered.getChannelData(0),
    sampleRate: TARGET_RATE,
    durationSec: decoded.duration,
  };
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

/** Encode mono Float32 PCM to a 16-bit WAV blob for playback / download. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataSize = samples.length * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  wstr(36, "data");
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    off += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}
