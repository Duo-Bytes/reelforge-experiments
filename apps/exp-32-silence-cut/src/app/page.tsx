"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SILERO_HOP_16K,
  SILERO_VAD_URL,
  decodeToMono16k,
  detectSilenceEnergy,
  drawWaveform,
  silenceFromVadProbabilities,
  type SilenceSegment,
} from "../lib/silence";

type Detector = "vad" | "energy";
type VadStatus = "idle" | "loading" | "ready" | "error";

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const [fileName, setFileName] = useState<string>("");
  const [duration, setDuration] = useState<number>(0);
  const [segments, setSegments] = useState<SilenceSegment[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outboundBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [vadStatus, setVadStatus] = useState<VadStatus>("idle");
  const [vadProvider, setVadProvider] = useState<string | null>(null);
  const [detector, setDetector] = useState<Detector>("vad");
  const [lastInferenceMs, setLastInferenceMs] = useState<number | null>(null);
  const [hasSamples, setHasSamples] = useState(false);
  const samplesRef = useRef<Float32Array | null>(null);

  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/vad.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "STATUS") {
        // Surface non-fatal status (e.g. "wasm fallback") only as info.
        if (typeof m.message === "string" && m.message.includes("WebGPU EP unavailable")) {
          setError(m.message);
        }
      } else if (m.type === "READY") {
        setVadStatus("ready");
        setVadProvider(m.provider);
      } else if (m.type === "PROGRESS") {
        setProgress({ done: m.done, total: m.total });
      } else if (m.type === "PROBS") {
        const probs = m.probs as Float32Array;
        const segs = silenceFromVadProbabilities(probs, m.hop, m.sampleRate, {
          speechOnProb: 0.5,
          speechOffProb: 0.35,
          minSilenceMs: 350,
          paddingMs: 80,
        });
        setSegments(segs);
        setLastInferenceMs(m.totalMs);
        setVadProvider(m.provider);
        const samples = samplesRef.current;
        const canvas = canvasRef.current;
        if (canvas && samples) drawWaveform(canvas, samples, 16000, segs);
        setAnalyzing(false);
        setProgress(null);
      } else if (m.type === "ERROR") {
        setError(m.message);
        setVadStatus("error");
        setAnalyzing(false);
        setProgress(null);
      }
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  const loadVad = useCallback(() => {
    if (vadStatus === "loading" || vadStatus === "ready") return;
    setVadStatus("loading");
    setError(null);
    workerRef.current?.postMessage({ type: "LOAD", url: SILERO_VAD_URL });
  }, [vadStatus]);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setSegments([]);
    setLastInferenceMs(null);
    setFileName(file.name);
    try {
      const { samples, sampleRate, durationSec } = await decodeToMono16k(file);
      samplesRef.current = samples;
      setHasSamples(true);
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
    setSegments([]);
    try {
      if (detector === "vad" && vadStatus === "ready" && workerRef.current) {
        // Transfer a copy so the worker owns the buffer (faster than postMessage clone).
        const copy = new Float32Array(samples);
        workerRef.current.postMessage(
          {
            type: "RUN",
            samples: copy,
            sampleRate: 16000,
            hop: SILERO_HOP_16K,
          },
          [copy.buffer],
        );
        return; // async — result lands on worker.onmessage
      }
      const segs = detectSilenceEnergy(samples, 16000, {
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
      if (!(detector === "vad" && vadStatus === "ready" && workerRef.current)) {
        setAnalyzing(false);
      }
    }
  }, [detector, vadStatus]);

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

  const totalSilenceSec = segments.reduce(
    (a, s) => a + (s.endSec - s.startSec),
    0,
  );

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">
            Exp-32 · On-Device Silence &amp; Filler-Word Removal
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Decode → resample to 16 kHz mono → run Silero-VAD via{" "}
            <code>onnxruntime-web</code> WebGPU EP → emit silence segments.{" "}
            <strong>Never uploads audio.</strong>
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="file" v={fileName || "—"} />
          <Stat
            label="duration"
            v={duration ? `${duration.toFixed(1)} s` : "—"}
          />
          <Stat
            label="outbound bytes"
            v={String(outboundBytes)}
            good={outboundBytes === 0}
          />
          <Stat
            label="detector"
            v={
              detector === "vad"
                ? `silero-vad · ${vadProvider ?? vadStatus}`
                : "energy (rms)"
            }
          />
        </section>

        <section className="space-y-3 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="cursor-pointer rounded border border-zinc-400 px-2 py-1">
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
              or drop a file anywhere on this page
            </span>

            <label className="ml-auto flex items-center gap-1">
              <span className="text-zinc-500">detector</span>
              <select
                value={detector}
                onChange={(e) => setDetector(e.target.value as Detector)}
                className="rounded border border-zinc-400 bg-transparent px-1 py-0.5"
              >
                <option value="vad">silero-vad</option>
                <option value="energy">energy</option>
              </select>
            </label>

            <button
              type="button"
              onClick={loadVad}
              disabled={vadStatus !== "idle" && vadStatus !== "error"}
              className="rounded border border-zinc-400 px-2 py-1 disabled:opacity-40"
            >
              {vadStatus === "ready"
                ? `vad ready (${vadProvider ?? ""})`
                : vadStatus === "loading"
                  ? "loading vad…"
                  : "load vad model"}
            </button>

            <button
              type="button"
              onClick={runDetection}
              disabled={
                !hasSamples ||
                analyzing ||
                (detector === "vad" && vadStatus !== "ready")
              }
              className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
            >
              {analyzing ? "analyzing…" : "detect silence"}
            </button>
          </div>

          {progress && (
            <div className="text-xs text-zinc-500">
              <progress
                value={progress.done}
                max={progress.total}
                className="w-full"
              />
              <div>
                hop {progress.done}/{progress.total} (
                {((100 * progress.done) / Math.max(1, progress.total)).toFixed(0)}%)
              </div>
            </div>
          )}

          <canvas
            ref={canvasRef}
            width={1024}
            height={180}
            className="block w-full rounded bg-zinc-100 dark:bg-zinc-900"
          />
          <div className="text-xs text-zinc-500">
            Found {segments.length} silence regions, total{" "}
            {totalSilenceSec.toFixed(2)} s
            {duration > 0 &&
              ` (${((totalSilenceSec / duration) * 100).toFixed(1)}% of clip)`}
            {lastInferenceMs !== null &&
              ` · vad inference ${lastInferenceMs.toFixed(0)} ms`}
            .
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Next steps</h2>
          <ul className="ml-5 list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
            <li>
              Filler-word pass: run exp-26 (Whisper transcript) and classify
              &quot;um&quot; / &quot;uh&quot; / &quot;you know&quot; by token + duration.
            </li>
            <li>Emit ripple-delete actions into exp-09 timeline state.</li>
            <li>Batch multiple hops per ONNX dispatch to amortize launch overhead.</li>
          </ul>
        </section>
      </div>
    </main>
  );
}

function Stat({
  label,
  v,
  good,
}: {
  label: string;
  v: string;
  good?: boolean;
}) {
  return (
    <div className="rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
      <div className="text-zinc-500">{label}</div>
      <div className={`mt-1 truncate text-base ${good ? "text-emerald-500" : ""}`}>
        {v}
      </div>
    </div>
  );
}
