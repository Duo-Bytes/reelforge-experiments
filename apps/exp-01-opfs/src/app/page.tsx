"use client";

import { useEffect, useRef, useState } from "react";

type BenchResult = {
  iterations: number;
  chunkSize: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
};

type FileInfo = {
  fileId: string;
  name: string;
  size: number;
  ingestMs: number;
};

const BENCH_ITERATIONS = 100;
const BENCH_CHUNK = 1024 * 1024; // 1MB

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtMs(n: number): string {
  return `${n.toFixed(2)} ms`;
}

export default function Page() {
  const opfsWorkerRef = useRef<Worker | null>(null);
  const idbWorkerRef = useRef<Worker | null>(null);

  const [opfsFile, setOpfsFile] = useState<FileInfo | null>(null);
  const [idbFile, setIdbFile] = useState<FileInfo | null>(null);
  const [opfsProgress, setOpfsProgress] = useState(0);
  const [idbBusy, setIdbBusy] = useState(false);
  const [opfsBusy, setOpfsBusy] = useState(false);
  const [opfsBench, setOpfsBench] = useState<BenchResult | null>(null);
  const [idbBench, setIdbBench] = useState<BenchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opfsStatus, setOpfsStatus] = useState("idle");
  const [idbStatus, setIdbStatus] = useState("idle");

  useEffect(() => {
    if (typeof window === "undefined") return;

    const opfsWorker = new Worker(
      new URL("../workers/opfs.worker.ts", import.meta.url),
      { type: "module" },
    );
    const idbWorker = new Worker(
      new URL("../workers/idb.worker.ts", import.meta.url),
      { type: "module" },
    );

    opfsWorker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "PROGRESS") {
        setOpfsProgress(m.percent);
      } else if (m.type === "DONE") {
        setOpfsFile({
          fileId: m.fileId,
          name: pendingOpfsName.current ?? m.fileId,
          size: m.size,
          ingestMs: m.elapsedMs,
        });
        setOpfsBusy(false);
        setOpfsStatus(`ingested ${fmtBytes(m.size)} in ${fmtMs(m.elapsedMs)}`);
      } else if (m.type === "BENCH_RESULT") {
        setOpfsBench({
          iterations: m.iterations,
          chunkSize: m.chunkSize,
          median: m.median,
          p95: m.p95,
          min: m.min,
          max: m.max,
          mean: m.mean,
        });
        setOpfsBusy(false);
        setOpfsStatus("OPFS bench done");
      } else if (m.type === "ERROR") {
        setError(`OPFS: ${m.message}`);
        setOpfsBusy(false);
      }
    };

    idbWorker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "DONE") {
        setIdbFile({
          fileId: m.fileId,
          name: pendingIdbName.current ?? m.fileId,
          size: m.size,
          ingestMs: m.elapsedMs,
        });
        setIdbBusy(false);
        setIdbStatus(`ingested ${fmtBytes(m.size)} in ${fmtMs(m.elapsedMs)}`);
      } else if (m.type === "BENCH_RESULT") {
        setIdbBench({
          iterations: m.iterations,
          chunkSize: m.chunkSize,
          median: m.median,
          p95: m.p95,
          min: m.min,
          max: m.max,
          mean: m.mean,
        });
        setIdbBusy(false);
        setIdbStatus("IDB bench done");
      } else if (m.type === "ERROR") {
        setError(`IDB: ${m.message}`);
        setIdbBusy(false);
      }
    };

    opfsWorkerRef.current = opfsWorker;
    idbWorkerRef.current = idbWorker;

    return () => {
      opfsWorker.terminate();
      idbWorker.terminate();
      opfsWorkerRef.current = null;
      idbWorkerRef.current = null;
    };
  }, []);

  const pendingOpfsName = useRef<string | null>(null);
  const pendingIdbName = useRef<string | null>(null);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setOpfsBench(null);
    setIdbBench(null);
    setOpfsProgress(0);

    const fileId = crypto.randomUUID();
    pendingOpfsName.current = file.name;
    pendingIdbName.current = file.name;

    setOpfsBusy(true);
    setIdbBusy(true);
    setOpfsStatus("ingesting...");
    setIdbStatus("ingesting...");

    opfsWorkerRef.current?.postMessage({ type: "INGEST", file, fileId });
    idbWorkerRef.current?.postMessage({ type: "INGEST", file, fileId });
  };

  const runBench = (target: "opfs" | "idb") => {
    if (target === "opfs" && opfsFile && opfsWorkerRef.current) {
      setOpfsBusy(true);
      setOpfsStatus("OPFS benchmarking...");
      opfsWorkerRef.current.postMessage({
        type: "BENCH",
        fileId: opfsFile.fileId,
        iterations: BENCH_ITERATIONS,
        chunkSize: BENCH_CHUNK,
      });
    } else if (target === "idb" && idbFile && idbWorkerRef.current) {
      setIdbBusy(true);
      setIdbStatus("IDB benchmarking...");
      idbWorkerRef.current.postMessage({
        type: "BENCH",
        fileId: idbFile.fileId,
        iterations: BENCH_ITERATIONS,
        chunkSize: BENCH_CHUNK,
      });
    }
  };

  const runBoth = () => {
    runBench("opfs");
    runBench("idb");
  };

  const speedup = opfsBench && idbBench ? idbBench.median / opfsBench.median : null;

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-4xl space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-01 · OPFS File System</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Ingest a video file into OPFS and IndexedDB in parallel, then
            compare random byte-range read latency.
          </p>
          <p className="text-xs text-zinc-500">
            Targets: 1GB ingest &lt; 15s · OPFS read &lt; 5ms · IDB read &gt;
            15ms
          </p>
        </header>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <label className="mb-2 block text-sm font-semibold">
            Pick a file (video preferred, any large file works)
          </label>
          <input
            type="file"
            onChange={onFileChange}
            disabled={opfsBusy || idbBusy}
            className="block w-full text-sm"
          />
          {opfsBusy && (
            <div className="mt-3">
              <progress
                value={opfsProgress}
                max={100}
                className="w-full"
              />
              <span className="ml-2 text-xs">
                {opfsProgress.toFixed(1)}%
              </span>
            </div>
          )}
        </section>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Panel
            title="OPFS"
            status={opfsStatus}
            file={opfsFile}
            bench={opfsBench}
            disabled={opfsBusy || !opfsFile}
            onBench={() => runBench("opfs")}
          />
          <Panel
            title="IndexedDB"
            status={idbStatus}
            file={idbFile}
            bench={idbBench}
            disabled={idbBusy || !idbFile}
            onBench={() => runBench("idb")}
          />
        </section>

        <section className="flex items-center gap-4">
          <button
            type="button"
            onClick={runBoth}
            disabled={opfsBusy || idbBusy || !opfsFile || !idbFile}
            className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
          >
            Run both benchmarks
          </button>
          {speedup !== null && (
            <span className="text-sm">
              OPFS is{" "}
              <span className="font-bold text-emerald-600 dark:text-emerald-400">
                {speedup.toFixed(2)}×
              </span>{" "}
              faster than IDB at random 1MB reads
            </span>
          )}
        </section>

        <footer className="text-xs text-zinc-500">
          Run the benchmarks twice — first run includes OS page-cache warm-up.
          Verify in Chrome DevTools → Performance and Memory tabs.
        </footer>
      </div>
    </main>
  );
}

