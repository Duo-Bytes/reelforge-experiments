/**
 * A short synthetic tone fallback so the page is interactive without
 * a real audio input.
 */

const SAMPLE_RATE = 48_000;

export async function synthesizeSpeechLike(
  durationSec = 10,
): Promise<AudioBuffer> {
  // Not actually speech-like, but a structured tone that the VAD will mark
  // as voiced — bursts of warble at 220 Hz with short gaps in between.
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: SAMPLE_RATE * durationSec,
    sampleRate: SAMPLE_RATE,
  });
  const burstDur = 0.45;
  const gapDur = 0.15;
  let t = 0;
  while (t < durationSec) {
    const osc = new OscillatorNode(ctx, { type: "sawtooth", frequency: 220 });
    const env = new GainNode(ctx, { gain: 0 });
    osc.connect(env).connect(ctx.destination);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.5, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.001, t + burstDur);
    osc.start(t);
    osc.stop(t + burstDur);
    t += burstDur + gapDur;
  }
  return ctx.startRendering();
}
