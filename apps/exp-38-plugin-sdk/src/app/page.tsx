"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  EXAMPLE_PLUGIN,
  validatePlugin,
  type Plugin,
  type ParamValue,
} from "../lib/plugin";

type CompileMessage = { type: string; message: string; line: number };

export default function Page() {
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const initRef = useRef(false);
  const pluginRef = useRef<Plugin>(EXAMPLE_PLUGIN);
  const [ready, setReady] = useState(false);
  const [plugin, setPlugin] = useState<Plugin>(EXAMPLE_PLUGIN);
  const [params, setParams] = useState<Record<string, ParamValue>>(() =>
    Object.fromEntries(EXAMPLE_PLUGIN.params.map((p) => [p.id, p.default])),
  );
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<CompileMessage[]>([]);
  const [compileMs, setCompileMs] = useState(0);
  const [reloadCount, setReloadCount] = useState(0);

  // Sandbox worker owns the WebGPU device + OffscreenCanvas preview.
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    const canvas = previewRef.current;
    if (!canvas) return;
    const offscreen = canvas.transferControlToOffscreen();
    const w = new Worker(
      new URL("../workers/plugin.worker.ts", import.meta.url),
      { type: "module" },
    );
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "READY") {
        setReady(true);
        // Compile the example plugin immediately.
        w.postMessage({
          type: "COMPILE",
          code: pluginRef.current.shader,
          params: pluginRef.current.params,
        });
      } else if (m.type === "COMPILED") {
        setDiagnostics(m.messages ?? []);
        setCompileMs(m.ms ?? 0);
        if (m.ok) {
          setError(null);
          setReloadCount((n) => n + 1);
        } else {
          const errs = (m.messages as CompileMessage[]).filter((x) => x.type === "error");
          setError(errs.map((x) => `L${x.line}: ${x.message}`).join("\n") || "compile failed");
        }
      } else if (m.type === "ERROR") {
        setError(m.message);
      }
    };
    w.postMessage({ type: "INIT", canvas: offscreen }, [offscreen]);
    workerRef.current = w;
    return () => {
      w.terminate();
      workerRef.current = null;
      initRef.current = false;
    };
  }, []);

  const recompile = useCallback((next: Plugin) => {
    setError(null);
    try {
      validatePlugin(next);
      pluginRef.current = next;
      setPlugin(next);
      setParams((prev) => {
        const fresh: Record<string, ParamValue> = {};
        for (const p of next.params) {
          fresh[p.id] = prev[p.id] ?? p.default;
        }
        return fresh;
      });
      workerRef.current?.postMessage({
        type: "COMPILE",
        code: next.shader,
        params: next.params,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Push param changes to the worker's uniform buffer (live, no recompile).
  useEffect(() => {
    workerRef.current?.postMessage({
      type: "PARAMS",
      values: params,
      specs: plugin.params,
    });
  }, [params, plugin]);

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-38 · Plugin / Effect SDK</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Plugin = WGSL shader + JSON-Schema params. The shader is
            compiled for real via <code>createShaderModule</code> in a
            sandboxed WebGPU worker; compile errors come straight from{" "}
            <code>getCompilationInfo()</code>. Edit the JSON and click out to
            hot-reload; drag params to update the live preview.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="plugin id" v={plugin.id} />
          <Stat label="gpu" v={ready ? "ready" : "init…"} good={ready} />
          <Stat label="compile" v={`${compileMs.toFixed(1)} ms`} good={compileMs > 0 && compileMs < 200} />
          <Stat label="reloads" v={String(reloadCount)} />
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">plugin.json</h2>
            <textarea
              defaultValue={JSON.stringify(EXAMPLE_PLUGIN, null, 2)}
              onBlur={(e) => {
                try {
                  const parsed = JSON.parse(e.target.value) as Plugin;
                  void recompile(parsed);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
              spellCheck={false}
              className="block h-72 w-full rounded bg-zinc-100 p-2 font-mono text-[11px] dark:bg-zinc-900"
            />
            <div className="mt-2 text-xs text-zinc-500">
              Tip: edit + click outside to hot-reload.
            </div>
          </div>
          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">params</h2>
            <div className="space-y-3 text-xs">
              {plugin.params.map((p) => (
                <ParamControl
                  key={p.id}
                  spec={p}
                  value={params[p.id] ?? p.default}
                  onChange={(v) => setParams((prev) => ({ ...prev, [p.id]: v }))}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">preview (live WebGPU)</h2>
          <canvas
            ref={previewRef}
            width={1024}
            height={256}
            className="block w-full rounded bg-zinc-100 dark:bg-zinc-900"
          />
          {diagnostics.length > 0 && (
            <div className="mt-2 max-h-32 overflow-auto rounded bg-zinc-100 p-2 text-[11px] dark:bg-zinc-900">
              {diagnostics.map((d, i) => (
                <div
                  key={i}
                  className={d.type === "error" ? "text-red-500" : "text-amber-500"}
                >
                  [{d.type}] L{d.line}: {d.message}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">How it works / next steps</h2>
          <ul className="ml-5 list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
            <li>Plugin WGSL is compiled in a dedicated worker via <code>createShaderModule</code>; <code>getCompilationInfo()</code> + a validation error scope surface real diagnostics without crashing the UI.</li>
            <li>Params pack into a std140 uniform buffer and update the live preview with no recompile.</li>
            <li>Deny <code>fetch</code> + storage on the worker scope via the exp-37 service worker for true isolation.</li>
            <li>Hot-reload from a local directory via <code>FileSystemObserver</code>; fall back to polling on older Chrome.</li>
            <li>Kill-switch: if a dispatch exceeds budget, call <code>device.destroy()</code> on the plugin worker.</li>
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

function ParamControl({
  spec,
  value,
  onChange,
}: {
  spec: Plugin["params"][number];
  value: ParamValue;
  onChange: (v: ParamValue) => void;
}) {
  if (spec.type === "f32") {
    const [lo, hi] = spec.range ?? [0, 1];
    return (
      <label className="block">
        <div className="flex justify-between">
          <span>{spec.id}</span>
          <span className="text-zinc-500">{Number(value).toFixed(3)}</span>
        </div>
        <input
          type="range"
          min={lo}
          max={hi}
          step={(hi - lo) / 1000}
          value={Number(value)}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="block w-full"
        />
      </label>
    );
  }
  if (spec.type === "vec3") {
    const arr = Array.isArray(value) ? value : [1, 1, 1];
    return (
      <div>
        <div>{spec.id} (vec3)</div>
        <div className="flex gap-2">
          {(["x", "y", "z"] as const).map((axis, i) => (
            <input
              key={axis}
              type="number"
              step={0.05}
              value={arr[i]}
              onChange={(e) => {
                const next = [...arr];
                next[i] = parseFloat(e.target.value);
                onChange(next);
              }}
              className="w-16 rounded border bg-transparent px-1"
            />
          ))}
        </div>
      </div>
    );
  }
  return null;
}
