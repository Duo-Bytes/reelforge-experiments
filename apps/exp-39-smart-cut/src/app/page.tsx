"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeForAnalysis,
  fakeTranscript,
  scoreCandidates,
  type Candidate,
  type Transcript,
  type Weights,
} from "../lib/smartcut";

const DEFAULT_WEIGHTS: Weights = {
  text: 1.0,
  audio: 0.6,
  motion: 0.4,
  novelty: 0.4,
};

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [fileName, setFileName] = useState("");
  const [duration, setDuration] = useState(0);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outboundBytes] = useState(0);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setFileName(file.name);
    setBusy(true);
    try {
      const decoded = await decodeForAnalysis(file);
      setDuration(decoded.durationSec);
      // v1: fakeTranscript stands in for real Whisper output.  v2 wires exp-26.
      const t = fakeTranscript(decoded.durationSec);
      setTranscript(t);
      const cs = scoreCandidates(t, decoded.audioEnergy, decoded.motion, DEFAULT_WEIGHTS);
      setCandidates(cs);
      drawTimeline(canvasRef.current, decoded.audioEnergy, decoded.motion, cs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const reweight = useCallback(
    (w: Weights) => {
      if (!transcript) return;
      // Use already-computed signals stashed on the transcript for instant reweight.
      const cs = scoreCandidates(
        transcript,
        transcript.audioEnergyCached ?? [],
        transcript.motionCached ?? [],
        w,
      );
      setCandidates(cs);
      drawTimeline(
        canvasRef.current,
        transcript.audioEnergyCached ?? [],
        transcript.motionCached ?? [],
        cs,
      );
    },
    [transcript],
  );

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
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-39 · On-Device Smart-Cut</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Long-form → short-form ranked candidates. v1 ships the scoring +
            timeline UI against a stub transcript; v2 wires exp-26 Whisper for
            real word-level transcription. <strong>Never uploads audio.</strong>
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Stat label="file" v={fileName || "—"} />
          <Stat label="duration" v={duration ? `${duration.toFixed(1)} s` : "—"} />
          <Stat label="candidates" v={String(candidates.length)} />
          <Stat label="outbound bytes" v={String(outboundBytes)} good={outboundBytes === 0} />
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
            <label className="rounded border border-zinc-400 px-2 py-1 cursor-pointer">
              choose media…
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
            <span className="text-zinc-500">{busy ? "analyzing…" : "drop a file or browse"}</span>
          </div>
          <canvas
            ref={canvasRef}
            width={1024}
            height={120}
            className="block w-full rounded bg-zinc-100 dark:bg-zinc-900"
          />
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-[1fr,1.5fr]">
          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">weights</h2>
            <div className="space-y-3 text-xs">
              {(Object.keys(weights) as Array<keyof Weights>).map((k) => (
                <label key={k}>
                  <div className="flex justify-between">
                    <span>{k}</span>
                    <span className="text-zinc-500">{weights[k].toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={weights[k]}
                    onChange={(e) => {
                      const next = { ...weights, [k]: parseFloat(e.target.value) };
                      setWeights(next);
                      reweight(next);
                    }}
                    className="block w-full"
                  />
                </label>
              ))}
            </div>
          </div>
          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">top candidates</h2>
            <div className="max-h-72 space-y-2 overflow-auto text-xs">
              {candidates.slice(0, 10).map((c, i) => (
                <div
                  key={i}
                  className="rounded border border-zinc-300 p-2 dark:border-zinc-700"
                >
                  <div className="flex justify-between">
                    <span>
                      #{i + 1} · {fmt(c.startSec)} → {fmt(c.endSec)} ·{" "}
                      <span className="text-zinc-500">{(c.endSec - c.startSec).toFixed(0)}s</span>
                    </span>
                    <span className="font-semibold">{c.score.toFixed(2)}</span>
                  </div>
                  <div className="mt-1 text-zinc-500">{c.summary}</div>
                  <div className="mt-1 flex gap-1 text-[10px] text-zinc-500">
                    <span>txt:{c.textScore.toFixed(2)}</span>
                    <span>aud:{c.audioScore.toFixed(2)}</span>
                    <span>mov:{c.motionScore.toFixed(2)}</span>
                    <span>nov:{c.noveltyScore.toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Next steps</h2>
          <ul className="ml-5 list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
            <li>Replace <code>fakeTranscript</code> with exp-26 Whisper / Moonshine streaming output.</li>
            <li>Snap candidate boundaries to sentence start/end from the real transcript.</li>
            <li>Visual-motion signal via low-res WebCodecs decode (240p, every 2 s).</li>
            <li>Cache signals so weight-slider drag re-ranks under 100 ms.</li>
            <li>&quot;Send to timeline&quot; emits an exp-09 action; animated captions via exp-23 keyframes.</li>
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

function fmt(s: number) {
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function drawTimeline(
  canvas: HTMLCanvasElement | null,
  energy: number[],
  motion: number[],
  candidates: Candidate[],
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // candidate windows
  const maxScore = Math.max(0.1, ...candidates.map((c) => c.score));
  const totalSec = candidates[0]?.totalSec ?? 1;
  for (const c of candidates) {
    const x0 = (c.startSec / totalSec) * w;
    const x1 = (c.endSec / totalSec) * w;
    ctx.fillStyle = `rgba(16,185,129,${0.15 + 0.5 * (c.score / maxScore)})`;
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
  }

  // energy curve
  ctx.strokeStyle = "rgba(250,204,21,0.9)";
  ctx.beginPath();
  for (let i = 0; i < energy.length; i++) {
    const x = (i / energy.length) * w;
    const y = h - (energy[i] * h * 0.45);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // motion curve
  ctx.strokeStyle = "rgba(59,130,246,0.7)";
  ctx.beginPath();
  for (let i = 0; i < motion.length; i++) {
    const x = (i / motion.length) * w;
    const y = h - 4 - (motion[i] * h * 0.45);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
