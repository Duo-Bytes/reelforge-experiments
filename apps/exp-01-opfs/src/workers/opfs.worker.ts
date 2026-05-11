/// <reference lib="webworker" />

type IngestMsg = { type: "INGEST"; file: File; fileId: string };
type ReadRangeMsg = {
  type: "READ_RANGE";
  fileId: string;
  offset: number;
  length: number;
  reqId: string;
};
type BenchMsg = {
  type: "BENCH";
  fileId: string;
  iterations: number;
  chunkSize: number;
};
type CloseMsg = { type: "CLOSE"; fileId: string };
type InMsg = IngestMsg | ReadRangeMsg | BenchMsg | CloseMsg;

const handles = new Map<string, FileSystemSyncAccessHandle>();
const sizes = new Map<string, number>();

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  try {
    if (msg.type === "INGEST") {
      await ingestFile(msg.file, msg.fileId);
    } else if (msg.type === "READ_RANGE") {
      const bytes = readRange(msg.fileId, msg.offset, msg.length);
      (self as unknown as Worker).postMessage(
        { type: "READ_RESULT", reqId: msg.reqId, bytes },
        [bytes.buffer],
      );
    } else if (msg.type === "BENCH") {
      runBench(msg.fileId, msg.iterations, msg.chunkSize);
    } else if (msg.type === "CLOSE") {
      const h = handles.get(msg.fileId);
      if (h) {
        h.close();
        handles.delete(msg.fileId);
        sizes.delete(msg.fileId);
      }
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function ingestFile(file: File, fileId: string): Promise<void> {
  const estimate = await navigator.storage.estimate();
  const quota = estimate.quota ?? 0;
  const usage = estimate.usage ?? 0;
  const remaining = quota - usage;
  if (file.size > remaining * 0.8) {
    self.postMessage({
      type: "ERROR",
      message: `File size ${file.size} exceeds 80% of remaining OPFS quota ${remaining}`,
    });
    return;
  }

  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(fileId, { create: true });
  const syncHandle = await fileHandle.createSyncAccessHandle();

  syncHandle.truncate(0);

  const CHUNK = 4 * 1024 * 1024;
  let offset = 0;
  const t0 = performance.now();
  let lastReport = 0;

  while (offset < file.size) {
    const end = Math.min(offset + CHUNK, file.size);
    const slice = file.slice(offset, end);
    const buffer = await slice.arrayBuffer();
    const view = new Uint8Array(buffer);
    syncHandle.write(view, { at: offset });
    offset += view.byteLength;
    const now = performance.now();
    if (now - lastReport > 100 || offset >= file.size) {
      lastReport = now;
      self.postMessage({
        type: "PROGRESS",
        percent: (offset / file.size) * 100,
        bytes: offset,
      });
    }
  }

  syncHandle.flush();
  handles.set(fileId, syncHandle);
  sizes.set(fileId, file.size);

  const elapsedMs = performance.now() - t0;
  self.postMessage({
    type: "DONE",
    fileId,
    size: file.size,
    elapsedMs,
  });
}

function readRange(fileId: string, offset: number, length: number): Uint8Array {
  const handle = handles.get(fileId);
  if (!handle) throw new Error(`No open handle for ${fileId}`);
  const buf = new Uint8Array(length);
  handle.read(buf, { at: offset });
  return buf;
}

function runBench(fileId: string, iterations: number, chunkSize: number): void {
  const handle = handles.get(fileId);
  const size = sizes.get(fileId);
  if (!handle || size === undefined) {
    throw new Error(`No open handle for ${fileId}`);
  }
  if (chunkSize > size) {
    throw new Error(`chunkSize ${chunkSize} exceeds file size ${size}`);
  }

  const buf = new Uint8Array(chunkSize);
  const samples: number[] = new Array(iterations);
  const maxOffset = size - chunkSize;

  for (let i = 0; i < iterations; i++) {
    const offset = Math.floor(Math.random() * maxOffset);
    const t0 = performance.now();
    handle.read(buf, { at: offset });
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
