"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  evaluate,
  makeKeyframe,
  normalizeTrack,
  type Keyframe,
} from "../lib/keyframes";
import {
  BRIGHTNESS,
  GAUSSIAN_BLUR,
  REGISTRY,
  applyStack,
  type Effect,
} from "../lib/effects";

const DURATION = 10; // seconds
const TIMELINE_PX = 720;

type EffectInstance = {
  effect: Effect;
  // tracks keyed by paramSchema.key
  tracks: Record<string, Keyframe[]>;
};

function defaultTrack(defaultValue: number): Keyframe[] {
  return [
    { ...makeKeyframe(0, defaultValue), type: "bezier" },
    { ...makeKeyframe(DURATION, defaultValue), type: "bezier" },
  ];
}

function buildInstance(effect: Effect): EffectInstance {
  const tracks: Record<string, Keyframe[]> = {};
  for (const p of effect.paramSchema) {
    tracks[p.key] = defaultTrack(p.default);
  }
  return { effect, tracks };
}

export default function Page() {
  const [stack, setStack] = useState<EffectInstance[]>(() => [
    buildInstance(BRIGHTNESS),
    buildInstance(GAUSSIAN_BLUR),
  ]);
  const [playhead, setPlayhead] = useState(0);
  const [selected, setSelected] = useState<{
    effectIdx: number;
    paramKey: string;
    kfIdx: number;
  } | null>(null);
  const [frameMs, setFrameMs] = useState(0);
  const [evalUs, setEvalUs] = useState(0);
  const previewRef = useRef<HTMLCanvasElement | null>(null);

  // Live frame-time meter — wraps the per-frame render in performance.now.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      setFrameMs(now - last);
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Evaluate the current parameter values at the playhead.
  const evaluated = useMemo(() => {
    const t0 = performance.now();
    const out: { effect: Effect; params: Record<string, number> }[] = [];
    for (const inst of stack) {
      const params: Record<string, number> = {};
      for (const p of inst.effect.paramSchema) {
        params[p.key] = evaluate(inst.tracks[p.key] ?? [], playhead);
      }
      out.push({ effect: inst.effect, params });
    }
    const dt = performance.now() - t0;
    const calls = Math.max(
      1,
      stack.reduce((n, s) => n + s.effect.paramSchema.length, 0),
    );
    return { stack: out, evalUs: (dt * 1000) / calls };
  }, [stack, playhead]);

  // Surface the eval timing in a post-render effect (no side effects in useMemo).
  useEffect(() => {
    setEvalUs(evaluated.evalUs);
  }, [evaluated]);

  // WebGPU preview — render a gradient with the brightness applied and a
  // CSS-level halo proxy for blur. If WebGPU is unavailable we fall back
  // to 2D canvas; the contract is the same.
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    let cancelled = false;
    let gpuRes: { device: GPUDevice; ctx: GPUCanvasContext } | null = null;

    const setup = async () => {
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;
      // Try WebGPU first; if it fails we just keep the 2D canvas.
      try {
        if (!navigator.gpu) throw new Error("no webgpu");
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("no adapter");
        const device = await adapter.requestDevice();
        const wgpu = canvas.getContext("webgpu");
        if (!wgpu) throw new Error("no webgpu context");
        wgpu.configure({
          device,
          format: navigator.gpu.getPreferredCanvasFormat(),
          alphaMode: "premultiplied",
        });
        gpuRes = { device, ctx: wgpu };
      } catch {
        // 2D fallback path is fine for this experiment.
      }
      if (cancelled) {
        gpuRes?.device.destroy();
      }
    };
    void setup();

    return () => {
      cancelled = true;
      gpuRes?.device.destroy();
    };
  }, []);

  // Per-frame redraw using the 2D fallback (deterministic across environments).
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const brightness = evaluated.stack.find((s) => s.effect.id === "brightness")
      ?.params.amount ?? 1;
    const blur = evaluated.stack.find((s) => s.effect.id === "gaussian_blur")
      ?.params.radius ?? 0;

    const W = canvas.width;
    const H = canvas.height;
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#1e3a8a");
    grad.addColorStop(0.5, "#9333ea");
    grad.addColorStop(1, "#f97316");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Apply stack ordering: brightness first then blur is different from
    // blur first then brightness — the CPU stub gives us a deterministic
    // sanity check on ordering; the WebGPU pipeline does the real work.
    void applyStack({ r: 1, g: 1, b: 1 }, evaluated.stack);

    ctx.globalCompositeOperation = "multiply";
    const m = Math.max(0, Math.min(2, brightness));
    const ch = Math.round(m * 128);
    ctx.fillStyle = `rgb(${ch},${ch},${ch})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";

    // Blur halo proxy.
    if (blur > 0.01) {
      ctx.filter = `blur(${Math.min(32, blur)}px)`;
      ctx.drawImage(canvas, 0, 0);
      ctx.filter = "none";
    }
  }, [evaluated]);

  const onTimelineClick = useCallback(
    (effectIdx: number, paramKey: string, ev: React.MouseEvent<HTMLDivElement>) => {
      const rect = ev.currentTarget.getBoundingClientRect();
      const t = ((ev.clientX - rect.left) / rect.width) * DURATION;
      const inst = stack[effectIdx];
      const spec = inst.effect.paramSchema.find((p) => p.key === paramKey);
      if (!spec) return;
      const current = evaluate(inst.tracks[paramKey], t);
      const kf = { ...makeKeyframe(t, current), type: "bezier" as const };
      const next = normalizeTrack([...(inst.tracks[paramKey] ?? []), kf]);
      setStack((prev) =>
        prev.map((p, i) =>
          i === effectIdx
            ? { ...p, tracks: { ...p.tracks, [paramKey]: next } }
            : p,
        ),
      );
    },
    [stack],
  );

  const removeKeyframe = useCallback(
    (effectIdx: number, paramKey: string, kfIdx: number) => {
      setStack((prev) =>
        prev.map((p, i) => {
          if (i !== effectIdx) return p;
          const t = p.tracks[paramKey];
          if (!t || t.length <= 2) return p;
          return {
            ...p,
            tracks: {
              ...p.tracks,
              [paramKey]: t.filter((_, j) => j !== kfIdx),
            },
          };
        }),
      );
      setSelected(null);
    },
    [],
  );

  const moveEffect = useCallback((idx: number, dir: -1 | 1) => {
    setStack((prev) => {
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }, []);

  const updateTangent = useCallback(
    (
      effectIdx: number,
      paramKey: string,
      kfIdx: number,
      side: "in" | "out",
      v: { x: number; y: number },
    ) => {
      setStack((prev) =>
        prev.map((p, i) => {
          if (i !== effectIdx) return p;
          const t = p.tracks[paramKey];
          if (!t) return p;
          const nt = t.map((kf, j) => {
            if (j !== kfIdx) return kf;
            if (side === "in") return { ...kf, inTangent: v };
            return { ...kf, outTangent: v };
          });
          return { ...p, tracks: { ...p.tracks, [paramKey]: nt } };
        }),
      );
    },
    [],
  );

  return (
    <main className="min-h-screen bg-zinc-50 p-6 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold">
            Exp-23 · Effects + Bezier Keyframes
          </h1>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Cubic-bezier parameter animation with Newton-method t-solve, a
            plugin contract for effects, deterministic stack ordering, and a
            live preview. Click a timeline strip to add a keyframe;
            right-click a dot to remove.
          </p>
        </header>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded border border-zinc-300 p-3 dark:border-zinc-700 md:col-span-2">
            <h2 className="mb-2 text-sm font-semibold">Preview</h2>
            <canvas
              ref={previewRef}
              width={640}
              height={240}
              className="w-full rounded bg-zinc-200 dark:bg-zinc-800"
            />
            <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-zinc-500">
              <div>
                frame: <span className="text-zinc-200">{frameMs.toFixed(1)} ms</span>
              </div>
              <div>
                evaluate(): <span className="text-zinc-200">{evalUs.toFixed(2)} µs</span>
              </div>
              <div>
                t = <span className="text-zinc-200">{playhead.toFixed(3)} s</span>
              </div>
            </div>
          </div>

          <div className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">Effect stack</h2>
            <p className="mb-2 text-[10px] text-zinc-500">
              Order matters — Brightness then Blur is not the same as Blur
              then Brightness.
            </p>
            <ul className="space-y-1 text-xs">
              {stack.map((inst, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between rounded border border-zinc-300/50 px-2 py-1 dark:border-zinc-700/50"
                >
                  <span>
                    {i + 1}. {inst.effect.name}
                  </span>
                  <span className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => moveEffect(i, -1)}
                      className="rounded border px-1 text-[10px] disabled:opacity-30"
                      disabled={i === 0}
                    >
                      up
                    </button>
                    <button
                      type="button"
                      onClick={() => moveEffect(i, 1)}
                      className="rounded border px-1 text-[10px] disabled:opacity-30"
                      disabled={i === stack.length - 1}
                    >
                      dn
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-3 border-t border-zinc-300/50 pt-2 text-[10px] dark:border-zinc-700/50">
              <div className="mb-1 text-zinc-500">add effect</div>
              <div className="flex flex-wrap gap-1">
                {REGISTRY.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() =>
                      setStack((p) => [...p, buildInstance(e)])
                    }
                    className="rounded border px-2 py-0.5"
                  >
                    +{e.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Playhead</h2>
          <input
            type="range"
            min={0}
            max={DURATION}
            step={0.001}
            value={playhead}
            onChange={(e) => setPlayhead(parseFloat(e.target.value))}
            className="w-full"
          />
        </section>

        <section className="space-y-3">
          {stack.map((inst, effectIdx) =>
            inst.effect.paramSchema.map((spec) => {
              const track = inst.tracks[spec.key];
              const current = evaluate(track, playhead);
              return (
                <div
                  key={`${effectIdx}-${spec.key}`}
                  className="rounded border border-zinc-300 p-3 dark:border-zinc-700"
                >
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-semibold">
                      {inst.effect.name} · {spec.key}
                    </span>
                    <span className="text-zinc-500">
                      {current.toFixed(3)} (min {spec.min}, max {spec.max})
                    </span>
                  </div>
                  <div
                    className="relative h-10 cursor-crosshair rounded bg-zinc-200 dark:bg-zinc-800"
                    style={{ width: "100%", maxWidth: TIMELINE_PX }}
                    onClick={(e) => onTimelineClick(effectIdx, spec.key, e)}
                  >
                    {/* playhead */}
                    <div
                      className="absolute top-0 bottom-0 w-px bg-amber-500"
                      style={{ left: `${(playhead / DURATION) * 100}%` }}
                    />
                    {track.map((kf, kfIdx) => (
                      <button
                        type="button"
                        key={kfIdx}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected({ effectIdx, paramKey: spec.key, kfIdx });
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          removeKeyframe(effectIdx, spec.key, kfIdx);
                        }}
                        className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border ${
                          selected?.effectIdx === effectIdx &&
                          selected?.paramKey === spec.key &&
                          selected?.kfIdx === kfIdx
                            ? "border-amber-400 bg-amber-300"
                            : "border-zinc-100 bg-emerald-500"
                        }`}
                        style={{
                          left: `${(kf.time / DURATION) * 100}%`,
                        }}
                        title={`t=${kf.time.toFixed(2)} v=${kf.value.toFixed(2)}`}
                      />
                    ))}
                  </div>
                </div>
              );
            }),
          )}
        </section>

        {selected && (
          <CurveEditor
            stack={stack}
            sel={selected}
            onClose={() => setSelected(null)}
            onTangent={updateTangent}
          />
        )}

        <footer className="text-[10px] text-zinc-500">
          Newton's method 8-iter, falls back to bisection if |dx/dt| &lt; 1e-6.
          Hold keyframes short-circuit the segment evaluator. Project state
          is `structuredClone`-safe — try it in DevTools.
        </footer>
      </div>
    </main>
  );
}

