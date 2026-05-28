/// <reference lib="webworker" />
/**
 * On-device transcription worker for exp-39, shared shape with exp-26.
 *
 * Runs Whisper-tiny via Transformers.js (onnxruntime-web) on the WebGPU
 * EP, wasm fallback. Emits word-timed tokens used by the smart-cut text
 * scorer. Audio never leaves the machine; model weights cache via the
 * Cache API after the first download.
 */

import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";

env.allowLocalModels = false;

type RequestMessage = { id: number; pcm: Float32Array };
type ProgressMessage = {
  id: number;
  kind: "progress";
  phase: "load" | "transcribe";
  done: number;
  total: number;
};
type Word = { t: number; w: string };
type ResultMessage = { id: number; kind: "result"; words: Word[]; ms: number };
type ErrorMessage = { id: number; kind: "error"; message: string };

type AsrChunk = { timestamp: [number, number | null]; text: string };
type AsrOutput = { text: string; chunks?: AsrChunk[] };

const REPO = "onnx-community/whisper-tiny.en";

const createAsrPipeline = pipeline as unknown as (
  task: "automatic-speech-recognition",
  model: string,
  options: Record<string, unknown>,
) => Promise<AutomaticSpeechRecognitionPipeline>;

let asr: AutomaticSpeechRecognitionPipeline | null = null;

async function getPipeline(id: number): Promise<AutomaticSpeechRecognitionPipeline> {
  if (asr) return asr;
  asr = await createAsrPipeline("automatic-speech-recognition", REPO, {
    device: "webgpu",
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
  return asr;
}

self.onmessage = async (e: MessageEvent<RequestMessage>) => {
  const { id, pcm } = e.data;
  const t0 = performance.now();
  try {
    const pipe = await getPipeline(id);
    post({ id, kind: "progress", phase: "transcribe", done: 0, total: 1 });

    const transcribe = pipe as unknown as (
      audio: Float32Array,
      options: Record<string, unknown>,
    ) => Promise<AsrOutput | AsrOutput[]>;
    const result = await transcribe(pcm, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    const out = Array.isArray(result) ? result[0]! : result;
    const words: Word[] = [];
    for (const c of out.chunks ?? []) {
      const w = c.text.trim();
      if (w) words.push({ t: c.timestamp[0] ?? 0, w });
    }

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
