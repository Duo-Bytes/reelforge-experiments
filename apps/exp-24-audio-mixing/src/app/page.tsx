"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateTestTones } from "../lib/test-tones";
import {
  applyCompressor,
  applyDucker,
  applyEq,
  createMixGraph,
  pulseDuck,
  rms,
  startTracks,
  stopTracks,
  type CompressorParams,
  type DuckerParams,
  type EqBandParams,
  type MixGraph,
} from "../lib/mix-graph";
import { disposeDuckerWorkletUrl } from "../lib/ducker-worklet";

type TrackState = {
  gain: number;
  pan: number;
  eq: EqBandParams[];
  comp: CompressorParams;
  duck: DuckerParams;
};

const DEFAULT_EQ: EqBandParams[] = [
  { freq: 120, gain: 0, q: 0.7 },
  { freq: 500, gain: 0, q: 1 },
  { freq: 2500, gain: 0, q: 1 },
  { freq: 8000, gain: 0, q: 0.7 },
];

const DEFAULT_COMP: CompressorParams = {
  threshold: -18,
  ratio: 3,
  attack: 0.005,
  release: 0.12,
  knee: 6,
};

const DEFAULT_DUCK: DuckerParams = {
  depth: 0.7,
  sensitivity: 4,
  attackMs: 6,
  releaseMs: 120,
};

function defaultTrackState(gain: number, pan: number): TrackState {
  return {
    gain,
    pan,
    eq: DEFAULT_EQ.map((b) => ({ ...b })),
    comp: { ...DEFAULT_COMP },
    duck: { ...DEFAULT_DUCK },
  };
}

