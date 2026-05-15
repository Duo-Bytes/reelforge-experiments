"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  computeStats,
  isLoAFSupported,
  snapshotEntry,
  topScripts,
  type LoAFEntry,
} from "../lib/loaf";

const WINDOW_MS = 30_000;
const GATE_WINDOW_MS = 10_000;
const GATE_THRESHOLD_MS = 50;
const GENERATOR_DURATION_MS = 5_000;

type GeneratorKind = "idle" | "block" | "thrash" | "churn";

export default function Page() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [entries, setEntries] = useState<LoAFEntry[]>([]);
  const [generator, setGenerator] = useState<GeneratorKind>("idle");
  const [generatorUntil, setGeneratorUntil] = useState(0);
  const [churnTick, setChurnTick] = useState(0);
  const thrashHostRef = useRef<HTMLDivElement | null>(null);

  // Feature detect + install the observer.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isLoAFSupported()) {
      setSupported(false);
      return;
    }
    setSupported(true);
    const obs = new PerformanceObserver((list) => {
      const next: LoAFEntry[] = [];
      for (const e of list.getEntries()) {
        next.push(snapshotEntry(e));
      }
      if (next.length === 0) return;
      setEntries((prev) => {
        const cutoff = performance.now() - WINDOW_MS;
        const merged = [...prev, ...next].filter((e) => e.startTime >= cutoff);
        return merged;
      });
    });
    try {
      obs.observe({ type: "long-animation-frame", buffered: true });
    } catch {
      setSupported(false);
      return;
    }
    return () => obs.disconnect();
  }, []);

  // Generator main loop. Each kind injects a different kind of work
  // per rAF tick until `generatorUntil` passes.
  useEffect(() => {
    if (generator === "idle") return;
    let raf = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const now = performance.now();
      if (now >= generatorUntil) {
        setGenerator("idle");
        return;
      }
      if (generator === "block") {
        // Busy-loop 100 ms. Mimics a sync export step or a sloppy parse.
        const start = performance.now();
        while (performance.now() - start < 100) {
          // intentional spin
        }
      } else if (generator === "thrash") {
        const host = thrashHostRef.current;
        if (host) {
          const nodes = host.children;
          for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i] as HTMLElement;
            // Read then write forces layout for each iteration.
            const w = el.offsetWidth;
            el.style.width = `${(w + (i % 3)) % 200}px`;
          }
        }
      } else if (generator === "churn") {
        setChurnTick((c) => c + 1);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [generator, generatorUntil]);

  const startGenerator = useCallback((kind: GeneratorKind) => {
    setGenerator(kind);
    setGeneratorUntil(performance.now() + GENERATOR_DURATION_MS);
  }, []);

  const stats = useMemo(() => computeStats(entries), [entries]);
  const scripts = useMemo(() => topScripts(entries), [entries]);

  const gateStats = useMemo(() => {
    const cutoff = performance.now() - GATE_WINDOW_MS;
    const recent = entries.filter((e) => e.startTime >= cutoff);
    return computeStats(recent);
  }, [entries]);

  const gatePass = gateStats.count === 0 || gateStats.median < GATE_THRESHOLD_MS;

  const downloadReport = useCallback(() => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            userAgent: navigator.userAgent,
            window_ms: WINDOW_MS,
            gate_window_ms: GATE_WINDOW_MS,
            gate_threshold_ms: GATE_THRESHOLD_MS,
            stats,
            gate: { pass: gatePass, ...gateStats },
            topScripts: scripts,
            entries,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "exp28-loaf-report.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [entries, gatePass, gateStats, scripts, stats]);

  // 1k-row list whose `churnTick` re-renders are what the "churn"
  // generator drives. We render its size lazily so this component
  // doesn't allocate when the generator isn't running.
  const churnRows = useMemo(() => {
    if (generator !== "churn" && churnTick === 0) return [];
    const out: number[] = [];
    for (let i = 0; i < 1000; i++) out.push((i + churnTick) % 999);
    return out;
  }, [generator, churnTick]);

  if (supported === false) {
    return (
      <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
        <div className="mx-auto max-w-3xl space-y-4">
          <h1 className="text-2xl font-bold">Exp-28 · LoAF Budget</h1>
          <div className="rounded border border-amber-500 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            This browser does not expose{" "}
            <code>PerformanceObserver({"{"}type:&nbsp;&quot;long-animation-frame&quot;{"}"})</code>.
            Chrome 123+ required. Firefox and Safari have not shipped LoAF as
            of mid-2026.
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 p-6 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold">Exp-28 · LoAF Budget</h1>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Long Animation Frame observer with per-script attribution and a
            CI-grade pass/fail gate (median &lt; {GATE_THRESHOLD_MS} ms over
            the last {GATE_WINDOW_MS / 1000} s).
          </p>
        </header>

        <section
          className={`rounded border p-3 text-sm ${
            gatePass
              ? "border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
              : "border-red-500 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200"
          }`}
        >
          <strong>{gatePass ? "PASS" : "FAIL"}</strong>{" "}
          — median LoAF over last {GATE_WINDOW_MS / 1000} s:{" "}
          {gateStats.median.toFixed(1)} ms ({gateStats.count} entries).
          Threshold {GATE_THRESHOLD_MS} ms.
        </section>

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="count (30 s)" value={String(stats.count)} />
          <Stat label="median" value={`${stats.median.toFixed(1)} ms`} />
          <Stat label="p95" value={`${stats.p95.toFixed(1)} ms`} />
          <Stat label="max" value={`${stats.max.toFixed(1)} ms`} />
        </section>

        <section className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Load generators</h2>
          <p className="mb-2 text-[10px] text-zinc-500">
            Each runs for {GENERATOR_DURATION_MS / 1000} s. Watch the gate
            flip red within ~2 s and recover within ~3 s of stopping.
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            <GenButton
              label="Block 100 ms"
              kind="block"
              active={generator === "block"}
              onStart={startGenerator}
            />
            <GenButton
              label="Layout thrash"
              kind="thrash"
              active={generator === "thrash"}
              onStart={startGenerator}
            />
            <GenButton
              label="React state churn"
              kind="churn"
              active={generator === "churn"}
              onStart={startGenerator}
            />
            <button
              type="button"
              onClick={() => setGenerator("idle")}
              className="rounded border border-zinc-400 px-2 py-1"
            >
              Stop
            </button>
            <button
              type="button"
              onClick={downloadReport}
              className="rounded border border-emerald-500 px-2 py-1 text-emerald-600 dark:text-emerald-400"
            >
              Download report (JSON)
            </button>
          </div>
          {generator !== "idle" && (
            <div className="mt-2 text-[10px] text-zinc-500">
              running: {generator} (ends in{" "}
              {Math.max(0, generatorUntil - performance.now()).toFixed(0)} ms)
            </div>
          )}
        </section>

        <section className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Top contributing scripts</h2>
          {scripts.length === 0 ? (
            <p className="text-[10px] text-zinc-500">no entries yet — trigger a generator</p>
          ) : (
            <table className="w-full text-[11px]">
              <thead className="text-zinc-500">
                <tr className="text-left">
                  <th className="p-1">source</th>
                  <th className="p-1">total ms</th>
                  <th className="p-1">forced layout ms</th>
                  <th className="p-1">count</th>
                </tr>
              </thead>
              <tbody>
                {scripts.map((s) => (
                  <tr
                    key={s.key}
                    className="border-t border-zinc-300/30 dark:border-zinc-700/30"
                  >
                    <td className="truncate p-1" title={s.key}>
                      {s.key}
                    </td>
                    <td className="p-1">{s.total.toFixed(1)}</td>
                    <td className="p-1">{s.forced.toFixed(1)}</td>
                    <td className="p-1">{s.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-[10px] text-zinc-500">
            Empty source URLs are cross-origin scripts without
            Timing-Allow-Origin — bucketed as (unattributed) rather than
            dropped. The forced-layout column catches{" "}
            <code>getBoundingClientRect</code>-style thrash even when total
            script time is small.
          </p>
        </section>

        <section className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Recent entries</h2>
          <div className="max-h-60 overflow-auto text-[10px]">
            <table className="w-full">
              <thead className="sticky top-0 bg-zinc-50 text-zinc-500 dark:bg-black">
                <tr className="text-left">
                  <th className="p-1">t (ms)</th>
                  <th className="p-1">dur</th>
                  <th className="p-1">block</th>
                  <th className="p-1">render</th>
                  <th className="p-1">scripts</th>
                </tr>
              </thead>
              <tbody>
                {entries.slice(-40).reverse().map((e, i) => (
                  <tr
                    key={i}
                    className="border-t border-zinc-300/30 dark:border-zinc-700/30"
                  >
                    <td className="p-1">{e.startTime.toFixed(0)}</td>
                    <td className="p-1">{e.duration.toFixed(1)}</td>
                    <td className="p-1">{e.blockingDuration.toFixed(1)}</td>
                    <td className="p-1">{e.renderStart.toFixed(0)}</td>
                    <td className="p-1">{e.scripts.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Layout-thrash victim DOM. Off-screen but present in layout. */}
        <div
          ref={thrashHostRef}
          aria-hidden
          className="pointer-events-none fixed -bottom-[600px] -left-[600px] h-1 w-1 overflow-hidden"
        >
          {Array.from({ length: 200 }, (_, i) => (
            <div key={i} className="inline-block h-2 bg-zinc-500" style={{ width: 40 }} />
          ))}
        </div>

        {/* React state churn: a 1k-row list rendered when needed. */}
        {churnRows.length > 0 && (
          <div className="grid grid-cols-10 gap-px text-[8px] opacity-30">
            {churnRows.map((v, i) => (
              <span key={i} className="bg-zinc-200 px-px dark:bg-zinc-800">
                {v}
              </span>
            ))}
          </div>
        )}

        <footer className="text-[10px] text-zinc-500">
          LoAF entries fire after the frame — never try to react to a slow
          frame synchronously. The 10 s gate window is the minimum that
          doesn&apos;t flicker. Disconnect the observer on unmount (this app
          does, in the effect cleanup).
        </footer>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className="text-lg">{value}</div>
    </div>
  );
}

function GenButton({
  label,
  kind,
  active,
  onStart,
}: {
  label: string;
  kind: GeneratorKind;
  active: boolean;
  onStart: (k: GeneratorKind) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onStart(kind)}
      className={`rounded border px-2 py-1 ${
        active
          ? "border-amber-500 bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          : "border-zinc-400"
      }`}
    >
      {label}
    </button>
  );
}
