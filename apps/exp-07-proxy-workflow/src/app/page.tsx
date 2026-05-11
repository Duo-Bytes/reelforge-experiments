"use client";

import { useEffect, useRef, useState } from "react";
import type { CodecConfig } from "../lib/types";

type Ingested = {
  fileId: string;
  config: CodecConfig;
  sampleCount: number;
  keyframeCount: number;
  durationUs: number;
  elapsedMs: number;
};

type ProxyMeta = {
  sourceFileId: string;
  proxyFileId: string;
  width: number;
  height: number;
  bitrate: number;
  fps: number;
  durationUs: number;
  proxyBytes: number;
  encodedFrames: number;
  createdAt: number;
};

type Progress = {
  fileId: string;
  percent: number;
  encoded: number;
  total: number;
};

type Done = {
  fileId: string;
  meta: ProxyMeta;
  elapsedMs: number;
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export default function Page() {
  const workerRef = useRef<Worker | null>(null);
  const [ingested, setIngested] = useState<Ingested | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [proxies, setProxies] = useState<ProxyMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/proxy.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "INGESTED") {
        setIngested({
          fileId: m.fileId,
          config: m.config,
          sampleCount: m.sampleCount,
          keyframeCount: m.keyframeCount,
          durationUs: m.durationUs,
          elapsedMs: m.elapsedMs,
        });
        setStatus(`ingested · ${m.elapsedMs.toFixed(0)} ms`);
        setBusy(false);
      } else if (m.type === "PROGRESS") {
        setProgress({
          fileId: m.fileId,
          percent: m.percent,
          encoded: m.encoded,
          total: m.total,
        });
      } else if (m.type === "DONE") {
        setDone({
          fileId: m.fileId,
          meta: m.meta,
          elapsedMs: m.elapsedMs,
        });
        setProgress(null);
        setStatus(`proxy ready · ${m.elapsedMs.toFixed(0)} ms`);
        setBusy(false);
        worker.postMessage({ type: "LIST" });
      } else if (m.type === "LIST_RESULT") {
        setProxies(m.proxies);
      } else if (m.type === "RESET_OK") {
        worker.postMessage({ type: "LIST" });
      } else if (m.type === "ERROR") {
        setError(m.message);
        setBusy(false);
      }
    };
    workerRef.current = worker;
    worker.postMessage({ type: "LIST" });
    return () => {
      worker.terminate();
    };
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setIngested(null);
    setDone(null);
    setProgress(null);
    setBusy(true);
    setStatus("ingesting...");
    workerRef.current?.postMessage({
      type: "INGEST",
      file,
      fileId: crypto.randomUUID(),
    });
  };

  const onTranscode = () => {
    if (!ingested) return;
    setBusy(true);
    setStatus("transcoding...");
    workerRef.current?.postMessage({
      type: "TRANSCODE",
      fileId: ingested.fileId,
    });
  };

  const onReset = (fileId: string) => {
    workerRef.current?.postMessage({ type: "RESET", fileId });
  };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-07 · Proxy Workflow</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Background-transcode source video to a 720p H.264 proxy with
            keyframe-per-frame for instant scrubbing. Source stays in OPFS
            for export. Metadata in IndexedDB.
          </p>
          <p className="text-xs text-zinc-500">
            Targets: 30s 1080p source proxy &lt; 90s · main thread &lt; 2%
            during transcode · proxy seeks instantly at any frame.
          </p>
        </header>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <label className="mb-2 block text-sm font-semibold">Pick MP4</label>
          <input
            type="file"
            accept="video/mp4,video/quicktime,video/*"
            onChange={onFileChange}
            disabled={busy}
            className="block w-full text-sm"
          />
          <div className="mt-2 text-xs text-zinc-500">{status}</div>
        </section>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {ingested && (
          <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">Ingested source</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
              <dt className="text-zinc-500">file id</dt>
              <dd className="font-mono">{ingested.fileId.slice(0, 8)}…</dd>
              <dt className="text-zinc-500">codec</dt>
              <dd className="font-mono">{ingested.config.codec}</dd>
              <dt className="text-zinc-500">resolution</dt>
              <dd>
                {ingested.config.width}×{ingested.config.height}
              </dd>
              <dt className="text-zinc-500">fps</dt>
              <dd>{ingested.config.fps.toFixed(2)}</dd>
              <dt className="text-zinc-500">duration</dt>
              <dd>{(ingested.durationUs / 1000).toFixed(0)} ms</dd>
              <dt className="text-zinc-500">samples</dt>
              <dd>{ingested.sampleCount}</dd>
              <dt className="text-zinc-500">keyframes</dt>
              <dd>{ingested.keyframeCount}</dd>
              <dt className="text-zinc-500">ingest ms</dt>
              <dd>{ingested.elapsedMs.toFixed(0)}</dd>
            </dl>
            <button
              type="button"
              onClick={onTranscode}
              disabled={busy}
              className="mt-3 rounded bg-zinc-900 px-3 py-1 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
            >
              transcode 720p proxy
            </button>
          </section>
        )}

        {progress && (
          <section className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">Transcoding</h2>
            <progress value={progress.percent} max={100} className="w-full" />
            <div className="mt-1 text-xs text-zinc-500">
              {progress.percent.toFixed(1)}% · encoded{" "}
              {progress.encoded}/{progress.total}
            </div>
          </section>
        )}

        {done && (
          <section className="rounded border border-emerald-500 p-4 text-sm dark:border-emerald-500">
            <h2 className="mb-2 text-sm font-semibold">Proxy ready</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs md:grid-cols-4">
              <dt className="text-zinc-500">resolution</dt>
              <dd>
                {done.meta.width}×{done.meta.height}
              </dd>
              <dt className="text-zinc-500">bitrate</dt>
              <dd>{(done.meta.bitrate / 1_000_000).toFixed(1)} Mbps</dd>
              <dt className="text-zinc-500">fps</dt>
              <dd>{done.meta.fps}</dd>
              <dt className="text-zinc-500">file size</dt>
              <dd>{fmtBytes(done.meta.proxyBytes)}</dd>
              <dt className="text-zinc-500">frames</dt>
              <dd>{done.meta.encodedFrames}</dd>
              <dt className="text-zinc-500">elapsed</dt>
              <dd>{done.elapsedMs.toFixed(0)} ms</dd>
            </dl>
          </section>
        )}

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">
            IndexedDB proxy metadata
          </h2>
          {proxies.length === 0 ? (
            <div className="text-xs text-zinc-500">no proxies yet</div>
          ) : (
            <ul className="space-y-2 text-xs">
              {proxies.map((p) => (
                <li
                  key={p.sourceFileId}
                  className="flex items-center justify-between gap-2 rounded border border-zinc-300 p-2 dark:border-zinc-700"
                >
                  <div>
                    <div className="font-mono">
                      {p.sourceFileId.slice(0, 8)}… → {p.proxyFileId}
                    </div>
                    <div className="text-zinc-500">
                      {p.width}×{p.height} @ {p.fps}fps ·{" "}
                      {fmtBytes(p.proxyBytes)} · {p.encodedFrames} frames
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onReset(p.sourceFileId)}
                    className="rounded border border-zinc-400 px-2 py-1"
                  >
                    delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
