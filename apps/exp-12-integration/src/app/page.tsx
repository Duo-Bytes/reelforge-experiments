"use client";

import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEditor, getEditor, clipAtTime, timelineToAssetUs, type AssetId } from "../store/timeline";
import { createRingBuffer } from "../lib/ringBuffer";

type WorkerStatus = "idle" | "starting" | "ready" | "error";

export default function Editor() {
  const renderRef = useRef<Worker | null>(null);
  const audioRef = useRef<Worker | null>(null);
  const proxyRef = useRef<Worker | null>(null);
  const aiRef = useRef<Worker | null>(null);
  const initRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const playingRef = useRef(false);
  const playheadUsRef = useRef(0);
  const sabRef = useRef<SharedArrayBuffer | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioNodeRef = useRef<AudioWorkletNode | null>(null);
  const lastRenderedKeyRef = useRef<string | null>(null);
  // Files cannot live in the Zustand store (non-serializable, can be huge).
  // Keep a parallel Map keyed by assetId so workers added after import (audio,
  // export, AI) can still recover the original File without re-prompting.
  const filesRef = useRef<Map<AssetId, File>>(new Map());

  const [renderStatus, setRenderStatus] = useState<WorkerStatus>("idle");
  const [audioStatus, setAudioStatus] = useState<WorkerStatus>("idle");
  const [proxyStatus, setProxyStatus] = useState<WorkerStatus>("idle");
  const [aiStatus, setAiStatus] = useState<WorkerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [crossOriginIso, setCrossOriginIso] = useState(false);
  const [progress, setProgress] = useState<{
    label: string;
    percent: number;
  } | null>(null);
  const [renderInfo, setRenderInfo] = useState<{
    tier: string;
    totalMs: number;
    vramSize: number;
    ramSize: number;
  } | null>(null);

  const tracks = useEditor(useShallow((s) => s.tracks));
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const zoom = useEditor((s) => s.zoom);
  const setZoom = useEditor((s) => s.setZoom);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const selectClip = useEditor((s) => s.selectClip);
  const toggleBgRemoval = useEditor((s) => s.toggleBgRemoval);
  const moveClip = useEditor((s) => s.moveClip);
  const reset = useEditor((s) => s.reset);

  // Timeline width
  const totalWidth = useEditor(
    useShallow((s) => {
      let max = 0;
      for (const id in s.clips) {
        const c = s.clips[id];
        if (c.startUs + c.durationUs > max) max = c.startUs + c.durationUs;
      }
      return Math.max(2000, (max / 1_000_000) * s.zoom + 400);
    }),
  );

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    setCrossOriginIso(window.crossOriginIsolated);
    const files = filesRef.current;

    // Render worker — owns OffscreenCanvas
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    const offscreen = canvas.transferControlToOffscreen();

    const renderWorker = new Worker(
      new URL("../workers/render.worker.ts", import.meta.url),
      { type: "module" },
    );
    renderWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "READY") setRenderStatus("ready");
      else if (m.type === "ASSET_LOADED") {
        getEditor().updateAsset(m.assetId, {
          width: m.config.width,
          height: m.config.height,
          fps: m.config.fps,
          durationUs: m.durationUs,
        });
        // Add the clip to the first empty video track once metadata lands.
        const ed = getEditor();
        const t = ed.tracks.find((tr) => tr.type === "video");
        if (t) {
          const trackEnd = t.clipIds.length
            ? (() => {
                const last = ed.clips[t.clipIds[t.clipIds.length - 1]];
                return last.startUs + last.durationUs;
              })()
            : 0;
          ed.addClip({
            id: `clip-${m.assetId}`,
            trackId: t.id,
            assetId: m.assetId,
            startUs: trackEnd,
            inUs: 0,
            durationUs: m.durationUs,
            bgRemoval: false,
            label: ed.assets[m.assetId]?.name ?? "Clip",
          });
        }
      } else if (m.type === "RENDERED") {
        setRenderInfo({
          tier: m.tier,
          totalMs: m.totalMs,
          vramSize: m.vramSize,
          ramSize: m.ramSize,
        });
      } else if (m.type === "ERROR") {
        setError(`render: ${m.message}`);
        setRenderStatus("error");
      }
    };
    renderWorker.postMessage({ type: "INIT", canvas: offscreen }, [offscreen]);
    setRenderStatus("starting");
    renderRef.current = renderWorker;

    // Audio worker (started later on user gesture)
    const audioWorker = new Worker(
      new URL("../workers/audio.worker.ts", import.meta.url),
      { type: "module" },
    );
    audioWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "INFO") setAudioStatus("ready");
      else if (m.type === "ERROR") {
        setError(`audio: ${m.message}`);
        setAudioStatus("error");
      }
    };
    audioRef.current = audioWorker;

    // Proxy worker
    const proxyWorker = new Worker(
      new URL("../workers/proxy.worker.ts", import.meta.url),
      { type: "module" },
    );
    proxyWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "INGESTED") {
        setProxyStatus("starting");
        // Trigger transcode for the source.
        proxyWorker.postMessage({ type: "TRANSCODE", fileId: m.fileId });
      } else if (m.type === "PROGRESS") {
        setProgress({
          label: `proxy ${m.encoded}/${m.total}`,
          percent: m.percent,
        });
      } else if (m.type === "DONE") {
        setProgress(null);
        setProxyStatus("ready");
        getEditor().updateAsset(m.fileId, { proxyFileId: m.meta.proxyFileId });
      } else if (m.type === "ERROR") {
        setError(`proxy: ${m.message}`);
        setProxyStatus("error");
      }
    };
    proxyRef.current = proxyWorker;

    // AI worker (idle until user enables a clip's bg removal)
    const aiWorker = new Worker(
      new URL("../workers/ai.worker.ts", import.meta.url),
      { type: "module" },
    );
    aiWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "READY") setAiStatus("ready");
      else if (m.type === "ERROR") {
        setError(`ai: ${m.message}`);
        setAiStatus("error");
      }
    };
    aiRef.current = aiWorker;

    return () => {
      renderWorker.terminate();
      audioWorker.terminate();
      proxyWorker.terminate();
      aiWorker.terminate();
      renderRef.current = null;
      audioRef.current = null;
      proxyRef.current = null;
      aiRef.current = null;
      files.clear();
      initRef.current = false;
    };
  }, []);

  // Master playback clock — drives both render and playhead.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = now - last;
      last = now;

      if (playingRef.current) {
        // Anchor to audio clock if AudioContext is running, else wall-clock.
        if (audioCtxRef.current) {
          const ctx = audioCtxRef.current;
          playheadUsRef.current =
            (ctx.currentTime - ctx.outputLatency) * 1_000_000;
        } else {
          playheadUsRef.current += dt * 1000;
        }
      }

      const ts = playheadUsRef.current;
      const c = clipAtTime(ts, "video");
      if (c) {
        const a = getEditor().assets[c.assetId];
        if (a) {
          const assetUs = timelineToAssetUs(c, ts);
          // Snap to nearest fps boundary to dedup render requests.
          const stepUs = a.fps > 0 ? Math.round(1_000_000 / a.fps) : 33333;
          const snap = Math.max(
            0,
            Math.min(a.durationUs - 1, Math.round(assetUs / stepUs) * stepUs),
          );
          const key = `${a.id}:${snap}`;
          if (key !== lastRenderedKeyRef.current) {
            lastRenderedKeyRef.current = key;
            renderRef.current?.postMessage({
              type: "SEEK",
              assetId: a.id,
              targetUs: snap,
            });
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    const fileId = crypto.randomUUID();
    filesRef.current.set(fileId, file);
    getEditor().addAsset({
      id: fileId,
      name: file.name,
      sourceFileId: fileId,
      proxyFileId: null,
      width: 0,
      height: 0,
      durationUs: 0,
      fps: 0,
      hasAudio: true,
    });
    // Render worker = preview decode.
    renderRef.current?.postMessage({ type: "LOAD", assetId: fileId, file });
    // Proxy worker = background ingest + transcode.
    proxyRef.current?.postMessage({ type: "INGEST", file, fileId });
    setProxyStatus("starting");
  };

  const clearAll = () => {
    audioRef.current?.postMessage({ type: "STOP" });
    filesRef.current.clear();
    reset();
  };

  const startAudio = async () => {
    const ed = getEditor();
    const firstAsset = Object.values(ed.assets)[0];
    if (!firstAsset) {
      setError("import a clip before starting audio");
      return;
    }
    const file = filesRef.current.get(firstAsset.id);
    if (!file) {
      setError(`no cached File for asset ${firstAsset.id}; re-import`);
      return;
    }
    const sab = createRingBuffer();
    sabRef.current = sab;
    const ctx = new AudioContext({ latencyHint: "interactive" });
    if (ctx.state === "suspended") await ctx.resume();
    await ctx.audioWorklet.addModule("/audio-worklet-processor.js");
    const node = new AudioWorkletNode(ctx, "ring-buffer-processor", {
      processorOptions: { sab },
      outputChannelCount: [2],
    });
    node.connect(ctx.destination);
    audioCtxRef.current = ctx;
    audioNodeRef.current = node;
    setAudioStatus("starting");
    audioRef.current?.postMessage({
      type: "START",
      file,
      sab,
      startUs: playheadUsRef.current,
    });
  };

  const togglePlay = () => {
    playingRef.current = !playingRef.current;
    setPlaying(playingRef.current);
  };
  const [playing, setPlaying] = useState(false);

  const seekTo = (us: number) => {
    playheadUsRef.current = us;
  };

  const loadAiModel = () => {
    setAiStatus("starting");
    aiRef.current?.postMessage({
      type: "LOAD_URL",
      url: "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx",
    });
  };

  const selectedClip = selectedClipId ? clips[selectedClipId] : null;

  return (
    <main className="min-h-screen bg-black p-4 font-mono text-zinc-100">
      <div className="grid grid-cols-12 gap-3">
        <header className="col-span-12 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Exp-12 · Integration</h1>
            <p className="text-xs text-zinc-400">
              5-worker NLE skeleton: render + decode (sub) + audio + proxy +
              ai.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <input
              type="file"
              accept="video/*"
              onChange={onImport}
              className="text-xs"
            />
            <button
              type="button"
              onClick={togglePlay}
              className="rounded bg-zinc-100 px-3 py-1 text-black"
            >
              {playing ? "pause" : "play"}
            </button>
            <button
              type="button"
              onClick={() => seekTo(0)}
              className="rounded border border-zinc-600 px-2 py-1"
            >
              rewind
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="rounded border border-zinc-600 px-2 py-1"
            >
              clear
            </button>
          </div>
        </header>

        <aside className="col-span-3 space-y-3 rounded border border-zinc-700 p-3 text-xs">
          <h2 className="text-sm font-semibold">Workers</h2>
          <Status label="render" status={renderStatus} />
          <Status label="audio" status={audioStatus} />
          <Status label="proxy" status={proxyStatus} />
          <Status label="ai" status={aiStatus} />
          <div>
            crossOriginIsolated:{" "}
            <span className={crossOriginIso ? "text-emerald-400" : "text-red-400"}>
              {String(crossOriginIso)}
            </span>
          </div>

          <div className="border-t border-zinc-700 pt-2">
            <button
              type="button"
              onClick={startAudio}
              disabled={audioStatus !== "idle"}
              className="rounded border border-zinc-600 px-2 py-1 disabled:opacity-40"
            >
              start AudioContext
            </button>
          </div>
          <div>
            <button
              type="button"
              onClick={loadAiModel}
              disabled={aiStatus !== "idle"}
              className="rounded border border-zinc-600 px-2 py-1 disabled:opacity-40"
            >
              load AI model (RMBG-1.4)
            </button>
          </div>

          <div className="border-t border-zinc-700 pt-2">
            <h3 className="font-semibold">Assets</h3>
            {Object.values(assets).length === 0 && (
              <div className="text-zinc-500">none yet</div>
            )}
            {Object.values(assets).map((a) => (
              <div key={a.id} className="mt-1 text-zinc-400">
                <div className="truncate">{a.name}</div>
                <div className="text-zinc-600">
                  {a.width}×{a.height} ·{" "}
                  {(a.durationUs / 1000).toFixed(0)}ms · proxy{" "}
                  {a.proxyFileId ? "✓" : "…"}
                </div>
              </div>
            ))}
          </div>
        </aside>

        <section className="col-span-6 rounded border border-zinc-700 bg-zinc-950 p-2">
          <canvas
            ref={canvasRef}
            className="aspect-video w-full bg-zinc-900"
          />
          <div className="mt-2 text-xs text-zinc-400">
            {renderInfo ? (
              <>
                tier{" "}
                <span
                  className={
                    renderInfo.tier === "vram"
                      ? "text-emerald-400"
                      : renderInfo.tier === "ram"
                        ? "text-amber-400"
                        : "text-red-400"
                  }
                >
                  {renderInfo.tier}
                </span>{" "}
                · {renderInfo.totalMs.toFixed(2)}ms · vram{" "}
                {renderInfo.vramSize} / ram {renderInfo.ramSize}
              </>
            ) : (
              "no render yet"
            )}
          </div>
          {progress && (
            <div className="mt-2">
              <progress value={progress.percent} max={100} className="w-full" />
              <div className="text-xs text-zinc-500">
                {progress.label} · {progress.percent.toFixed(1)}%
              </div>
            </div>
          )}
          {error && (
            <div className="mt-2 rounded border border-red-500 p-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </section>

        <aside className="col-span-3 space-y-3 rounded border border-zinc-700 p-3 text-xs">
          <h2 className="text-sm font-semibold">Properties</h2>
          {selectedClip ? (
            <div className="space-y-2">
              <div>
                <span className="text-zinc-500">id</span>{" "}
                <span className="font-mono">{selectedClip.id}</span>
              </div>
              <div>
                <span className="text-zinc-500">label</span>{" "}
                {selectedClip.label}
              </div>
              <div>
                <span className="text-zinc-500">start</span>{" "}
                {(selectedClip.startUs / 1000).toFixed(0)}ms
              </div>
              <div>
                <span className="text-zinc-500">duration</span>{" "}
                {(selectedClip.durationUs / 1000).toFixed(0)}ms
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedClip.bgRemoval}
                  onChange={() => toggleBgRemoval(selectedClip.id)}
                  disabled={aiStatus !== "ready"}
                />
                Background removal
                {aiStatus !== "ready" && (
                  <span className="text-zinc-500">(load AI model first)</span>
                )}
              </label>
            </div>
          ) : (
            <div className="text-zinc-500">no clip selected</div>
          )}
        </aside>

        <section className="col-span-12 rounded border border-zinc-700 bg-zinc-950">
          <div className="flex items-center gap-3 border-b border-zinc-800 p-2 text-xs">
            <span>zoom</span>
            <input
              type="range"
              min={20}
              max={400}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="w-32"
            />
            <span className="w-16">{zoom} px/s</span>
          </div>
          <div className="overflow-auto">
            <div style={{ width: totalWidth }} className="relative">
              {tracks.map((t) => (
                <TrackRow
                  key={t.id}
                  trackId={t.id}
                  trackLabel={t.label}
                  trackType={t.type}
                  zoom={zoom}
                  selectedClipId={selectedClipId}
                  onSelect={selectClip}
                  onMove={moveClip}
                />
              ))}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function Status({
  label,
  status,
}: {
  label: string;
  status: WorkerStatus;
}) {
  const color =
    status === "ready"
      ? "text-emerald-400"
      : status === "starting"
        ? "text-amber-400"
        : status === "error"
          ? "text-red-400"
          : "text-zinc-500";
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-400">{label}</span>
      <span className={color}>{status}</span>
    </div>
  );
}

function TrackRow({
  trackId,
  trackLabel,
  trackType,
  zoom,
  selectedClipId,
  onSelect,
  onMove,
}: {
  trackId: string;
  trackLabel: string;
  trackType: "video" | "audio";
  zoom: number;
  selectedClipId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, newStartUs: number) => void;
}) {
  const clipIds = useEditor(
    useShallow((s) => s.tracks.find((t) => t.id === trackId)?.clipIds ?? []),
  );
  return (
    <div
      className={`relative h-16 border-b border-zinc-800 ${trackType === "audio" ? "bg-zinc-900/40" : "bg-zinc-950"}`}
      onPointerDown={() => onSelect(null)}
    >
      <div className="sticky left-0 z-10 inline-block bg-zinc-900 px-2 py-1 text-[10px] text-zinc-400">
        {trackLabel}
      </div>
      <div className="absolute inset-0">
        {clipIds.map((id) => (
          <ClipBox
            key={id}
            clipId={id}
            zoom={zoom}
            isSelected={id === selectedClipId}
            onSelect={onSelect}
            onMove={onMove}
          />
        ))}
      </div>
    </div>
  );
}

function ClipBox({
  clipId,
  zoom,
  isSelected,
  onSelect,
  onMove,
}: {
  clipId: string;
  zoom: number;
  isSelected: boolean;
  onSelect: (id: string | null) => void;
  onMove: (id: string, us: number) => void;
}) {
  const c = useEditor((s) => s.clips[clipId]);
  const ref = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startLeft: number; pid: number } | null>(null);
  if (!c) return null;
  const widthPx = (c.durationUs / 1_000_000) * zoom;
  const leftPx = (c.startUs / 1_000_000) * zoom;

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect(clipId);
    if (!ref.current) return;
    ref.current.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startLeft: leftPx,
      pid: e.pointerId,
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pid !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    if (ref.current) ref.current.style.transform = `translateX(${dx}px)`;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pid !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const newLeftPx = Math.max(0, drag.startLeft + dx);
    if (ref.current) {
      ref.current.releasePointerCapture(e.pointerId);
      ref.current.style.transform = "translateX(0)";
    }
    dragRef.current = null;
    onMove(clipId, (newLeftPx / zoom) * 1_000_000);
  };
  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        left: leftPx,
        top: 6,
        width: Math.max(2, widthPx),
        backgroundColor: "#3b82f6",
        outline: isSelected
          ? "2px solid #fff"
          : "1px solid rgba(255,255,255,0.2)",
      }}
      className="absolute h-12 cursor-grab touch-none rounded text-white shadow-sm select-none active:cursor-grabbing"
    >
      <span className="block truncate px-1 text-[10px] leading-[1.6]">
        {c.label}
        {c.bgRemoval ? " · bg" : ""}
      </span>
    </div>
  );
}
