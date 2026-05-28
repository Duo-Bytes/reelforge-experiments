/// <reference lib="webworker" />
/**
 * Transcribe worker for exp-26. Thin wrapper over @reelforge/asr, which
 * runs Whisper / Moonshine on the WebGPU EP (wasm fallback) via
 * Transformers.js. Audio never leaves the machine; weights cache after
 * the first download.
 */

import { loadAsr, transcribe, type AsrWord } from "@reelforge/asr";
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import type { WordTimestamp } from "../lib/types";

type RequestMessage = { id: number; pcm: Float32Array; model: string };
type ProgressMessage = {
  id: number;
  kind: "progress";
  phase: "load" | "transcribe";
  done: number;
  total: number;
};
type ResultMessage = { id: number; kind: "result"; words: WordTimestamp[]; ms: number };
type ErrorMessage = { id: number; kind: "error"; message: string };

// Map the UI's friendly ids to HF repos maintained for Transformers.js v3.
const MODEL_REPOS: Record<string, { repo: string; wordTimestamps: boolean }> = {
  "whisper-tiny": { repo: "onnx-community/whisper-tiny.en", wordTimestamps: true },
  "moonshine-base": { repo: "onnx-community/moonshine-base-ONNX", wordTimestamps: false },
};

let pipe: AutomaticSpeechRecognitionPipeline | null = null;
let loadedRepo: string | null = null;

self.onmessage = async (e: MessageEvent<RequestMessage>) => {
  const { id, pcm, model } = e.data;
  const t0 = performance.now();
  try {
    const entry = MODEL_REPOS[model] ?? MODEL_REPOS["whisper-tiny"]!;
    if (!pipe || loadedRepo !== entry.repo) {
      pipe = await loadAsr(entry.repo, {
        onProgress: (done) =>
          post({ id, kind: "progress", phase: "load", done, total: 100 }),
      });
      loadedRepo = entry.repo;
    }
    post({ id, kind: "progress", phase: "transcribe", done: 0, total: 1 });

    const words: AsrWord[] = await transcribe(pipe, pcm, {
      wordTimestamps: entry.wordTimestamps,
    });

    post({ id, kind: "progress", phase: "transcribe", done: 1, total: 1 });
    post({ id, kind: "result", words, ms: performance.now() - t0 });
  } catch (err) {
    post({ id, kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

function post(m: ProgressMessage | ResultMessage | ErrorMessage): void {
  (self as DedicatedWorkerGlobalScope).postMessage(m);
}

export {};
