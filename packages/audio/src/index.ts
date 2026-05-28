// Shared browser-audio helpers for ReelForge experiments.
//
// Decoding + resampling happen inside the Web Audio engine
// (OfflineAudioContext) rather than in JS, so they stay fast and exact.
// All functions are client-only (require Web Audio + DOM).

/** Downmix to mono and resample an already-decoded buffer to `targetRate`. */
export async function resampleToMono(
  decoded: AudioBuffer,
  targetRate: number,
): Promise<Float32Array> {
  const offline = new OfflineAudioContext(
    1,
    Math.max(1, Math.ceil(decoded.duration * targetRate)),
    targetRate,
  );
  const src = offline.createBufferSource();
  src.buffer = decoded;
  if (decoded.numberOfChannels === 1) {
    src.connect(offline.destination);
  } else {
    // Average all channels into one mono input.
    const merger = offline.createGain();
    merger.gain.value = 1 / decoded.numberOfChannels;
    src.connect(merger);
    merger.connect(offline.destination);
  }
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/** Decode a media file and return mono PCM at `targetRate` plus duration. */
export async function decodeToMono(
  file: File,
  targetRate: number,
): Promise<{ samples: Float32Array; sampleRate: number; durationSec: number }> {
  const buf = await file.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    const samples = await resampleToMono(decoded, targetRate);
    return { samples, sampleRate: targetRate, durationSec: decoded.duration };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/** Encode mono Float32 PCM to a 16-bit PCM WAV blob. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  return encodeWavInterleaved([samples], sampleRate);
}

/** Encode an AudioBuffer (any channel count) to a 16-bit PCM WAV blob. */
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }
  return encodeWavInterleaved(channels, buffer.sampleRate);
}

function encodeWavInterleaved(channels: Float32Array[], sampleRate: number): Blob {
  const numChannels = Math.max(1, channels.length);
  const numSamples = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
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
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  wstr(36, "data");
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}
