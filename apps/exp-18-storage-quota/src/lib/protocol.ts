// Wire protocol shared between page.tsx and opfs.worker.ts.

export type MainToWorker =
  | { kind: "start"; chunkBytes: number }
  | { kind: "stop" }
  | { kind: "clear" };

export type WorkerToMain =
  | { kind: "ready" }
  | { kind: "wrote"; index: number; bytes: number; totalChunks: number }
  | { kind: "evicted"; removedIndex: number; reason: string }
  | { kind: "error"; message: string; fatal: boolean }
  | { kind: "stopped"; totalChunks: number }
  | { kind: "cleared" };
