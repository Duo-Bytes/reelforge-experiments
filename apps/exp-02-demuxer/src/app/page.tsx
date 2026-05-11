"use client";

import { useEffect, useRef, useState } from "react";
import type { DemuxResult, GopRange } from "../lib/types";

type GopReply = { gop: GopRange | null; queryMs: number };

type SideState = {
  result: DemuxResult | null;
  gop: GopReply | null;
  status: string;
  busy: boolean;
  error: string | null;
  isConfigSupported: "unknown" | "yes" | "no";
};

const initial: SideState = {
  result: null,
  gop: null,
  status: "idle",
  busy: false,
  error: null,
  isConfigSupported: "unknown",
};

function fmtBytes(n: number): string {
  if (n < 0) return "n/a";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtMs(n: number): string {
  return `${n.toFixed(2)} ms`;
}

function fmtUs(n: number): string {
  return `${(n / 1000).toFixed(2)} ms`;
}

export default function Page() {
  const mp4boxRef = useRef<Worker | null>(null);
  const mediabunnyRef = useRef<Worker | null>(null);

  const [mp4box, setMp4box] = useState<SideState>(initial);
  const [mb, setMb] = useState<SideState>(initial);
  const [seekMs, setSeekMs] = useState("1000");

  useEffect(() => {
    const mp4 = new Worker(
      new URL("../workers/mp4box.worker.ts", import.meta.url),
      { type: "module" },
    );
    const med = new Worker(
      new URL("../workers/mediabunny.worker.ts", import.meta.url),
      { type: "module" },
    );

    mp4.onmessage = (e: MessageEvent) => handleMsg(e.data, setMp4box);
    med.onmessage = (e: MessageEvent) => handleMsg(e.data, setMb);

    mp4boxRef.current = mp4;
    mediabunnyRef.current = med;

    return () => {
      mp4.terminate();
      med.terminate();
    };
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setMp4box({ ...initial, busy: true, status: "demuxing..." });
    setMb({ ...initial, busy: true, status: "demuxing..." });
    mp4boxRef.current?.postMessage({ type: "DEMUX", file });
    mediabunnyRef.current?.postMessage({ type: "DEMUX", file });
  };

  // Verify codec support whenever a result lands.
  useEffect(() => {
    void verifyCodec(mp4box.result, setMp4box);
  }, [mp4box.result]);
  useEffect(() => {
    void verifyCodec(mb.result, setMb);
  }, [mb.result]);

  const onSeek = () => {
    const us = Math.max(0, Number(seekMs) * 1000);
    const reqId = crypto.randomUUID();
    if (mp4box.result) {
      setMp4box((s) => ({ ...s, gop: null, status: "querying GOP..." }));
      mp4boxRef.current?.postMessage({ type: "GOP", reqId, targetUs: us });
    }
    if (mb.result) {
      setMb((s) => ({ ...s, gop: null, status: "querying GOP..." }));
      mediabunnyRef.current?.postMessage({ type: "GOP", reqId, targetUs: us });
    }
  };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-02 · MP4 Demuxer</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Demux an MP4 with both mp4box.js and mediabunny in parallel
            workers; build a sample-level seek index; query GOP ranges by
            timestamp.
          </p>
          <p className="text-xs text-zinc-500">
            Targets: 1GB parse &lt; 5s · GOP query &lt; 1ms · codec accepted by
            VideoDecoder.isConfigSupported.
          </p>
        </header>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <label className="mb-2 block text-sm font-semibold">
            Pick an MP4
          </label>
          <input
            type="file"
            accept="video/mp4,video/quicktime,video/*"
            onChange={onFileChange}
            disabled={mp4box.busy || mb.busy}
            className="block w-full text-sm"
          />
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Panel title="mp4box.js" state={mp4box} />
          <Panel title="mediabunny" state={mb} />
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">GOP query</h2>
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              seek to ms
              <input
                value={seekMs}
                onChange={(e) => setSeekMs(e.target.value)}
                className="w-32 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <button
              type="button"
              onClick={onSeek}
              disabled={!mp4box.result && !mb.result}
              className="rounded bg-zinc-900 px-3 py-1 text-xs text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
            >
              query GOP
            </button>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <GopBlock title="mp4box.js" gop={mp4box.gop} />
            <GopBlock title="mediabunny" gop={mb.gop} />
          </div>
        </section>

        <footer className="text-xs text-zinc-500">
          mediabunny does not expose source byte offsets per packet — see the
          comment block at the top of <code>mediabunny.worker.ts</code>.
        </footer>
      </div>
    </main>
  );
}

function handleMsg(
  data: { type: string; result?: DemuxResult; gop?: GopRange | null; queryMs?: number; message?: string },
  setState: (updater: (s: SideState) => SideState) => void,
): void {
  if (data.type === "DEMUX_RESULT" && data.result) {
    setState(() => ({
      result: data.result!,
      gop: null,
      status: `parsed in ${data.result!.parseMs.toFixed(0)} ms`,
      busy: false,
      error: null,
      isConfigSupported: "unknown",
    }));
  } else if (data.type === "GOP_RESULT") {
    setState((s) => ({
      ...s,
      gop: { gop: data.gop ?? null, queryMs: data.queryMs ?? 0 },
      status: "ready",
    }));
  } else if (data.type === "ERROR") {
    setState((s) => ({ ...s, error: data.message ?? "error", busy: false }));
  }
}

async function verifyCodec(
  result: DemuxResult | null,
  setState: (updater: (s: SideState) => SideState) => void,
): Promise<void> {
  if (!result) return;
  if (typeof VideoDecoder === "undefined") {
    setState((s) => ({ ...s, isConfigSupported: "no" }));
    return;
  }
  try {
    const support = await VideoDecoder.isConfigSupported({
      codec: result.config.codec,
      description: result.config.description,
      codedWidth: result.config.width,
      codedHeight: result.config.height,
    });
    setState((s) => ({
      ...s,
      isConfigSupported: support.supported ? "yes" : "no",
    }));
  } catch {
    setState((s) => ({ ...s, isConfigSupported: "no" }));
  }
}

function Panel({ title, state }: { title: string; state: SideState }) {
  const r = state.result;
  return (
    <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-xs text-zinc-500">{state.status}</span>
      </div>
      {state.error && (
        <div className="mb-2 rounded border border-red-500 bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">
          {state.error}
        </div>
      )}
      {r && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <dt className="text-zinc-500">codec</dt>
          <dd className="font-mono">{r.config.codec}</dd>
          <dt className="text-zinc-500">VideoDecoder.isConfigSupported</dt>
          <dd
            className={
              state.isConfigSupported === "yes"
                ? "text-emerald-600 dark:text-emerald-400"
                : state.isConfigSupported === "no"
                  ? "text-red-600 dark:text-red-400"
                  : ""
            }
          >
            {state.isConfigSupported}
          </dd>
          <dt className="text-zinc-500">resolution</dt>
          <dd>
            {r.config.width}×{r.config.height}
          </dd>
          <dt className="text-zinc-500">fps (avg)</dt>
          <dd>{r.config.fps.toFixed(2)}</dd>
          <dt className="text-zinc-500">duration</dt>
          <dd>{fmtUs(r.durationUs)}</dd>
          <dt className="text-zinc-500">samples</dt>
          <dd>{r.samplesByPts.length}</dd>
          <dt className="text-zinc-500">keyframes</dt>
          <dd>{r.samplesByPts.filter((s) => s.isKeyframe).length}</dd>
          <dt className="text-zinc-500">parse</dt>
          <dd className="font-bold">{fmtMs(r.parseMs)}</dd>
          <dt className="text-zinc-500">desc bytes</dt>
          <dd>{fmtBytes(r.config.description.byteLength)}</dd>
        </dl>
      )}
    </div>
  );
}

function GopBlock({
  title,
  gop,
}: {
  title: string;
  gop: GopReply | null;
}) {
  return (
    <div className="rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
      <div className="mb-1 text-zinc-500">{title}</div>
      {!gop && <div className="text-zinc-500">no query</div>}
      {gop && !gop.gop && <div>no result for that timestamp</div>}
      {gop?.gop && (
        <dl className="grid grid-cols-2 gap-x-2 gap-y-1">
          <dt className="text-zinc-500">query</dt>
          <dd className="font-bold">{fmtMs(gop.queryMs)}</dd>
          <dt className="text-zinc-500">samples</dt>
          <dd>
            {gop.gop.startIdx}..{gop.gop.endIdx}
          </dd>
          <dt className="text-zinc-500">frame count</dt>
          <dd>{gop.gop.frameCount}</dd>
          <dt className="text-zinc-500">byte range</dt>
          <dd>
            {gop.gop.byteStart >= 0
              ? `${gop.gop.byteStart} → ${gop.gop.byteEnd}`
              : "n/a (no offsets)"}
          </dd>
        </dl>
      )}
    </div>
  );
}
