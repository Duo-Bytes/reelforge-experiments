// Shared on-device ASR helper for ReelForge experiments.
//
// Wraps Transformers.js (which itself wraps onnxruntime-web) so callers
// get a Whisper / Moonshine pipeline on the WebGPU EP (wasm fallback)
// plus a normalised word list. Intended to run inside a Web Worker.
// Model weights download once and cache on-device; audio never leaves
// the machine.

import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";

// Always pull models from the hub; never look for ./models on the origin.
env.allowLocalModels = false;

export type AsrWord = { word: string; start: number; end: number };

type AsrChunk = { timestamp: [number, number | null]; text: string };
type AsrOutput = { text: string; chunks?: AsrChunk[] };

// The `pipeline` overload set is a huge union keyed on the task string;
// referencing it directly makes tsc bail with "union type too complex".
const createAsrPipeline = pipeline as unknown as (
  task: "automatic-speech-recognition",
  model: string,
  options: Record<string, unknown>,
) => Promise<AutomaticSpeechRecognitionPipeline>;

export type LoadAsrOptions = {
  /** Per-file download progress, 0–100. */
  onProgress?: (pct: number) => void;
  /** onnxruntime dtype map; defaults to fp32 encoder + q8 decoder. */
  dtype?: Record<string, string> | string;
};

export async function loadAsr(
  repo: string,
  opts: LoadAsrOptions = {},
): Promise<AutomaticSpeechRecognitionPipeline> {
  return createAsrPipeline("automatic-speech-recognition", repo, {
    device: "webgpu",
    dtype: opts.dtype ?? { encoder_model: "fp32", decoder_model_merged: "q8" },
    progress_callback: (p: unknown) => {
      const e = p as { status?: string; progress?: number };
      if (e.status === "progress" && typeof e.progress === "number") {
        opts.onProgress?.(Math.round(e.progress));
      }
    },
  });
}

export type TranscribeOptions = {
  /** True for Whisper word-level alignment; false for segment timestamps. */
  wordTimestamps: boolean;
  chunkLengthSec?: number;
  strideLengthSec?: number;
};

export async function transcribe(
  pipe: AutomaticSpeechRecognitionPipeline,
  pcm16k: Float32Array,
  opts: TranscribeOptions,
): Promise<AsrWord[]> {
  const run = pipe as unknown as (
    audio: Float32Array,
    options: Record<string, unknown>,
  ) => Promise<AsrOutput | AsrOutput[]>;
  const result = await run(pcm16k, {
    return_timestamps: opts.wordTimestamps ? "word" : true,
    chunk_length_s: opts.chunkLengthSec ?? 30,
    stride_length_s: opts.strideLengthSec ?? 5,
  });
  const out = Array.isArray(result) ? result[0]! : result;
  return toWords(out, opts.wordTimestamps);
}

/** Flatten ASR chunks into word-timed entries in clip seconds. */
function toWords(out: AsrOutput, wordLevel: boolean): AsrWord[] {
  const chunks = out.chunks ?? [];
  const words: AsrWord[] = [];
  for (const c of chunks) {
    const start = c.timestamp[0] ?? 0;
    const end = c.timestamp[1] ?? start;
    const text = c.text.trim();
    if (!text) continue;
    if (wordLevel) {
      words.push({ word: text, start, end });
      continue;
    }
    // Segment-level: split on whitespace and spread evenly across the span.
    const toks = text.split(/\s+/).filter(Boolean);
    const span = Math.max(0, end - start);
    const each = toks.length > 0 ? span / toks.length : 0;
    toks.forEach((w, i) => {
      const ws = start + i * each;
      words.push({ word: w, start: ws, end: ws + each * 0.9 });
    });
  }
  return words;
}