export default function Page() {
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [tracks, setTracks] = useState<TrackState[]>([
    defaultTrackState(0.6, -0.3),
    defaultTrackState(0.55, 0.3),
  ]);
  const [latency, setLatency] = useState({
    base: 0,
    output: 0,
    sampleRate: 0,
  });
  const [levels, setLevels] = useState<{
    track: number[];
    master: number;
  }>({ track: [0, 0], master: 0 });

  const graphRef = useRef<MixGraph | null>(null);
  const buffersRef = useRef<AudioBuffer[] | null>(null);
  const rafRef = useRef<number | null>(null);
  const scratchRef = useRef<Float32Array>(new Float32Array(1024));
  const sideScratchRef = useRef<Float32Array>(new Float32Array(512));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const tones = await generateTestTones();
        if (cancelled) return;
        buffersRef.current = [tones.track1, tones.track2];
        setReady(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const g = graphRef.current;
    if (g) {
      stopTracks(g);
      void g.ctx.close().catch(() => undefined);
      graphRef.current = null;
    }
    disposeDuckerWorkletUrl();
  }, []);

  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    setError(null);
    if (!buffersRef.current) return;
    if (graphRef.current) return;
    try {
      const graph = await createMixGraph(buffersRef.current);
      if (graph.ctx.state === "suspended") {
        await graph.ctx.resume();
      }
      // initial param sync from React state.
      for (let i = 0; i < graph.tracks.length; i += 1) {
        const t = graph.tracks[i]!;
        const s = tracks[i]!;
        t.gain.gain.value = s.gain;
        t.pan.pan.value = s.pan;
        for (let b = 0; b < 4; b += 1) applyEq(t.eq[b]!, s.eq[b]!);
        applyCompressor(t.comp, s.comp);
        applyDucker(t.duck, s.duck);
      }
      startTracks(graph, buffersRef.current);
      graphRef.current = graph;
      setLatency({
        base: graph.ctx.baseLatency ?? 0,
        output: graph.ctx.outputLatency ?? 0,
        sampleRate: graph.ctx.sampleRate,
      });
      setPlaying(true);
      const tick = () => {
        const g = graphRef.current;
        if (!g) return;
        const trackLevels: number[] = [];
        for (let i = 0; i < g.tracks.length; i += 1) {
          const t = g.tracks[i]!;
          const r = rms(t.analyser, scratchRef.current);
          trackLevels.push(r);
          // Feed sidechain RMS into the OTHER track's ducker.
          const other = g.tracks[(i + 1) % g.tracks.length]!;
          const sideRms = rms(other.sidechainAnalyser, sideScratchRef.current);
          const rmsParam = t.duck.parameters.get("sidechainRms");
          if (rmsParam) rmsParam.setTargetAtTime(sideRms, g.ctx.currentTime, 0.01);
        }
        const masterLevel = rms(g.masterAnalyser, scratchRef.current);
        setLevels({ track: trackLevels, master: masterLevel });
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      teardown();
      setPlaying(false);
    }
  }, [tracks, teardown]);

  const stop = useCallback(() => {
    teardown();
    setPlaying(false);
    setLevels({ track: [0, 0], master: 0 });
  }, [teardown]);

  // Live-sync React state → live graph params.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    for (let i = 0; i < g.tracks.length; i += 1) {
      const t = g.tracks[i]!;
      const s = tracks[i]!;
      t.gain.gain.value = s.gain;
      t.pan.pan.value = s.pan;
      for (let b = 0; b < 4; b += 1) applyEq(t.eq[b]!, s.eq[b]!);
      applyCompressor(t.comp, s.comp);
      applyDucker(t.duck, s.duck);
    }
  }, [tracks]);

  const setTrack = useCallback((idx: number, patch: Partial<TrackState>) => {
    setTracks((prev) =>
      prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)),
    );
  }, []);

  const setEqBand = useCallback(
    (trackIdx: number, bandIdx: number, patch: Partial<EqBandParams>) => {
      setTracks((prev) =>
        prev.map((t, i) => {
          if (i !== trackIdx) return t;
          const eq = t.eq.map((b, bi) =>
            bi === bandIdx ? { ...b, ...patch } : b,
          );
          return { ...t, eq };
        }),
      );
    },
    [],
  );

  const triggerDuck = useCallback((trackIdx: number) => {
    const g = graphRef.current;
    if (!g) return;
    const t = g.tracks[trackIdx];
    if (!t) return;
    pulseDuck(t.duck, g.ctx);
  }, []);

  const latencyMs = useMemo(
    () => ((latency.base + latency.output) * 1000).toFixed(1),
    [latency],
  );

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-24 · Audio Mixing Graph</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Per-track Gain / Pan / 4-band EQ / Compressor / Sidechain duck
            (AudioWorklet). Test tones generated procedurally — no network.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="flex flex-wrap items-center gap-3 rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
          <button
            type="button"
            onClick={playing ? stop : start}
            disabled={!ready}
            className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
          >
            {playing ? "Stop" : "Play"}
          </button>
          <span className="text-zinc-500">
            sample rate: <span className="text-zinc-800 dark:text-zinc-200">{latency.sampleRate || "—"}</span>
          </span>
          <span className="text-zinc-500">
            base latency: <span className="text-zinc-800 dark:text-zinc-200">{(latency.base * 1000).toFixed(1)} ms</span>
          </span>
          <span className="text-zinc-500">
            output latency: <span className="text-zinc-800 dark:text-zinc-200">{(latency.output * 1000).toFixed(1)} ms</span>
          </span>
          <span className="text-zinc-500">
            round trip: <span className="text-zinc-800 dark:text-zinc-200">{latencyMs} ms</span>
          </span>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {tracks.map((t, i) => (
            <TrackStrip
              key={i}
              index={i}
              state={t}
              level={levels.track[i] ?? 0}
              onPatch={(patch) => setTrack(i, patch)}
              onPatchEq={(b, patch) => setEqBand(i, b, patch)}
              onTriggerDuck={() => triggerDuck(i)}
            />
          ))}
        </section>

        <section className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-semibold">Master</span>
            <span className="text-zinc-500">
              limiter @ -1 dBFS · linear meter
            </span>
          </div>
          <Meter v={levels.master} />
        </section>

        <footer className="text-xs text-zinc-500">
          The ducker is an inline-registered AudioWorklet driven by an a-rate
          AudioParam; the host samples each track&apos;s sidechain Analyser
          every animation frame and writes it to the *other* track&apos;s
          ducker (so each track ducks under the other). Click &quot;trigger
          duck&quot; for an audible pulse.
        </footer>
      </div>
    </main>
  );
}

