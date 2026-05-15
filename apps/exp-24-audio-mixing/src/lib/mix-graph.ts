/**
 * Per-track signal path + master bus wiring.
 *
 *  Source ─ Gain ─ Pan ─ EQ(LS→P→P→HS) ─ Comp ─ Duck ─→ Master ─ Limiter ─ Out
 *
 * The "Duck" stage is an AudioWorkletNode driven by an a-rate AudioParam
 * ("sidechainRms"). The host samples the sidechain Analyser every
 * animation frame and writes to the param.
 */

import { getDuckerWorkletUrl } from "./ducker-worklet";

export type EqBandParams = {
  freq: number;
  gain: number;
  q: number;
};

export type CompressorParams = {
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  knee: number;
};

export type DuckerParams = {
  depth: number;
  sensitivity: number;
  attackMs: number;
  releaseMs: number;
};

export type TrackHandle = {
  source: AudioBufferSourceNode | null;
  gain: GainNode;
  pan: StereoPannerNode;
  eq: BiquadFilterNode[]; // [LS, P, P, HS]
  comp: DynamicsCompressorNode;
  duck: AudioWorkletNode;
  analyser: AnalyserNode;
  sidechainAnalyser: AnalyserNode;
};

export type MixGraph = {
  ctx: AudioContext;
  tracks: TrackHandle[];
  master: GainNode;
  limiter: DynamicsCompressorNode;
  masterAnalyser: AnalyserNode;
};

export async function createMixGraph(
  buffers: AudioBuffer[],
): Promise<MixGraph> {
  const ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.audioWorklet.addModule(getDuckerWorkletUrl());

  const limiter = new DynamicsCompressorNode(ctx, {
    threshold: -1,
    knee: 0,
    ratio: 20,
    attack: 0.001,
    release: 0.05,
  });
  const master = new GainNode(ctx, { gain: 0.9 });
  const masterAnalyser = new AnalyserNode(ctx, { fftSize: 1024 });
  master.connect(limiter).connect(masterAnalyser).connect(ctx.destination);

  const tracks: TrackHandle[] = buffers.map(() => makeTrack(ctx, master));

  // Cross-wire sidechain analysers: each track's *pre-duck* tap feeds the
  // OTHER track's ducker. (Music ducks under voice; here track 0 ducks
  // under track 1 and vice versa.)
  for (let i = 0; i < tracks.length; i += 1) {
    const other = tracks[(i + 1) % tracks.length]!;
    // pre-duck tap is the comp output (just before duck gain).
    tracks[i]!.comp.connect(other.sidechainAnalyser);
  }

  return { ctx, tracks, master, limiter, masterAnalyser };
}

function makeTrack(ctx: AudioContext, master: GainNode): TrackHandle {
  const gain = new GainNode(ctx, { gain: 0.7 });
  const pan = new StereoPannerNode(ctx, { pan: 0 });
  const eq: BiquadFilterNode[] = [
    new BiquadFilterNode(ctx, { type: "lowshelf", frequency: 120, gain: 0 }),
    new BiquadFilterNode(ctx, { type: "peaking", frequency: 500, gain: 0, Q: 1 }),
    new BiquadFilterNode(ctx, { type: "peaking", frequency: 2500, gain: 0, Q: 1 }),
    new BiquadFilterNode(ctx, { type: "highshelf", frequency: 8000, gain: 0 }),
  ];
  const comp = new DynamicsCompressorNode(ctx, {
    threshold: -18,
    knee: 6,
    ratio: 3,
    attack: 0.005,
    release: 0.12,
  });
  const duck = new AudioWorkletNode(ctx, "ducker", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const analyser = new AnalyserNode(ctx, { fftSize: 1024 });
  const sidechainAnalyser = new AnalyserNode(ctx, { fftSize: 512 });

  gain.connect(pan);
  let prev: AudioNode = pan;
  for (const band of eq) {
    prev.connect(band);
    prev = band;
  }
  prev.connect(comp);
  comp.connect(duck);
  duck.connect(analyser).connect(master);

  return {
    source: null,
    gain,
    pan,
    eq,
    comp,
    duck,
    analyser,
    sidechainAnalyser,
  };
}

export function startTracks(graph: MixGraph, buffers: AudioBuffer[]): void {
  for (let i = 0; i < graph.tracks.length; i += 1) {
    const t = graph.tracks[i]!;
    const src = new AudioBufferSourceNode(graph.ctx, {
      buffer: buffers[i] ?? null,
      loop: true,
    });
    src.connect(t.gain);
    src.start();
    t.source = src;
  }
}

export function stopTracks(graph: MixGraph): void {
  for (const t of graph.tracks) {
    try {
      t.source?.stop();
    } catch {
      // ignore — already stopped
    }
    t.source?.disconnect();
    t.source = null;
  }
}

export function rms(analyser: AnalyserNode, scratch: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(scratch);
  let sum = 0;
  for (let i = 0; i < scratch.length; i += 1) {
    const v = scratch[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / scratch.length);
}

export function applyEq(node: BiquadFilterNode, p: EqBandParams): void {
  node.frequency.value = p.freq;
  node.gain.value = p.gain;
  node.Q.value = Math.min(p.q, 18);
}

export function applyCompressor(
  node: DynamicsCompressorNode,
  p: CompressorParams,
): void {
  node.threshold.value = p.threshold;
  node.knee.value = p.knee;
  node.ratio.value = p.ratio;
  node.attack.value = p.attack;
  node.release.value = p.release;
}

export function applyDucker(node: AudioWorkletNode, p: DuckerParams): void {
  const depth = node.parameters.get("depth");
  const sensitivity = node.parameters.get("sensitivity");
  const attackMs = node.parameters.get("attackMs");
  const releaseMs = node.parameters.get("releaseMs");
  if (depth) depth.value = p.depth;
  if (sensitivity) sensitivity.value = p.sensitivity;
  if (attackMs) attackMs.value = p.attackMs;
  if (releaseMs) releaseMs.value = p.releaseMs;
}

export function pulseDuck(node: AudioWorkletNode, ctx: AudioContext): void {
  const rmsParam = node.parameters.get("sidechainRms");
  if (!rmsParam) return;
  const now = ctx.currentTime;
  rmsParam.cancelScheduledValues(now);
  rmsParam.setValueAtTime(0.6, now);
  rmsParam.linearRampToValueAtTime(0, now + 0.6);
}
