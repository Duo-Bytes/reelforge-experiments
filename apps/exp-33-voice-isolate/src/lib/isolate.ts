// Decode + minimal STFT + placeholder spectral-subtraction denoiser for exp-33.
// Replace the denoiser body with DeepFilterNet3 ONNX inference for v2.

const FFT_SIZE = 512;
const HOP = 256;

export type SpectrumRow = { mag: Float32Array };

export async function decodeMix(file: File): Promise<{
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
}> {
  const buf = await file.arrayBuffer();
  const tmp = new AudioContext();
  const decoded = await tmp.decodeAudioData(buf.slice(0));
  await tmp.close();
  // mono downmix
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / decoded.numberOfChannels;
  }
  return { samples: mono, sampleRate: decoded.sampleRate, durationSec: decoded.duration };
}

export function runEnergyAB(samples: Float32Array, _sampleRate: number): {
  drySpec: SpectrumRow[];
  wetSpec: SpectrumRow[];
  snrImprovement: number;
} {
  const dry = stft(samples);
  // Estimate noise floor as the per-bin 20th percentile across time.
  const noiseFloor = estimateNoiseFloor(dry);
  // Spectral subtraction: clamp(mag - 1.5 * noiseFloor, 0).
  // This is a stand-in for the real DNN denoiser.
  const wet: SpectrumRow[] = dry.map((row) => {
    const m = new Float32Array(row.mag.length);
    for (let i = 0; i < row.mag.length; i++) {
      m[i] = Math.max(0, row.mag[i] - 1.5 * noiseFloor[i]);
    }
    return { mag: m };
  });
  return {
    drySpec: dry,
    wetSpec: wet,
    snrImprovement: snrDelta(dry, wet),
  };
}

function stft(samples: Float32Array): SpectrumRow[] {
  const rows: SpectrumRow[] = [];
  const window = hann(FFT_SIZE);
  for (let i = 0; i + FFT_SIZE <= samples.length; i += HOP) {
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

function estimateNoiseFloor(spec: SpectrumRow[]): Float32Array {
  const bins = spec[0].mag.length;
  const out = new Float32Array(bins);
  const col: number[] = new Array(spec.length);
  for (let b = 0; b < bins; b++) {
    for (let t = 0; t < spec.length; t++) col[t] = spec[t].mag[b];
    col.sort((a, c) => a - c);
    out[b] = col[Math.floor(col.length * 0.2)];
  }
  return out;
}

function snrDelta(dry: SpectrumRow[], wet: SpectrumRow[]): number {
  let dryE = 0;
  let wetE = 0;
  for (let t = 0; t < dry.length; t++) {
    for (let b = 0; b < dry[t].mag.length; b++) {
      dryE += dry[t].mag[b] * dry[t].mag[b];
      wetE += wet[t].mag[b] * wet[t].mag[b];
    }
  }
  if (wetE === 0) return 0;
  return 10 * Math.log10(dryE / wetE);
}
