"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type BeforeInstallPromptEvent,
  type Capability,
  detectCapabilities,
} from "../lib/capabilities";

type LaunchedFile = {
  name: string;
  size: number;
  type: string;
  lastModified: number;
};

type LogEntry = { at: number; text: string; tone: "info" | "warn" | "error" };

// Minimal shapes for LaunchQueue / LaunchParams — not in the default DOM lib
// as of 2026 in all TS versions.
type LaunchParams = {
  files?: FileSystemFileHandle[];
  targetURL?: string;
};
type LaunchQueue = {
  setConsumer: (consumer: (params: LaunchParams) => void) => void;
};

declare global {
  interface Window {
    launchQueue?: LaunchQueue;
  }
}

export default function Page() {
  const [caps, setCaps] = useState<Capability[]>([]);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(false);
  const [launchedFiles, setLaunchedFiles] = useState<LaunchedFile[]>([]);
  const [shareResult, setShareResult] = useState<string>("");
  const [swState, setSwState] = useState<string>("not registered");
  const [log, setLog] = useState<LogEntry[]>([]);
  const consumerRegisteredRef = useRef<boolean>(false);

  const pushLog = useCallback((text: string, tone: LogEntry["tone"] = "info") => {
    setLog((prev) => {
      const next = [{ at: Date.now(), text, tone }, ...prev];
      return next.slice(0, 200);
    });
  }, []);

  // LaunchQueue consumer must register synchronously — register it here and
  // *do not* await anything before this point in the effect.
  useEffect(() => {
    if (consumerRegisteredRef.current) return;
    consumerRegisteredRef.current = true;

    if (typeof window === "undefined") return;
    if (!window.launchQueue) {
      pushLog("window.launchQueue not available — Chromium desktop only.", "warn");
      return;
    }
    window.launchQueue.setConsumer((params: LaunchParams) => {
      pushLog(`launchQueue fired with ${params.files?.length ?? 0} file(s).`, "info");
      if (!params.files || params.files.length === 0) return;
      void resolveLaunchedFiles(params.files).then((files) => {
        setLaunchedFiles((prev) => [...files, ...prev]);
      });
    });
  }, [pushLog]);

  // Everything else (capability detection, install events, SW registration,
  // standalone check) runs after the launchQueue consumer is registered.
  useEffect(() => {
    setCaps(detectCapabilities());

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
      pushLog("Captured beforeinstallprompt — install button available.", "info");
    };
    const onAppInstalled = () => {
      setInstalled(true);
      setInstallEvent(null);
      pushLog("PWA installed.", "info");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onAppInstalled);

    // Standalone detection (the installed PWA window).
    if (window.matchMedia?.("(display-mode: standalone)").matches) {
      setInstalled(true);
    }

    // Register the (no-op) service worker.
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          setSwState(reg.active ? "active" : reg.installing ? "installing" : "registered");
          pushLog(`Service worker registered (scope ${reg.scope}).`, "info");
        })
        .catch((err: Error) => {
          setSwState(`error: ${err.message}`);
          pushLog(`Service worker registration failed: ${err.message}`, "error");
        });
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, [pushLog]);

  const onInstall = useCallback(async () => {
    if (!installEvent) return;
    try {
      await installEvent.prompt();
      const choice = await installEvent.userChoice;
      pushLog(`Install prompt: ${choice.outcome} on ${choice.platform}.`, "info");
      setInstallEvent(null);
    } catch (err) {
      pushLog(`Install prompt error: ${(err as Error).message}`, "error");
    }
  }, [installEvent, pushLog]);

  const onShareText = useCallback(async () => {
    if (!navigator.share) {
      setShareResult("navigator.share unavailable");
      return;
    }
    try {
      await navigator.share({
        title: "ReelForge clip",
        text: "Exported from ReelForge Exp-30",
        url: window.location.href,
      });
      setShareResult("shared text");
      pushLog("Shared text payload.", "info");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setShareResult("user cancelled");
      } else {
        setShareResult(`error: ${(err as Error).message}`);
      }
    }
  }, [pushLog]);

  const onShareFile = useCallback(async () => {
    const nav = navigator as Navigator & {
      canShare?: (data: ShareData) => boolean;
      share?: (data: ShareData) => Promise<void>;
    };
    if (!nav.share || !nav.canShare) {
      setShareResult("file share unavailable");
      return;
    }
    const file = new File(
      [new Blob(["ReelForge exp-30 test export"], { type: "text/plain" })],
      "reelforge-test.txt",
      { type: "text/plain" },
    );
    const data: ShareData = { files: [file], title: "ReelForge test" };
    if (!nav.canShare(data)) {
      setShareResult("canShare(files) returned false");
      return;
    }
    try {
      await nav.share(data);
      setShareResult("shared file");
      pushLog("Shared file payload.", "info");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setShareResult("user cancelled");
      } else {
        setShareResult(`error: ${(err as Error).message}`);
      }
    }
  }, [pushLog]);

  const showInstall = useMemo(
    () => !installed && installEvent !== null,
    [installed, installEvent],
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10 flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold">
            Exp-30 · PWA Install + File Handlers + Web Share Target
          </h1>
          {installed && (
            <span className="px-2 py-0.5 text-xs font-semibold rounded bg-emerald-600 text-white">
              STANDALONE
            </span>
          )}
        </div>
        <p className="text-sm text-neutral-500 max-w-3xl">
          Tests four OS-integration surfaces: install, file_handlers + launchQueue,
          share_target, and outbound navigator.share. Most rows below require
          Chromium desktop; gating is via feature detection, not UA sniffing.
        </p>
      </header>

      <section className="rounded-md border border-neutral-500/30 p-4 flex flex-col gap-2">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500">
          Capability matrix
        </h2>
        <ul className="text-sm flex flex-col gap-1">
          {caps.map((c) => (
            <li key={c.name} className="flex items-baseline gap-2">
              <span
                className={`inline-block w-2.5 h-2.5 rounded-full ${
                  c.supported ? "bg-emerald-500" : "bg-neutral-500/50"
                }`}
              />
              <span className="font-mono">{c.name}</span>
              <span className="text-xs text-neutral-500">{c.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onInstall}
          disabled={!showInstall}
          className="px-3 py-1.5 text-sm rounded bg-emerald-600 text-white disabled:opacity-40"
        >
          Install app
        </button>
        <button
          type="button"
          onClick={onShareText}
          className="px-3 py-1.5 text-sm rounded border border-neutral-500/40"
        >
          navigator.share (text)
        </button>
        <button
          type="button"
          onClick={onShareFile}
          className="px-3 py-1.5 text-sm rounded border border-neutral-500/40"
        >
          navigator.share (file)
        </button>
        <div className="text-xs text-neutral-500">
          SW: <span className="font-mono">{swState}</span>
        </div>
        {shareResult && (
          <div className="text-xs text-neutral-500">
            share: <span className="font-mono">{shareResult}</span>
          </div>
        )}
      </section>

      <section className="rounded-md border border-neutral-500/30 p-4 flex flex-col gap-2">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500">
          Launched files{" "}
          <span className="text-neutral-500/70">
            ({launchedFiles.length})
          </span>
        </h2>
        {launchedFiles.length === 0 ? (
          <p className="text-sm text-neutral-500">
            None yet. After installing, double-click an <code>.mp4</code>,{" "}
            <code>.mov</code> or <code>.reelproj</code> in your file manager to
            launch this PWA with the file.
          </p>
        ) : (
          <ul className="text-xs font-mono flex flex-col gap-1">
            {launchedFiles.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex flex-wrap gap-x-4">
                <span>{f.name}</span>
                <span className="text-neutral-500">{f.size} B</span>
                <span className="text-neutral-500">{f.type || "(no type)"}</span>
                <span className="text-neutral-500">
                  {new Date(f.lastModified).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-md border border-neutral-500/30 p-4 flex flex-col gap-2">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500">
          Web Share Target
        </h2>
        <p className="text-sm text-neutral-500">
          The manifest declares <code>share_target</code> POSTing to{" "}
          <code>/share</code> with multipart form-data. After install, the app
          appears in the system share sheet on Android Chrome and Chromium
          desktop. The Service Worker would consume the POST in a real build;
          here the experiment focuses on the manifest declaration being valid.
        </p>
      </section>

      <section className="rounded-md border border-neutral-500/30 p-4">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500 mb-2">
          Event log
        </h2>
        <ol className="text-xs font-mono max-h-72 overflow-y-auto flex flex-col gap-0.5">
          {log.length === 0 && <li className="text-neutral-500">(no events yet)</li>}
          {log.map((e, i) => (
            <li
              key={`${e.at}-${i}`}
              className={
                e.tone === "error"
                  ? "text-red-500"
                  : e.tone === "warn"
                    ? "text-amber-500"
                    : "text-neutral-400"
              }
            >
              <span className="text-neutral-500">
                {new Date(e.at).toLocaleTimeString()}{" "}
              </span>
              {e.text}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

async function resolveLaunchedFiles(
  handles: FileSystemFileHandle[],
): Promise<LaunchedFile[]> {
  const out: LaunchedFile[] = [];
  for (const handle of handles) {
    try {
      const file = await handle.getFile();
      out.push({
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
      });
    } catch {
      // ignore individual failures
    }
  }
  return out;
}