function TrackStrip({
  index,
  state,
  level,
  onPatch,
  onPatchEq,
  onTriggerDuck,
}: {
  index: number;
  state: TrackState;
  level: number;
  onPatch: (patch: Partial<TrackState>) => void;
  onPatchEq: (band: number, patch: Partial<EqBandParams>) => void;
  onTriggerDuck: () => void;
}) {
  return (
    <div className="rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold">Track {index + 1}</span>
        <button
          type="button"
          onClick={onTriggerDuck}
          className="rounded border border-amber-500 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-400"
        >
          trigger duck
        </button>
      </div>
      <Meter v={level} />
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Knob
          label="gain"
          value={state.gain}
          min={0}
          max={1.2}
          step={0.01}
          onChange={(v) => onPatch({ gain: v })}
        />
        <Knob
          label="pan"
          value={state.pan}
          min={-1}
          max={1}
          step={0.01}
          onChange={(v) => onPatch({ pan: v })}
        />
      </div>
      <div className="mt-3">
        <div className="mb-1 text-[10px] text-zinc-500">4-band EQ</div>
        <div className="grid grid-cols-4 gap-1">
          {state.eq.map((b, bi) => (
            <div key={bi} className="rounded border border-zinc-200 p-1 dark:border-zinc-800">
              <div className="text-[9px] text-zinc-500">
                {["LS", "P", "P", "HS"][bi]}
              </div>
              <Knob
                label="hz"
                value={b.freq}
                min={20}
                max={20000}
                step={1}
                onChange={(v) => onPatchEq(bi, { freq: v })}
                compact
              />
              <Knob
                label="dB"
                value={b.gain}
                min={-18}
                max={18}
                step={0.1}
                onChange={(v) => onPatchEq(bi, { gain: v })}
                compact
              />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3">
        <div className="mb-1 text-[10px] text-zinc-500">Compressor</div>
        <div className="grid grid-cols-4 gap-1">
          <Knob
            label="thr"
            value={state.comp.threshold}
            min={-60}
            max={0}
            step={0.5}
            onChange={(v) => onPatch({ comp: { ...state.comp, threshold: v } })}
            compact
          />
          <Knob
            label="ratio"
            value={state.comp.ratio}
            min={1}
            max={20}
            step={0.1}
            onChange={(v) => onPatch({ comp: { ...state.comp, ratio: v } })}
            compact
          />
          <Knob
            label="att"
            value={state.comp.attack}
            min={0}
            max={1}
            step={0.001}
            onChange={(v) => onPatch({ comp: { ...state.comp, attack: v } })}
            compact
          />
          <Knob
            label="rel"
            value={state.comp.release}
            min={0}
            max={1}
            step={0.001}
            onChange={(v) => onPatch({ comp: { ...state.comp, release: v } })}
            compact
          />
        </div>
      </div>
      <div className="mt-3">
        <div className="mb-1 text-[10px] text-zinc-500">Ducker</div>
        <div className="grid grid-cols-4 gap-1">
          <Knob
            label="depth"
            value={state.duck.depth}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => onPatch({ duck: { ...state.duck, depth: v } })}
            compact
          />
          <Knob
            label="sens"
            value={state.duck.sensitivity}
            min={0.1}
            max={20}
            step={0.1}
            onChange={(v) =>
              onPatch({ duck: { ...state.duck, sensitivity: v } })
            }
            compact
          />
          <Knob
            label="att ms"
            value={state.duck.attackMs}
            min={0.1}
            max={200}
            step={0.1}
            onChange={(v) =>
              onPatch({ duck: { ...state.duck, attackMs: v } })
            }
            compact
          />
          <Knob
            label="rel ms"
            value={state.duck.releaseMs}
            min={1}
            max={2000}
            step={1}
            onChange={(v) =>
              onPatch({ duck: { ...state.duck, releaseMs: v } })
            }
            compact
          />
        </div>
      </div>
    </div>
  );
}

function Knob({
  label,
  value,
  min,
  max,
  step,
  onChange,
  compact,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  compact?: boolean;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-[10px]">
      <span className="flex items-center justify-between text-zinc-500">
        <span>{label}</span>
        <span className="font-mono text-zinc-700 dark:text-zinc-300">
          {compact ? value.toFixed(2) : value.toFixed(3)}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-zinc-700 dark:accent-zinc-300"
      />
    </label>
  );
}

function Meter({ v }: { v: number }) {
  const pct = Math.min(1, v * 3);
  return (
    <div className="h-2 w-full rounded bg-zinc-200 dark:bg-zinc-800">
      <div
        className="h-full rounded bg-emerald-500 transition-[width] duration-75"
        style={{ width: `${pct * 100}%` }}
      />
    </div>
  );
}
