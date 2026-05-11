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

type RenderStat = {
  targetUs: number;
  tier: "vram" | "ram" | "miss";
  fetchMs: number;
  drawMs: number;
  totalMs: number;
  vramSize: number;
  ramSize: number;
};

type Bench = {
  iterations: number;
  byTier: Record<"vram" | "ram" | "miss", { count: number; medianMs: number }>;
  totalMedianMs: number;
};

function fmtMs(n: number): string {
  return `${n.toFixed(2)} ms`;
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = xs.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const initRef = useRef(false);
  const samplesRef = useRef<RenderStat[]>([]);

  const [info, setInfo] = useState<LoadInfo | null>(null);
  const [last, setLast] = useState<RenderStat | null>(null);
  const [seekMs, setSeekMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [bench, setBench] = useState<Bench | null>(null);
  const [vramFrames, setVramFrames] = useState(60);
  const [ramFrames, setRamFrames] = useState(200);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    const canvas = canvasRef.current;
    if (!canvas) return;
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
        setStatus(`loaded · ${m.elapsedMs.toFixed(0)} ms`);
        samplesRef.current = [];
      } else if (m.type === "RENDERED") {
        const stat: RenderStat = {
          targetUs: m.targetUs,
          tier: m.tier,
          fetchMs: m.fetchMs,
          drawMs: m.drawMs,
          totalMs: m.totalMs,
          vramSize: m.vramSize,
          ramSize: m.ramSize,
        };
        setLast(stat);
        samplesRef.current.push(stat);
      } else if (m.type === "ERROR") {
        setError(m.message);
      }
    };
    worker.postMessage({ type: "INIT", canvas: offscreen }, [offscreen]);

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
    setLast(null);
    setBench(null);
    setStatus("loading...");
    workerRef.current?.postMessage({ type: "LOAD", file });
  };

  const seek = (ms: number) => {
    if (!info) return;
    setSeekMs(ms);
    const targetUs = Math.max(0, Math.min(ms * 1000, info.durationUs - 1));
    workerRef.current?.postMessage({ type: "SEEK", targetUs });
    workerRef.current?.postMessage({ type: "PREFETCH", targetUs });
  };

  const benchScrubAround = async () => {
    if (!info) return;
    const w = workerRef.current;
    if (!w) return;
    const center = Math.floor(info.durationUs / 2);
    setStatus("seeding cache...");
    // Seed: seek to center then prefetch ±30 frames, wait briefly.
    w.postMessage({ type: "SEEK", targetUs: center });
    w.postMessage({ type: "PREFETCH", targetUs: center });
    await new Promise((r) => setTimeout(r, 1500));
    setStatus("scrub bench (60 random ± 30 frames)...");
    samplesRef.current = [];
    const stepUs = info.config.fps > 0
      ? Math.round(1_000_000 / info.config.fps)
      : 33_333;
    for (let i = 0; i < 60; i++) {
      const off = Math.floor((Math.random() - 0.5) * 60) * stepUs;
      const targetUs = Math.max(0, Math.min(center + off, info.durationUs - 1));
      w.postMessage({ type: "SEEK", targetUs });
      await new Promise((r) => setTimeout(r, 16));
    }
    await new Promise((r) => setTimeout(r, 200));
    const samples = samplesRef.current;
    const byTier: Bench["byTier"] = {
      vram: { count: 0, medianMs: 0 },
      ram: { count: 0, medianMs: 0 },
      miss: { count: 0, medianMs: 0 },
    };
    const tally: Record<"vram" | "ram" | "miss", number[]> = {
      vram: [],
      ram: [],
      miss: [],
    };
    for (const s of samples) {
      tally[s.tier].push(s.totalMs);
    }
    for (const t of ["vram", "ram", "miss"] as const) {
      byTier[t] = { count: tally[t].length, medianMs: median(tally[t]) };
    }
    setBench({
      iterations: samples.length,
      byTier,
      totalMedianMs: median(samples.map((s) => s.totalMs)),
    });
    setStatus("bench done");
  };

  const applyConfig = () => {
    workerRef.current?.postMessage({
      type: "CONFIG",
      vramFrames,
      ramFrames,
    });
  };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-06 · Frame Cache</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Three-tier cache: GPUTexture (VRAM) → ImageBitmap (RAM) → cold
            decode. LRU eviction frees `texture.destroy()` and
            `bitmap.close()`. Pre-fetcher fills ±30 frames around the playhead.
          </p>
          <p className="text-xs text-zinc-500">
            Targets: VRAM hit &lt; 2ms · RAM hit &lt; 5ms · miss &lt; 500ms ·
            no leaks after 1000 evictions.
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
              <h2 className="mb-2 text-sm font-semibold">Cache config</h2>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-2">
                  VRAM frames
                  <input
                    type="number"
                    value={vramFrames}
                    onChange={(e) => setVramFrames(Number(e.target.value))}
                    className="w-20 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </label>
                <label className="flex items-center gap-2">
                  RAM frames
                  <input
                    type="number"
                    value={ramFrames}
                    onChange={(e) => setRamFrames(Number(e.target.value))}
                    className="w-20 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </label>
                <button
                  type="button"
                  onClick={applyConfig}
                  className="rounded border border-zinc-400 px-2 py-1"
                >
                  apply
                </button>
              </div>
            </section>

            <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
              <h2 className="mb-2 text-sm font-semibold">Seek</h2>
              <div className="flex items-center gap-3 text-sm">
                <input
                  type="range"
                  min={0}
                  max={Math.floor(info.durationUs / 1000)}
                  value={seekMs}
                  onChange={(e) => seek(Number(e.target.value))}
                  className="flex-1"
                />
                <span className="w-24 text-right text-xs">{seekMs} ms</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => seek(0)}
                  className="rounded border border-zinc-400 px-2 py-1"
                >
                  start
                </button>
                <button
                  type="button"
                  onClick={() => seek(Math.floor(info.durationUs / 2 / 1000))}
                  className="rounded border border-zinc-400 px-2 py-1"
                >
                  middle
                </button>
                <button
                  type="button"
                  onClick={benchScrubAround}
                  className="rounded bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-black"
                >
                  bench · scrub ±30 frames
                </button>
              </div>
            </section>

            <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
                <h3 className="mb-1 text-sm font-semibold">Last render</h3>
                {last ? (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <dt className="text-zinc-500">tier</dt>
                    <dd
                      className={
                        last.tier === "vram"
                          ? "font-bold text-emerald-500"
                          : last.tier === "ram"
                            ? "font-bold text-amber-500"
                            : "font-bold text-red-500"
                      }
                    >
                      {last.tier}
                    </dd>
                    <dt className="text-zinc-500">fetch</dt>
                    <dd>{fmtMs(last.fetchMs)}</dd>
                    <dt className="text-zinc-500">draw</dt>
                    <dd>{fmtMs(last.drawMs)}</dd>
                    <dt className="text-zinc-500">total</dt>
                    <dd className="font-bold">{fmtMs(last.totalMs)}</dd>
                    <dt className="text-zinc-500">vram size</dt>
                    <dd>{last.vramSize}</dd>
                    <dt className="text-zinc-500">ram size</dt>
                    <dd>{last.ramSize}</dd>
                  </dl>
                ) : (
                  <div className="text-zinc-500">no render yet</div>
                )}
              </div>

              <div className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
                <h3 className="mb-1 text-sm font-semibold">
                  Bench result · ±30 scrubs
                </h3>
                {bench ? (
                  <dl className="grid grid-cols-3 gap-x-2 gap-y-1">
                    <dt className="text-zinc-500">iter</dt>
                    <dd className="col-span-2">{bench.iterations}</dd>
                    <dt className="text-zinc-500">total median</dt>
                    <dd className="col-span-2 font-bold">
                      {fmtMs(bench.totalMedianMs)}
                    </dd>
                    <dt className="text-zinc-500">vram</dt>
                    <dd>{bench.byTier.vram.count}×</dd>
                    <dd>{fmtMs(bench.byTier.vram.medianMs)}</dd>
                    <dt className="text-zinc-500">ram</dt>
                    <dd>{bench.byTier.ram.count}×</dd>
                    <dd>{fmtMs(bench.byTier.ram.medianMs)}</dd>
                    <dt className="text-zinc-500">miss</dt>
                    <dd>{bench.byTier.miss.count}×</dd>
                    <dd>{fmtMs(bench.byTier.miss.medianMs)}</dd>
                  </dl>
                ) : (
                  <div className="text-zinc-500">run bench first</div>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
