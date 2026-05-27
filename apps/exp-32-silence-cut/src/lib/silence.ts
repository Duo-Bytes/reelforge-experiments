// Audio decode + on-device silence detection for exp-32.
//
// Two paths:
//   * detectSilenceEnergy — fast RMS-threshold fallback. Used when the VAD
//     model failed to load or the user explicitly picks it.
//   * silenceFromVadProbabilities — converts Silero-VAD speech probabilities
//     into silence segments via hysteresis + min-duration filtering. The
//     probabilities themselves are produced by the VAD worker.
//
// The decode/resample stage is shared.

export type SilenceSegment = { startSec: number; endSec: number };

export type SilenceOpts = {
  thresholdDb: number;
  minSilenceMs: number;
  paddingMs: number;
};

// Silero-VAD v5 chunk size at 16 kHz. 512 samples = 32 ms hops.
export const SILERO_HOP_16K = 512;
// Mirror of the canonical Silero-VAD weights. ~2.2 MB.
export const SILERO_VAD_URL =
  "https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx";

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

/** Energy-RMS silence detection. Cheap fallback when VAD isn't loaded. */
export function detectSilenceEnergy(
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

export type VadHysteresisOpts = {
  /** Speech probability above this enters the SPEAKING state. */
  speechOnProb: number;
  /** Speech probability below this enters the SILENT state. */
  speechOffProb: number;
  /** Drop silence runs shorter than this — they're inter-word pauses. */
  minSilenceMs: number;
  /** Shrink each detected silence by this much so we don't clip word tails. */
  paddingMs: number;
};

/**
 * Convert per-hop Silero-VAD speech probabilities into silence segments.
 *
 * Schmitt-trigger style hysteresis prevents flapping when probabilities
 * straddle a single threshold during noisy regions. Then a min-duration
 * filter drops inter-word pauses, and `paddingMs` shrinks the segment from
 * both ends so we don't clip plosive tails.
 */
export function silenceFromVadProbabilities(
  probs: Float32Array,
  hop: number,
  sampleRate: number,
  opts: VadHysteresisOpts,
): SilenceSegment[] {
  const hopSec = hop / sampleRate;
  const minSilenceSec = opts.minSilenceMs / 1000;
  const padSec = opts.paddingMs / 1000;

  const out: SilenceSegment[] = [];
  let speaking = false;
  let silentStartHop = 0;
  let prevSpeechEndHop = 0;

  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (speaking) {
      if (p < opts.speechOffProb) {
        speaking = false;
        silentStartHop = i;
        prevSpeechEndHop = i;
      }
    } else {
      if (p > opts.speechOnProb) {
        // Close the silence segment that just ended.
        const lenSec = (i - silentStartHop) * hopSec;
        if (lenSec >= minSilenceSec) {
          const start = silentStartHop * hopSec + padSec;
          const end = i * hopSec - padSec;
          if (end > start) out.push({ startSec: start, endSec: end });
        }
        speaking = true;
      }
    }
  }
  // Tail: if we ended silent, emit from last transition to end-of-stream.
  if (!speaking && probs.length > 0) {
    const startHop = prevSpeechEndHop || silentStartHop;
    const lenSec = (probs.length - startHop) * hopSec;
    if (lenSec >= minSilenceSec) {
      const start = startHop * hopSec + padSec;
      const end = probs.length * hopSec;
      if (end > start) out.push({ startSec: start, endSec: end });
    }
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
