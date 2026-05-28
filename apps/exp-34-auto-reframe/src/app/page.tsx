"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { saliencyHeuristic, smoothFocusPath, type FocusSample } from "../lib/reframe";

type Aspect = { id: string; w: number; h: number; label: string };
const ASPECTS: Aspect[] = [
  { id: "9:16", w: 9, h: 16, label: "9:16 (Reels / Shorts)" },
  { id: "1:1", w: 1, h: 1, label: "1:1 (Square)" },
  { id: "4:5", w: 4, h: 5, label: "4:5 (IG portrait)" },
];

export default function Page() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sourceRef = useRef<HTMLCanvasElement | null>(null);
  const detectRef = useRef<HTMLCanvasElement | null>(null);
  const outRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const pathRef = useRef<FocusSample[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const modelReadyRef = useRef(false);
  const inFlightRef = useRef(false);
  const lastDetectRef = useRef(0);
  const detIdRef = useRef(0);
  const [aspect, setAspect] = useState<Aspect>(ASPECTS[0]);
  const [fileName, setFileName] = useState("");
  const [fps, setFps] = useState(0);
  const [modelPct, setModelPct] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [focusLabel, setFocusLabel] = useState<string>("—");
  const [error, setError] = useState<string | null>(null);

  // Detector worker — loads YOLOS-tiny, returns normalised subject boxes.
  useEffect(() => {
    const w = new Worker(
      new URL("../workers/detect.worker.ts", import.meta.url),
      { type: "module" },
    );
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "LOAD") {
        setModelPct(m.done);
      } else if (m.type === "READY") {
        modelReadyRef.current = true;
        setModelReady(true);
        setModelPct(100);
      } else if (m.type === "FOCUS") {
        const v = videoRef.current;
        if (v) {
          const sw = v.videoWidth;
          const sh = v.videoHeight;
          pathRef.current.push({
            t: v.currentTime,
            x: m.cx * sw,
            y: m.cy * sh,
            w: m.w * sw,
            h: m.h * sh,
          });
          if (pathRef.current.length > 600) pathRef.current.shift();
          setFocusLabel(`${m.label} ${(m.score * 100).toFixed(0)}%`);
        }
        inFlightRef.current = false;
      } else if (m.type === "NOFOCUS" || m.type === "BUSY") {
        inFlightRef.current = false;
      } else if (m.type === "ERROR") {
        setError(`detector: ${m.message}`);
        inFlightRef.current = false;
      }
    };
    workerRef.current = w;
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  const handleFile = useCallback((file: File) => {
    setError(null);
    setFileName(file.name);
    pathRef.current = [];
    const v = videoRef.current;
    if (!v) return;
    v.src = URL.createObjectURL(file);
    v.play().catch(() => {/* user-gesture autoplay block; ignore */});
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let last = performance.now();
    let frames = 0;

    const tick = () => {
      const src = sourceRef.current;
      const out = outRef.current;
      if (!src || !out || v.readyState < 2) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const sw = v.videoWidth;
      const sh = v.videoHeight;
      if (src.width !== sw) { src.width = sw; src.height = sh; }

      const sctx = src.getContext("2d", { willReadFrequently: true });
      if (!sctx) return;
      sctx.drawImage(v, 0, 0, sw, sh);

      const now = performance.now();

      if (modelReadyRef.current) {
        // Sample a downscaled frame for the detector ~every 150 ms; drop
        // samples while one inference is still in flight.
        if (now - lastDetectRef.current > 150 && !inFlightRef.current) {
          lastDetectRef.current = now;
          const dc = detectRef.current;
          if (dc) {
            const dw = 256;
            const dh = Math.max(1, Math.round((256 * sh) / sw));
            if (dc.width !== dw) { dc.width = dw; dc.height = dh; }
            const dctx = dc.getContext("2d", { willReadFrequently: true });
            if (dctx) {
              dctx.drawImage(v, 0, 0, dw, dh);
              const img = dctx.getImageData(0, 0, dw, dh);
              const copy = new Uint8ClampedArray(img.data);
              inFlightRef.current = true;
              workerRef.current?.postMessage(
                { type: "DETECT", id: ++detIdRef.current, width: dw, height: dh, data: copy },
                [copy.buffer],
              );
            }
          }
        }
      } else if (frames % 3 === 0) {
        // Pre-model fallback: brightness center-of-mass.
        const focus = saliencyHeuristic(sctx, sw, sh);
        pathRef.current.push({ t: v.currentTime, x: focus.x, y: focus.y, w: focus.w, h: focus.h });
        if (pathRef.current.length > 600) pathRef.current.shift();
      }

      // Smoothed path → current focus rect.
      const smoothed = smoothFocusPath(pathRef.current, v.currentTime);
      const targetAspect = aspect.w / aspect.h;
      let cropW = Math.min(sw, smoothed.w * 1.2);
      let cropH = cropW / targetAspect;
      // Keep the crop inside the source on the tall axis too.
      if (cropH > sh) { cropH = sh; cropW = cropH * targetAspect; }
      if (cropW > sw) { cropW = sw; cropH = cropW / targetAspect; }
      let cropX = smoothed.x - cropW / 2;
      let cropY = smoothed.y - cropH / 2;
      cropX = Math.max(0, Math.min(sw - cropW, cropX));
      cropY = Math.max(0, Math.min(sh - cropH, cropY));

      const ow = 360;
      const oh = (ow * aspect.h) / aspect.w;
      if (out.width !== ow) { out.width = ow; out.height = oh; }
      const octx = out.getContext("2d");
      if (octx) {
        // Blurred letterbox fill — CapCut-style.
        octx.filter = "blur(24px) brightness(0.6)";
        octx.drawImage(v, 0, 0, sw, sh, 0, 0, ow, oh);
        octx.filter = "none";
        octx.drawImage(v, cropX, cropY, cropW, cropH, 0, 0, ow, oh);
        // focus marker
        octx.strokeStyle = "rgba(16,185,129,0.8)";
        octx.strokeRect(2, 2, ow - 4, oh - 4);
      }

      frames++;
      if (now - last >= 1000) {
        setFps(frames);
        frames = 0;
        last = now;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [aspect]);

  useEffect(() => {
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) handleFile(f);
    };
    const dragover = (e: DragEvent) => e.preventDefault();
    window.addEventListener("drop", drop);
    window.addEventListener("dragover", dragover);
    return () => {
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragover", dragover);
    };
  }, [handleFile]);

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-34 · Saliency-Driven Auto-Reframe</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Real on-device subject tracking: YOLOS-tiny object detection
            (Transformers.js, WebGPU EP) samples a 256 px downscale every
            ~150 ms; the focus path is Catmull-Rom-smoothed and cropped to the
            target aspect. A brightness heuristic drives the preview until the
            model loads. <strong>Never uploads media.</strong>
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <Stat label="file" v={fileName || "—"} />
          <Stat label="preview fps" v={String(fps)} good={fps >= 30} />
          <Stat
            label="detector"
            v={modelReady ? "ready" : `loading ${modelPct}%`}
            good={modelReady}
          />
          <Stat label="subject" v={focusLabel} />
          <Stat label="target" v={aspect.id} />
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
            <label className="rounded border border-zinc-400 px-2 py-1 cursor-pointer">
              choose video…
              <input
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
            </label>
            <span className="text-zinc-500">or drop a file</span>
            <div className="ml-auto flex gap-1">
              {ASPECTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAspect(a)}
                  className={`rounded border px-2 py-0.5 ${
                    aspect.id === a.id
                      ? "border-emerald-500 bg-emerald-500/20"
                      : "border-zinc-400"
                  }`}
                >
                  {a.id}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded bg-zinc-100 p-2 dark:bg-zinc-900">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">source</div>
              <video ref={videoRef} className="block w-full" muted loop playsInline controls />
              <canvas ref={sourceRef} className="hidden" />
              <canvas ref={detectRef} className="hidden" />
            </div>
            <div className="rounded bg-zinc-100 p-2 dark:bg-zinc-900">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
                reframe → {aspect.label}
              </div>
              <canvas ref={outRef} className="block w-full" />
            </div>
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Next steps</h2>
          <ul className="ml-5 list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
            <li>Apply the crop in the exp-04 WGSL compositor with bicubic resample.</li>
            <li>Add a jerk-limit on the focus path on top of the current smoothing.</li>
            <li>Manual override: drag the crop overlay to lock the auto-track.</li>
            <li>Swap YOLOS-tiny for a distilled face/saliency model to cut latency further.</li>
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
