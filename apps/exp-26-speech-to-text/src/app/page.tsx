"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { resampleToMono, audioBufferToWav } from "@reelforge/audio";
import { chunkAudio } from "../lib/chunk";
import { synthesizeSpeechLike } from "../lib/synth";
import type { TranscribeProgress, WordTimestamp } from "../lib/types";

type Stats = {
  duration: number;
  resampleMs: number;
  chunkCount: number;
  voicedCount: number;
  transcribeMs: number;
  words: number;
};

const MODEL_OPTIONS = [
  { id: "whisper-tiny", label: "Whisper-tiny (int8) — ~75 MB" },
  { id: "moonshine-base", label: "Moonshine-base — ~60 MB" },
] as const;

export default function Page() {
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<TranscribeProgress>({
    stage: "decode",
    done: 0,
    total: 0,
  });
  const [stats, setStats] = useState<Stats>({
    duration: 0,
    resampleMs: 0,
    chunkCount: 0,
    voicedCount: 0,
    transcribeMs: 0,
    words: 0,
  });
  const [words, setWords] = useState<WordTimestamp[]>([]);
  const [model, setModel] = useState<string>(MODEL_OPTIONS[0]!.id);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [eta, setEta] = useState<number | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastProgressTimeRef = useRef<number>(0);
  const transcribeStartRef = useRef<number>(0);

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

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const runPipeline = useCallback(
    async (buffer: AudioBuffer, blobUrl: string) => {
      setError(null);
      setRunning(true);
      setWords([]);
      setProgress({ stage: "decode", done: 0, total: 1 });
      try {
        setProgress({ stage: "resample", done: 0, total: 1 });
        const tR = performance.now();
        const pcm = await resampleToMono(buffer, 16000);
        const resampleMs = performance.now() - tR;
        setProgress({ stage: "vad", done: 0, total: 1 });
        setProgress({ stage: "chunk", done: 0, total: 1 });
        const chunks = chunkAudio(pcm);
        const voicedCount = chunks.filter((c) => c.voiced).length;
        setStats({
          duration: buffer.duration,
          resampleMs,
          chunkCount: chunks.length,
          voicedCount,
          transcribeMs: 0,
          words: 0,
        });
        setProgress({ stage: "transcribe", done: 0, total: 1 });
        const worker = workerRef.current;
        if (!worker) throw new Error("worker not ready");
        const id = ++reqIdRef.current;
        transcribeStartRef.current = performance.now();
        lastProgressTimeRef.current = transcribeStartRef.current;
        // Transfer the PCM buffer into the worker (zero-copy).
        const pcmForWorker = new Float32Array(pcm);
        const result = await new Promise<{ words: WordTimestamp[]; ms: number }>(
          (resolve, reject) => {
            const onMessage = (e: MessageEvent) => {
              const data = e.data as
                | { id: number; kind: "progress"; phase: "load" | "transcribe"; done: number; total: number }
                | { id: number; kind: "result"; words: WordTimestamp[]; ms: number }
                | { id: number; kind: "error"; message: string };
              if (data.id !== id) return;
              if (data.kind === "progress") {
                lastProgressTimeRef.current = performance.now();
                setProgress({
                  stage: data.phase === "load" ? "decode" : "transcribe",
                  done: data.done,
                  total: data.total,
                });
                setEta(null);
              } else if (data.kind === "error") {
                worker.removeEventListener("message", onMessage);
                reject(new Error(data.message));
              } else {
                worker.removeEventListener("message", onMessage);
                resolve({ words: data.words, ms: data.ms });
              }
            };
            const onError = (ev: ErrorEvent) => {
              worker.removeEventListener("error", onError);
              reject(new Error(ev.message));
            };
            worker.addEventListener("message", onMessage);
            worker.addEventListener("error", onError);
            worker.postMessage({ id, pcm: pcmForWorker, model }, [
              pcmForWorker.buffer,
            ]);
          },
        );
        setWords(result.words);
        setStats((s) => ({
          ...s,
          transcribeMs: result.ms,
          words: result.words.length,
        }));
        setProgress({
          stage: "done",
          done: chunks.length,
          total: chunks.length,
        });
        setEta(null);
        setAudioUrl(blobUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
      }
    },
    [model],
  );

  const onFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setError(null);
      const arr = await file.arrayBuffer();
      const ctx = new AudioContext();
      try {
        const buffer = await ctx.decodeAudioData(arr.slice(0));
        const blobUrl = URL.createObjectURL(file);
        await runPipeline(buffer, blobUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        await ctx.close().catch(() => undefined);
      }
    },
    [runPipeline],
  );

  const onSynthetic = useCallback(async () => {
    setError(null);
    try {
      const buffer = await synthesizeSpeechLike(10);
      // Render to a blob for <audio> playback.
      const blob = audioBufferToWav(buffer);
      const url = URL.createObjectURL(blob);
      await runPipeline(buffer, url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [runPipeline]);

  // Playback time tick.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setCurrentTime(a.currentTime);
    a.addEventListener("timeupdate", onTime);
    return () => a.removeEventListener("timeupdate", onTime);
  }, [audioUrl]);

  const activeIndex = useMemo(() => {
    if (words.length === 0) return -1;
    let lo = 0;
    let hi = words.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const w = words[mid]!;
      if (currentTime < w.start) hi = mid - 1;
      else if (currentTime > w.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }, [currentTime, words]);

  // Auto-scroll virtualised list to active word.
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const child = listRef.current.querySelector(
      `[data-idx="${activeIndex}"]`,
    ) as HTMLElement | null;
    if (child) child.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-26 · On-Device Speech-to-Text</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            16 kHz mono resampling (OfflineAudioContext) → VAD &amp; chunking →
            real Whisper/Moonshine transcription via{" "}
            <strong>Transformers.js on the WebGPU EP</strong>. Model weights
            download once and cache on-device.{" "}
            <strong>Audio never leaves the machine.</strong>
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="flex flex-wrap items-center gap-3 rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
          <label className="flex items-center gap-2">
            <span className="text-zinc-500">model:</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="border bg-transparent px-1"
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-zinc-500">audio:</span>
            <input type="file" accept="audio/*" onChange={onFile} disabled={running} />
          </label>
          <button
            type="button"
            onClick={onSynthetic}
            disabled={running}
            className="rounded bg-zinc-900 px-2 py-1 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
          >
            Use synthetic 10 s tone
          </button>
        </section>

        <section className="rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold">
              Pipeline · stage: <span className="text-emerald-600 dark:text-emerald-400">{progress.stage}</span>
            </span>
            <span className="text-zinc-500">
              {progress.done} / {progress.total}
              {eta !== null && progress.stage === "transcribe"
                ? ` · ETA ${(eta / 1000).toFixed(1)} s`
                : ""}
            </span>
          </div>
          <progress
            value={progress.total === 0 ? 0 : progress.done}
            max={progress.total === 0 ? 1 : progress.total}
            className="block w-full"
          />
        </section>

        <section className="grid grid-cols-2 gap-2 text-xs md:grid-cols-6">
          <Stat label="duration" v={`${stats.duration.toFixed(2)} s`} />
          <Stat label="resample" v={`${stats.resampleMs.toFixed(0)} ms`} />
          <Stat label="chunks" v={`${stats.chunkCount}`} />
          <Stat label="voiced" v={`${stats.voicedCount}`} />
          <Stat label="transcribe" v={`${stats.transcribeMs.toFixed(0)} ms`} />
          <Stat label="words" v={`${stats.words}`} />
        </section>

        {audioUrl && (
          <section className="rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
            <div className="mb-2 font-semibold">Playback</div>
            <audio ref={audioRef} src={audioUrl} controls className="w-full" />
          </section>
        )}

        <section className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-semibold">Transcript</span>
            <span className="text-zinc-500">
              {words.length === 0 ? "—" : `${words.length} words`}
            </span>
          </div>
          <VirtualisedWordList
            words={words}
            activeIndex={activeIndex}
            ref={listRef}
          />
        </section>

        <footer className="text-xs text-zinc-500">
          Transcription runs Whisper-tiny / Moonshine through Transformers.js
          on the WebGPU EP inside{" "}
          <code>src/workers/transcribe.worker.ts</code>. The first run
          downloads the model (~60–75 MB) and caches it on-device; later runs
          load from cache. Word timestamps come from Whisper&apos;s
          cross-attention alignment.
        </footer>
      </div>
    </main>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return (
    <div className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className="font-mono text-sm">{v}</div>
    </div>
  );
}

const ROW_HEIGHT = 22;

type WordListProps = {
  words: WordTimestamp[];
  activeIndex: number;
};

const VirtualisedWordList = forwardRef<HTMLDivElement, WordListProps>(
  function VirtualisedWordList({ words, activeIndex }, ref) {
    const [scrollTop, setScrollTop] = useState(0);
    const setRef = (el: HTMLDivElement | null) => {
      if (typeof ref === "function") ref(el);
      else if (ref)
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    };
    const viewportH = 320;
    const overscan = 6;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
    const endIdx = Math.min(
      words.length,
      Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + overscan,
    );
    const visible = words.slice(startIdx, endIdx);
    return (
      <div
        ref={setRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        className="relative h-80 overflow-y-auto rounded bg-zinc-100 text-xs dark:bg-zinc-900"
      >
        <div style={{ height: words.length * ROW_HEIGHT, position: "relative" }}>
          {visible.map((w, i) => {
            const idx = startIdx + i;
            const active = idx === activeIndex;
            return (
              <div
                key={idx}
                data-idx={idx}
                style={{
                  position: "absolute",
                  top: idx * ROW_HEIGHT,
                  height: ROW_HEIGHT,
                }}
                className={`flex w-full items-center gap-3 px-3 ${
                  active
                    ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
                    : ""
                }`}
              >
                <span className="text-zinc-500 tabular-nums">
                  [{w.start.toFixed(2)}–{w.end.toFixed(2)}]
                </span>
                <span className="font-mono">{w.word}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
);
