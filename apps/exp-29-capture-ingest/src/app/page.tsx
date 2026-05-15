"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  startPipeline,
  type PipelineHandle,
  type PipelineStats,
} from "../lib/encoder-pipeline";
import {
  deleteSession,
  listSessions,
  type SessionMeta,
} from "../lib/opfs-session";

type CardKind = "screen" | "camera";

const CODECS = [
  { id: "avc1.640028", label: "H.264 High @ L4 (avc1.640028)" },
  { id: "vp09.00.10.08", label: "VP9 Profile 0 (vp09.00.10.08)" },
] as const;

export default function Page() {
  const [error, setError] = useState<string | null>(null);
  const [recoverable, setRecoverable] = useState<SessionMeta[]>([]);
  const [featureOk, setFeatureOk] = useState<boolean | null>(null);

  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      "MediaStreamTrackProcessor" in window &&
      typeof VideoEncoder !== "undefined";
    setFeatureOk(ok);
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const sessions = await listSessions();
      setRecoverable(sessions.filter((s) => s.status === "recording"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  if (featureOk === false) {
    return (
      <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
        <div className="mx-auto max-w-3xl space-y-4">
          <h1 className="text-2xl font-bold">Exp-29 · Screen / Camera Capture Ingest</h1>
          <div className="rounded border border-amber-500 bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            MediaStreamTrackProcessor and/or VideoEncoder unavailable. This
            experiment requires Chromium 94+ (Chrome / Edge / Brave) on
            desktop.
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-29 · Screen / Camera Capture</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            getDisplayMedia / getUserMedia → MediaStreamTrackProcessor →
            VideoEncoder → OPFS. Raw H.264 bitstream + JSON chunk index.
            Crash-recoverable via <code>session.json</code>.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <CaptureCard kind="screen" onSessionChange={refreshSessions} />
          <CaptureCard kind="camera" onSessionChange={refreshSessions} />
        </section>

        <section className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-semibold">Recoverable sessions</span>
            <button
              type="button"
              onClick={() => void refreshSessions()}
              className="rounded border border-zinc-400 px-2 py-0.5 text-[10px]"
            >
              refresh
            </button>
          </div>
          {recoverable.length === 0 ? (
            <p className="text-xs text-zinc-500">
              No partial sessions in OPFS. (Sessions with{" "}
              <code>status: &quot;recording&quot;</code> indicate the tab
              crashed mid-record.)
            </p>
          ) : (
            <ul className="space-y-1 text-xs">
              {recoverable.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between rounded border border-zinc-200 p-2 dark:border-zinc-800"
                >
                  <div>
                    <div className="font-mono">{s.id}</div>
                    <div className="text-[10px] text-zinc-500">
                      {new Date(s.startedAt).toLocaleString()} · {s.codec} ·{" "}
                      {s.width}×{s.height}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        await deleteSession(s.id);
                        await refreshSessions();
                      }}
                      className="rounded border border-red-400 px-2 py-0.5 text-red-600 dark:text-red-400"
                    >
                      discard
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer className="text-xs text-zinc-500">
          Raw H.264 bitstreams are not playable in consumer players —
          production wraps with a mp4 muxer (see exp-10). No mp4-muxer
          dependency is added here; this experiment isolates the
          capture-write path.
        </footer>
      </div>
    </main>
  );
}

function CaptureCard({
  kind,
  onSessionChange,
}: {
  kind: CardKind;
  onSessionChange: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [stats, setStats] = useState<PipelineStats>({
    inputFps: 0,
    encodeQueueSize: 0,
    bitrateKbps: 0,
    bytesWritten: 0,
    droppedFrames: 0,
  });
  const [codec, setCodec] = useState<string>(CODECS[0]!.id);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pipelineRef = useRef<PipelineHandle | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const tickRef = useRef<number | null>(null);

  useEffect(() => {
    if (kind !== "camera") return;
    void (async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        setDevices(all.filter((d) => d.kind === "videoinput"));
      } catch {
        // permission may not be granted yet
      }
    })();
  }, [kind]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream =
        kind === "screen"
          ? await navigator.mediaDevices.getDisplayMedia({
              video: { width: { ideal: 3840 } },
              audio: true,
            })
          : await navigator.mediaDevices.getUserMedia({
              video: deviceId ? { deviceId: { exact: deviceId } } : true,
              audio: true,
            });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("no video track");
      const settings = videoTrack.getSettings();
      const pipeline = await startPipeline({
        track: videoTrack,
        source: kind,
        codec,
        width: settings.width ?? 1280,
        height: settings.height ?? 720,
        onError: (err) => setError(err.message),
      });
      pipelineRef.current = pipeline;
      setRecording(true);
      onSessionChange();
      tickRef.current = window.setInterval(() => {
        setStats(pipeline.getStats());
      }, 250);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [kind, codec, deviceId, onSessionChange]);

  const stop = useCallback(async () => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    const p = pipelineRef.current;
    pipelineRef.current = null;
    if (p) await p.stop();
    const s = streamRef.current;
    streamRef.current = null;
    if (s) {
      for (const t of s.getTracks()) t.stop();
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setRecording(false);
    onSessionChange();
  }, [onSessionChange]);

  useEffect(() => {
    return () => {
      void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold">
          {kind === "screen" ? "Screen capture" : "Camera capture"}
        </span>
        <span
          className={`rounded px-2 py-0.5 text-[10px] ${
            recording
              ? "bg-red-600 text-white"
              : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          }`}
        >
          {recording ? "REC" : "idle"}
        </span>
      </div>
      <video
        ref={videoRef}
        muted
        playsInline
        className="block aspect-video w-full rounded bg-black"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          <span className="text-zinc-500">codec:</span>
          <select
            value={codec}
            disabled={recording}
            onChange={(e) => setCodec(e.target.value)}
            className="border bg-transparent px-1"
          >
            {CODECS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        {kind === "camera" && devices.length > 0 && (
          <label className="flex items-center gap-1">
            <span className="text-zinc-500">device:</span>
            <select
              value={deviceId ?? ""}
              disabled={recording}
              onChange={(e) => setDeviceId(e.target.value || null)}
              className="border bg-transparent px-1"
            >
              <option value="">default</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || d.deviceId.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={recording ? () => void stop() : () => void start()}
          className="rounded bg-zinc-900 px-2 py-1 text-white dark:bg-zinc-100 dark:text-black"
        >
          {recording ? "Stop" : "Start"}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1 text-[10px]">
        <Stat label="input fps" v={stats.inputFps.toFixed(1)} />
        <Stat label="queue depth" v={`${stats.encodeQueueSize}`} />
        <Stat label="bitrate" v={`${stats.bitrateKbps.toFixed(0)} kbps`} />
        <Stat label="OPFS bytes" v={stats.bytesWritten.toLocaleString()} />
        <Stat label="dropped" v={`${stats.droppedFrames}`} />
      </div>
      {error && (
        <div className="mt-2 rounded border border-red-500 bg-red-50 p-2 text-[11px] text-red-700 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}
    </div>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return (
    <div className="rounded border border-zinc-200 p-1 dark:border-zinc-800">
      <div className="text-[9px] text-zinc-500">{label}</div>
      <div className="font-mono">{v}</div>
    </div>
  );
}
