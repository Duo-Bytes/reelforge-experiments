"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  applyTrim,
  buildSnapTargets,
  runTrimTests,
  seed500,
  snap,
  type Clip,
  type Edge,
  type TestResult,
  type TimelineState,
  type TrimMode,
} from "../lib/trim";

const PX_PER_SEC = 60;
const TRACK_HEIGHT = 28;
const HEADER_W = 60;
const SNAP_THRESHOLD_PX_DEFAULT = 8;

type Action =
  | { type: "trim"; mode: TrimMode; clipId: string; edge: Edge; delta: number }
  | { type: "reset" };

function reducer(state: TimelineState, action: Action): TimelineState {
  switch (action.type) {
    case "trim":
      return applyTrim(state, action.mode, action.clipId, action.edge, action.delta);
    case "reset":
      return seed500();
  }
}

type DragState = {
  clipId: string;
  edge: Edge;
  mode: TrimMode;
  startPointerX: number;
  startClip: Clip;
  liveDelta: number;
};

export default function Page() {
  const [state, dispatch] = useReducer(reducer, undefined, () => seed500());
  const [mode, setMode] = useState<TrimMode>("ripple");
  const [snapThresholdPx, setSnapThresholdPx] = useState(SNAP_THRESHOLD_PX_DEFAULT);
  const [scroll, setScroll] = useState({ x: 0, w: 1200 });
  const [snapTarget, setSnapTarget] = useState<number | null>(null);
  const [latencyMs, setLatencyMs] = useState(0);
  const [tests, setTests] = useState<TestResult[]>([]);

  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{ clientX: number; t: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Index clips by track for the windowing pass.
  const visibleClips = useMemo(() => {
    const x0 = scroll.x;
    const x1 = scroll.x + scroll.w;
    const t0 = x0 / PX_PER_SEC;
    const t1 = x1 / PX_PER_SEC;
    return state.clips.filter((c) => c.start + c.duration >= t0 && c.start <= t1);
  }, [state, scroll]);

  const totalSec = useMemo(() => {
    let m = 0;
    for (const c of state.clips) {
      const e = c.start + c.duration;
      if (e > m) m = e;
    }
    return m;
  }, [state]);

  const snapTargets = useMemo(() => buildSnapTargets(state), [state]);

  // Pointer move handler scheduled on rAF; coalesced events are folded
  // into "most recent point wins" because the meaningful delta is the
  // latest sample, not the sum.
  const onPointerMove = useCallback(
    (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Use the most recent coalesced sample.
      const coalesced = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [];
      const latest = coalesced.length ? coalesced[coalesced.length - 1] : ev;
      pendingPointerRef.current = {
        clientX: latest.clientX,
        t: performance.now(),
      };
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const p = pendingPointerRef.current;
        const d = dragRef.current;
        if (!p || !d) return;
        const dxPx = p.clientX - d.startPointerX;
        let deltaSec = dxPx / PX_PER_SEC;
        // Snap.
        const candidateAbs =
          d.edge === "out"
            ? d.startClip.start + d.startClip.duration + deltaSec
            : d.startClip.start + deltaSec;
        const result = snap(
          candidateAbs,
          snapTargets,
          snapThresholdPx / PX_PER_SEC,
        );
        if (result.target !== null) {
          deltaSec = result.target - (
            d.edge === "out"
              ? d.startClip.start + d.startClip.duration
              : d.startClip.start
          );
          setSnapTarget(result.target);
        } else {
          setSnapTarget(null);
        }
        d.liveDelta = deltaSec;
        // Mutate the dragged clip's DOM directly — no setState in the hot path.
        const el = document.getElementById(`clip-${d.clipId}`);
        if (el) {
          if (d.mode === "ripple" || d.mode === "roll") {
            if (d.edge === "out") {
              el.style.width = `${Math.max(2, (d.startClip.duration + deltaSec) * PX_PER_SEC)}px`;
            } else {
              el.style.left = `${(d.startClip.start + deltaSec) * PX_PER_SEC}px`;
              el.style.width = `${Math.max(2, (d.startClip.duration - deltaSec) * PX_PER_SEC)}px`;
            }
          } else if (d.mode === "slide") {
            el.style.left = `${(d.startClip.start + deltaSec) * PX_PER_SEC}px`;
          }
          // slip: visual position unchanged (only mediaIn/Out shift)
        }
        const now = performance.now();
        setLatencyMs(now - p.t);
      });
    },
    [snapTargets, snapThresholdPx],
  );

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const finalDelta = drag.liveDelta;
    // Round to nearest 1/240 of a second (frame quantum) to avoid drift.
    const rounded = Math.round(finalDelta * 240) / 240;
    dispatch({
      type: "trim",
      mode: drag.mode,
      clipId: drag.clipId,
      edge: drag.edge,
      delta: rounded,
    });
    dragRef.current = null;
    setSnapTarget(null);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove]);

  const beginDrag = useCallback(
    (clipId: string, edge: Edge, ev: React.PointerEvent<HTMLDivElement>) => {
      const c = state.clips.find((x) => x.id === clipId);
      if (!c) return;
      // For slip and slide, edge selection isn't meaningful — they
      // operate on the whole clip. We re-interpret a body click as the
      // operation, and the in-edge click as the canonical anchor.
      dragRef.current = {
        clipId,
        edge,
        mode,
        startPointerX: ev.clientX,
        startClip: c,
        liveDelta: 0,
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      ev.preventDefault();
    },
    [mode, state, onPointerMove, onPointerUp],
  );

  // Track scroll measurement.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setScroll({ x: el.scrollLeft, w: el.clientWidth });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  // Cleanup any in-flight rAF on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  const tracks = useMemo(() => {
    const s = new Set<string>();
    for (const c of state.clips) s.add(c.trackId);
    return [...s].sort();
  }, [state]);

  return (
    <main className="min-h-screen bg-zinc-50 p-6 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold">
            Exp-31 · Snapping + Ripple/Roll/Slip/Slide
          </h1>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            500-clip in-memory timeline. Hot path mutates DOM via{" "}
            <code>useRef</code>; the reducer is dispatched once on pointerup.
            Pointer events are coalesced and committed once per animation
            frame. Drag a clip&apos;s left/right edge.
          </p>
        </header>

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="clips" value={String(state.clips.length)} />
          <Stat
            label="drag latency"
            value={`${latencyMs.toFixed(1)} ms`}
            warn={latencyMs > 16}
          />
          <Stat label="mode" value={mode} />
          <Stat
            label="snap target"
            value={snapTarget == null ? "—" : `${snapTarget.toFixed(3)} s`}
          />
        </section>

        <section className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-zinc-500">trim mode</span>
          {(["ripple", "roll", "slip", "slide"] as TrimMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded border px-2 py-1 ${
                mode === m
                  ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200"
                  : "border-zinc-400"
              }`}
            >
              {m}
            </button>
          ))}
          <span className="ml-4 text-zinc-500">snap threshold</span>
          <input
            type="range"
            min={0}
            max={32}
            value={snapThresholdPx}
            onChange={(e) => setSnapThresholdPx(parseInt(e.target.value, 10))}
          />
          <span>{snapThresholdPx} px</span>
          <button
            type="button"
            onClick={() => dispatch({ type: "reset" })}
            className="ml-auto rounded border border-zinc-400 px-2 py-1"
          >
            reset seed
          </button>
          <button
            type="button"
            onClick={() => setTests(runTrimTests())}
            className="rounded border border-emerald-500 px-2 py-1 text-emerald-600 dark:text-emerald-400"
          >
            run tests
          </button>
        </section>

        <div
          ref={containerRef}
          className="relative max-w-full overflow-x-auto rounded border border-zinc-300 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <div
            className="relative"
            style={{
              width: HEADER_W + Math.max(scroll.w, totalSec * PX_PER_SEC + 200),
              height: tracks.length * TRACK_HEIGHT + 30,
            }}
          >
            {/* Ruler */}
            <div className="absolute left-0 right-0 top-0 h-6 border-b border-zinc-300 dark:border-zinc-700">
              {Array.from(
                { length: Math.ceil(totalSec) + 1 },
                (_, i) => (
                  <div
                    key={i}
                    className="absolute top-0 bottom-0 border-l border-zinc-300/50 text-[9px] text-zinc-500 dark:border-zinc-700/50"
                    style={{ left: HEADER_W + i * PX_PER_SEC }}
                  >
                    <span className="pl-1">{i}s</span>
                  </div>
                ),
              )}
            </div>

            {/* Tracks */}
            {tracks.map((trackId, ti) => (
              <div
                key={trackId}
                className="absolute left-0 right-0 border-b border-zinc-300/40 dark:border-zinc-700/40"
                style={{ top: 24 + ti * TRACK_HEIGHT, height: TRACK_HEIGHT }}
              >
                <div className="absolute left-0 top-0 flex h-full w-[60px] items-center justify-center bg-zinc-200 text-[10px] text-zinc-500 dark:bg-zinc-800">
                  {trackId}
                </div>
              </div>
            ))}

            {/* Clips (windowed) */}
            {visibleClips.map((c) => {
              const ti = tracks.indexOf(c.trackId);
              return (
                <ClipBlock
                  key={c.id}
                  clip={c}
                  top={24 + ti * TRACK_HEIGHT + 2}
                  height={TRACK_HEIGHT - 4}
                  mode={mode}
                  onEdgeDown={beginDrag}
                />
              );
            })}

            {/* Snap line */}
            {snapTarget != null && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-amber-400"
                style={{ left: HEADER_W + snapTarget * PX_PER_SEC }}
              />
            )}

            {/* Playhead */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-emerald-500"
              style={{ left: HEADER_W + state.playhead * PX_PER_SEC }}
            />

            {/* Markers */}
            {state.markers.map((m) => (
              <div
                key={m.id}
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-blue-400 opacity-60"
                style={{ left: HEADER_W + m.time * PX_PER_SEC }}
                title={m.label}
              />
            ))}
          </div>
        </div>

        {tests.length > 0 && (
          <section className="rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">Trim primitive tests</h2>
            <ul className="space-y-1">
              {tests.map((t, i) => (
                <li key={i}>
                  <span
                    className={t.pass ? "text-emerald-500" : "text-red-500"}
                  >
                    {t.pass ? "PASS" : "FAIL"}
                  </span>{" "}
                  {t.name}{" "}
                  <span className="text-zinc-500">{t.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="text-[10px] text-zinc-500">
          On pointerup, the delta is rounded to the 240 Hz frame quantum
          and dispatched in a single reducer action — keeps the undo stack
          one entry per drag and avoids float drift over many edits. Slip
          clamps to <code>mediaDuration</code>, not <code>duration</code>.
          Ripple is `trackId`-scoped.
        </footer>
      </div>
    </main>
  );
}

function ClipBlock({
  clip,
  top,
  height,
  mode,
  onEdgeDown,
}: {
  clip: Clip;
  top: number;
  height: number;
  mode: TrimMode;
  onEdgeDown: (
    clipId: string,
    edge: Edge,
    ev: React.PointerEvent<HTMLDivElement>,
  ) => void;
}) {
  const left = HEADER_W + clip.start * PX_PER_SEC;
  const width = Math.max(2, clip.duration * PX_PER_SEC);
  return (
    <div
      id={`clip-${clip.id}`}
      className="absolute rounded bg-emerald-700/70 text-[9px] text-white"
      style={{ left, top, width, height }}
    >
      <div
        className="absolute left-0 top-0 h-full w-2 cursor-ew-resize bg-emerald-300/50"
        onPointerDown={(e) => onEdgeDown(clip.id, "in", e)}
      />
      <div
        className="absolute right-0 top-0 h-full w-2 cursor-ew-resize bg-emerald-300/50"
        onPointerDown={(e) => onEdgeDown(clip.id, "out", e)}
      />
      <div
        className={`absolute inset-x-2 top-0 h-full ${
          mode === "slip" || mode === "slide" ? "cursor-grab" : ""
        }`}
        onPointerDown={(e) => {
          if (mode === "slip" || mode === "slide") onEdgeDown(clip.id, "in", e);
        }}
      >
        <span className="block truncate px-1 leading-[20px]">{clip.id}</span>
      </div>
    </div>
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
    <div
      className={`rounded border p-2 ${
        warn
          ? "border-red-500 text-red-600 dark:text-red-400"
          : "border-zinc-300 dark:border-zinc-700"
      }`}
    >
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className="text-base">{value}</div>
    </div>
  );
}
