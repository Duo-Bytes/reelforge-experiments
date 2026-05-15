/**
 * Shared types for exp-26. The integration shape is fixed; the only
 * thing the real model swap touches is `transcribeChunk` inside the
 * transcribe worker.
 */

export type WordTimestamp = {
  word: string;
  start: number; // seconds from clip start
  end: number;
};

export type Chunk = {
  index: number;
  /** Mono Float32 PCM at 16 kHz. */
  pcm: Float32Array;
  /** Start time in seconds from clip start (after overlap offset). */
  startSec: number;
  /** Duration in seconds. */
  durationSec: number;
  /** Whether the chunk passed the VAD gate. */
  voiced: boolean;
};

export type TranscribeProgress = {
  stage: "decode" | "resample" | "vad" | "chunk" | "transcribe" | "done";
  done: number;
  total: number;
};
