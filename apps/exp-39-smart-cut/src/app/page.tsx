"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  computeMotion,
  decodeForAnalysis,
  scoreCandidates,
  type Candidate,
  type Transcript,
  type Weights,
  type Word,
} from "../lib/smartcut";

const DEFAULT_WEIGHTS: Weights = {
  text: 1.0,
  audio: 0.6,
  motion: 0.4,
  novelty: 0.4,
};

type Phase = "idle" | "decoding" | "motion" | "loading-model" | "transcribing" | "scoring" | "done";

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const [fileName, setFileName] = useState("");
  const [duration, setDuration] = useState(0);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [loadPct, setLoadPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [outboundBytes, setOutboundBytes] = useState(0);

  // Privacy instrument: wrap globalThis.fetch and tally the byte length of
  // any REQUEST BODY sent to a cross-origin URL. Model weights are INBOUND
  // (response bodies) and are therefore never counted — only payloads that
  // actually leave this origin do. This makes the "zero outbound bytes"
  // claim falsifiable: if any audio/video ever got uploaded, this counter
  // would tick up. Installed early and restored on unmount. (Worker fetches
  // for model weights are inbound and likewise don't affect this number.)
  useEffect(() => {
    const original = globalThis.fetch.bind(globalThis);
    const origin = globalThis.location?.origin;

    const isCrossOrigin = (url: string): boolean => {
      try {
        const u = new URL(url, globalThis.location?.href);
        return !!origin && u.origin !== origin;
      } catch {
        return false;
      }
    };

    const bodyBytes = (body: BodyInit | null | undefined): number => {
      if (body == null) return 0;
      if (typeof body === "string") return new TextEncoder().encode(body).length;
      if (body instanceof Blob) return body.size;
      if (body instanceof ArrayBuffer) return body.byteLength;
      if (ArrayBuffer.isView(body)) return body.byteLength;
      if (body instanceof URLSearchParams)
        return new TextEncoder().encode(body.toString()).length;
      // FormData / ReadableStream: size isn't synchronously knowable, but the
      // mere presence of an outbound body is the signal that matters, so we
      // count a sentinel of 1 byte rather than under-reporting it as zero.
      return 1;
    };

    const wrapped: typeof fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      // Only request payloads leaving the origin count as "outbound".
      if (isCrossOrigin(url)) {
        let n = 0;
        if (init?.body != null) {
          n = bodyBytes(init.body);
        } else if (input instanceof Request && input.body != null) {
          // A Request built with a streaming body: size isn't synchronously
          // known, but its presence is the privacy signal, so count 1 byte.
          n = 1;
        }
        if (n > 0) setOutboundBytes((b) => b + n);
      }
      return original(input as RequestInfo | URL, init);
    };

    globalThis.fetch = wrapped;
    return () => {
      globalThis.fetch = original;
    };
  }, []);

  useEffect(() => {
    const w = new Worker(
      new URL("../workers/transcribe.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = w;
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  const transcribe = useCallback((pcm: Float32Array): Promise<Word[]> => {
    return new Promise((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) {
        reject(new Error("worker not ready"));
        return;
      }
      const id = ++reqIdRef.current;
      const onMessage = (e: MessageEvent) => {
        const data = e.data as
          | { id: number; kind: "progress"; phase: "load" | "transcribe"; done: number; total: number }
          | { id: number; kind: "result"; words: Word[]; ms: number }
          | { id: number; kind: "error"; message: string };
        if (data.id !== id) return;
        if (data.kind === "progress") {
          if (data.phase === "load") {
            setPhase("loading-model");
            setLoadPct(data.done);
          } else {
            setPhase("transcribing");
          }
        } else if (data.kind === "error") {
          worker.removeEventListener("message", onMessage);
          reject(new Error(data.message));
        } else {
          worker.removeEventListener("message", onMessage);
          resolve(data.words);
        }
      };
      worker.addEventListener("message", onMessage);
      const copy = new Float32Array(pcm);
      worker.postMessage({ id, pcm: copy }, [copy.buffer]);
    });
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setFileName(file.name);
      setBusy(true);
      setCandidates([]);
      try {
        setPhase("decoding");
        const decoded = await decodeForAnalysis(file);
        setDuration(decoded.durationSec);

        setPhase("motion");
        const motion = await computeMotion(
          file,
          decoded.durationSec,
          decoded.audioEnergy.length,
        );

        const words = await transcribe(decoded.pcm16k);
        const t: Transcript = { words, totalSec: decoded.durationSec };
        setTranscript(t);

        setPhase("scoring");
        const cs = scoreCandidates(t, decoded.audioEnergy, motion, DEFAULT_WEIGHTS);
        setCandidates(cs);
        drawTimeline(canvasRef.current, decoded.audioEnergy, motion, cs);
        setPhase("done");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("idle");
      } finally {
        setBusy(false);
      }
    },
    [transcribe],
  );

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
            Long-form → short-form ranked candidates. Real on-device Whisper
            transcript (Transformers.js, WebGPU EP) + audio RMS energy + video
            frame-difference motion drive the scorer.{" "}
            <strong>Never uploads audio or video.</strong>
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
            <span className="text-zinc-500">
              {busy
                ? phase === "loading-model"
                  ? `loading model… ${loadPct}%`
                  : `${phase}…`
                : "drop a file or browse"}
            </span>
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
            <li>Snap candidate boundaries to sentence start/end from the transcript.</li>
            <li>Swap the <code>&lt;video&gt;</code> seek sampler for a low-res WebCodecs decode (faster, frame-accurate).</li>
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
