// Generate small, deterministic media fixtures for the experiments.
//
// Run: `node fixtures/generate.mjs`
//
// Produces `fixtures/tone-16k.wav` — 16 kHz mono, ~4 s, alternating
// tone / silence segments so the audio experiments (decode, resample,
// VAD/silence-cut, denoise, scopes) have structured input to chew on
// without anyone needing to bring their own file.
//
// NOTE: this tone has no speech, so it exercises plumbing + performance,
// not transcription quality. For ASR (exp-26/32/39) and video
// (exp-34/39) you still need a real clip — see fixtures/README.md.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const SAMPLE_RATE = 16000;
const CHANNELS = 1;

/** [durationSec, frequencyHz | 0 for silence, amplitude] segments. */
const SEGMENTS = [
  [0.6, 0, 0],
  [0.8, 220, 0.5],
  [0.5, 0, 0],
  [0.8, 440, 0.6],
  [0.4, 0, 0],
  [0.9, 660, 0.45],
  [0.6, 0, 0],
];

function buildSamples() {
  const total = SEGMENTS.reduce((n, [d]) => n + Math.round(d * SAMPLE_RATE), 0);
  const out = new Float32Array(total);
  let i = 0;
  for (const [dur, freq, amp] of SEGMENTS) {
    const n = Math.round(dur * SAMPLE_RATE);
    for (let k = 0; k < n; k++, i++) {
      out[i] = freq === 0 ? 0 : amp * Math.sin((2 * Math.PI * freq * k) / SAMPLE_RATE);
    }
  }
  return out;
}

function encodeWav(samples) {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
  buf.writeUInt16LE(CHANNELS * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(v < 0 ? v * 0x8000 : v * 0x7fff, off);
    off += 2;
  }
  return buf;
}

const wav = encodeWav(buildSamples());
const outPath = join(here, "tone-16k.wav");
writeFileSync(outPath, wav);
console.log(`wrote ${outPath} (${wav.length} bytes)`);