function Panel({
  title,
  status,
  file,
  bench,
  disabled,
  onBench,
}: {
  title: string;
  status: string;
  file: FileInfo | null;
  bench: BenchResult | null;
  disabled: boolean;
  onBench: () => void;
}) {
  return (
    <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onBench}
          disabled={disabled}
          className="rounded border border-zinc-400 px-2 py-1 text-xs disabled:opacity-40"
        >
          Run bench
        </button>
      </div>
      <div className="text-xs text-zinc-500">{status}</div>
      {file && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <dt className="text-zinc-500">name</dt>
          <dd className="truncate">{file.name}</dd>
          <dt className="text-zinc-500">size</dt>
          <dd>{fmtBytes(file.size)}</dd>
          <dt className="text-zinc-500">ingest</dt>
          <dd>{fmtMs(file.ingestMs)}</dd>
        </dl>
      )}
      {bench && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <dt className="text-zinc-500">iter × chunk</dt>
          <dd>
            {bench.iterations} × {fmtBytes(bench.chunkSize)}
          </dd>
          <dt className="text-zinc-500">median</dt>
          <dd className="font-bold">{fmtMs(bench.median)}</dd>
          <dt className="text-zinc-500">mean</dt>
          <dd>{fmtMs(bench.mean)}</dd>
          <dt className="text-zinc-500">p95</dt>
          <dd>{fmtMs(bench.p95)}</dd>
          <dt className="text-zinc-500">min / max</dt>
          <dd>
            {fmtMs(bench.min)} / {fmtMs(bench.max)}
          </dd>
        </dl>
      )}
    </div>
  );
}
