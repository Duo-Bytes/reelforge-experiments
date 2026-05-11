"use client";

import { useEffect, useRef, useState } from "react";
import {
  initCompositor,
  renderComposite,
  type CompositorContext,
} from "../lib/compositor";

type LoadInfo = {
  codec: string;
  width: number;
  height: number;
  durationUs: number;
  sampleCount: number;
  keyframeCount: number;
};

type StressResult = {
  iterations: number;
  median: number;
  p95: number;
  min: number;
  max: number;
};

function fmtMs(n: number): string {
  return `${n.toFixed(2)} ms`;
}

export default function Page() {
  const workerRef = useRef<Worker | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<CompositorContext | null>(null);
  const bottomFrameRef = useRef<VideoFrame | null>(null);
  const topFrameRef = useRef<VideoFrame | null>(null);

  const [info, setInfo] = useState<LoadInfo | null>(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState<string | null>(null);
  const [topAlpha, setTopAlpha] = useState(0.5);
  const [enableTop, setEnableTop] = useState(false);
  const [bottomMs, setBottomMs] = useState(0);
  const [topMs, setTopMs] = useState(0);
  const [renderMs, setRenderMs] = useState<number | null>(null);
  const [stress, setStress] = useState<StressResult | null>(null);
  const [busy, setBusy] = useState(false);

  // Track outstanding seek requests so we can route arriving frames to the
  // right slot (bottom vs top).
  const pendingRef = useRef<Map<string, "bottom" | "top">>(new Map());

  useEffect(() => {
    let unmounted = false;
    const worker = new Worker(
      new URL("../workers/decode.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent) => {
      if (unmounted) {
        // late frame arriving during teardown — close it and bail
        if (e.data?.type === "FRAME") (e.data.frame as VideoFrame)?.close?.();
        return;
      }
      const m = e.data;
      if (m.type === "LOADED") {
        setInfo({
          codec: m.config.codec,
          width: m.config.width,
          height: m.config.height,
          durationUs: m.durationUs,
          sampleCount: m.sampleCount,
          keyframeCount: m.keyframeCount,
        });
        setStatus(`loaded · ${m.elapsedMs.toFixed(0)} ms`);
        setBusy(false);
      } else if (m.type === "FRAME") {
        const slot = pendingRef.current.get(m.reqId);
        pendingRef.current.delete(m.reqId);
        const frame: VideoFrame = m.frame;
        if (slot === "bottom") {
          bottomFrameRef.current?.close();
          bottomFrameRef.current = frame;
        } else if (slot === "top") {
          topFrameRef.current?.close();
          topFrameRef.current = frame;
        } else {
          frame.close();
        }
        renderNow();
      } else if (m.type === "ERROR") {
        setError(m.message);
        setBusy(false);
      }
    };
    workerRef.current = worker;
    return () => {
      unmounted = true;
      worker.terminate();
      bottomFrameRef.current?.close();
      topFrameRef.current?.close();
    };
  }, []);

  // Re-render whenever uniforms change (alpha or enableTop).
  useEffect(() => {
    renderNow();
  }, [topAlpha, enableTop]);

  const ensureCompositor = async () => {
    if (compositorRef.current) return compositorRef.current;
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("canvas not mounted");
    const ctx = await initCompositor(canvas);
    compositorRef.current = ctx;
    return ctx;
  };

  const renderNow = () => {
    const compositor = compositorRef.current;
    const bottom = bottomFrameRef.current;
    if (!compositor || !bottom) return;
    const canvas = canvasRef.current;
    if (canvas && info) {
      canvas.width = info.width;
      canvas.height = info.height;
    }
    const t0 = performance.now();
    renderComposite(
      compositor,
      bottom,
      enableTop ? topFrameRef.current : null,
      topAlpha,
    );
    setRenderMs(performance.now() - t0);
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setInfo(null);
    setBusy(true);
    setStress(null);
    bottomFrameRef.current?.close();
    topFrameRef.current?.close();
    bottomFrameRef.current = null;
    topFrameRef.current = null;
    try {
      await ensureCompositor();
      setStatus("demuxing + configuring...");
      workerRef.current?.postMessage({ type: "LOAD", file });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const requestFrame = (slot: "bottom" | "top", us: number) => {
    if (!info) return;
    const reqId = crypto.randomUUID();
    pendingRef.current.set(reqId, slot);
    const targetUs = Math.max(0, Math.min(us, info.durationUs - 1));
    if (slot === "bottom") setBottomMs(Math.round(targetUs / 1000));
    else setTopMs(Math.round(targetUs / 1000));
    workerRef.current?.postMessage({ type: "SEEK", reqId, targetUs });
  };

  const onStress = async () => {
    if (!info) return;
    setBusy(true);
    setStatus("rendering 1000 frames...");
    const compositor = compositorRef.current;
    const bottom = bottomFrameRef.current;
    if (!compositor || !bottom) {
      setBusy(false);
      setError("load + seek bottom frame first");
      return;
    }
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now();
      renderComposite(compositor, bottom, enableTop ? topFrameRef.current : null, topAlpha);
      // Yield once in a while so the browser can paint and we don't block.
      if (i % 60 === 0) await new Promise((r) => setTimeout(r));
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    setStress({
      iterations: samples.length,
      median: samples[Math.floor(samples.length / 2)],
      p95: samples[Math.floor(samples.length * 0.95)],
      min: samples[0],
      max: samples[samples.length - 1],
    });
    setBusy(false);
    setStatus("stress done");
  };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-04 · WebGPU Compositor</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Zero-copy VideoFrame → texture_external → WGSL alpha blend.
            VideoFrames import per render call (external textures expire end
            of task), bind groups recreated each frame.
          </p>
          <p className="text-xs text-zinc-500">
            Targets: render &lt; 2ms · main thread &lt; 3% CPU · stable heap
            after 1000 frames.
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

        {info && (
          <>
            <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
                <dt className="text-zinc-500">codec</dt>
                <dd className="font-mono">{info.codec}</dd>
                <dt className="text-zinc-500">resolution</dt>
                <dd>
                  {info.width}×{info.height}
                </dd>
                <dt className="text-zinc-500">duration</dt>
                <dd>{(info.durationUs / 1000).toFixed(0)} ms</dd>
                <dt className="text-zinc-500">samples</dt>
                <dd>{info.sampleCount}</dd>
              </dl>
            </section>

            <section className="space-y-3 rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
              <h2 className="text-base font-semibold">Layers</h2>
              <div className="space-y-2">
                <div>
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    <span className="font-semibold">bottom · ms</span>
                    <span>{bottomMs}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.floor(info.durationUs / 1000)}
                    value={bottomMs}
                    onChange={(e) =>
                      requestFrame("bottom", Number(e.target.value) * 1000)
                    }
                    className="w-full"
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    <input
                      id="enableTop"
                      type="checkbox"
                      checked={enableTop}
                      onChange={(e) => setEnableTop(e.target.checked)}
                    />
                    <label htmlFor="enableTop" className="font-semibold">
                      top layer
                    </label>
                    <span>· ms {topMs}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.floor(info.durationUs / 1000)}
                    value={topMs}
                    onChange={(e) =>
                      requestFrame("top", Number(e.target.value) * 1000)
                    }
                    disabled={!enableTop}
                    className="w-full"
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    <span className="font-semibold">top alpha</span>
                    <span>{topAlpha.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={topAlpha}
                    onChange={(e) => setTopAlpha(Number(e.target.value))}
                    disabled={!enableTop}
                    className="w-full"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => requestFrame("bottom", 0)}
                  className="rounded border border-zinc-400 px-2 py-1"
                >
                  bottom @ 0
                </button>
                <button
                  type="button"
                  onClick={() =>
                    requestFrame("bottom", Math.floor(info.durationUs / 2))
                  }
                  className="rounded border border-zinc-400 px-2 py-1"
                >
                  bottom @ middle
                </button>
                <button
                  type="button"
                  onClick={() =>
                    requestFrame("top", Math.floor(info.durationUs / 2))
                  }
                  className="rounded border border-zinc-400 px-2 py-1"
                  disabled={!enableTop}
                >
                  top @ middle
                </button>
                <button
                  type="button"
                  onClick={onStress}
                  disabled={busy}
                  className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
                >
                  stress · 1000 renders
                </button>
              </div>
            </section>

            <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
              <h2 className="mb-2 text-sm font-semibold">Composite</h2>
              <canvas
                ref={canvasRef}
                className="aspect-video max-h-[60vh] w-full bg-zinc-900 object-contain"
              />
              <div className="mt-2 text-xs">
                last render: {renderMs !== null ? fmtMs(renderMs) : "—"}
              </div>
            </section>

            {stress && (
              <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
                <h3 className="mb-1 text-sm font-semibold">
                  Stress · {stress.iterations} renders
                </h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <dt className="text-zinc-500">median</dt>
                  <dd className="font-bold">{fmtMs(stress.median)}</dd>
                  <dt className="text-zinc-500">p95</dt>
                  <dd>{fmtMs(stress.p95)}</dd>
                  <dt className="text-zinc-500">min / max</dt>
                  <dd>
                    {fmtMs(stress.min)} / {fmtMs(stress.max)}
                  </dd>
                </dl>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
