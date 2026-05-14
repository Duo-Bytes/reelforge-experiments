"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { renderTestPattern, runScopes, type ScopeReadback } from "../lib/scopes";

type AdapterInfo = {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
} | null;

export default function Page() {
  const sourceRef = useRef<HTMLCanvasElement | null>(null);
  const lumaRef = useRef<HTMLCanvasElement | null>(null);
  const paradeRef = useRef<HTMLCanvasElement | null>(null);
  const vectorRef = useRef<HTMLCanvasElement | null>(null);
  const histoRef = useRef<HTMLCanvasElement | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [adapter, setAdapter] = useState<AdapterInfo>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [pattern, setPattern] = useState<"smpte" | "ramp" | "skin">("smpte");
  const [perFrameMs, setPerFrameMs] = useState(0);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    (async () => {
      if (typeof navigator === "undefined" || !("gpu" in navigator)) {
        setSupported(false);
        return;
      }
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        setSupported(false);
        return;
      }
      const info = adapter.info;
      setAdapter({
        vendor: info?.vendor ?? "",
        architecture: info?.architecture ?? "",
        device: info?.device ?? "",
        description: info?.description ?? "",
      });
      setSupported(true);
    })();
  }, []);

  const start = useCallback(async () => {
    if (running || !supported) return;
    setError(null);
    setRunning(true);
    try {
      const src = sourceRef.current!;
      const ctx = src.getContext("2d");
      if (!ctx) throw new Error("2d context unavailable");
      renderTestPattern(ctx, src.width, src.height, pattern);
      const stop = await runScopes({
        sourceCanvas: src,
        onReadback: (rb: ScopeReadback) => {
          paintLuma(lumaRef.current, rb);
          paintParade(paradeRef.current, rb);
          paintVector(vectorRef.current, rb);
          paintHisto(histoRef.current, rb);
          setPerFrameMs(rb.elapsedMs);
        },
      });
      stopRef.current = stop;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  }, [running, supported, pattern]);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setRunning(false);
  }, []);

  useEffect(() => () => stopRef.current?.(), []);

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-35 · WebGPU Compute Scopes</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Luma waveform, RGB parade, vectorscope, and histogram via WGSL compute
            passes over a test pattern. The same passes plug directly onto the
            exp-04 compositor&apos;s output texture.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">GPU adapter</h2>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-zinc-500">supported</dt>
              <dd>{supported === null ? "…" : supported ? "yes" : "no — needs WebGPU"}</dd>
              <dt className="text-zinc-500">vendor</dt>
              <dd className="truncate">{adapter?.vendor || "—"}</dd>
              <dt className="text-zinc-500">architecture</dt>
              <dd className="truncate">{adapter?.architecture || "—"}</dd>
              <dt className="text-zinc-500">device</dt>
              <dd className="truncate">{adapter?.device || "—"}</dd>
            </dl>
          </div>
          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Controls</h2>
            <div className="flex flex-wrap gap-2 text-xs">
              <label>
                pattern
                <select
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value as typeof pattern)}
                  className="ml-1 border bg-transparent px-1"
                >
                  <option value="smpte">SMPTE bars</option>
                  <option value="ramp">grey ramp</option>
                  <option value="skin">skin-tone gradient</option>
                </select>
              </label>
              <button
                type="button"
                onClick={start}
                disabled={running || !supported}
                className="rounded bg-zinc-900 px-2 py-1 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
              >
                start
              </button>
              <button
                type="button"
                onClick={stop}
                disabled={!running}
                className="rounded border border-zinc-400 px-2 py-1 disabled:opacity-40"
              >
                stop
              </button>
              <span className="ml-auto text-zinc-500">{perFrameMs.toFixed(2)} ms / frame</span>
            </div>
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-2 text-base font-semibold">Source (1024×384)</h2>
          <canvas
            ref={sourceRef}
            width={1024}
            height={384}
            className="block w-full rounded bg-zinc-100 dark:bg-zinc-900"
          />
        </section>

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <ScopePanel title="luma WFM" canvasRef={lumaRef} />
          <ScopePanel title="RGB parade" canvasRef={paradeRef} />
          <ScopePanel title="vectorscope" canvasRef={vectorRef} />
          <ScopePanel title="histogram" canvasRef={histoRef} />
        </section>

        <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Next steps</h2>
          <ul className="ml-5 list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
            <li>Replace JS bin accumulation with a WGSL compute pass using <code>atomic&lt;u32&gt;</code> bins.</li>
            <li>Per-workgroup shared bins → atomic merge to reduce global contention.</li>
            <li>Mount on exp-04 compositor output texture; verify color-space-aware vectorscope per exp-13.</li>
            <li>Render to a <code>bitmaprenderer</code> canvas context for zero-copy mirror to side displays.</li>
          </ul>
        </section>
      </div>
    </main>
  );
}

