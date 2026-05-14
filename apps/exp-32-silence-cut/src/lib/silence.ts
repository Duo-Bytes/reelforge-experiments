// Audio decode + placeholder silence detector for exp-32.
//
// v1 uses an energy-threshold detector so the demo runs end-to-end.
// v2 swaps the detector body for Silero-VAD ONNX inference (WebGPU EP).
// The decode + resample stage is the real production path either way.

export type SilenceSegment = { startSec: number; endSec: number };

export type SilenceOpts = {
  thresholdDb: number;
  minSilenceMs: number;
  paddingMs: number;
};

const TARGET_RATE = 16000;

export async function decodeToMono16k(file: File): Promise<{
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
}> {
  const buf = await file.arrayBuffer();
  // OfflineAudioContext supports any rate; ask for the target directly so the
  // resample happens inside the audio engine, not in JS.
  const tmpCtx = new AudioContext();
  const decoded = await tmpCtx.decodeAudioData(buf.slice(0));
  await tmpCtx.close();

  const offline = new OfflineAudioContext(
    1,
    Math.ceil((decoded.duration * TARGET_RATE)),
    TARGET_RATE,
  );
  const src = offline.createBufferSource();
  src.buffer = decoded;
  // Average channels into one mono input.
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

// Placeholder detector. Replace with Silero-VAD inference for production.
export function detectSilence(
  samples: Float32Array,
  sampleRate: number,
  opts: SilenceOpts,
): SilenceSegment[] {
  const hop = Math.round((30 / 1000) * sampleRate); // 30 ms hops
  const minSilenceSamples = Math.round((opts.minSilenceMs / 1000) * sampleRate);
  const padSamples = Math.round((opts.paddingMs / 1000) * sampleRate);
  const threshold = Math.pow(10, opts.thresholdDb / 20);

  const out: SilenceSegment[] = [];
  let silentStart = -1;

  for (let i = 0; i < samples.length; i += hop) {
    let sumSq = 0;
    const end = Math.min(i + hop, samples.length);
    for (let j = i; j < end; j++) sumSq += samples[j] * samples[j];
    const rms = Math.sqrt(sumSq / (end - i));
    const isSilent = rms < threshold;

    if (isSilent && silentStart < 0) silentStart = i;
    else if (!isSilent && silentStart >= 0) {
      const len = i - silentStart;
      if (len >= minSilenceSamples) {
        out.push({
          startSec: Math.max(0, silentStart + padSamples) / sampleRate,
          endSec: Math.max(0, i - padSamples) / sampleRate,
        });
      }
      silentStart = -1;
    }
  }
  if (silentStart >= 0) {
    out.push({
      startSec: (silentStart + padSamples) / sampleRate,
      endSec: samples.length / sampleRate,
    });
  }
  return out;
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  samples: Float32Array,
  sampleRate: number,
  silence: SilenceSegment[],
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const total = samples.length;
  ctx.clearRect(0, 0, w, h);

  // silence bars
  ctx.fillStyle = "rgba(239,68,68,0.18)";
  for (const s of silence) {
    const x0 = Math.floor((s.startSec * sampleRate / total) * w);
    const x1 = Math.ceil((s.endSec * sampleRate / total) * w);
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
  }

  // waveform peak per column
  const samplesPerPx = Math.max(1, Math.floor(total / w));
  ctx.strokeStyle = "rgba(63,63,70,0.85)";
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    let min = 1;
    let max = -1;
    const start = x * samplesPerPx;
    const end = Math.min(start + samplesPerPx, total);
    for (let j = start; j < end; j++) {
      if (samples[j] < min) min = samples[j];
      if (samples[j] > max) max = samples[j];
    }
    const y0 = ((1 - max) / 2) * h;
    const y1 = ((1 - min) / 2) * h;
    ctx.moveTo(x + 0.5, y0);
    ctx.lineTo(x + 0.5, y1);
  }
  ctx.stroke();
}
