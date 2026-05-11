/// <reference lib="webworker" />

import { openDB, type IDBPDatabase } from "idb";

type IngestMsg = { type: "INGEST"; file: File; fileId: string };
type BenchMsg = {
  type: "BENCH";
  fileId: string;
  iterations: number;
  chunkSize: number;
};
type InMsg = IngestMsg | BenchMsg;

const DB_NAME = "exp01-idb-bench";
const STORE = "blobs";

let dbPromise: Promise<IDBPDatabase> | null = null;
const sizes = new Map<string, number>();

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      },
    });
  }
  return dbPromise;
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  try {
    if (msg.type === "INGEST") {
      await ingestFile(msg.file, msg.fileId);
    } else if (msg.type === "BENCH") {
      await runBench(msg.fileId, msg.iterations, msg.chunkSize);
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function ingestFile(file: File, fileId: string): Promise<void> {
  const db = await getDB();
  const t0 = performance.now();
  await db.put(STORE, file, fileId);
  sizes.set(fileId, file.size);
  const elapsedMs = performance.now() - t0;
  self.postMessage({ type: "DONE", fileId, size: file.size, elapsedMs });
}

async function runBench(
  fileId: string,
  iterations: number,
  chunkSize: number,
): Promise<void> {
  const db = await getDB();
  const blob = (await db.get(STORE, fileId)) as Blob | undefined;
  if (!blob) throw new Error(`No blob for ${fileId}`);
  const size = blob.size;
  if (chunkSize > size) {
    throw new Error(`chunkSize ${chunkSize} exceeds file size ${size}`);
  }

  const samples: number[] = new Array(iterations);
  const maxOffset = size - chunkSize;

  for (let i = 0; i < iterations; i++) {
    const offset = Math.floor(Math.random() * maxOffset);
    const t0 = performance.now();
    const slice = blob.slice(offset, offset + chunkSize);
    await slice.arrayBuffer();
    samples[i] = performance.now() - t0;
  }

  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const min = samples[0];
  const max = samples[samples.length - 1];
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;

  self.postMessage({
    type: "BENCH_RESULT",
    fileId,
    iterations,
    chunkSize,
    median,
    p95,
    min,
    max,
    mean,
  });
}
