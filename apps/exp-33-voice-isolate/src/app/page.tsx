"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeMix, runEnergyAB, type SpectrumRow } from "../lib/isolate";

export default function Page() {
  const dryRef = useRef<HTMLCanvasElement | null>(null);
  const wetRef = useRef<HTMLCanvasElement | null>(null);
  const [fileName, setFileName] = useState("");
  const [duration, setDuration] = useState(0);
  const [snrDb, setSnrDb] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outboundBytes] = useState(0);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setSnrDb(null);
    setFileName(file.name);
    setBusy(true);
    try {
      const decoded = await decodeMix(file);
      setDuration(decoded.durationSec);
      const { drySpec, wetSpec, snrImprovement } = runEnergyAB(decoded.samples, decoded.sampleRate);
      paintSpectrogram(dryRef.current, drySpec);
      paintSpectrogram(wetRef.current, wetSpec);
      setSnrDb(snrImprovement);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) void handleFile(f);
    };
    const dragover = (e: DragEvent) => e.preventDefault();
    window.addEventListener("drop", drop);
    window.addEventListener("dragover", dragover);
    return () => {
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragover", dragover);
    };
  }, [handleFile]);

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-33 · On-Device Voice Isolation / Denoise</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            v1 demonstrates the STFT spectrogram + A/B pipeline with a placeholder
            spectral-subtraction denoiser. v2 swaps in DeepFilterNet3 ONNX (WebGPU
            EP) — same surface, much higher quality.{" "}
            <strong>Never uploads audio.</strong>
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Stat label="file" v={fileName || "—"} />
          <Stat label="duration" v={duration ? `${duration.toFixed(1)} s` : "—"} />
          <Stat
            label="SNR improvement"
            v={snrDb !== null ? `${snrDb.toFixed(1)} dB` : "—"}
            good={snrDb !== null && snrDb > 6}
          />
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
            <label className="rounded border border-zinc-400 px-2 py-1 cursor-pointer">
              choose audio…
              <input
                type="file"
                accept="audio/*,video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                }}
              />
            </label>
            <span className="text-zinc-500">
              or drop a file anywhere on this page · {busy ? "processing…" : "idle"}
            </span>
            <div className="ml-auto text-zinc-500">
              outbound bytes:{" "}
              <span className={outboundBytes === 0 ? "text-emerald-500" : "text-red-500"}>
                {outboundBytes}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <SpecPanel title="dry" canvasRef={dryRef} />
            <SpecPanel title="wet" canvasRef={wetRef} />
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Next steps</h2>
          <ul className="ml-5 list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
            <li>
              Replace the placeholder denoise pass with DeepFilterNet3 ONNX
              (~25 MB) via <code>onnxruntime-web</code> WebGPU EP.
            </li>
            <li>Move the STFT into a WGSL compute pass instead of JS FFT.</li>
            <li>
              Realtime path: <code>AudioWorkletNode</code> ring-buffer to a worker
              that drains into the model.
            </li>
            <li>
              Render-to-OPFS path via <code>OfflineAudioContext</code>; emit a WAV
              the exp-10 export pipeline can mux.
            </li>
            <li>Compensate <code>AudioContext.outputLatency</code> in exp-08 A/V sync.</li>
          </ul>
        </section>
      </div>
    </main>
  );
}

function SpecPanel({
  title,
  canvasRef,
}: {
  title: string;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
  return (
    <div className="rounded bg-zinc-100 p-2 dark:bg-zinc-900">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">{title}</div>
      <canvas ref={canvasRef} width={512} height={180} className="block w-full" />
    </div>
  );
}

function Stat({ label, v, good }: { label: string; v: string; good?: boolean }) {
  return (
    <div className="rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
      <div className="text-zinc-500">{label}</div>
      <div className={`mt-1 truncate text-base ${good ? "text-emerald-500" : ""}`}>{v}</div>
    </div>
  );
}

function paintSpectrogram(canvas: HTMLCanvasElement | null, spec: SpectrumRow[]) {
  if (!canvas || spec.length === 0) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.createImageData(w, h);
  const cols = spec.length;
  const bins = spec[0].mag.length;
  for (let x = 0; x < w; x++) {
    const col = spec[Math.min(cols - 1, Math.floor((x / w) * cols))];
    for (let y = 0; y < h; y++) {
      const b = Math.min(bins - 1, Math.floor((1 - y / h) * bins));
      const v = Math.min(1, Math.max(0, col.mag[b] * 4));
      const idx = (y * w + x) * 4;
      img.data[idx] = Math.round(v * 255);
      img.data[idx + 1] = Math.round(v * 180);
      img.data[idx + 2] = Math.round((1 - v) * 120);
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
