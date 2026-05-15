/**
 * 16 kHz mono resampling via OfflineAudioContext.
 *
 * Whisper / Moonshine both want 16 kHz mono Float32. This is real,
 * deterministic, and a fraction of real-time on a laptop.
 */

export async function resampleTo16kMono(
  buffer: AudioBuffer,
): Promise<Float32Array> {
  const targetSampleRate = 16_000;
  const length = Math.ceil(buffer.duration * targetSampleRate);
  // OfflineAudioContext minimum sample rate is 8 kHz.
  if (targetSampleRate < 8000) {
    throw new Error("Target sample rate below OfflineAudioContext minimum");
  }
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length,
    sampleRate: targetSampleRate,
  });
  const src = new AudioBufferSourceNode(ctx, { buffer });
  // Mix down to mono by averaging input channels.
  if (buffer.numberOfChannels > 1) {
    const mixer = new ChannelMergerNode(ctx, { numberOfInputs: 1 });
    const splitter = new ChannelSplitterNode(ctx, {
      numberOfOutputs: buffer.numberOfChannels,
    });
    const gain = new GainNode(ctx, { gain: 1 / buffer.numberOfChannels });
    src.connect(splitter);
    for (let i = 0; i < buffer.numberOfChannels; i += 1) {
      splitter.connect(gain, i);
    }
    gain.connect(mixer, 0, 0);
    mixer.connect(ctx.destination);
  } else {
    src.connect(ctx.destination);
  }
  src.start();
  const rendered = await ctx.startRendering();
  // copy out so the AudioBuffer can be GC'd.
  return new Float32Array(rendered.getChannelData(0));
}
