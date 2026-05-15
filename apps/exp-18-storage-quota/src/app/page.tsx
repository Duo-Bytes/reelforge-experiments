"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, formatPct } from "../lib/format";
import type { MainToWorker, WorkerToMain } from "../lib/protocol";

type Estimate = {
  usage: number;
  quota: number;
  details: Record<string, number>;
};

type LogEntry = { at: number; text: string; tone: "info" | "warn" | "evict" | "error" };

const CHUNK_OPTIONS = [
  { label: "1 MiB", bytes: 1 * 1024 * 1024 },
  { label: "4 MiB", bytes: 4 * 1024 * 1024 },
  { label: "8 MiB", bytes: 8 * 1024 * 1024 },
  { label: "16 MiB", bytes: 16 * 1024 * 1024 },
];

export default function Page() {
  const workerRef = useRef<Worker | null>(null);
  const pollRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);

  const [supported, setSupported] = useState<boolean>(true);
  const [supportNote, setSupportNote] = useState<string>("");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [persistResult, setPersistResult] = useState<string>("");
  const [running, setRunning] = useState<boolean>(false);
  const [chunkBytes, setChunkBytes] = useState<number>(CHUNK_OPTIONS[2].bytes);
  const [totalChunks, setTotalChunks] = useState<number>(0);
  const [writtenBytes, setWrittenBytes] = useState<number>(0);
  const [evictions, setEvictions] = useState<number>(0);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [log, setLog] = useState<LogEntry[]>([]);

  const pushLog = useCallback((text: string, tone: LogEntry["tone"] = "info") => {
    setLog((prev) => {
      const next = [{ at: Date.now(), text, tone }, ...prev];
      return next.slice(0, 200);
    });
  }, []);

  // Capability detection — runs once.
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    if (!("storage" in navigator) || !navigator.storage?.getDirectory) {
      setSupported(false);
      setSupportNote("navigator.storage.getDirectory is unavailable.");
      return;
    }
    // FileSystemSyncAccessHandle is worker-only; we cannot feature-detect it
    // from the main thread without instantiating a worker, so we instead rely
    // on the worker reporting "ready". If it never does, the panel will stay
    // blank — surfaced via the running banner.
    void navigator.storage
      .persisted()
      .then(setPersisted)
      .catch(() => setPersisted(null));
  }, []);

  // Live estimate poller.
  const refreshEstimate = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return;
    try {
      const e = await navigator.storage.estimate();
      const detailsRaw = (e as StorageEstimate & { usageDetails?: Record<string, number> })
        .usageDetails;
      setEstimate({
        usage: e.usage ?? 0,
        quota: e.quota ?? 0,
        details: detailsRaw ?? {},
      });
    } catch {
      // ignore; estimate sometimes rejects on private contexts
    }
  }, []);

  useEffect(() => {
    void refreshEstimate();
    pollRef.current = window.setInterval(() => {
      void refreshEstimate();
      if (running) setElapsedMs(Date.now() - startedAtRef.current);
    }, 500);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [running, refreshEstimate]);

  // Worker lifecycle.
  useEffect(() => {
    if (!supported) return;
    const w = new Worker(new URL("../workers/opfs.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = w;
    w.onmessage = (event: MessageEvent<WorkerToMain>) => {
      const msg = event.data;
      if (msg.kind === "ready") {
        pushLog("Worker ready.", "info");
      } else if (msg.kind === "wrote") {
        setTotalChunks(msg.totalChunks);
        setWrittenBytes((b) => b + msg.bytes);
      } else if (msg.kind === "evicted") {
        setEvictions((n) => n + 1);
        pushLog(`Quota hit — evicted chunk ${msg.removedIndex} (${msg.reason}).`, "evict");
      } else if (msg.kind === "error") {
        pushLog(msg.message, "error");
        if (msg.fatal) setRunning(false);
      } else if (msg.kind === "stopped") {
        setRunning(false);
        pushLog(`Stopped. ${msg.totalChunks} chunks live.`, "info");
      } else if (msg.kind === "cleared") {
        setTotalChunks(0);
        setWrittenBytes(0);
        setEvictions(0);
        setElapsedMs(0);
        pushLog("OPFS cleared.", "info");
        void refreshEstimate();
      }
    };
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, [supported, pushLog, refreshEstimate]);

  const send = useCallback((m: MainToWorker) => {
    workerRef.current?.postMessage(m);
  }, []);

  const onStart = useCallback(() => {
    if (running) return;
    setRunning(true);
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    pushLog(`Start — chunk size ${formatBytes(chunkBytes)}.`, "info");
    send({ kind: "start", chunkBytes });
  }, [running, chunkBytes, pushLog, send]);

  const onStop = useCallback(() => {
    if (!running) return;
    send({ kind: "stop" });
  }, [running, send]);

  const onClear = useCallback(() => {
    send({ kind: "clear" });
  }, [send]);

  const onRequestPersist = useCallback(async () => {
    if (!navigator.storage?.persist) {
      setPersistResult("storage.persist unavailable");
      return;
    }
    try {
      const granted = await navigator.storage.persist();
      setPersisted(granted);
      setPersistResult(granted ? "granted" : "denied");
      pushLog(`navigator.storage.persist() → ${granted ? "true" : "false"}`, "info");
    } catch (err) {
      setPersistResult(`error: ${(err as Error).message}`);
    }
  }, [pushLog]);

  const ratio = useMemo(() => {
    if (!estimate || !estimate.quota) return 0;
    return estimate.usage / estimate.quota;
  }, [estimate]);

  const warn = ratio > 0.8;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10 flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Exp-18 · Storage Quota & Eviction Drill</h1>
        <p className="text-sm text-neutral-500 max-w-3xl">
          Fills OPFS with fixed-size chunks until <code>QuotaExceededError</code>, then
          drops the oldest chunk and continues. Watch the estimate panel rise, hit a
          wall, and stabilise.
        </p>
      </header>

      {!supported && (
        <div className="border border-red-500/50 bg-red-500/5 rounded-md p-4 text-sm">
          Unsupported environment: {supportNote}
        </div>
      )}

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-md border border-neutral-500/30 p-4 flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wider text-neutral-500">Estimate</h2>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold">{formatBytes(estimate?.usage)}</span>
            <span className="text-sm text-neutral-500">/ {formatBytes(estimate?.quota)}</span>
          </div>
          <div className="h-2 w-full bg-neutral-500/20 rounded overflow-hidden">
            <div
              className={`h-full transition-all ${warn ? "bg-red-500" : "bg-emerald-500"}`}
              style={{ width: `${Math.min(100, ratio * 100).toFixed(2)}%` }}
            />
          </div>
          <div className="text-xs text-neutral-500">{formatPct(ratio)} of quota</div>
          {estimate && Object.keys(estimate.details).length > 0 && (
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              {Object.entries(estimate.details).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <dt className="text-neutral-500">{k}</dt>
                  <dd className="font-mono">{formatBytes(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        <div className="rounded-md border border-neutral-500/30 p-4 flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wider text-neutral-500">Persistence</h2>
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full ${
                persisted ? "bg-emerald-500" : persisted === false ? "bg-amber-500" : "bg-neutral-500"
              }`}
            />
            <span className="text-sm">
              {persisted === null ? "unknown" : persisted ? "persisted" : "best-effort"}
            </span>
          </div>
          <button
            type="button"
            onClick={onRequestPersist}
            className="mt-2 px-3 py-1.5 text-sm border border-neutral-500/40 rounded hover:bg-neutral-500/10"
          >
            Request persist()
          </button>
          {persistResult && (
            <div className="text-xs text-neutral-500">last: {persistResult}</div>
          )}
        </div>

        <div className="rounded-md border border-neutral-500/30 p-4 flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wider text-neutral-500">Run</h2>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="text-neutral-500">Live chunks</dt>
            <dd className="font-mono">{totalChunks}</dd>
            <dt className="text-neutral-500">Bytes written</dt>
            <dd className="font-mono">{formatBytes(writtenBytes)}</dd>
            <dt className="text-neutral-500">Evictions</dt>
            <dd className="font-mono">{evictions}</dd>
            <dt className="text-neutral-500">Elapsed</dt>
            <dd className="font-mono">{(elapsedMs / 1000).toFixed(1)} s</dd>
          </dl>
        </div>
      </section>

      {warn && (
        <div className="border border-amber-500/60 bg-amber-500/10 rounded-md p-3 text-sm">
          Warning — usage exceeds 80% of quota. The browser may begin evicting this
          origin if it is not persisted.
        </div>
      )}

      <section className="flex flex-wrap items-center gap-3">
        <label className="text-sm flex items-center gap-2">
          Chunk size
          <select
            value={chunkBytes}
            onChange={(e) => setChunkBytes(Number(e.target.value))}
            disabled={running}
            className="border border-neutral-500/40 bg-transparent rounded px-2 py-1 text-sm"
          >
            {CHUNK_OPTIONS.map((o) => (
              <option key={o.bytes} value={o.bytes}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onStart}
          disabled={running || !supported}
          className="px-3 py-1.5 text-sm rounded bg-emerald-600 text-white disabled:opacity-40"
        >
          Start fill
        </button>
        <button
          type="button"
          onClick={onStop}
          disabled={!running}
          className="px-3 py-1.5 text-sm rounded border border-neutral-500/40 disabled:opacity-40"
        >
          Stop
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={running}
          className="px-3 py-1.5 text-sm rounded border border-red-500/50 text-red-500 disabled:opacity-40"
        >
          Clear OPFS
        </button>
      </section>

      <section className="rounded-md border border-neutral-500/30 p-4">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500 mb-2">Event log</h2>
        <ol className="text-xs font-mono max-h-72 overflow-y-auto flex flex-col gap-0.5">
          {log.length === 0 && <li className="text-neutral-500">(no events yet)</li>}
          {log.map((e, i) => (
            <li
              key={`${e.at}-${i}`}
              className={
                e.tone === "error"
                  ? "text-red-500"
                  : e.tone === "evict"
                    ? "text-amber-500"
                    : e.tone === "warn"
                      ? "text-amber-400"
                      : "text-neutral-400"
              }
            >
              <span className="text-neutral-500">
                {new Date(e.at).toLocaleTimeString()}{" "}
              </span>
              {e.text}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
