/// <reference lib="webworker" />

// Writer worker for the PRIMARY tab.
//
// Holds a FileSystemSyncAccessHandle on OPFS_FILE for the lifetime of the
// worker. The main thread debounces user input and posts { kind: "write" }
// messages; we truncate and write each time. Reads serve the same handle so
// the primary stays consistent.

import { OPFS_FILE, type MainToWorker, type WorkerToMain } from "../lib/protocol";

declare const self: DedicatedWorkerGlobalScope;

let handle: FileSystemSyncAccessHandle | null = null;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const post = (m: WorkerToMain): void => {
  self.postMessage(m);
};

async function ensureHandle(): Promise<FileSystemSyncAccessHandle> {
  if (handle) return handle;
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(OPFS_FILE, { create: true });
  handle = await fileHandle.createSyncAccessHandle();
  return handle;
}

function readAll(h: FileSystemSyncAccessHandle): string {
  const size = h.getSize();
  if (size === 0) return "";
  const buf = new Uint8Array(size);
  h.read(buf, { at: 0 });
  return decoder.decode(buf);
}

function writeAll(h: FileSystemSyncAccessHandle, text: string): number {
  const bytes = encoder.encode(text);
  h.truncate(0);
  h.write(bytes, { at: 0 });
  h.flush();
  return bytes.byteLength;
}

self.addEventListener("message", (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  (async () => {
    try {
      if (msg.kind === "write") {
        const h = await ensureHandle();
        const bytes = writeAll(h, msg.text);
        post({ kind: "wrote", at: Date.now(), bytes });
      } else if (msg.kind === "read") {
        const h = await ensureHandle();
        const text = readAll(h);
        post({ kind: "read", text, at: Date.now() });
      } else if (msg.kind === "close") {
        if (handle) {
          try {
            handle.close();
          } catch {
            // ignore
          }
          handle = null;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      post({ kind: "error", message });
    }
  })();
});

// Best-effort release on unload.
self.addEventListener("close", () => {
  if (handle) {
    try {
      handle.close();
    } catch {
      // ignore
    }
    handle = null;
  }
});

post({ kind: "ready" });
