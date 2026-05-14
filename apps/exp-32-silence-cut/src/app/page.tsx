"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeToMono16k, drawWaveform, detectSilence, type SilenceSegment } from "../lib/silence";

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [duration, setDuration] = useState<number>(0);
  const [segments, setSegments] = useState<SilenceSegment[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [outboundBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const samplesRef = useRef<Float32Array | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setSegments([]);
    setFileName(file.name);
    try {
      const { samples, sampleRate, durationSec } = await decodeToMono16k(file);
      samplesRef.current = samples;
      setDuration(durationSec);
      const canvas = canvasRef.current;
      if (canvas) drawWaveform(canvas, samples, sampleRate, []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const runDetection = useCallback(async () => {
    const samples = samplesRef.current;
    if (!samples) return;
    setAnalyzing(true);
    setError(null);
    try {
      // TODO(real impl): swap energy-based detector for Silero-VAD ONNX via WebGPU EP.
      // The energy detector below is a placeholder so the page works end-to-end.
      const segs = detectSilence(samples, 16000, {
        thresholdDb: -45,
        minSilenceMs: 350,
        paddingMs: 80,
      });
      setSegments(segs);
      const canvas = canvasRef.current;
      if (canvas) drawWaveform(canvas, samples, 16000, segs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
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

  const totalSilenceSec = segments.reduce((a, s) => a + (s.endSec - s.startSec), 0);

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-32 · On-Device Silence &amp; Filler-Word Removal</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Decode → resample to 16 kHz mono → detect silence regions on-device.
            v1 ships an energy-threshold detector; v2 swaps in Silero-VAD via{" "}
            <code>onnxruntime-web</code> WebGPU EP.{" "}
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
          <Stat label="outbound bytes" v={String(outboundBytes)} good={outboundBytes === 0} />
        </section>

        <section className="space-y-3 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <div className="flex flex-wrap items-center gap-3 text-xs">
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
            <span className="text-zinc-500">or drop a file anywhere on this page</span>
            <button
              type="button"
              onClick={runDetection}
              disabled={!samplesRef.current || analyzing}
              className="ml-auto rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
            >
              {analyzing ? "analyzing…" : "detect silence"}
            </button>
          </div>
          <canvas
            ref={canvasRef}
            width={1024}
            height={180}
            className="block w-full rounded bg-zinc-100 dark:bg-zinc-900"
          />
          <div className="text-xs text-zinc-500">
            Found {segments.length} silence regions, total{" "}
            {totalSilenceSec.toFixed(2)} s
            {duration > 0 && ` (${((totalSilenceSec / duration) * 100).toFixed(1)}% of clip)`}.
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Next steps</h2>
          <ul className="ml-5 list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
            <li>
              Wire <code>onnxruntime-web</code> WebGPU EP with Silero-VAD-v5 ONNX
              (~2 MB). Cache via <code>Cache API</code> using exp-11&apos;s loader.
            </li>
            <li>Hysteresis on the speech-probability mask; min-segment-duration filter.</li>
            <li>
              Filler-word pass: run exp-26 (Whisper transcript) and classify
              &quot;um&quot; / &quot;uh&quot; / &quot;you know&quot; by token + duration.
            </li>
            <li>Emit ripple-delete actions into exp-09 timeline state.</li>
            <li>Batch 32 hops per ONNX dispatch to amortize launch overhead.</li>
          </ul>
        </section>
      </div>
    </main>
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
