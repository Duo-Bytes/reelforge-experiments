"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BroadcastMessage,
  CHANNEL_NAME,
  LOCK_NAME,
  MainToWorker,
  OPFS_FILE,
  WorkerToMain,
} from "../lib/protocol";

type Role = "pending" | "primary" | "reader";

type LogEntry = { at: number; text: string; tone: "info" | "lock" | "io" | "error" };

type LockSnapshot = {
  held: { clientId?: string; mode?: string; name?: string }[];
  pending: { clientId?: string; mode?: string; name?: string }[];
};

const newId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
};

export default function Page() {
  const idRef = useRef<string>("");
  if (idRef.current === "") idRef.current = newId();

  const [role, setRole] = useState<Role>("pending");
  const [text, setText] = useState<string>("");
  const [mirrorText, setMirrorText] = useState<string>("");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [lockSnapshot, setLockSnapshot] = useState<LockSnapshot | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [supported, setSupported] = useState<boolean>(true);
  const [supportNote, setSupportNote] = useState<string>("");
  const [claiming, setClaiming] = useState<boolean>(false);

  // Refs for cross-effect plumbing.
  const channelRef = useRef<BroadcastChannel | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const releaseRef = useRef<(() => void) | null>(null); // resolves the lock promise
  const writeDebounceRef = useRef<number | null>(null);
  const claimAttemptRef = useRef<AbortController | null>(null);

  const pushLog = useCallback((textIn: string, tone: LogEntry["tone"] = "info") => {
    setLog((prev) => {
      const next = [{ at: Date.now(), text: textIn, tone }, ...prev];
      return next.slice(0, 200);
    });
  }, []);

  // Capability detection.
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    if (!("locks" in navigator)) {
      setSupported(false);
      setSupportNote("navigator.locks is unavailable.");
      return;
    }
    if (!("storage" in navigator) || !navigator.storage?.getDirectory) {
      setSupported(false);
      setSupportNote("OPFS (navigator.storage.getDirectory) is unavailable.");
      return;
    }
  }, []);

  // Worker lifecycle (only PRIMARY uses it, but instantiating once per page
  // keeps message wiring simple — the worker idles until told to write).
  useEffect(() => {
    if (!supported) return;
    const w = new Worker(new URL("../workers/writer.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = w;
    w.onmessage = (event: MessageEvent<WorkerToMain>) => {
      const msg = event.data;
      if (msg.kind === "ready") {
        pushLog("Writer worker ready.", "info");
      } else if (msg.kind === "wrote") {
        pushLog(`Wrote ${msg.bytes} B to ${OPFS_FILE}.`, "io");
        channelRef.current?.postMessage({
          kind: "updated",
          from: idRef.current,
          at: msg.at,
        } satisfies BroadcastMessage);
      } else if (msg.kind === "read") {
        setMirrorText(msg.text);
        setLastUpdate(msg.at);
      } else if (msg.kind === "error") {
        pushLog(`Worker error: ${msg.message}`, "error");
      }
    };
    return () => {
      try {
        w.postMessage({ kind: "close" } satisfies MainToWorker);
      } catch {
        // ignore
      }
      w.terminate();
      workerRef.current = null;
    };
  }, [supported, pushLog]);

  // Broadcast channel — both roles listen, primary publishes.
  useEffect(() => {
    if (!supported) return;
    const ch = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = ch;
    ch.onmessage = (event: MessageEvent<BroadcastMessage>) => {
      const msg = event.data;
      if (msg.from === idRef.current) return;
      if (msg.kind === "updated") {
        setLastUpdate(msg.at);
        // Re-read OPFS only if this tab is a reader — primary owns the truth.
        if (role === "reader") {
          // Reader cannot open a sync handle (primary holds it); read via
          // the regular FileSystemFileHandle.getFile() path on the main thread.
          void readFromOpfsMain().then((t) => setMirrorText(t));
        }
      }
    };
    return () => {
      ch.close();
      channelRef.current = null;
    };
  }, [supported, role]);

  // Acquire-or-fall-back lock dance.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;

    const acquireExclusive = async () => {
      // First attempt: ifAvailable. If we get a non-null lock, we're PRIMARY
      // and we hold for the lifetime of this effect.
      try {
        await navigator.locks.request(LOCK_NAME, { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (!lock) {
            if (!cancelled) {
              setRole("reader");
              pushLog("Lock held by another tab — reader mode.", "lock");
              await primeReaderState();
            }
            return;
          }
          if (cancelled) return;
          setRole("primary");
          pushLog(`Acquired exclusive lock as ${idRef.current}.`, "lock");
          // Hold the lock until releaseRef is invoked (on unmount or claim).
          await new Promise<void>((resolve) => {
            releaseRef.current = () => {
              releaseRef.current = null;
              resolve();
            };
          });
          pushLog("Released lock.", "lock");
        });
      } catch (err) {
        pushLog(`Lock request failed: ${(err as Error).message}`, "error");
      }
    };

    void acquireExclusive();

    return () => {
      cancelled = true;
      releaseRef.current?.();
    };
  }, [supported, pushLog]);

  // Page-hide: release lock voluntarily so the other tab can pick up faster.
  useEffect(() => {
    const onHide = () => {
      releaseRef.current?.();
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // Lock snapshot poller (diagnostic; navigator.locks.query()).
  useEffect(() => {
    if (!supported) return;
    const poll = async () => {
      if (!navigator.locks?.query) return;
      try {
        const snap = (await navigator.locks.query()) as {
          held?: { clientId?: string; mode?: string; name?: string }[];
          pending?: { clientId?: string; mode?: string; name?: string }[];
        };
        const filterByName = (
          entries?: { clientId?: string; mode?: string; name?: string }[],
        ): { clientId?: string; mode?: string; name?: string }[] =>
          (entries ?? [])
            .filter((e) => e.name === LOCK_NAME)
            .map((e) => ({ clientId: e.clientId, mode: e.mode, name: e.name }));
        setLockSnapshot({
          held: filterByName(snap.held),
          pending: filterByName(snap.pending),
        });
      } catch {
        // ignore
      }
    };
    void poll();
    const timer = window.setInterval(poll, 750);
    return () => {
      window.clearInterval(timer);
    };
  }, [supported]);

  // PRIMARY: debounce-write the textarea.
  useEffect(() => {
    if (role !== "primary") return;
    if (writeDebounceRef.current !== null) window.clearTimeout(writeDebounceRef.current);
    writeDebounceRef.current = window.setTimeout(() => {
      workerRef.current?.postMessage({ kind: "write", text } satisfies MainToWorker);
    }, 250);
    return () => {
      if (writeDebounceRef.current !== null) {
        window.clearTimeout(writeDebounceRef.current);
        writeDebounceRef.current = null;
      }
    };
  }, [role, text]);

  // PRIMARY: load current contents on promotion.
  useEffect(() => {
    if (role !== "primary") return;
    void readFromOpfsMain().then((t) => {
      setText(t);
      setMirrorText(t);
    });
  }, [role]);

  // READER: prime mirror once.
  const primeReaderState = useCallback(async () => {
    const t = await readFromOpfsMain();
    setMirrorText(t);
  }, []);

  // Claim primary: release any reader-side hold and queue a non-ifAvailable
  // exclusive request that will pick up the moment the current primary releases.
  const onClaimPrimary = useCallback(async () => {
    if (claiming) return;
    setClaiming(true);
    pushLog("Queuing exclusive lock request (waiting)...", "lock");
    const ac = new AbortController();
    claimAttemptRef.current = ac;
    try {
      await navigator.locks.request(
        LOCK_NAME,
        { mode: "exclusive", signal: ac.signal },
        async (lock) => {
          if (!lock) return;
          setRole("primary");
          pushLog("Claimed primary.", "lock");
          await new Promise<void>((resolve) => {
            releaseRef.current = () => {
              releaseRef.current = null;
              resolve();
            };
          });
        },
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        pushLog("Claim aborted.", "lock");
      } else {
        pushLog(`Claim failed: ${(err as Error).message}`, "error");
      }
    } finally {
      setClaiming(false);
      claimAttemptRef.current = null;
    }
  }, [claiming, pushLog]);

  const roleBadge = useMemo(() => {
    if (role === "primary") {
      return <span className="px-2 py-0.5 text-xs font-semibold rounded bg-emerald-600 text-white">PRIMARY</span>;
    }
    if (role === "reader") {
      return <span className="px-2 py-0.5 text-xs font-semibold rounded bg-amber-500 text-black">READER</span>;
    }
    return <span className="px-2 py-0.5 text-xs font-semibold rounded bg-neutral-500 text-white">PENDING</span>;
  }, [role]);

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10 flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Exp-19 · Multi-Tab Coordination via Web Locks</h1>
          {roleBadge}
        </div>
        <p className="text-sm text-neutral-500 max-w-3xl">
          Open this page in two tabs. Exactly one wins the exclusive lock; the
          other observes via <code>BroadcastChannel</code> and re-reads OPFS on each
          change. Close PRIMARY → READER can claim.
        </p>
        <div className="text-xs text-neutral-500 font-mono">tab id: {idRef.current}</div>
      </header>

      {!supported && (
        <div className="border border-red-500/50 bg-red-500/5 rounded-md p-4 text-sm">
          Unsupported environment: {supportNote}
        </div>
      )}

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-md border border-neutral-500/30 p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs uppercase tracking-wider text-neutral-500">
              {role === "primary" ? "Editor (PRIMARY)" : "Mirror (READER)"}
            </h2>
            {role === "reader" && (
              <button
                type="button"
                onClick={onClaimPrimary}
                disabled={claiming}
                className="px-2 py-1 text-xs rounded bg-emerald-600 text-white disabled:opacity-40"
              >
                {claiming ? "Waiting..." : "Claim primary"}
              </button>
            )}
          </div>
          {role === "primary" ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="min-h-48 w-full bg-transparent border border-neutral-500/30 rounded p-2 text-sm font-mono"
              placeholder="Type here — debounced to OPFS every 250ms."
            />
          ) : (
            <pre className="min-h-48 w-full bg-neutral-500/5 border border-neutral-500/20 rounded p-2 text-sm font-mono whitespace-pre-wrap break-words">
              {mirrorText || "(empty)"}
            </pre>
          )}
          <div className="text-xs text-neutral-500">
            Last update:{" "}
            {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "never"}
          </div>
        </div>

        <div className="rounded-md border border-neutral-500/30 p-4 flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wider text-neutral-500">
            navigator.locks.query()
          </h2>
          <div className="text-xs font-mono">
            <div className="text-neutral-500">held</div>
            <ul className="mb-2">
              {(lockSnapshot?.held ?? []).length === 0 && (
                <li className="text-neutral-500">(none)</li>
              )}
              {(lockSnapshot?.held ?? []).map((e, i) => (
                <li key={`h-${i}`}>
                  · {e.mode} {e.name} {e.clientId ? `(${e.clientId})` : ""}
                </li>
              ))}
            </ul>
            <div className="text-neutral-500">pending</div>
            <ul>
              {(lockSnapshot?.pending ?? []).length === 0 && (
                <li className="text-neutral-500">(none)</li>
              )}
              {(lockSnapshot?.pending ?? []).map((e, i) => (
                <li key={`p-${i}`}>
                  · {e.mode} {e.name} {e.clientId ? `(${e.clientId})` : ""}
                </li>
              ))}
            </ul>
          </div>
          <div className="text-xs text-neutral-500 pt-2 border-t border-neutral-500/20 mt-2">
            Note: the lock-holder UUID above is opaque per spec; only your own
            tab id ({idRef.current}) is shown verbatim.
          </div>
        </div>
      </section>

      <section className="rounded-md border border-neutral-500/30 p-4">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500 mb-2">Event log</h2>
        <ol className="text-xs font-mono max-h-72 overflow-y-auto flex flex-col gap-0.5">
          {log.length === 0 && <li className="text-neutral-500">(no events yet)</li>}
          {log.map((e, i) => (
            <li
              key={`${e.at}-${i}`}
              className={
                e.tone === "error"
                  ? "text-red-500"
                  : e.tone === "lock"
                    ? "text-emerald-500"
                    : e.tone === "io"
                      ? "text-sky-400"
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

// Read OPFS from the main thread (no sync access handle, so this is safe to
// run from any tab — readers use this; the primary also uses it once at
// promotion time to seed its editor).
async function readFromOpfsMain(): Promise<string> {
  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(OPFS_FILE, { create: true });
    const file = await fileHandle.getFile();
    return await file.text();
  } catch {
    return "";
  }
}
