"use client";

import { useEffect, useRef, useState } from "react";
import type { CloseMode, RunMetrics, RunMode } from "../lib/types";

type Loaded = {
  codec: string;
  width: number;
  height: number;
  fps: number;
  sampleCount: number;
  elapsedMs: number;
};

export default function Page() {
  const workerRef = useRef<Worker | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  const [history, setHistory] = useState<
    { t: number; queue: number; outstanding: number; heap?: number }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<RunMode>("backpressure");
  const [closeMode, setCloseMode] = useState<CloseMode>("close");
  const [hwm, setHwm] = useState(8);
  const [iterations, setIterations] = useState(3);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = new Worker(
      new URL("../workers/bench.worker.ts", import.meta.url),
      { type: "module" },
    );
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "LOADED") {
        setLoaded(m as Loaded);
      } else if (m.type === "METRICS") {
        setMetrics(m.metrics as RunMetrics);
        setHistory((h) => {
          const next = [
            ...h,
            {
              t: m.metrics.elapsedMs as number,
              queue: m.metrics.currentQueueSize as number,
              outstanding: m.metrics.outstandingFrames as number,
              heap: m.metrics.jsHeapMb as number | undefined,
            },
          ];
          if (next.length > 500) next.shift();
          return next;
        });
      } else if (m.type === "DONE") {
        setBusy(false);
      } else if (m.type === "ERROR") {
        setError(m.message as string);
        setBusy(false);
      }
    };
    workerRef.current = w;
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoaded(null);
    setMetrics(null);
    setHistory([]);
    setError(null);
    workerRef.current?.postMessage({ type: "LOAD", file });
  };

  const run = () => {
    if (!loaded) return;
    setBusy(true);
    setMetrics(null);
    setHistory([]);
    setError(null);
    workerRef.current?.postMessage({
      type: "RUN",
      mode,
      closeMode,
      highWaterMark: hwm,
      iterations,
    });
  };

  const stop = () => {
    workerRef.current?.postMessage({ type: "STOP" });
  };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-14 · WebCodecs Backpressure</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Sustained decode of an MP4 with explicit{" "}
            <code>decodeQueueSize</code> watermarks and a deliberate leak
            harness. Pick a 4K60 file for the worst-case test.
          </p>
          <p className="text-xs text-zinc-500">
            Pass criteria: backpressure mode + close mode → outstanding frames
            stays ≤ HWM and JS heap is flat. No-backpressure + leak mode →
            queue size or heap explodes (proves the trap exists).
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <label className="block text-sm font-semibold">Source MP4</label>
          <input type="file" accept="video/mp4" onChange={onFile} className="mt-2" />
          {loaded && (
            <dl className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 text-xs">
              <dt className="text-zinc-500">codec</dt>
              <dd className="col-span-2">{loaded.codec}</dd>
              <dt className="text-zinc-500">resolution</dt>
              <dd className="col-span-2">
                {loaded.width}×{loaded.height} @ {loaded.fps.toFixed(2)} fps
              </dd>
              <dt className="text-zinc-500">samples</dt>
              <dd className="col-span-2">{loaded.sampleCount}</dd>
              <dt className="text-zinc-500">demux</dt>
              <dd className="col-span-2">{loaded.elapsedMs.toFixed(1)} ms</dd>
            </dl>
          )}
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Backpressure</h2>
            <label className="block text-xs">
              <input
                type="radio"
                checked={mode === "backpressure"}
                onChange={() => setMode("backpressure")}
              />{" "}
              On — pause feed when queue ≥ HWM
            </label>
            <label className="block text-xs">
              <input
                type="radio"
                checked={mode === "no-backpressure"}
                onChange={() => setMode("no-backpressure")}
              />{" "}
              Off — fire-and-forget (creates the &quot;traffic jam&quot;)
            </label>
            <label className="mt-2 block text-xs">
              high-water mark
              <input
                type="number"
                min={1}
                max={256}
                value={hwm}
                onChange={(e) => setHwm(parseInt(e.target.value) || 1)}
                className="ml-2 w-16 border bg-transparent px-1"
              />
            </label>
            <label className="mt-2 block text-xs">
              loop iterations
              <input
                type="number"
                min={1}
                max={20}
                value={iterations}
                onChange={(e) => setIterations(parseInt(e.target.value) || 1)}
                className="ml-2 w-16 border bg-transparent px-1"
              />
            </label>
          </div>
          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">VideoFrame lifetime</h2>
            <label className="block text-xs">
              <input
                type="radio"
                checked={closeMode === "close"}
                onChange={() => setCloseMode("close")}
              />{" "}
              .close() each frame — correct path
            </label>
            <label className="block text-xs">
              <input
                type="radio"
                checked={closeMode === "leak"}
                onChange={() => setCloseMode("leak")}
              />{" "}
              Leak — drop reference without close()
            </label>
            <p className="mt-2 text-xs text-zinc-500">
              VideoFrame holds GPU memory until close() is called. Dropping
              the JS reference is not enough — the leak path proves it.
            </p>
          </div>
        </section>

        <section className="flex items-center gap-2">
          <button
            onClick={run}
            disabled={busy || !loaded}
            className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
          >
            Run
          </button>
          <button
            onClick={stop}
            disabled={!busy}
            className="rounded border border-zinc-400 px-4 py-2 text-sm disabled:opacity-40"
          >
            Stop
          </button>
        </section>

        {metrics && (
          <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Live metrics</h2>
            <dl className="grid grid-cols-3 gap-x-4 gap-y-1 text-xs md:grid-cols-4">
              <Stat label="decoded" value={metrics.decodedCount.toString()} />
              <Stat label="closed" value={metrics.closedCount.toString()} />
              <Stat
                label="outstanding"
                value={metrics.outstandingFrames.toString()}
                emphasize={metrics.outstandingFrames > 50}
              />
              <Stat
                label="current queue"
                value={metrics.currentQueueSize.toString()}
              />
              <Stat
                label="peak queue"
                value={metrics.peakQueueSize.toString()}
                emphasize={metrics.peakQueueSize > 100}
              />
              <Stat
                label="rolling fps"
                value={metrics.rollingFps.toFixed(0)}
              />
              <Stat
                label="avg interval"
                value={`${metrics.avgDecodeIntervalMs.toFixed(2)} ms`}
              />
              <Stat
                label="JS heap"
                value={
                  metrics.jsHeapMb !== undefined
                    ? `${metrics.jsHeapMb.toFixed(1)} MB`
                    : "—"
                }
                emphasize={(metrics.jsHeapMb ?? 0) > 1024}
              />
              <Stat
                label="elapsed"
                value={`${(metrics.elapsedMs / 1000).toFixed(1)} s`}
              />
            </dl>
            <SparkLine
              history={history}
              max={Math.max(metrics.peakQueueSize, 20)}
            />
          </section>
        )}

        <footer className="text-xs text-zinc-500">
          For 4K60 testing, use any sufficiently long HEVC clip. Watch Chrome
          Task Manager (Shift+Esc) → GPU process memory: with leak mode and no
          backpressure the GPU memory should climb monotonically.
        </footer>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className={emphasize ? "font-bold text-red-500" : "font-medium"}>
        {value}
      </dd>
    </>
  );
}

function SparkLine({
  history,
  max,
}: {
  history: { t: number; queue: number; outstanding: number; heap?: number }[];
  max: number;
}) {
  if (history.length < 2) return null;
  const w = 600;
  const h = 120;
  const dx = w / (history.length - 1);
  const queuePath = history
    .map((p, i) => `${i === 0 ? "M" : "L"}${i * dx},${h - (p.queue / max) * h}`)
    .join(" ");
  const outstandingMax = Math.max(
    ...history.map((p) => p.outstanding),
    10,
  );
  const outPath = history
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${i * dx},${
          h - (p.outstanding / outstandingMax) * h
        }`,
    )
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="mt-3 block w-full text-xs"
      preserveAspectRatio="none"
    >
      <rect x={0} y={0} width={w} height={h} fill="transparent" />
      <path
        d={queuePath}
        stroke="currentColor"
        strokeOpacity={0.7}
        fill="none"
      />
      <path
        d={outPath}
        stroke="orange"
        strokeOpacity={0.9}
        fill="none"
      />
      <text x={4} y={12} className="fill-current">
        queue (gray) / outstanding frames (orange)
      </text>
    </svg>
  );
}
