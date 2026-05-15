/**
 * Procedural test-tone generation for exp-24. Two stereo buffers are
 * synthesised at page load via OfflineAudioContext — no network deps.
 *
 *  - track 1: a sustained 220 Hz sine with a slow tremolo
 *  - track 2: a four-note arpeggio (A3, C4, E4, A4) repeating
 */

export type TestTones = {
  track1: AudioBuffer;
  track2: AudioBuffer;
};

const DURATION_SEC = 8;
const SAMPLE_RATE = 48_000;

export async function generateTestTones(): Promise<TestTones> {
  const [track1, track2] = await Promise.all([
    renderSineWithTremolo(220, 5, 0.4),
    renderArpeggio([220, 261.63, 329.63, 440], 0.5, 0.35),
  ]);
  return { track1, track2 };
}

async function renderSineWithTremolo(
  freq: number,
  tremoloHz: number,
  amp: number,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: SAMPLE_RATE * DURATION_SEC,
    sampleRate: SAMPLE_RATE,
  });
  const osc = new OscillatorNode(ctx, { frequency: freq, type: "sine" });
  const lfo = new OscillatorNode(ctx, { frequency: tremoloHz, type: "sine" });
  const lfoGain = new GainNode(ctx, { gain: 0.2 });
  const gain = new GainNode(ctx, { gain: amp });
  lfo.connect(lfoGain).connect(gain.gain);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  lfo.start();
  return ctx.startRendering();
}

async function renderArpeggio(
  freqs: number[],
  noteDur: number,
  amp: number,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: SAMPLE_RATE * DURATION_SEC,
    sampleRate: SAMPLE_RATE,
  });
  const master = new GainNode(ctx, { gain: amp });
  master.connect(ctx.destination);
  let t = 0;
  const notes = Math.ceil(DURATION_SEC / noteDur);
  for (let i = 0; i < notes; i += 1) {
    const freq = freqs[i % freqs.length]!;
    const osc = new OscillatorNode(ctx, { frequency: freq, type: "triangle" });
    const env = new GainNode(ctx, { gain: 0 });
    osc.connect(env).connect(master);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, t + noteDur);
    osc.start(t);
    osc.stop(t + noteDur);
    t += noteDur;
  }
  return ctx.startRendering();
}
