"use client";

import { useEffect, useRef, useState } from "react";

type Demuxed = {
  codec: string;
  width: number;
  height: number;
  fps: number;
  sampleCount: number;
  durationUs: number;
};

type Progress = {
  frame: number;
  total: number;
  percent: number;
  encoderQueue: number;
  elapsedMs: number;
};

type Done = {
  fileName: string;
  bytes: number;
  frames: number;
  elapsedMs: number;
  muxer: "mediabunny" | "mp4-muxer";
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export default function Page() {
  const workerRef = useRef<Worker | null>(null);
  const fileRef = useRef<File | null>(null);

  const [stage, setStage] = useState("idle");
  const [demuxed, setDemuxed] = useState<Demuxed | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [bitrate, setBitrate] = useState(8_000_000);
  const [fps, setFps] = useState(30);
  const [muxer, setMuxer] = useState<"mediabunny" | "mp4-muxer">("mediabunny");

  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/export.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "STAGE") {
        setStage(m.stage);
      } else if (m.type === "DEMUXED") {
        setDemuxed({
          codec: m.config.codec,
          width: m.config.width,
          height: m.config.height,
          fps: m.config.fps,
          sampleCount: m.sampleCount,
          durationUs: m.durationUs,
        });
      } else if (m.type === "PROGRESS") {
        setProgress({
          frame: m.frame,
          total: m.total,
          percent: m.percent,
          encoderQueue: m.encoderQueue,
          elapsedMs: m.elapsedMs,
        });
      } else if (m.type === "DONE") {
        setDone({
          fileName: m.fileName,
          bytes: m.bytes,
          frames: m.frames,
          elapsedMs: m.elapsedMs,
          muxer: m.muxer,
        });
        setProgress(null);
        setStage("done");
        setBusy(false);
      } else if (m.type === "ERROR") {
        setError(m.message);
        setBusy(false);
      }
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    fileRef.current = f;
    setStage(`selected ${f.name}`);
    setDone(null);
    setError(null);
  };

  const startExport = () => {
    const file = fileRef.current;
    if (!file) {
      setError("pick a file first");
      return;
    }
    setError(null);
    setDone(null);
    setProgress(null);
    setBusy(true);
    setStage("starting...");
    workerRef.current?.postMessage({
      type: "EXPORT",
      file,
      width,
      height,
      bitrate,
      fps,
      muxer,
    });
  };

  const downloadExport = async () => {
    if (!done) return;
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(done.fileName);
    const file = await handle.getFile();
    const w = window as Window &
      typeof globalThis & {
        showSaveFilePicker?: (opts: {
          suggestedName: string;
          types: { description: string; accept: Record<string, string[]> }[];
        }) => Promise<FileSystemFileHandle>;
      };
    if (typeof w.showSaveFilePicker === "function") {
      try {
        const saveHandle = await w.showSaveFilePicker({
          suggestedName: done.fileName,
          types: [
            {
              description: "MP4 Video",
              accept: { "video/mp4": [".mp4"] },
            },
          ],
        });
        const writable = await (saveHandle as unknown as {
          createWritable: () => Promise<WritableStream>;
        }).createWritable();
        await file.stream().pipeTo(writable);
        return;
      } catch {
        // user cancelled — fall through
      }
    }
    // Fallback: blob URL <a download>
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = done.fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-10 · Export Pipeline</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Decode source -&gt; WebGPU passthrough composite (in worker
            OffscreenCanvas) -&gt; VideoEncoder -&gt; muxer -&gt; OPFS -&gt;
            showSaveFilePicker. Toggle the muxer to compare mediabunny vs
            mp4-muxer.
          </p>
          <p className="text-xs text-zinc-500">
            Targets: 30s 1080p export &lt; 120s, plays in QuickTime/VLC, no
            VideoFrame leaks.
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
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Export config</h2>
          <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-5">
            <label className="flex items-center gap-2">
              W
              <input
                type="number"
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
                className="w-20 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="flex items-center gap-2">
              H
              <input
                type="number"
                value={height}
                onChange={(e) => setHeight(Number(e.target.value))}
                className="w-20 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="flex items-center gap-2">
              fps
              <input
                type="number"
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                className="w-16 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="flex items-center gap-2">
              kbps
              <input
                type="number"
                value={Math.round(bitrate / 1000)}
                onChange={(e) =>
                  setBitrate(Math.max(100_000, Number(e.target.value) * 1000))
                }
                className="w-24 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="flex items-center gap-2">
              muxer
              <select
                value={muxer}
                onChange={(e) =>
                  setMuxer(e.target.value as "mediabunny" | "mp4-muxer")
                }
                className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="mediabunny">mediabunny</option>
                <option value="mp4-muxer">mp4-muxer</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex items-center gap-3 text-xs">
            <button
              type="button"
              onClick={startExport}
              disabled={busy}
              className="rounded bg-zinc-900 px-3 py-1 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
            >
              start export
            </button>
            <span className="text-zinc-500">stage: {stage}</span>
          </div>
        </section>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {demuxed && (
          <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
            <h3 className="mb-1 text-sm font-semibold">Source</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
              <dt className="text-zinc-500">codec</dt>
              <dd className="font-mono">{demuxed.codec}</dd>
              <dt className="text-zinc-500">resolution</dt>
              <dd>
                {demuxed.width}×{demuxed.height}
              </dd>
              <dt className="text-zinc-500">fps</dt>
              <dd>{demuxed.fps.toFixed(2)}</dd>
              <dt className="text-zinc-500">samples</dt>
              <dd>{demuxed.sampleCount}</dd>
              <dt className="text-zinc-500">duration</dt>
              <dd>{(demuxed.durationUs / 1000).toFixed(0)} ms</dd>
            </dl>
          </section>
        )}

        {progress && (
          <section className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <h3 className="mb-2 text-sm font-semibold">Encoding</h3>
            <progress value={progress.percent} max={100} className="w-full" />
            <div className="mt-1 text-xs text-zinc-500">
              {progress.frame}/{progress.total} ·{" "}
              {progress.percent.toFixed(1)}% · queue {progress.encoderQueue}
              {" · "}
              {(progress.elapsedMs / 1000).toFixed(1)} s
            </div>
          </section>
        )}

        {done && (
          <section className="rounded border border-emerald-500 p-4 text-sm dark:border-emerald-500">
            <h3 className="mb-2 text-sm font-semibold">
              Export complete · {done.muxer}
            </h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs md:grid-cols-4">
              <dt className="text-zinc-500">file</dt>
              <dd className="font-mono">{done.fileName}</dd>
              <dt className="text-zinc-500">size</dt>
              <dd>{fmtBytes(done.bytes)}</dd>
              <dt className="text-zinc-500">frames</dt>
              <dd>{done.frames}</dd>
              <dt className="text-zinc-500">elapsed</dt>
              <dd>{(done.elapsedMs / 1000).toFixed(2)} s</dd>
            </dl>
            <button
              type="button"
              onClick={downloadExport}
              className="mt-3 rounded bg-zinc-900 px-3 py-1 text-sm text-white dark:bg-zinc-100 dark:text-black"
            >
              save file
            </button>
          </section>
        )}
      </div>
    </main>
  );
}
