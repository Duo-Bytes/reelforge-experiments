"use client";

import { useEffect, useRef, useState } from "react";
import { ANIMATED_WGSL } from "../shaders/animated.wgsl";
import { GpuRuntime, type LossEvent, type ResourceRegistry } from "../lib/registry";

type StatsRow = {
  fps: number;
  state: "ready" | "lost" | "recovering" | "failed";
  events: LossEvent[];
  successCount: number;
  failureCount: number;
  recoveryMs: { min: number; max: number; mean: number } | null;
};

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<GpuRuntime | null>(null);
  const rafRef = useRef<number | null>(null);
  const formatRef = useRef<GPUTextureFormat>("bgra8unorm");
  const contextRef = useRef<GPUCanvasContext | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<StatsRow>({
    fps: 0,
    state: "ready",
    events: [],
    successCount: 0,
    failureCount: 0,
    recoveryMs: null,
  });
  const [scriptedRunning, setScriptedRunning] = useState(false);
  const [intervalMs, setIntervalMs] = useState(5000);
  const scriptedTimer = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    let frames = 0;
    let lastFpsAt = performance.now();

    (async () => {
      try {
        const canvas = canvasRef.current!;
        if (!navigator.gpu) throw new Error("WebGPU not supported");
        formatRef.current = navigator.gpu.getPreferredCanvasFormat();
        const context = canvas.getContext("webgpu");
        if (!context) throw new Error("no webgpu context");
        contextRef.current = context;

        const runtime = new GpuRuntime();
        runtime.setBuild((registry) => registerResources(registry, formatRef.current));

        runtime.on({
          onState: () => syncStats(runtime),
          onLoss: () => syncStats(runtime),
          onRecover: () => {
            // re-configure canvas with the new device
            const dev = runtime.getDevice();
            context.configure({
              device: dev,
              format: formatRef.current,
              alphaMode: "premultiplied",
            });
            syncStats(runtime);
          },
        });

        await runtime.init();
        context.configure({
          device: runtime.getDevice(),
          format: formatRef.current,
          alphaMode: "premultiplied",
        });
        runtimeRef.current = runtime;
        if (cancelled) return;

        const tick = () => {
          if (cancelled) return;
          const rt = runtimeRef.current;
          if (rt && rt.getState() === "ready") {
            try {
              renderFrame(rt, context);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }
          frames++;
          const now = performance.now();
          if (now - lastFpsAt > 500) {
            const fps = Math.round((frames * 1000) / (now - lastFpsAt));
            frames = 0;
            lastFpsAt = now;
            setStats((s) => ({ ...s, fps }));
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (scriptedTimer.current !== null) window.clearInterval(scriptedTimer.current);
    };
  }, []);

  const syncStats = (rt: GpuRuntime): void => {
    const events = rt.getEvents();
    const recovered = events.filter((e) => e.recoveryMs !== null);
    const failed = events.filter(
      (e) => e.recoveryMs === null && e !== events[events.length - 1],
    );
    let recoveryMs: StatsRow["recoveryMs"] = null;
    if (recovered.length > 0) {
      const xs = recovered.map((e) => e.recoveryMs!);
      recoveryMs = {
        min: Math.min(...xs),
        max: Math.max(...xs),
        mean: xs.reduce((a, b) => a + b, 0) / xs.length,
      };
    }
    setStats((s) => ({
      ...s,
      state: rt.getState(),
      events,
      successCount: recovered.length,
      failureCount: failed.length,
      recoveryMs,
    }));
  };

  const onForceLoss = () => {
    runtimeRef.current?.forceLoss();
  };

  const onToggleScripted = () => {
    if (scriptedRunning) {
      if (scriptedTimer.current !== null) {
        window.clearInterval(scriptedTimer.current);
        scriptedTimer.current = null;
      }
      setScriptedRunning(false);
    } else {
      scriptedTimer.current = window.setInterval(() => {
        runtimeRef.current?.forceLoss();
      }, intervalMs);
      setScriptedRunning(true);
    }
  };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-15 · GPU Device-Lost Recovery</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Force <code>device.lost</code>, recover via the resource
            registry, resume rendering. Goal: median recovery &lt; 1 s,
            survives a scripted loss loop indefinitely.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <canvas
            ref={canvasRef}
            width={1024}
            height={576}
            className="block w-full rounded bg-black"
          />
          <div className="mt-2 flex items-center justify-between text-xs">
            <span>{stats.fps} fps</span>
            <span>
              state:{" "}
              <span
                className={
                  stats.state === "ready"
                    ? "text-emerald-500"
                    : stats.state === "failed"
                      ? "text-red-500"
                      : "text-amber-500"
                }
              >
                {stats.state}
              </span>
            </span>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Force a loss</h2>
            <button
              type="button"
              onClick={onForceLoss}
              disabled={stats.state !== "ready"}
              className="rounded bg-zinc-900 px-3 py-1 text-xs text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
            >
              device.destroy()
            </button>
            <p className="mt-2 text-xs text-zinc-500">
              Equivalent in production: driver update, OS sleep/wake,
              background-tab GPU eviction, or
              <code>chrome://gpu</code> &quot;crash GPU process&quot;.
            </p>
          </div>

          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Scripted loss loop</h2>
            <div className="flex items-center gap-2 text-xs">
              <label>interval</label>
              <input
                type="number"
                min={500}
                max={60000}
                step={500}
                value={intervalMs}
                onChange={(e) =>
                  setIntervalMs(Math.max(500, parseInt(e.target.value) || 500))
                }
                className="w-24 border bg-transparent px-1"
              />
              <span>ms</span>
              <button
                type="button"
                onClick={onToggleScripted}
                className="ml-auto rounded border border-zinc-400 px-3 py-1"
              >
                {scriptedRunning ? "Stop" : "Start"}
              </button>
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              Runs forever, losing the device every <code>interval</code>
              {" "}ms. Watch the recovery histogram below.
            </p>
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-2 text-base font-semibold">Recovery stats</h2>
          <dl className="grid grid-cols-3 gap-x-4 gap-y-1 text-xs md:grid-cols-4">
            <Stat label="recovered" value={stats.successCount.toString()} />
            <Stat
              label="failed"
              value={stats.failureCount.toString()}
              warn={stats.failureCount > 0}
            />
            <Stat
              label="recovery min"
              value={
                stats.recoveryMs ? `${stats.recoveryMs.min.toFixed(1)} ms` : "—"
              }
            />
            <Stat
              label="recovery mean"
              value={
                stats.recoveryMs ? `${stats.recoveryMs.mean.toFixed(1)} ms` : "—"
              }
              warn={(stats.recoveryMs?.mean ?? 0) > 1000}
            />
            <Stat
              label="recovery max"
              value={
                stats.recoveryMs ? `${stats.recoveryMs.max.toFixed(1)} ms` : "—"
              }
              warn={(stats.recoveryMs?.max ?? 0) > 1000}
            />
          </dl>
          <details className="mt-3 text-xs">
            <summary>recent events ({stats.events.length})</summary>
            <ul className="mt-2 space-y-1">
              {stats.events
                .slice(-10)
                .reverse()
                .map((e, i) => (
                  <li key={i} className="rounded bg-zinc-100 p-2 dark:bg-zinc-900">
                    <div>
                      <strong>{e.reason}</strong> · {e.message}
                    </div>
                    <div>
                      occurred {e.occurredAt.toFixed(0)} ms ·{" "}
                      {e.recoveryMs !== null
                        ? `recovered in ${e.recoveryMs.toFixed(1)} ms (${e.resourcesRebuilt} resources)`
                        : "no recovery"}
                    </div>
                  </li>
                ))}
            </ul>
          </details>
        </section>

        <footer className="text-xs text-zinc-500">
          Pass criteria: indefinite scripted loop with median recovery
          &lt; 1 s, zero failures, fps returns to baseline within one frame
          of state == ready.
        </footer>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className={warn ? "font-bold text-red-500" : "font-medium"}>
        {value}
      </dd>
    </>
  );
}

// Registry contents -- this is the recover-from-zero specification of the
// app's GPU state. Adding any resource means adding a registry entry.
function registerResources(reg: ResourceRegistry, format: GPUTextureFormat): void {
  reg.register("shader", "shader-module", [], (device) =>
    device.createShaderModule({ code: ANIMATED_WGSL }),
  );

  reg.register("pipeline", "pipeline", ["shader"], (device) => {
    const module = reg.get<GPUShaderModule>("shader");
    return device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
  });

  reg.register("uniform", "buffer", [], (device) =>
    device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
  );

  reg.register("palette", "buffer", [], (device) => {
    const buf = device.createBuffer({
      size: 4 * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const f = new Float32Array(16);
    // Four RGBA palette colors. Re-uploaded on every recovery to prove the
    // path works.
    f.set([0.1, 0.4, 0.8, 1, 0.9, 0.2, 0.3, 1, 0.4, 0.8, 0.3, 1, 0.9, 0.7, 0.1, 1]);
    device.queue.writeBuffer(buf, 0, f);
    return buf;
  });

  reg.register(
    "bindGroup",
    "bind-group",
    ["pipeline", "uniform", "palette"],
    (device) => {
      const pipeline = reg.get<GPURenderPipeline>("pipeline");
      const uniform = reg.get<GPUBuffer>("uniform");
      const palette = reg.get<GPUBuffer>("palette");
      return device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: palette } },
        ],
      });
    },
  );
}

function renderFrame(rt: GpuRuntime, context: GPUCanvasContext): void {
  const device = rt.getDevice();
  const reg = rt.getRegistry();
  const pipeline = reg.get<GPURenderPipeline>("pipeline");
  const uniform = reg.get<GPUBuffer>("uniform");
  const bindGroup = reg.get<GPUBindGroup>("bindGroup");
  const events = rt.getEvents();
  const recoveries = events.filter((e) => e.recoveryMs !== null).length;

  const data = new Float32Array(4);
  data[0] = performance.now() / 1000;
  data[1] = 0;
  data[2] = recoveries;
  device.queue.writeBuffer(uniform, 0, data);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(6);
  pass.end();
  device.queue.submit([encoder.finish()]);
}
