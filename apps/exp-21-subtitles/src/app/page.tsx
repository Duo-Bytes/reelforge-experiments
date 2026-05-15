"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseAss, type ParsedAss } from "../lib/ass";
import { SAMPLE_ASS, SAMPLE_VTT } from "../lib/samples";
import { activeCues, parseVtt, type VttCue } from "../lib/vtt";

type Mode = "vtt" | "ass";

// Parse samples once at module load — the inputs are static.
const parsedVtt: { cues: VttCue[]; error: string | null } = (() => {
  try {
    return { cues: parseVtt(SAMPLE_VTT), error: null };
  } catch (err) {
    return {
      cues: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
})();

const parsedAss: { doc: ParsedAss | null; error: string | null } = (() => {
  try {
    return { doc: parseAss(SAMPLE_ASS), error: null };
  } catch (err) {
    return {
      doc: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
})();

export default function Page() {
  const [mode, setMode] = useState<Mode>("vtt");
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const error: string | null = parsedVtt.error ?? parsedAss.error;
  const [workerRenderMs, setWorkerRenderMs] = useState<number | null>(null);

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const lastFrameTsRef = useRef<number>(performance.now());
  const rafRef = useRef<number | null>(null);
  const playingRef = useRef(false);
  const playheadRef = useRef(0);
  const modeRef = useRef<Mode>("vtt");

  const vttCues: VttCue[] = parsedVtt.cues;
  const assDoc: ParsedAss | null = parsedAss.doc;

  const activeVtt = useMemo(() => activeCues(vttCues, playhead), [vttCues, playhead]);
  const activeAss = useMemo(() => {
    if (!assDoc) return [];
    return assDoc.cues.filter(
      (c) =>
        playhead >= c.start - c.fadeIn / 1000 &&
        playhead < c.end + c.fadeOut / 1000,
    );
  }, [assDoc, playhead]);

  // Worker lifecycle. Re-create on mode flip so we don't leak workers when
  // the user spam-toggles between samples.
  useEffect(() => {
    if (mode !== "ass" || !assDoc) return;
    const worker = new Worker(
      new URL("../workers/ass.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as
        | { kind: "ready" }
        | { kind: "frame"; reqId: number; bitmap: ImageBitmap; renderMs: number };
      if (msg.kind === "frame") {
        setWorkerRenderMs(msg.renderMs);
        const canvas = previewCanvasRef.current;
        if (!canvas) {
          msg.bitmap.close();
          return;
        }
        const ctx = canvas.getContext("bitmaprenderer");
        if (ctx) {
          ctx.transferFromImageBitmap(msg.bitmap);
        } else {
          msg.bitmap.close();
        }
      }
    };

    worker.postMessage({ kind: "init", doc: assDoc });
    return () => {
      worker.postMessage({ kind: "dispose" });
      worker.terminate();
      workerRef.current = null;
    };
  }, [mode, assDoc]);

  // Keep refs synced so the rAF loop reads current values without restart.
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Render loop. Runs once for the page lifetime. Reads current playhead
  // and mode through refs so we don't churn rAF on every state update.
  useEffect(() => {
    const loop = (ts: number) => {
      const dt = (ts - lastFrameTsRef.current) / 1000;
      lastFrameTsRef.current = ts;
      if (playingRef.current) {
        setPlayhead((p) => {
          const next = p + dt;
          return next > 30 ? 0 : next;
        });
      }
      if (modeRef.current === "ass" && workerRef.current && previewCanvasRef.current) {
        const c = previewCanvasRef.current;
        const reqId = ++reqIdRef.current;
        workerRef.current.postMessage({
          kind: "render",
          t: playheadRef.current,
          width: c.width,
          height: c.height,
          reqId,
        });
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const onScrub = useCallback((v: number) => {
    setPlayhead(v);
    setPlaying(false);
  }, []);

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-21 · Subtitle Rendering</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            WebVTT cues render via DOM overlay; a minimal ASS subset renders
            via Canvas2D on an OffscreenCanvas inside a Worker. The playhead
            slider drives both. Production needs SubtitlesOctopus (libass)
            for full ASS support — we ship the minimum here.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="flex flex-wrap items-center gap-3 text-xs">
          <div className="flex overflow-hidden rounded border border-zinc-400">
            <button
              type="button"
              onClick={() => setMode("vtt")}
              className={`px-3 py-1 ${mode === "vtt" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : ""}`}
            >
              WebVTT
            </button>
            <button
              type="button"
              onClick={() => setMode("ass")}
              className={`px-3 py-1 ${mode === "ass" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : ""}`}
            >
              ASS (worker)
            </button>
          </div>
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className="rounded bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-black"
          >
            {playing ? "Pause" : "Play"}
          </button>
          <span className="text-zinc-500">t = {playhead.toFixed(2)} s</span>
          {mode === "ass" && workerRenderMs !== null && (
            <span className="text-zinc-500">
              worker render: {workerRenderMs.toFixed(2)} ms / frame
            </span>
          )}
        </section>

        <input
          type="range"
          min={0}
          max={30}
          step={0.05}
          value={playhead}
          onChange={(e) => onScrub(parseFloat(e.target.value))}
          className="block w-full"
        />

        <div className="relative aspect-video w-full overflow-hidden rounded border border-zinc-300 bg-zinc-900 dark:border-zinc-700">
          {/* Background fill so subtitles are legible. */}
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-900 via-zinc-900 to-emerald-900" />
          {mode === "ass" ? (
            <canvas
              ref={previewCanvasRef}
              width={1280}
              height={720}
              className="absolute inset-0 h-full w-full"
            />
          ) : (
            <VttOverlay cues={activeVtt} />
          )}
        </div>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">
              Active cues ({mode})
            </h2>
            {mode === "vtt" ? (
              activeVtt.length === 0 ? (
                <p className="text-zinc-500">none</p>
              ) : (
                activeVtt.map((c) => (
                  <div key={c.index} className="border-t border-zinc-700/30 py-1">
                    [{c.start.toFixed(2)} → {c.end.toFixed(2)}] {c.align}
                    {c.linePct !== null ? ` line:${c.linePct}%` : ""}
                    <div className="pl-3">{c.text}</div>
                  </div>
                ))
              )
            ) : activeAss.length === 0 ? (
              <p className="text-zinc-500">none</p>
            ) : (
              activeAss.map((c) => (
                <div key={c.index} className="border-t border-zinc-700/30 py-1">
                  [{c.start.toFixed(2)} → {c.end.toFixed(2)}] \an{c.alignment}{" "}
                  {c.fadeIn > 0 ? `fade(${c.fadeIn},${c.fadeOut})` : ""}
                  <div className="pl-3">{c.text}</div>
                </div>
              ))
            )}
          </div>

          <div className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">All cues</h2>
            <ul className="space-y-1">
              {(mode === "vtt"
                ? vttCues.map((c) => `${c.start.toFixed(2)}-${c.end.toFixed(2)} ${c.align} ${c.text.replace(/\n/g, " ⏎ ")}`)
                : (assDoc?.cues ?? []).map(
                    (c) =>
                      `${c.start.toFixed(2)}-${c.end.toFixed(2)} \\an${c.alignment} ${c.text.replace(/\n/g, " ⏎ ")}`,
                  )
              ).map((s, i) => (
                <li
                  key={i}
                  className="border-t border-zinc-700/30 pt-1 text-zinc-500"
                >
                  {s}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <footer className="text-xs text-zinc-500">
          The VTT path uses a DOM overlay (positioned divs). The ASS path
          posts {`{ playhead, w, h }`} to a worker each rAF and draws the
          resulting ImageBitmap into a bitmaprenderer canvas. Re-mount the
          ASS tab to verify the worker is terminated cleanly.
        </footer>
      </div>
    </main>
  );
}

function VttOverlay({ cues }: { cues: VttCue[] }) {
  return (
    <>
      {cues.map((c) => {
        const top = c.linePct !== null ? `${c.linePct}%` : "85%";
        const left =
          c.align === "start" ? "4%" : c.align === "end" ? undefined : "50%";
        const right = c.align === "end" ? "4%" : undefined;
        const transform =
          c.align === "center" ? "translate(-50%, -50%)" : "translateY(-50%)";
        const textAlign =
          c.align === "start" ? "left" : c.align === "end" ? "right" : "center";
        return (
          <div
            key={c.index}
            style={{ top, left, right, transform, textAlign }}
            className="absolute max-w-[70%] whitespace-pre-line text-2xl font-semibold leading-tight text-white drop-shadow-[0_2px_2px_rgba(0,0,0,0.95)]"
          >
            {c.text}
          </div>
        );
      })}
    </>
  );
}
