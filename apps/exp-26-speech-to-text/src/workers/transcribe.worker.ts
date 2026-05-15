/// <reference lib="webworker" />
/**
 * Transcribe worker for exp-26.
 *
 * IMPORTANT: this implementation returns MOCK word-timed output so we
 * can prove the integration shape without downloading a 100 MB+
 * Whisper / Moonshine model.
 *
 * To wire a real model, replace `transcribeChunk` below with:
 *
 *   import * as ort from "onnxruntime-web/webgpu";
 *   const session = await ort.InferenceSession.create("/models/whisper-tiny.onnx",
 *     { executionProviders: ["webgpu"] });
 *   ...feed log-Mel features, decode greedy / beam, emit word timestamps...
 *
 * Benchmark to beat: Moonshine reports 107 ms latency vs Whisper-Large
 * V3's 11,286 ms on the same hardware.
 */

import type { Chunk, WordTimestamp } from "../lib/types";
import { voicedRegions, vadHops } from "../lib/vad";

type RequestMessage = {
  id: number;
  chunks: Chunk[];
};

type ProgressMessage = {
  id: number;
  kind: "progress";
  done: number;
  total: number;
};

type ResultMessage = {
  id: number;
  kind: "result";
  words: WordTimestamp[];
  ms: number;
};

const MOCK_VOCAB = [
  "the",
  "quick",
  "brown",
  "fox",
  "jumps",
  "over",
  "lazy",
  "dog",
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
  "sed",
  "do",
  "eiusmod",
  "tempor",
];

let nextWordIdx = 0;
function mockNextWord(): string {
  const w = MOCK_VOCAB[nextWordIdx % MOCK_VOCAB.length]!;
  nextWordIdx += 1;
  return w;
}

/**
 * Per-chunk mock transcription. Real implementation goes here.
 * Contract: in -> Chunk (16 kHz mono PCM, voiced flag); out -> word
 * timestamps in CLIP time (not chunk time — caller stitches).
 */
async function transcribeChunk(chunk: Chunk): Promise<WordTimestamp[]> {
  // Simulate a small async delay to mirror real inference cost.
  await new Promise<void>((r) => setTimeout(r, 20 + Math.random() * 30));
  if (!chunk.voiced) return [];
  const hops = vadHops(chunk.pcm);
  const regions = voicedRegions(hops);
  const out: WordTimestamp[] = [];
  for (const r of regions) {
    // ~one word per 350 ms within the voiced region.
    const span = r.endSec - r.startSec;
    const n = Math.max(1, Math.round(span / 0.35));
    const each = span / n;
    for (let i = 0; i < n; i += 1) {
      const localStart = r.startSec + i * each;
      const localEnd = localStart + Math.min(each * 0.9, 0.32);
      out.push({
        word: mockNextWord(),
        start: chunk.startSec + localStart,
        end: chunk.startSec + localEnd,
      });
    }
  }
  return out;
}

self.onmessage = async (e: MessageEvent<RequestMessage>) => {
  const { id, chunks } = e.data;
  const t0 = performance.now();
  const all: WordTimestamp[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const words = await transcribeChunk(chunks[i]!);
    all.push(...words);
    const msg: ProgressMessage = {
      id,
      kind: "progress",
      done: i + 1,
      total: chunks.length,
    };
    (self as DedicatedWorkerGlobalScope).postMessage(msg);
  }
  // Stitch: dedupe words whose start times are within 100 ms across the
  // 1 s overlap windows. Cheap heuristic for the mock.
  all.sort((a, b) => a.start - b.start);
  const stitched: WordTimestamp[] = [];
  for (const w of all) {
    const last = stitched[stitched.length - 1];
    if (last && Math.abs(last.start - w.start) < 0.1 && last.word === w.word) {
      continue;
    }
    stitched.push(w);
  }
  const reply: ResultMessage = {
    id,
    kind: "result",
    words: stitched,
    ms: performance.now() - t0,
  };
  (self as DedicatedWorkerGlobalScope).postMessage(reply);
};

export {};
