/// <reference lib="webworker" />
/**
 * On-device transcription worker for exp-39. Thin wrapper over
 * @reelforge/asr (Whisper-tiny on the WebGPU EP). Emits word-timed tokens
 * for the smart-cut text scorer. Audio never leaves the machine.
 */

import { loadAsr, transcribe } from "@reelforge/asr";
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

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

const REPO = "onnx-community/whisper-tiny.en";
let pipe: AutomaticSpeechRecognitionPipeline | null = null;

self.onmessage = async (e: MessageEvent<RequestMessage>) => {
  const { id, pcm } = e.data;
  const t0 = performance.now();
  try {
    if (!pipe) {
      pipe = await loadAsr(REPO, {
        onProgress: (done) =>
          post({ id, kind: "progress", phase: "load", done, total: 100 }),
      });
    }
    post({ id, kind: "progress", phase: "transcribe", done: 0, total: 1 });

    const asrWords = await transcribe(pipe, pcm, { wordTimestamps: true });
    const words: Word[] = asrWords.map((w) => ({ t: w.start, w: w.word }));

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
