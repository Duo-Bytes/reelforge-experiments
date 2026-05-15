"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDebouncedTransition,
  qualityForState,
  type CompositorQuality,
  type PressureState,
} from "../lib/policy";
import { createComposer, type Composer } from "../lib/composer";
import { startBurn, type LoadHandle } from "../lib/load-gen";
import {
  getPressureObserver,
  type PressureRecord,
} from "../lib/pressure-types";

type HistoryPoint = {
  t: number;
  state: PressureState;
};

const STATE_COLOURS: Record<PressureState, string> = {
  nominal: "#10b981",
  fair: "#eab308",
  serious: "#f97316",
  critical: "#ef4444",
};

export default function Page() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [cpuState, setCpuState] = useState<PressureState>("nominal");
  const [gpuState, setGpuState] = useState<PressureState | null>(null);
  const [quality, setQuality] = useState<CompositorQuality>(
    qualityForState("nominal"),
  );
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [log, setLog] = useState<{ t: number; msg: string }[]>([]);
  const [stats, setStats] = useState({ fps: 0, rectCount: 0, w: 0, h: 0 });

  const composerRef = useRef<Composer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const historyCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const burnRef = useRef<LoadHandle | null>(null);
  const startedAtRef = useRef<number>(Date.now());
  const cpuStateRef = useRef<PressureState>("nominal");

  useEffect(() => {
    cpuStateRef.current = cpuState;
  }, [cpuState]);

  const appendLog = useCallback((msg: string) => {
    setLog((prev) => {
      const next = [...prev, { t: Date.now(), msg }];
      return next.length > 50 ? next.slice(next.length - 50) : next;
    });
  }, []);

  useEffect(() => {
    const PO = getPressureObserver();
    if (!PO) {
      setSupported(false);
      return;
    }
    setSupported(true);
    const onCpuChange = createDebouncedTransition((s) => {
      setCpuState(s);
      const q = qualityForState(s);
      setQuality(q);
      composerRef.current?.setQuality(q);
      appendLog(q.reason);
    });
    const onGpuChange = createDebouncedTransition((s) => {
      setGpuState(s);
      appendLog(`gpu pressure → ${s}`);
    });
    const cpuObserver = new PO((records: PressureRecord[]) => {
      for (const r of records) {
        if (r.source === "cpu") onCpuChange(r.state);
      }
    }, { sampleInterval: 1000 });
    const gpuObserver = new PO((records: PressureRecord[]) => {
      for (const r of records) {
        if (r.source === "gpu") onGpuChange(r.state);
      }
    }, { sampleInterval: 1000 });
    void cpuObserver.observe("cpu").catch((err: unknown) => {
      appendLog(`cpu observer error: ${err instanceof Error ? err.message : String(err)}`);
    });
    void gpuObserver.observe("gpu").catch(() => {
      // gpu source is optional; many browsers don't expose it
    });
    return () => {
      cpuObserver.disconnect();
      gpuObserver.disconnect();
    };
  }, [appendLog]);

  // Composer + history.
  useEffect(() => {
    if (!canvasRef.current) return;
    const c = createComposer(canvasRef.current);
    composerRef.current = c;
    const id = window.setInterval(() => {
      setStats({
        fps: c.getFps(),
        rectCount: c.getRectCount(),
        ...c.getResolution(),
      });
      setHistory((prev) => {
        const next = [
          ...prev,
          { t: Date.now() - startedAtRef.current, state: cpuStateRef.current },
        ];
        return next.length > 60 ? next.slice(next.length - 60) : next;
      });
    }, 1000);
    return () => {
      window.clearInterval(id);
      c.stop();
      composerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draw history graph.
  useEffect(() => {
    const c = historyCanvasRef.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.resetTransform();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, w, h);
    const max = 60;
    const barW = w / max;
    for (let i = 0; i < history.length; i += 1) {
      const p = history[i]!;
      ctx.fillStyle = STATE_COLOURS[p.state];
      ctx.fillRect(i * barW, 0, barW, h);
    }
  }, [history]);

  const triggerBurn = useCallback((seconds: number) => {
    if (burnRef.current) burnRef.current.stop();
    burnRef.current = startBurn(seconds * 1000);
    appendLog(`burn started: ${seconds}s on ${navigator.hardwareConcurrency - 1} cores`);
    window.setTimeout(() => {
      burnRef.current = null;
      appendLog(`burn ended`);
    }, seconds * 1000 + 200);
  }, [appendLog]);

  const stopBurn = useCallback(() => {
    burnRef.current?.stop();
    burnRef.current = null;
    appendLog("burn cancelled");
  }, [appendLog]);

  if (supported === false) {
    return (
      <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
        <div className="mx-auto max-w-3xl space-y-4">
          <h1 className="text-2xl font-bold">Exp-27 · Compute-Pressure Adaptive Quality</h1>
          <div className="rounded border border-amber-500 bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            PressureObserver not available in this browser. Try Chrome 125+
            on desktop. The fallback policy treats every state as
            &quot;nominal&quot; — preview will not adapt.
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-27 · Compute-Pressure Adaptive Quality</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            PressureObserver (cpu + gpu) drives a compositor stand-in that
            drops resolution / rect count / effects as the system gets hot.
            Synthetic load generator provokes <code>serious</code> on demand.
          </p>
        </header>

        <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Card label="CPU state">
            <span
              className="text-xl font-semibold"
              style={{ color: STATE_COLOURS[cpuState] }}
            >
              {cpuState}
            </span>
          </Card>
          <Card label="GPU state">
            <span
              className="text-xl font-semibold"
              style={{ color: gpuState ? STATE_COLOURS[gpuState] : "#888" }}
            >
              {gpuState ?? "unreported"}
            </span>
          </Card>
          <Card label="Compositor">
            <div className="text-xs">
              <div>fps: {stats.fps.toFixed(1)}</div>
              <div>rects: {stats.rectCount}</div>
              <div>
                res: {stats.w}×{stats.h}
              </div>
              <div>effects: {quality.effectsLevel}</div>
            </div>
          </Card>
        </section>

        <section className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-semibold">History (last 60 s)</span>
            <div className="flex items-center gap-3 text-[10px]">
              {(["nominal", "fair", "serious", "critical"] as const).map((s) => (
                <span key={s} className="flex items-center gap-1">
                  <span
                    className="inline-block h-2 w-2"
                    style={{ background: STATE_COLOURS[s] }}
                  />
                  {s}
                </span>
              ))}
            </div>
          </div>
          <canvas ref={historyCanvasRef} className="block h-8 w-full rounded" />
        </section>

        <section className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
          <div className="mb-2 text-xs font-semibold">Compositor canvas</div>
          <canvas
            ref={canvasRef}
            className="block h-72 w-full rounded bg-black"
          />
        </section>

        <section className="flex flex-wrap items-center gap-2 rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
          <span className="text-zinc-500">Synthetic load:</span>
          <button
            type="button"
            onClick={() => triggerBurn(15)}
            className="rounded bg-amber-600 px-2 py-1 text-white"
          >
            Burn cores 15 s
          </button>
          <button
            type="button"
            onClick={() => triggerBurn(30)}
            className="rounded bg-red-600 px-2 py-1 text-white"
          >
            Burn cores 30 s
          </button>
          <button
            type="button"
            onClick={stopBurn}
            className="rounded border border-zinc-400 px-2 py-1"
          >
            Cancel
          </button>
          <span className="ml-auto text-zinc-500">
            {navigator.hardwareConcurrency} logical cores
          </span>
        </section>

        <section className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
          <div className="mb-2 text-xs font-semibold">Policy log</div>
          <div className="max-h-48 overflow-y-auto rounded bg-zinc-100 text-[11px] dark:bg-zinc-900">
            {log.length === 0 ? (
              <div className="p-2 text-zinc-500">No transitions yet.</div>
            ) : (
              log
                .slice()
                .reverse()
                .map((l, i) => (
                  <div
                    key={i}
                    className="border-b border-zinc-200 px-2 py-1 dark:border-zinc-800"
                  >
                    <span className="text-zinc-500">
                      {new Date(l.t).toLocaleTimeString()}
                    </span>{" "}
                    <span>{l.msg}</span>
                  </div>
                ))
            )}
          </div>
        </section>

        <footer className="text-xs text-zinc-500">
          State transitions are debounced 1 s to avoid flapping. CPU burn
          uses {navigator.hardwareConcurrency - 1} workers; GPU pressure
          requires real WebGPU work (not provoked here). The compositor
          halves its resolution and rect count on <code>serious</code> and
          pauses entirely on <code>critical</code>.
        </footer>
      </div>
    </main>
  );
}

function Card({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}
