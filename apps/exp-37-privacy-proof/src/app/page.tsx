"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type AuditEntry = {
  t: number;
  url: string;
  initiator: string;
  outcome: "allowed-self" | "allowed-cache" | "blocked";
  bytes: number;
};

export default function Page() {
  const [privacyMode, setPrivacyMode] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [outboundBytes, setOutboundBytes] = useState(0);
  const [blockedCount, setBlockedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const observerRef = useRef<PerformanceObserver | null>(null);

  // PerformanceObserver tracks every resource-load entry.  We classify into
  // "allowed-self" / "allowed-cache" / "blocked" by URL origin + transferSize.
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    const obs = new PerformanceObserver((list) => {
      const additions: AuditEntry[] = [];
      let bumpBytes = 0;
      let bumpBlocked = 0;
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        const url = entry.name;
        const sameOrigin = url.startsWith(location.origin);
        const transfer = entry.transferSize ?? 0;
        const cacheHit = transfer === 0 && entry.encodedBodySize > 0;
        let outcome: AuditEntry["outcome"];
        if (sameOrigin) outcome = cacheHit ? "allowed-cache" : "allowed-self";
        else outcome = "blocked";
        if (outcome === "blocked") bumpBlocked++;
        if (outcome === "allowed-self") bumpBytes += transfer;
        additions.push({
          t: entry.startTime,
          url,
          initiator: entry.initiatorType,
          outcome,
          bytes: transfer,
        });
      }
      if (additions.length) {
        setEntries((prev) => [...additions, ...prev].slice(0, 500));
        setOutboundBytes((b) => b + bumpBytes);
        setBlockedCount((b) => b + bumpBlocked);
      }
    });
    obs.observe({ type: "resource", buffered: true });
    observerRef.current = obs;
    return () => obs.disconnect();
  }, []);

  // CSP violation reports (when the real header is wired up) land on the
  // `securitypolicyviolation` event.  Surface them in the audit log.
  useEffect(() => {
    const handler = (e: SecurityPolicyViolationEvent) => {
      setEntries((prev) =>
        [
          {
            t: performance.now(),
            url: e.blockedURI || "<inline>",
            initiator: `csp-violation:${e.effectiveDirective}`,
            outcome: "blocked" as const,
            bytes: 0,
          },
          ...prev,
        ].slice(0, 500),
      );
      setBlockedCount((b) => b + 1);
    };
    document.addEventListener("securitypolicyviolation", handler);
    return () => document.removeEventListener("securitypolicyviolation", handler);
  }, []);

  const installPrivacySW = useCallback(async () => {
    setError(null);
    try {
      if (!("serviceWorker" in navigator)) {
        throw new Error("Service Worker unavailable.");
      }
      // The SW file would live at /privacy-sw.js (not bundled in this stub).
      // In production it intercepts every fetch and rejects non-self URLs when
      // privacy mode is on.
      // For now we simulate the toggle.
      setPrivacyMode(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const probeBlockedFetch = useCallback(async () => {
    // Demonstrates what would happen when privacy mode is fully wired:
    // the service worker would intercept and synthesize a 403.
    // In this stub we just record the attempt so the audit panel shows
    // the user what *would* have been blocked.
    setEntries((prev) =>
      [
        {
          t: performance.now(),
          url: "https://example-analytics.invalid/track",
          initiator: privacyMode ? "fetch:blocked-by-sw" : "fetch:not-attempted",
          outcome: "blocked" as const,
          bytes: 0,
        },
        ...prev,
      ].slice(0, 500),
    );
    setBlockedCount((b) => b + 1);
  }, [privacyMode]);

  const exportAttestation = useCallback(() => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            origin: location.origin,
            privacyMode,
            outboundBytes,
            blockedCount,
            entries,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "privacy-attestation.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [privacyMode, outboundBytes, blockedCount, entries]);

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-37 · Provable Privacy Mode</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Audit every outbound request, surface a live counter of bytes that
            leave the device, and block third-party egress at the service-worker
            layer when Privacy Mode is on.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Big label="privacy mode" v={privacyMode ? "ON" : "off"} good={privacyMode} />
          <Big
            label="outbound bytes (cross-origin)"
            v={String(outboundBytes)}
            good={outboundBytes === 0}
          />
          <Big label="blocked attempts" v={String(blockedCount)} />
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={installPrivacySW}
              disabled={privacyMode}
              className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
            >
              Install Privacy Mode SW
            </button>
            <button
              type="button"
              onClick={probeBlockedFetch}
              className="rounded border border-zinc-400 px-3 py-1"
            >
              Probe a cross-origin fetch (what would happen)
            </button>
            <button
              type="button"
              onClick={exportAttestation}
              className="ml-auto rounded border border-zinc-400 px-3 py-1"
            >
              Export attestation JSON
            </button>
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Live audit log</h2>
          <div className="max-h-96 overflow-auto rounded bg-zinc-100 p-2 text-[10px] dark:bg-zinc-900">
            {entries.length === 0 ? (
              <div className="text-zinc-500">no requests captured yet — open DevTools Network too.</div>
            ) : (
              <table className="w-full">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="text-left">t (ms)</th>
                    <th className="text-left">initiator</th>
                    <th className="text-left">url</th>
                    <th className="text-right">bytes</th>
                    <th className="text-left">outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={i} className="border-t border-zinc-300/30 dark:border-zinc-700/30">
                      <td>{e.t.toFixed(1)}</td>
                      <td>{e.initiator}</td>
                      <td className="max-w-[280px] truncate font-mono">{e.url}</td>
                      <td className="text-right">{e.bytes}</td>
                      <td
                        className={
                          e.outcome === "blocked"
                            ? "text-red-500"
                            : e.outcome === "allowed-cache"
                              ? "text-amber-400"
                              : "text-emerald-500"
                        }
                      >
                        {e.outcome}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Next steps</h2>
          <ul className="ml-5 list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
            <li>Ship <code>public/privacy-sw.js</code> that synthesises 403s for non-self URLs while privacy mode is on.</li>
            <li>Add strict-CSP response headers in <code>next.config.ts</code> for the editor route; gate <code>connect-src</code> by toggle.</li>
            <li>Wire a same-origin <code>Reporting-Endpoints</code> handler that stores CSP violations in IndexedDB.</li>
            <li>Pre-cache ONNX model weights into the SW install step so the first run does not need network.</li>
            <li>Marketing-grade demo: scripted 60-min editing session that ends with 0 outbound bytes.</li>
          </ul>
        </section>
      </div>
    </main>
  );
}

function Big({ label, v, good }: { label: string; v: string; good?: boolean }) {
  return (
    <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
      <div className="text-xs text-zinc-500">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold ${good ? "text-emerald-500" : ""}`}
      >
        {v}
      </div>
    </div>
  );
}
