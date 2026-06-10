/// <reference lib="webworker" />

// OPFS quota-drill worker.
//
// Receives { kind: "start"; chunkBytes } and writes fixed-size chunks
// into the OPFS root forever, reporting progress to the main thread.
// When a write throws QuotaExceededError it pops the lowest-index
// surviving chunk (LRU) and retries — proving graceful recovery from
// browser-driven eviction.

import type { MainToWorker, WorkerToMain } from "../lib/protocol";

declare const self: DedicatedWorkerGlobalScope;

const CHUNK_PREFIX = "chunk-";
const PAD = 8;

type State = {
  root: FileSystemDirectoryHandle | null;
  running: boolean;
  liveIndices: number[]; // sorted ascending; lowest == oldest (LRU pop)
  nextIndex: number;
};

const state: State = {
  root: null,
  running: false,
  liveIndices: [],
  nextIndex: 0,
};

const post = (m: WorkerToMain): void => {
  self.postMessage(m);
};

const isQuotaExceeded = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: number };
  // Modern path is the named DOMException; the legacy DOMException exposes
  // QUOTA_EXCEEDED_ERR (code 22) instead of a name. Accept either.
  return e.name === "QuotaExceededError" || e.code === 22;
};

const chunkName = (i: number): string => `${CHUNK_PREFIX}${String(i).padStart(PAD, "0")}.bin`;

async function ensureRoot(): Promise<FileSystemDirectoryHandle> {
  if (state.root) return state.root;
  // navigator.storage is available in workers in Chromium.
  state.root = await navigator.storage.getDirectory();
  return state.root;
}

async function writeChunk(index: number, payload: Uint8Array): Promise<void> {
  const root = await ensureRoot();
  const fileHandle = await root.getFileHandle(chunkName(index), { create: true });
  // FileSystemSyncAccessHandle is worker-only — that's why we live here.
  const sync = await fileHandle.createSyncAccessHandle();
  try {
    sync.truncate(0);
    // Buffer must be a fresh BufferSource view; write() returns bytes written.
    sync.write(payload, { at: 0 });
    sync.flush();
  } finally {
    sync.close();
  }
}

async function deleteChunk(index: number): Promise<void> {
  const root = await ensureRoot();
  await root.removeEntry(chunkName(index));
}

async function clearAll(): Promise<void> {
  const root = await ensureRoot();
  // for-await on directory handle entries.
  const toRemove: string[] = [];
  for await (const [name] of root as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (name.startsWith(CHUNK_PREFIX)) toRemove.push(name);
  }
  for (const name of toRemove) {
    try {
      await root.removeEntry(name);
    } catch {
      // best-effort
    }
  }
  state.liveIndices = [];
  state.nextIndex = 0;
}

async function runLoop(chunkBytes: number): Promise<void> {
  // One reusable payload buffer; filled with a recognisable pattern.
  const payload = new Uint8Array(chunkBytes);
  for (let i = 0; i < payload.length; i += 64) payload[i] = (i / 64) & 0xff;

  while (state.running) {
    const index = state.nextIndex;
    try {
      await writeChunk(index, payload);
      state.liveIndices.push(index);
      state.nextIndex += 1;
      post({
        kind: "wrote",
        index,
        bytes: chunkBytes,
        totalChunks: state.liveIndices.length,
      });
    } catch (err) {
      if (isQuotaExceeded(err)) {
        // LRU eviction: drop the oldest surviving chunk and try again.
        if (state.liveIndices.length === 0) {
          post({ kind: "error", message: "Quota exceeded with no chunks to evict.", fatal: true });
          state.running = false;
          break;
        }
        const victim = state.liveIndices.shift();
        if (victim !== undefined) {
          try {
            await deleteChunk(victim);
            post({ kind: "evicted", removedIndex: victim, reason: "QuotaExceededError" });
          } catch (delErr) {
            post({
              kind: "error",
              message: `Eviction failed for chunk ${victim}: ${(delErr as Error).message}`,
              fatal: false,
            });
          }
        }
        // continue loop; will retry the same nextIndex
      } else {
        const message = err instanceof Error ? err.message : String(err);
        post({ kind: "error", message, fatal: true });
        state.running = false;
        break;
      }
    }

    // Yield to the event loop so 'stop' messages can be processed and so
    // navigator.storage.estimate() has time to settle for the main thread.
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  post({ kind: "stopped", totalChunks: state.liveIndices.length });
}

self.addEventListener("message", (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  if (msg.kind === "start") {
    if (state.running) return;
    state.running = true;
    runLoop(msg.chunkBytes).catch((err: Error) => {
      post({ kind: "error", message: err.message, fatal: true });
      state.running = false;
    });
  } else if (msg.kind === "stop") {
    state.running = false;
  } else if (msg.kind === "clear") {
    state.running = false;
    clearAll()
      .then(() => post({ kind: "cleared" }))
      .catch((err: Error) =>
        post({ kind: "error", message: `clear: ${err.message}`, fatal: false }),
      );
  }
});

post({ kind: "ready" });
