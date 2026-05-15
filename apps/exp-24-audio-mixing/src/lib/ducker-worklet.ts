/**
 * Inline AudioWorklet processor source for the sidechain ducker.
 *
 * Registered at runtime via a Blob URL — no separate worker file needed.
 * The processor reads a single a-rate AudioParam ("sidechainRms") that
 * the main thread updates each animation frame from an AnalyserNode on
 * the sidechain track. It outputs the input multiplied by
 * (1 - clamp(rms * sensitivity, 0, depth)) shaped by a one-pole
 * attack/release smoother.
 *
 * NOTE: for true sample-accurate ducking you would compute RMS inside
 * the processor itself from a sidechain input. This shape favours
 * legibility for the experiment.
 */

const PROCESSOR_SOURCE = /* javascript */ `
class DuckerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "sidechainRms",
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: "a-rate",
      },
      {
        name: "depth",
        defaultValue: 0.8,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate",
      },
      {
        name: "sensitivity",
        defaultValue: 4,
        minValue: 0.1,
        maxValue: 20,
        automationRate: "k-rate",
      },
      {
        name: "attackMs",
        defaultValue: 6,
        minValue: 0.1,
        maxValue: 200,
        automationRate: "k-rate",
      },
      {
        name: "releaseMs",
        defaultValue: 120,
        minValue: 1,
        maxValue: 2000,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();
    this._smoothed = 1;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const rms = parameters.sidechainRms;
    const depth = parameters.depth[0];
    const sensitivity = parameters.sensitivity[0];
    const attackMs = parameters.attackMs[0];
    const releaseMs = parameters.releaseMs[0];
    const sr = sampleRate;
    const aCoef = Math.exp(-1 / ((attackMs / 1000) * sr));
    const rCoef = Math.exp(-1 / ((releaseMs / 1000) * sr));
    const channels = input.length;
    const samples = input[0].length;
    for (let i = 0; i < samples; i += 1) {
      const r = rms.length > 1 ? rms[i] : rms[0];
      const target = 1 - Math.max(0, Math.min(depth, r * sensitivity));
      const coef = target < this._smoothed ? aCoef : rCoef;
      this._smoothed = target + coef * (this._smoothed - target);
      for (let c = 0; c < channels; c += 1) {
        output[c][i] = input[c][i] * this._smoothed;
      }
    }
    return true;
  }
}

registerProcessor("ducker", DuckerProcessor);
`;

let cachedUrl: string | null = null;

export function getDuckerWorkletUrl(): string {
  if (cachedUrl) return cachedUrl;
  const blob = new Blob([PROCESSOR_SOURCE], { type: "application/javascript" });
  cachedUrl = URL.createObjectURL(blob);
  return cachedUrl;
}

export function disposeDuckerWorkletUrl(): void {
  if (cachedUrl) {
    URL.revokeObjectURL(cachedUrl);
    cachedUrl = null;
  }
}
