"use client";

import { useEffect, useRef, useState } from "react";
import type { CodecConfig } from "../lib/types";

type LoadInfo = {
  config: CodecConfig;
  durationUs: number;
  sampleCount: number;
  keyframeCount: number;
  elapsedMs: number;
};

type Stats = {
  fps: number;
  playheadUs: number;
  stepUs: number;
};

function fmtMs(n: number): string {
  return `${n.toFixed(2)} ms`;
}

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const initializedRef = useRef(false);

  const [info, setInfo] = useState<LoadInfo | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [seekMs, setSeekMs] = useState(0);
  const [counter, setCounter] = useState(0);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // Set initial canvas pixel dims so OffscreenCanvas isn't 300x150.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));

    const offscreen = canvas.transferControlToOffscreen();
    const worker = new Worker(
      new URL("../workers/render.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "READY") {
        setStatus("renderer ready");
      } else if (m.type === "LOADED") {
        setInfo({
          config: m.config,
          durationUs: m.durationUs,
          sampleCount: m.sampleCount,
          keyframeCount: m.keyframeCount,
          elapsedMs: m.elapsedMs,
        });
        setSeekMs(0);
        setStatus(`loaded · ${m.elapsedMs.toFixed(0)} ms`);
      } else if (m.type === "STATS") {
        setStats({ fps: m.fps, playheadUs: m.playheadUs, stepUs: m.stepUs });
      } else if (m.type === "ERROR") {
        setError(m.message);
      }
    };

    worker.postMessage({ type: "INIT", canvas: offscreen, dpr }, [offscreen]);

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setInfo(null);
    setStatus("demuxing in render worker...");
    workerRef.current?.postMessage({ type: "LOAD", file });
  };

  const onPlay = () => {
    setPlaying(true);
    workerRef.current?.postMessage({
      type: "PLAY",
      fps: info?.config.fps ?? 30,
    });
  };

  const onPause = () => {
    setPlaying(false);
    workerRef.current?.postMessage({ type: "PAUSE" });
  };

  const onSeek = (ms: number) => {
    if (!info) return;
    setSeekMs(ms);
    setPlaying(false);
    workerRef.current?.postMessage({
      type: "SEEK",
      targetUs: Math.max(0, Math.min(ms * 1000, info.durationUs - 1)),
    });
  };

  const stressReact = () => {
    for (let i = 0; i < 100; i++) {
      setTimeout(() => setCounter((c) => c + 1), i * 5);
    }
  };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">
            Exp-05 · OffscreenCanvas Worker
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Render worker owns OffscreenCanvas + WebGPU + decode sub-worker.
            Main thread only sends PLAY/PAUSE/SEEK. rAF replaced by
            MessageChannel ping-pong.
          </p>
          <p className="text-xs text-zinc-500">
            Targets: stable 30fps · zero drops on React stress · main thread
            &lt; 5% CPU during playback.
          </p>
        </header>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <label className="mb-2 block text-sm font-semibold">Pick MP4</label>
          <input
            type="file"
            accept="video/mp4,video/quicktime,video/*"
            onChange={onFileChange}
            className="block w-full text-sm"
          />
          <div className="mt-2 text-xs text-zinc-500">{status}</div>
        </section>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Preview</h2>
          <canvas
            ref={canvasRef}
            className="aspect-video w-full bg-zinc-900"
          />
        </section>

        {info && (
          <>
            <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
              <h2 className="mb-2 text-sm font-semibold">Transport</h2>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                {playing ? (
                  <button
                    type="button"
                    onClick={onPause}
                    className="rounded bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-black"
                  >
                    pause
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onPlay}
                    className="rounded bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-black"
                  >
                    play
                  </button>
                )}
                <input
                  type="range"
                  min={0}
                  max={Math.floor(info.durationUs / 1000)}
                  value={seekMs}
                  onChange={(e) => onSeek(Number(e.target.value))}
                  className="flex-1"
                />
                <span className="w-24 text-right text-xs">{seekMs} ms</span>
              </div>
            </section>

            <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
              <h3 className="mb-1 text-sm font-semibold">Stream</h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
                <dt className="text-zinc-500">codec</dt>
                <dd className="font-mono">{info.config.codec}</dd>
                <dt className="text-zinc-500">resolution</dt>
                <dd>
                  {info.config.width}×{info.config.height}
                </dd>
                <dt className="text-zinc-500">duration</dt>
                <dd>{(info.durationUs / 1000).toFixed(0)} ms</dd>
                <dt className="text-zinc-500">fps (avg)</dt>
                <dd>{info.config.fps.toFixed(2)}</dd>
                <dt className="text-zinc-500">samples</dt>
                <dd>{info.sampleCount}</dd>
                <dt className="text-zinc-500">keyframes</dt>
                <dd>{info.keyframeCount}</dd>
                <dt className="text-zinc-500">load time</dt>
                <dd>{fmtMs(info.elapsedMs)}</dd>
              </dl>
            </section>

            <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
              <h3 className="mb-1 text-sm font-semibold">
                Render-worker stats (1Hz update)
              </h3>
              {stats ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <dt className="text-zinc-500">fps</dt>
                  <dd className="font-bold">{stats.fps.toFixed(1)}</dd>
                  <dt className="text-zinc-500">playhead</dt>
                  <dd>{(stats.playheadUs / 1000).toFixed(0)} ms</dd>
                  <dt className="text-zinc-500">step</dt>
                  <dd>{(stats.stepUs / 1000).toFixed(2)} ms</dd>
                </dl>
              ) : (
                <div className="text-zinc-500">play to populate</div>
              )}
            </section>

            <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
              <h3 className="mb-1 text-sm font-semibold">React stress test</h3>
              <p className="mb-2 text-xs text-zinc-500">
                Hammers main thread with 100 staggered setState calls.
                Render-worker FPS should not drop.
              </p>
              <div className="flex items-center gap-3 text-sm">
                <button
                  type="button"
                  onClick={stressReact}
                  className="rounded border border-zinc-400 px-3 py-1 text-xs"
                >
                  stress · 100 setStates
                </button>
                <span className="text-xs text-zinc-500">
                  counter: {counter}
                </span>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