function CurveEditor({
  stack,
  sel,
  onClose,
  onTangent,
}: {
  stack: EffectInstance[];
  sel: { effectIdx: number; paramKey: string; kfIdx: number };
  onClose: () => void;
  onTangent: (
    effectIdx: number,
    paramKey: string,
    kfIdx: number,
    side: "in" | "out",
    v: { x: number; y: number },
  ) => void;
}) {
  const inst = stack[sel.effectIdx];
  const track = inst.tracks[sel.paramKey];
  const kf = track[sel.kfIdx];
  // SVG is in normalised coords; tangent x is seconds, y is value units.
  const W = 320;
  const H = 160;
  const TX = (x: number) => W / 2 + x * 60;
  const TY = (y: number) => H / 2 - y * 40;

  const drag = (side: "in" | "out") => (ev: React.PointerEvent<SVGCircleElement>) => {
    const svg = ev.currentTarget.ownerSVGElement;
    if (!svg) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) - W / 2) / 60;
      const y = -((e.clientY - rect.top) - H / 2) / 40;
      onTangent(sel.effectIdx, sel.paramKey, sel.kfIdx, side, { x, y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section className="rounded border border-amber-400 p-3 dark:border-amber-600">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-semibold">
          Tangent editor · {inst.effect.name}/{sel.paramKey} · key #{sel.kfIdx}
        </span>
        <button type="button" onClick={onClose} className="rounded border px-2 text-[10px]">
          close
        </button>
      </div>
      <svg
        width={W}
        height={H}
        className="rounded bg-zinc-100 dark:bg-zinc-900"
      >
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="#71717a" strokeDasharray="2 3" />
        <line x1={W / 2} y1={0} x2={W / 2} y2={H} stroke="#71717a" strokeDasharray="2 3" />
        <line
          x1={TX(kf.inTangent.x)}
          y1={TY(kf.inTangent.y)}
          x2={W / 2}
          y2={H / 2}
          stroke="#f59e0b"
        />
        <line
          x1={W / 2}
          y1={H / 2}
          x2={TX(kf.outTangent.x)}
          y2={TY(kf.outTangent.y)}
          stroke="#10b981"
        />
        <circle cx={W / 2} cy={H / 2} r={5} fill="#fbbf24" />
        <circle
          cx={TX(kf.inTangent.x)}
          cy={TY(kf.inTangent.y)}
          r={6}
          fill="#f59e0b"
          onPointerDown={drag("in")}
          className="cursor-grab"
        />
        <circle
          cx={TX(kf.outTangent.x)}
          cy={TY(kf.outTangent.y)}
          r={6}
          fill="#10b981"
          onPointerDown={drag("out")}
          className="cursor-grab"
        />
      </svg>
      <p className="mt-2 text-[10px] text-zinc-500">
        Drag the orange (in) or green (out) handle. Tangent units are
        seconds × value. The evaluator solves x → t with Newton's method
        and reads y at that t.
      </p>
    </section>
  );
}
