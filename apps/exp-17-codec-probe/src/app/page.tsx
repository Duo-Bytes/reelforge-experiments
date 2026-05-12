"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CODECS,
  HW_PREFS,
  RESOLUTIONS,
  computeProfile,
  probeAdapterInfo,
  probeRow,
  type CapabilityProfile,
  type ProbeResult,
} from "../lib/matrix";

type AdapterInfo = {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
} | null;

export default function Page() {
  const [results, setResults] = useState<ProbeResult[] | null>(null);
  const [adapter, setAdapter] = useState<AdapterInfo>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [filterFamily, setFilterFamily] = useState<string>("all");
  const [filterRes, setFilterRes] = useState<string>("all");

  useEffect(() => {
    void runProbe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runProbe = async () => {
    setRunning(true);
    setError(null);
    setResults(null);
    try {
      if (typeof VideoDecoder === "undefined") {
        throw new Error("VideoDecoder unavailable — use Chrome 94+");
      }
      const info = await probeAdapterInfo();
      setAdapter(info);
      const tasks: { codec: typeof CODECS[number]; res: typeof RESOLUTIONS[number]; hw: typeof HW_PREFS[number] }[] = [];
      for (const codec of CODECS) {
        for (const res of RESOLUTIONS) {
          for (const hw of HW_PREFS) {
            tasks.push({ codec, res, hw });
          }
        }
      }
      setProgress({ done: 0, total: tasks.length });
      const out: ProbeResult[] = [];
      // Run probes serially. isConfigSupported can hit the GPU process and
      // parallelism doesn't help; serial gives stable timings.
      for (const t of tasks) {
        const r = await probeRow(t.codec, t.res, t.hw);
        out.push(r);
        setProgress((p) => ({ done: p.done + 1, total: p.total }));
      }
      setResults(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const profile: CapabilityProfile | null = useMemo(
    () => (results ? computeProfile(results) : null),
    [results],
  );

  const filtered = useMemo(() => {
    if (!results) return [];
    return results.filter((r) => {
      if (filterFamily !== "all" && r.family !== filterFamily) return false;
      if (filterRes !== "all") {
        const want = RESOLUTIONS.find((x) => x.label === filterRes);
        if (!want) return false;
        if (r.width !== want.width || r.height !== want.height) return false;
      }
      return true;
    });
  }, [results, filterFamily, filterRes]);

  const downloadJson = () => {
    if (!results) return;
    const blob = new Blob(
      [
        JSON.stringify(
          { adapter, profile, results, generatedAt: new Date().toISOString() },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "exp17-capabilities.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-17 · Codec &amp; Hardware-Accel Probe</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Calls{" "}
            <code>VideoDecoder.isConfigSupported</code> and{" "}
            <code>VideoEncoder.isConfigSupported</code> across the full codec
            × resolution × bit-depth × hardware-preference matrix and
            computes a capability profile the rest of the app can branch on.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">GPU adapter</h2>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-zinc-500">vendor</dt>
              <dd className="truncate">{adapter?.vendor || "—"}</dd>
              <dt className="text-zinc-500">architecture</dt>
              <dd className="truncate">{adapter?.architecture || "—"}</dd>
              <dt className="text-zinc-500">device</dt>
              <dd className="truncate">{adapter?.device || "—"}</dd>
              <dt className="text-zinc-500">description</dt>
              <dd className="truncate">{adapter?.description || "—"}</dd>
            </dl>
          </div>
          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Probe progress</h2>
            <progress
              value={progress.done}
              max={progress.total || 1}
              className="block w-full"
            />
            <div className="mt-1 text-xs">
              {progress.done} / {progress.total}{" "}
              {running ? "probing..." : "done"}
            </div>
            <div className="mt-3 flex gap-2 text-xs">
              <button
                type="button"
                onClick={runProbe}
                disabled={running}
                className="rounded bg-zinc-900 px-2 py-1 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
              >
                Re-run
              </button>
              <button
                type="button"
                onClick={downloadJson}
                disabled={!results}
                className="rounded border border-zinc-400 px-2 py-1 disabled:opacity-40"
              >
                Download JSON
              </button>
            </div>
          </div>
        </section>

        {profile && (
          <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Capability profile</h2>
            <p className="mb-2 text-xs text-zinc-500">
              Derived from the matrix. The rest of the app can read this once
              at startup and branch UI accordingly.
            </p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs md:grid-cols-3">
              <Cap label="Ingest H.264" v={profile.canIngestH264} />
              <Cap label="Ingest HEVC" v={profile.canIngestHEVC} />
              <Cap label="Ingest HEVC 10-bit (HDR)" v={profile.canIngestHEVCHDR} />
              <Cap label="Ingest VP9" v={profile.canIngestVP9} />
              <Cap label="Ingest AV1" v={profile.canIngestAV1} />
              <Cap label="Encode H.264 (HW)" v={profile.canEncodeH264HW} />
              <Cap label="Encode HEVC (HW)" v={profile.canEncodeHEVCHW} />
              <Cap label="Encode AV1 (HW)" v={profile.canEncodeAV1HW} />
              <Cap label="Export 4K" v={profile.canExport4K} />
              <Cap label="Proxy required for HEVC" v={profile.proxyRequiredForHEVC} warn />
              <Cap
                label="Recommended proxy codec"
                v={profile.recommendedProxyCodec}
              />
            </dl>
          </section>
        )}

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Full matrix</h2>
            <div className="flex gap-2 text-xs">
              <label>
                family
                <select
                  value={filterFamily}
                  onChange={(e) => setFilterFamily(e.target.value)}
                  className="ml-1 border bg-transparent px-1"
                >
                  <option value="all">all</option>
                  <option value="H.264">H.264</option>
                  <option value="HEVC">HEVC</option>
                  <option value="VP9">VP9</option>
                  <option value="AV1">AV1</option>
                  <option value="VVC">VVC</option>
                </select>
              </label>
              <label>
                res
                <select
                  value={filterRes}
                  onChange={(e) => setFilterRes(e.target.value)}
                  className="ml-1 border bg-transparent px-1"
                >
                  <option value="all">all</option>
                  {RESOLUTIONS.map((r) => (
                    <option key={r.label} value={r.label}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <div className="max-h-96 overflow-auto rounded bg-zinc-100 text-[10px] dark:bg-zinc-900">
            <table className="w-full">
              <thead className="sticky top-0 bg-zinc-100 text-zinc-500 dark:bg-zinc-900">
                <tr className="text-left">
                  <th className="p-1">codec</th>
                  <th className="p-1">res</th>
                  <th className="p-1">bd</th>
                  <th className="p-1">hw</th>
                  <th className="p-1">dec</th>
                  <th className="p-1">enc</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr
                    key={i}
                    className="border-t border-zinc-300/30 dark:border-zinc-700/30"
                  >
                    <td className="p-1 font-mono">{r.codec}</td>
                    <td className="p-1">
                      {r.width}×{r.height}
                    </td>
                    <td className="p-1">{r.bitDepth}</td>
                    <td className="p-1">{r.hardwareAcceleration}</td>
                    <td
                      className={`p-1 ${
                        r.decoderSupported === true
                          ? "text-emerald-500"
                          : r.decoderSupported === "error"
                            ? "text-red-500"
                            : "text-zinc-500"
                      }`}
                    >
                      {String(r.decoderSupported)}
                    </td>
                    <td
                      className={`p-1 ${
                        r.encoderSupported === true
                          ? "text-emerald-500"
                          : r.encoderSupported === "error"
                            ? "text-red-500"
                            : "text-zinc-500"
                      }`}
                    >
                      {String(r.encoderSupported)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10px] text-zinc-500">
            Each row probes a single config. &quot;dec&quot; / &quot;enc&quot;
            reflect <code>isConfigSupported</code>{" "}
            <code>.supported</code> — &quot;error&quot; means the call threw,
            which is also valuable signal.
          </p>
        </section>

        <footer className="text-xs text-zinc-500">
          HEVC support on Chrome requires the OS-level decoder and is often
          disabled by default on Linux. AV1 encode is software-only on most
          machines as of 2026.
        </footer>
      </div>
    </main>
  );
}

function Cap({
  label,
  v,
  warn,
}: {
  label: string;
  v: boolean | string;
  warn?: boolean;
}) {
  const isBool = typeof v === "boolean";
  const color = !isBool
    ? "text-emerald-600 dark:text-emerald-400"
    : v
      ? warn
        ? "text-amber-500"
        : "text-emerald-600 dark:text-emerald-400"
      : "text-zinc-500";
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className={color}>{String(v)}</dd>
    </>
  );
}
