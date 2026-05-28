/// <reference lib="webworker" />
/**
 * Transcribe worker for exp-26.
 *
 * Real on-device speech-to-text via Transformers.js (which wraps
 * onnxruntime-web). The WebGPU EP is requested first; Transformers.js
 * itself falls back to wasm when WebGPU is unavailable. Model weights are
 * fetched once from the HF hub and cached by the library in the browser
 * Cache API — no audio or features ever leave the machine.
 *
 * Word-level timestamps come from Whisper's cross-attention alignment
 * (`return_timestamps: "word"`). Moonshine has no word aligner, so we
 * request segment timestamps and distribute word times linearly.
 *
 * Benchmark to beat: Moonshine ~107 ms latency vs Whisper-Large-V3's
 * ~11,286 ms on the same hardware.
 */

import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import type { WordTimestamp } from "../lib/types";

// Always pull from the hub; never look for ./models on the origin.
env.allowLocalModels = false;

type RequestMessage = {
  id: number;
  pcm: Float32Array;
  model: string;
};

type ProgressMessage = {
  id: number;
  kind: "progress";
  phase: "load" | "transcribe";
  done: number;
  total: number;
};

type ResultMessage = {
  id: number;
  kind: "result";
  words: WordTimestamp[];
  ms: number;
};

type ErrorMessage = {
  id: number;
  kind: "error";
  message: string;
};

type AsrChunk = { timestamp: [number, number | null]; text: string };
type AsrOutput = { text: string; chunks?: AsrChunk[] };

// Map the UI's friendly ids to HF repos maintained for Transformers.js v3.
const MODEL_REPOS: Record<string, { repo: string; wordTimestamps: boolean }> = {
  "whisper-tiny": { repo: "onnx-community/whisper-tiny.en", wordTimestamps: true },
  "moonshine-base": {
    repo: "onnx-community/moonshine-base-ONNX",
    wordTimestamps: false,
  },
};

// The `pipeline` overload set is a huge union keyed on the task string;
// referencing it directly makes tsc bail with "union type too complex".
// Narrow it to the single signature we use.
const createAsrPipeline = pipeline as unknown as (
  task: "automatic-speech-recognition",
  model: string,
  options: Record<string, unknown>,
) => Promise<AutomaticSpeechRecognitionPipeline>;

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loadedRepo: string | null = null;

async function getPipeline(
  id: number,
  modelId: string,
): Promise<{ pipe: AutomaticSpeechRecognitionPipeline; wordTimestamps: boolean }> {
  const entry = MODEL_REPOS[modelId] ?? MODEL_REPOS["whisper-tiny"]!;
  if (asr && loadedRepo === entry.repo) {
    return { pipe: asr, wordTimestamps: entry.wordTimestamps };
  }
  asr = await createAsrPipeline("automatic-speech-recognition", entry.repo, {
    device: "webgpu",
    // q8 keeps the decoder small; the encoder stays fp32 for accuracy.
    dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
    progress_callback: (p: unknown) => {
      const e = p as { status?: string; progress?: number };
      if (e.status === "progress" && typeof e.progress === "number") {
        post({
          id,
          kind: "progress",
          phase: "load",
          done: Math.round(e.progress),
          total: 100,
        });
      }
    },
  });
  loadedRepo = entry.repo;
  return { pipe: asr, wordTimestamps: entry.wordTimestamps };
}

/** Flatten ASR chunks into word-timed entries in clip seconds. */
function toWords(out: AsrOutput, wordLevel: boolean): WordTimestamp[] {
  const chunks = out.chunks ?? [];
  const words: WordTimestamp[] = [];
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

self.onmessage = async (e: MessageEvent<RequestMessage>) => {
  const { id, pcm, model } = e.data;
  const t0 = performance.now();
  try {
    const { pipe, wordTimestamps } = await getPipeline(id, model);
    post({ id, kind: "progress", phase: "transcribe", done: 0, total: 1 });

    const transcribe = pipe as unknown as (
      audio: Float32Array,
      options: Record<string, unknown>,
    ) => Promise<AsrOutput | AsrOutput[]>;
    const result = await transcribe(pcm, {
      return_timestamps: wordTimestamps ? "word" : true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    const out = Array.isArray(result) ? result[0]! : result;
    const words = toWords(out, wordTimestamps);

    post({ id, kind: "progress", phase: "transcribe", done: 1, total: 1 });
    const reply: ResultMessage = {
      id,
      kind: "result",
      words,
      ms: performance.now() - t0,
    };
    post(reply);
  } catch (err) {
    const reply: ErrorMessage = {
      id,
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    post(reply);
  }
};

function post(m: ProgressMessage | ResultMessage | ErrorMessage): void {
  (self as DedicatedWorkerGlobalScope).postMessage(m);
}

export {};