function ScopePanel({
  title,
  canvasRef,
}: {
  title: string;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
  return (
    <div className="rounded bg-zinc-100 p-2 dark:bg-zinc-900">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">{title}</div>
      <canvas ref={canvasRef} width={256} height={196} className="block w-full" />
    </div>
  );
}

function paintLuma(canvas: HTMLCanvasElement | null, rb: ScopeReadback) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.createImageData(w, h);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  const cols = rb.lumaWaveform.length / 256;
  for (let x = 0; x < w; x++) {
    const col = Math.min(cols - 1, Math.floor((x / w) * cols));
    for (let y = 0; y < h; y++) {
      const bin = Math.min(255, Math.floor((1 - y / h) * 256));
      const v = rb.lumaWaveform[col * 256 + bin] / Math.max(1, rb.maxBin);
      const lit = Math.min(255, Math.floor(v * 800));
      const idx = (y * w + x) * 4;
      img.data[idx] = lit;
      img.data[idx + 1] = lit;
      img.data[idx + 2] = lit;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function paintParade(canvas: HTMLCanvasElement | null, rb: ScopeReadback) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const cols = rb.rgbParade.length / (256 * 3);
  const channelWidth = Math.floor(w / 3);
  const colors: [number, number, number][] = [
    [255, 96, 96],
    [96, 255, 96],
    [96, 160, 255],
  ];
  for (let c = 0; c < 3; c++) {
    const baseX = c * channelWidth;
    for (let x = 0; x < channelWidth; x++) {
      const col = Math.min(cols - 1, Math.floor((x / channelWidth) * cols));
      for (let y = 0; y < h; y++) {
        const bin = Math.min(255, Math.floor((1 - y / h) * 256));
        const v = rb.rgbParade[c * cols * 256 + col * 256 + bin] / Math.max(1, rb.maxBin);
        if (v <= 0) continue;
        ctx.fillStyle = `rgba(${colors[c][0]},${colors[c][1]},${colors[c][2]},${Math.min(1, v * 8)})`;
        ctx.fillRect(baseX + x, y, 1, 1);
      }
    }
  }
}

function paintVector(canvas: HTMLCanvasElement | null, rb: ScopeReadback) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "rgba(0,0,0,0.8)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(63,63,70,0.6)";
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.45, 0, Math.PI * 2);
  ctx.stroke();
  for (const [u, v, n] of rb.vectorscope) {
    const x = w / 2 + u * (w / 2) * 0.9;
    const y = h / 2 - v * (h / 2) * 0.9;
    ctx.fillStyle = `rgba(255,200,160,${Math.min(1, n / Math.max(1, rb.maxBin / 16))})`;
    ctx.fillRect(x, y, 1, 1);
  }
}

function paintHisto(canvas: HTMLCanvasElement | null, rb: ScopeReadback) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, 0, w, h);
  const colors = ["rgba(255,96,96,0.8)", "rgba(96,255,96,0.8)", "rgba(96,160,255,0.8)"];
  for (let c = 0; c < 3; c++) {
    const bins = rb.histogram[c];
    const peak = Math.max(...bins);
    ctx.strokeStyle = colors[c];
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 256) * w;
      const y = h - (bins[i] / Math.max(1, peak)) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
