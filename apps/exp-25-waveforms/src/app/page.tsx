"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  parsePeaks,
  pickLod,
  type PeakData,
} from "../lib/peak-format";
import { drawFilmstrip, drawWaveform, type ViewState } from "../lib/draw";
import {
  hasPeakFile,
  hashFloat32,
  readPeakFile,
  writePeakFile,
} from "../lib/opfs";
import { synthesizeChirp, synthesizeFilmstrip, type FilmstripFrame } from "../lib/synth";

type Stats = {
  decodeMs: number;
  peakMs: number;
  opfsBytes: number;
  lastDrawMs: number;
  fromCache: boolean;
};

export default function Page() {
  const [error, setError] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<PeakData | null>(null);
  const [filmstrip, setFilmstrip] = useState<FilmstripFrame[]>([]);
  const [view, setView] = useState<ViewState>({
    startSample: 0,
    samplesPerPixel: 4096,
  });
  const [stats, setStats] = useState<Stats>({
    decodeMs: 0,
    peakMs: 0,
    opfsBytes: 0,
    lastDrawMs: 0,
    fromCache: false,
  });
  const [busy, setBusy] = useState(false);

  const waveformRef = useRef<HTMLCanvasElement | null>(null);
  const filmstripRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const dragRef = useRef<{ startX: number; startSample: number } | null>(null);

  useEffect(() => {
    const w = new Worker(new URL("../workers/peaks.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = w;
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  const ingestAudioBuffer = useCallback(
    async (buffer: AudioBuffer, decodeMs: number) => {
      setBusy(true);
      try {
        const channel = buffer.getChannelData(0);
        const copy = new Float32Array(channel);
        const hash = await hashFloat32(copy, buffer.duration);
        const cached = await hasPeakFile(hash);
        if (cached) {
          const buf = await readPeakFile(hash);
          if (buf) {
            const parsed = parsePeaks(buf);
            setPeaks(parsed);
            setView({
              startSample: 0,
              samplesPerPixel: Math.max(
                256,
                Math.floor(parsed.sampleCount / 1000),
              ),
            });
            setStats((s) => ({
              ...s,
              decodeMs,
              peakMs: 0,
              opfsBytes: buf.byteLength,
              fromCache: true,
            }));
            return;
          }
        }
        const worker = workerRef.current;
        if (!worker) throw new Error("worker not ready");
        const id = ++reqIdRef.current;
        const transfer = copy.buffer;
        const resp = await new Promise<{
          result: ArrayBuffer;
          buildMs: number;
        }>((resolve, reject) => {
          const cleanup = () => {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
          };
          const onMessage = (e: MessageEvent) => {
            const data = e.data as { id: number; result: ArrayBuffer; buildMs: number };
            if (data.id !== id) return;
            cleanup();
            resolve({ result: data.result, buildMs: data.buildMs });
          };
          const onError = (ev: ErrorEvent) => {
            cleanup();
            reject(new Error(ev.message));
          };
          worker.addEventListener("message", onMessage);
          worker.addEventListener("error", onError);
          worker.postMessage({ id, buffer: transfer, sampleRate: buffer.sampleRate }, [
            transfer,
          ]);
        });
        const parsed = parsePeaks(resp.result.slice(0));
        const bytes = await writePeakFile(hash, resp.result);
        setPeaks(parsed);
        setView({
          startSample: 0,
          samplesPerPixel: Math.max(
            256,
            Math.floor(parsed.sampleCount / 1000),
          ),
        });
        setStats((s) => ({
          ...s,
          decodeMs,
          peakMs: resp.buildMs,
          opfsBytes: bytes,
          fromCache: false,
        }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const loadFile = useCallback(
    async (file: File) => {
      setError(null);
      const arr = await file.arrayBuffer();
      const ctx = new AudioContext();
      try {
        const t0 = performance.now();
        const buffer = await ctx.decodeAudioData(arr.slice(0));
        const decodeMs = performance.now() - t0;
        await ingestAudioBuffer(buffer, decodeMs);
      } finally {
        await ctx.close().catch(() => undefined);
      }
    },
    [ingestAudioBuffer],
  );

  const loadSynthetic = useCallback(async () => {
    setError(null);
    const t0 = performance.now();
    const buffer = await synthesizeChirp(30);
    const decodeMs = performance.now() - t0;
    await ingestAudioBuffer(buffer, decodeMs);
    const strip = await synthesizeFilmstrip(30);
    setFilmstrip(strip);
  }, [ingestAudioBuffer]);

  useEffect(() => {
    if (!peaks) return;
    const canvas = waveformRef.current;
    if (!canvas) return;
    const lod = pickLod(peaks, view.samplesPerPixel);
    const ms = drawWaveform(canvas, lod, view, peaks.sampleCount);
    setStats((s) => ({ ...s, lastDrawMs: ms }));
  }, [peaks, view]);

  useEffect(() => {
    if (filmstrip.length === 0) return;
    const c = filmstripRef.current;
    if (!c) return;
    drawFilmstrip(c, filmstrip, 80, 45);
  }, [filmstrip]);

  // Pan
  useEffect(() => {
    const canvas = waveformRef.current;
    if (!canvas) return;
    const onDown = (e: PointerEvent) => {
      dragRef.current = { startX: e.clientX, startSample: view.startSample };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !peaks) return;
      const dx = e.clientX - drag.startX;
      const newStart = Math.max(
        0,
        Math.min(
          peaks.sampleCount - canvas.clientWidth * view.samplesPerPixel,
          drag.startSample - dx * view.samplesPerPixel,
        ),
      );
      setView((v) => ({ ...v, startSample: newStart }));
    };
    const onUp = (e: PointerEvent) => {
      dragRef.current = null;
      canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [peaks, view.samplesPerPixel, view.startSample]);

  const currentLod = useMemo(
    () => (peaks ? pickLod(peaks, view.samplesPerPixel) : null),
    [peaks, view.samplesPerPixel],
  );

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void loadFile(file);
  };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-25 · Waveforms &amp; Filmstrip</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Multi-resolution peak data generated in a worker, persisted to
            OPFS, drawn at any zoom without re-decoding. Filmstrip thumbs
            for video-style scrubbing.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="flex flex-wrap items-center gap-3 rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
          <label className="flex items-center gap-2">
            <span className="text-zinc-500">audio:</span>
            <input
              type="file"
              accept="audio/*"
              onChange={onFile}
              className="text-xs"
            />
          </label>
          <button
            type="button"
            onClick={loadSynthetic}
            disabled={busy}
            className="rounded bg-zinc-900 px-2 py-1 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
          >
            Use synthetic chirp + filmstrip
          </button>
          <span className="text-zinc-500">{busy ? "working..." : "idle"}</span>
        </section>

        <section className="rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold">Waveform</span>
            <span className="text-zinc-500">
              {currentLod
                ? `LOD bin ${currentLod.binSize} · ${peaks?.sampleCount.toLocaleString()} samples`
                : "—"}
            </span>
          </div>
          <canvas
            ref={waveformRef}
            className="block h-40 w-full cursor-grab touch-none rounded bg-zinc-100 dark:bg-zinc-900"
          />
          <div className="mt-2 flex items-center gap-3">
            <label className="flex items-center gap-2">
              <span className="text-zinc-500">zoom</span>
              <input
                type="range"
                min={Math.log2(64)}
                max={Math.log2(131072)}
                step={0.1}
                value={Math.log2(view.samplesPerPixel)}
                onChange={(e) =>
                  setView((v) => ({
                    ...v,
                    samplesPerPixel: Math.round(2 ** Number(e.target.value)),
                  }))
                }
                disabled={!peaks}
                className="w-64 accent-zinc-700 dark:accent-zinc-300"
              />
              <span className="font-mono">
                {view.samplesPerPixel} samples/px
              </span>
            </label>
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold">Filmstrip</span>
            <span className="text-zinc-500">
              {filmstrip.length === 0
                ? "— click \"Use synthetic\" to generate"
                : `${filmstrip.length} thumbs`}
            </span>
          </div>
          <div className="overflow-x-auto rounded bg-zinc-100 p-1 dark:bg-zinc-900">
            <canvas ref={filmstripRef} className="block" />
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3 text-xs md:grid-cols-5">
          <Stat label="decode" v={`${stats.decodeMs.toFixed(1)} ms`} />
          <Stat label="peak build" v={`${stats.peakMs.toFixed(1)} ms`} />
          <Stat label="OPFS bytes" v={stats.opfsBytes.toLocaleString()} />
          <Stat label="last draw" v={`${stats.lastDrawMs.toFixed(2)} ms`} />
          <Stat label="source" v={stats.fromCache ? "OPFS cache" : "fresh"} />
        </section>

        <footer className="text-xs text-zinc-500">
          OPFS is private to origin — refresh the page after loading and the
          second decode skips the peak build entirely. Drag the waveform to
          pan; the zoom slider picks the appropriate LOD automatically.
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
