"use client";

import { useEffect, useRef, useState } from "react";
import { createRingBuffer, ringStats } from "../lib/ringBuffer";

type Info = {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  durationSec: number;
};

export default function Page() {
  const workerRef = useRef<Worker | null>(null);
  const sabRef = useRef<SharedArrayBuffer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const fileRef = useRef<File | null>(null);
  const tickRef = useRef<number | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [info, setInfo] = useState<Info | null>(null);
  const [crossOriginIsolated, setCrossOriginIsolated] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [outputLatency, setOutputLatency] = useState(0);
  const [audioCurrent, setAudioCurrent] = useState(0);
  const [videoTargetUs, setVideoTargetUs] = useState(0);
  const [compensate, setCompensate] = useState(true);
  const [fillFrames, setFillFrames] = useState(0);
  const [underruns, setUnderruns] = useState(0);

  useEffect(() => {
    setCrossOriginIsolated(typeof window !== "undefined" && window.crossOriginIsolated);
    const worker = new Worker(
      new URL("../workers/audio.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "INFO") {
        setInfo({
          codec: m.codec,
          sampleRate: m.sampleRate,
          numberOfChannels: m.numberOfChannels,
          durationSec: m.durationSec,
        });
      } else if (m.type === "DONE") {
        setStatus("audio decode finished");
      } else if (m.type === "ERROR") {
        setError(m.message);
        setStatus("error");
      }
    };
    workerRef.current = worker;
    return () => {
      stopTicker();
      worker.terminate();
      ctxRef.current?.close();
    };
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    fileRef.current = f;
    setError(null);
    setInfo(null);
    setStatus(`selected ${f.name}`);
  };

  const startPlayback = async () => {
    const file = fileRef.current;
    if (!file) {
      setError("pick a file first");
      return;
    }
    if (!window.crossOriginIsolated) {
      setError("crossOriginIsolated is false — SharedArrayBuffer unavailable");
      return;
    }
    setError(null);
    setStatus("starting...");

    const sab = createRingBuffer();
    sabRef.current = sab;

    const ctx = new AudioContext({ latencyHint: "interactive" });
    if (ctx.state === "suspended") await ctx.resume();
    await ctx.audioWorklet.addModule("/audio-worklet-processor.js");
    const node = new AudioWorkletNode(ctx, "ring-buffer-processor", {
      processorOptions: { sab },
      outputChannelCount: [2],
    });
    node.connect(ctx.destination);

    ctxRef.current = ctx;
    nodeRef.current = node;
    setOutputLatency(ctx.outputLatency);

    workerRef.current?.postMessage({
      type: "START",
      file,
      sab,
      startUs: 0,
    });

    setPlaying(true);
    setStatus("playing");
    startTicker();
  };

  const stopPlayback = () => {
    workerRef.current?.postMessage({ type: "STOP" });
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    ctxRef.current?.close();
    ctxRef.current = null;
    sabRef.current = null;
    setPlaying(false);
    setStatus("stopped");
    stopTicker();
  };

  const startTicker = () => {
    stopTicker();
    const tick = () => {
      const ctx = ctxRef.current;
      const sab = sabRef.current;
      if (ctx && sab) {
        setOutputLatency(ctx.outputLatency);
        const now = ctx.currentTime;
        setAudioCurrent(now);
        const target = compensate ? now - ctx.outputLatency : now;
        setVideoTargetUs(Math.max(0, target * 1_000_000));
        const stats = ringStats(sab);
        setFillFrames(stats.fillFrames);
        setUnderruns(stats.underruns);
      }
      tickRef.current = requestAnimationFrame(tick);
    };
    tickRef.current = requestAnimationFrame(tick);
  };
  const stopTicker = () => {
    if (tickRef.current !== null) cancelAnimationFrame(tickRef.current);
    tickRef.current = null;
  };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-08 · Audio Sync</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            AudioDecoder in worker → SharedArrayBuffer ring buffer →
            AudioWorkletProcessor → AudioContext.destination. The video sync
            target = currentTime − outputLatency, so Bluetooth latency
            (50–200ms) doesn&apos;t desync the picture.
          </p>
          <p className="text-xs text-zinc-500">
            Targets: no underruns · A/V drift ≤ 1 frame · outputLatency
            compensation visible.
          </p>
        </header>

        <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
          <div>
            crossOriginIsolated:{" "}
            <span
              className={
                crossOriginIsolated
                  ? "text-emerald-500"
                  : "text-red-500"
              }
            >
              {String(crossOriginIsolated)}
            </span>
          </div>
          <div>
            SharedArrayBuffer:{" "}
            <span
              className={
                typeof SharedArrayBuffer !== "undefined"
                  ? "text-emerald-500"
                  : "text-red-500"
              }
            >
              {typeof SharedArrayBuffer !== "undefined" ? "available" : "unavailable"}
            </span>
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <label className="mb-2 block text-sm font-semibold">Pick MP4 / M4A</label>
          <input
            type="file"
            accept="audio/*,video/*"
            onChange={onFileChange}
            disabled={playing}
            className="block w-full text-sm"
          />
          <div className="mt-2 flex items-center gap-3">
            {playing ? (
              <button
                type="button"
                onClick={stopPlayback}
                className="rounded bg-zinc-900 px-3 py-1 text-sm text-white dark:bg-zinc-100 dark:text-black"
              >
                stop
              </button>
            ) : (
              <button
                type="button"
                onClick={startPlayback}
                className="rounded bg-zinc-900 px-3 py-1 text-sm text-white dark:bg-zinc-100 dark:text-black"
              >
                play (user gesture starts AudioContext)
              </button>
            )}
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={compensate}
                onChange={(e) => setCompensate(e.target.checked)}
              />
              compensate outputLatency
            </label>
            <span className="text-xs text-zinc-500">{status}</span>
          </div>
        </section>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {info && (
          <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">Audio track</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
              <dt className="text-zinc-500">codec</dt>
              <dd className="font-mono">{info.codec}</dd>
              <dt className="text-zinc-500">sample rate</dt>
              <dd>{info.sampleRate} Hz</dd>
              <dt className="text-zinc-500">channels</dt>
              <dd>{info.numberOfChannels}</dd>
              <dt className="text-zinc-500">duration</dt>
              <dd>{info.durationSec.toFixed(2)} s</dd>
            </dl>
          </section>
        )}

        <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">A/V sync clock</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
            <dt className="text-zinc-500">audioCtx.outputLatency</dt>
            <dd>{(outputLatency * 1000).toFixed(1)} ms</dd>
            <dt className="text-zinc-500">audioCtx.currentTime</dt>
            <dd>{audioCurrent.toFixed(3)} s</dd>
            <dt className="text-zinc-500">video target (PTS)</dt>
            <dd>{(videoTargetUs / 1000).toFixed(1)} ms</dd>
            <dt className="text-zinc-500">compensation</dt>
            <dd>{compensate ? "ON" : "OFF"}</dd>
            <dt className="text-zinc-500">ring fill</dt>
            <dd>
              {fillFrames} frames (
              {info ? ((fillFrames / info.sampleRate) * 1000).toFixed(0) : "—"} ms)
            </dd>
            <dt className="text-zinc-500">underruns</dt>
            <dd
              className={underruns > 0 ? "text-red-500" : "text-emerald-500"}
            >
              {underruns}
            </dd>
          </dl>
          <p className="mt-3 text-zinc-500">
            Toggle the compensation checkbox while playing to observe the
            video target jump by ~outputLatency. On Bluetooth the jump is 50
            – 200ms; on wired output 3 – 20ms.
          </p>
        </section>
      </div>
    </main>
  );
}
