"use client";

import { useEffect, useRef, useState } from "react";
import type { CodecConfig } from "../lib/types";

type LoadInfo = {
  config: CodecConfig;
  sampleCount: number;
  keyframeCount: number;
  durationUs: number;
  elapsedMs: number;
};

type SeekStat = {
  reqId: string;
  decodeMs: number;
  peakQueueSize: number;
};

type StressResult = {
  iterations: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  peakQueueSize: number;
};

function fmtUs(n: number): string {
  return `${(n / 1000).toFixed(2)} ms`;
}
function fmtMs(n: number): string {
  return `${n.toFixed(2)} ms`;
}

export default function Page() {
  const workerRef = useRef<Worker | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState<LoadInfo | null>(null);
  const [seekUs, setSeekUs] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [lastSeek, setLastSeek] = useState<SeekStat | null>(null);
  const [stress, setStress] = useState<StressResult | null>(null);
  const [stressBusy, setStressBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/decode.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "LOADED") {
        setLoaded({
          config: m.config,
          sampleCount: m.sampleCount,
          keyframeCount: m.keyframeCount,
          durationUs: m.durationUs,
          elapsedMs: m.elapsedMs,
        });
        setLoading(false);
        setStatus(`loaded in ${m.elapsedMs.toFixed(0)} ms`);
      } else if (m.type === "FRAME") {
        const frame: VideoFrame = m.frame;
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
          const ctx = canvas.getContext("2d");
          if (ctx) ctx.drawImage(frame, 0, 0);
        }
        // MANDATORY frame.close() — releases GPU texture
        frame.close();
        setLastSeek({
          reqId: m.reqId,
          decodeMs: m.decodeMs,
          peakQueueSize: m.peakQueueSize,
        });
        setSeeking(false);
        setStatus(`seek done in ${m.decodeMs.toFixed(0)} ms`);
      } else if (m.type === "STRESS_RESULT") {
        setStress({
          iterations: m.iterations,
          median: m.median,
          p95: m.p95,
          min: m.min,
          max: m.max,
          peakQueueSize: m.peakQueueSize,
        });
        setStressBusy(false);
        setStatus("stress test done");
      } else if (m.type === "ERROR") {
        setError(m.message);
        setLoading(false);
        setSeeking(false);
        setStressBusy(false);
      }
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
    };
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setLoaded(null);
    setLastSeek(null);
    setStress(null);
    setLoading(true);
    setStatus("demuxing + configuring...");
    workerRef.current?.postMessage({ type: "LOAD", file });
  };

  const onSeek = (us: number) => {
    if (!loaded) return;
    setSeeking(true);
    setStatus(`seeking to ${fmtUs(us)}`);
    setSeekUs(us);
    workerRef.current?.postMessage({
      type: "SEEK",
      reqId: crypto.randomUUID(),
      targetUs: Math.max(0, Math.min(us, loaded.durationUs - 1)),
    });
  };

  const onStress = () => {
    if (!loaded) return;
    setStressBusy(true);
    setStatus("stress testing 100 random seeks...");
    workerRef.current?.postMessage({ type: "STRESS", iterations: 100 });
  };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-03 · WebCodecs Decode</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Frame-accurate seek via VideoDecoder. Demux + configure on load,
            then per seek: locate GOP, feed in DTS order, emit frame at target
            PTS.
          </p>
          <p className="text-xs text-zinc-500">
            Targets: cold seek &lt; 500ms · keyframe seek &lt; 100ms ·
            decodeQueueSize ≤ 8 · no leaks after 200 seeks.
          </p>
        </header>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <label className="mb-2 block text-sm font-semibold">Pick MP4</label>
          <input
            type="file"
            accept="video/mp4,video/quicktime,video/*"
            onChange={onFileChange}
            disabled={loading || seeking || stressBusy}
            className="block w-full text-sm"
          />
          <div className="mt-2 text-xs text-zinc-500">{status}</div>
        </section>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {loaded && (
          <>
            <section className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
              <h2 className="mb-2 text-base font-semibold">Stream</h2>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs md:grid-cols-4">
                <dt className="text-zinc-500">codec</dt>
                <dd className="font-mono">{loaded.config.codec}</dd>
                <dt className="text-zinc-500">resolution</dt>
                <dd>
                  {loaded.config.width}×{loaded.config.height}
                </dd>
                <dt className="text-zinc-500">duration</dt>
                <dd>{fmtUs(loaded.durationUs)}</dd>
                <dt className="text-zinc-500">samples</dt>
                <dd>{loaded.sampleCount}</dd>
                <dt className="text-zinc-500">keyframes</dt>
                <dd>{loaded.keyframeCount}</dd>
                <dt className="text-zinc-500">load time</dt>
                <dd>{fmtMs(loaded.elapsedMs)}</dd>
              </dl>
            </section>

            <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
              <h2 className="mb-2 text-sm font-semibold">Seek</h2>
              <div className="flex items-center gap-3 text-sm">
                <input
                  type="range"
                  min={0}
                  max={loaded.durationUs}
                  step={Math.max(1, Math.floor(loaded.durationUs / 1000))}
                  value={seekUs}
                  onChange={(e) => setSeekUs(Number(e.target.value))}
                  onMouseUp={(e) =>
                    onSeek(Number((e.target as HTMLInputElement).value))
                  }
                  className="flex-1"
                  disabled={seeking || stressBusy}
                />
                <span className="w-32 text-right text-xs">{fmtUs(seekUs)}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => onSeek(0)}
                  disabled={seeking || stressBusy}
                  className="rounded border border-zinc-400 px-2 py-1 disabled:opacity-40"
                >
                  start
                </button>
                <button
                  type="button"
                  onClick={() => onSeek(Math.floor(loaded.durationUs / 2))}
                  disabled={seeking || stressBusy}
                  className="rounded border border-zinc-400 px-2 py-1 disabled:opacity-40"
                >
                  middle
                </button>
                <button
                  type="button"
                  onClick={() => onSeek(loaded.durationUs - 1)}
                  disabled={seeking || stressBusy}
                  className="rounded border border-zinc-400 px-2 py-1 disabled:opacity-40"
                >
                  end
                </button>
                <button
                  type="button"
                  onClick={onStress}
                  disabled={seeking || stressBusy}
                  className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
                >
                  stress · 100 random seeks
                </button>
              </div>
            </section>

            <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
              <h2 className="mb-2 text-sm font-semibold">Frame</h2>
              <canvas
                ref={canvasRef}
                className="max-h-[60vh] w-full max-w-full bg-zinc-900 object-contain"
              />
            </section>

            <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
                <h3 className="mb-1 text-sm font-semibold">Last seek</h3>
                {lastSeek ? (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <dt className="text-zinc-500">decode</dt>
                    <dd className="font-bold">{fmtMs(lastSeek.decodeMs)}</dd>
                    <dt className="text-zinc-500">peak queue</dt>
                    <dd>{lastSeek.peakQueueSize}</dd>
                  </dl>
                ) : (
                  <div className="text-zinc-500">no seek yet</div>
                )}
              </div>
              <div className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
                <h3 className="mb-1 text-sm font-semibold">Stress result</h3>
                {stress ? (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <dt className="text-zinc-500">iterations</dt>
                    <dd>{stress.iterations}</dd>
                    <dt className="text-zinc-500">median</dt>
                    <dd className="font-bold">{fmtMs(stress.median)}</dd>
                    <dt className="text-zinc-500">p95</dt>
                    <dd>{fmtMs(stress.p95)}</dd>
                    <dt className="text-zinc-500">min / max</dt>
                    <dd>
                      {fmtMs(stress.min)} / {fmtMs(stress.max)}
                    </dd>
                    <dt className="text-zinc-500">peak queue</dt>
                    <dd>{stress.peakQueueSize}</dd>
                  </dl>
                ) : (
                  <div className="text-zinc-500">no stress yet</div>
                )}
              </div>
            </section>
          </>
        )}

        <footer className="text-xs text-zinc-500">
          frame.close() called on every emitted VideoFrame to free GPU texture.
        </footer>
      </div>
    </main>
  );
}
