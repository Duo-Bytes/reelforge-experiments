"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Action, ClipV2, Project } from "../lib/schema";

type Stats = {
  opened: boolean;
  projectId?: string;
  journalEntries?: number;
  journalSize?: number;
  snapshotBytes?: number;
  lastSnapshotAt?: number;
  recovered?: boolean;
};

const PROJECT_ID = "exp16-default";

export default function Page() {
  const workerRef = useRef<Worker | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [stats, setStats] = useState<Stats>({ opened: false });
  const [error, setError] = useState<string | null>(null);
  const [recoveredBanner, setRecoveredBanner] = useState(false);
  const [autoSnapshotEveryN, setAutoSnapshotEveryN] = useState(50);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = new Worker(
      new URL("../workers/journal.worker.ts", import.meta.url),
      { type: "module" },
    );
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "OPENED") {
        setProject(m.project as Project);
        setStats({
          opened: true,
          projectId: PROJECT_ID,
          journalEntries: m.journalEntries,
          journalSize: m.journalSize,
          snapshotBytes: m.snapshotBytes,
        });
        if (m.recovered) setRecoveredBanner(true);
      } else if (m.type === "COMMITTED") {
        setProject(m.project as Project);
        setStats((s) => ({
          ...s,
          journalEntries: m.journalEntries,
          journalSize: m.journalSize,
        }));
      } else if (m.type === "SNAPSHOTTED") {
        setProject(m.project as Project);
        setStats((s) => ({
          ...s,
          journalEntries: 0,
          journalSize: 0,
          snapshotBytes: m.snapshotBytes,
          lastSnapshotAt: performance.now(),
        }));
      } else if (m.type === "ERROR" || m.type === "WARN") {
        setError(m.message as string);
      }
    };
    workerRef.current = w;
    w.postMessage({ type: "OPEN", projectId: PROJECT_ID });
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  // Persist a marker that this tab was alive for the crash demo. On open,
  // a stale marker means the previous tab crashed without snapshotting.
  useEffect(() => {
    sessionStorage.setItem("exp16-tab-alive", "1");
  }, []);

  const commit = (action: Action) => {
    workerRef.current?.postMessage({ type: "COMMIT", action });
  };

  const snapshot = () => {
    workerRef.current?.postMessage({ type: "SNAPSHOT" });
  };

  // Auto-snapshot policy: every N journal entries.
  useEffect(() => {
    if (
      stats.journalEntries !== undefined &&
      stats.journalEntries > 0 &&
      stats.journalEntries % autoSnapshotEveryN === 0
    ) {
      snapshot();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.journalEntries, autoSnapshotEveryN]);

  const stress = (count: number) => {
    if (!project) return;
    for (let i = 0; i < count; i++) {
      commit({
        type: "add_clip",
        clip: {
          id: crypto.randomUUID(),
          start: Math.random() * 60,
          length: 1 + Math.random() * 5,
          track: Math.floor(Math.random() * 4),
        },
      });
    }
  };

  const reset = async () => {
    // Best-effort: delete the project dir and reload.
    try {
      const root = await navigator.storage.getDirectory();
      const projects = await root.getDirectoryHandle("projects", {
        create: false,
      });
      await projects.removeEntry(PROJECT_ID, { recursive: true });
    } catch {
      /* */
    }
    location.reload();
  };

  const simulateCrash = () => {
    // Drop the tab without flushing pending writes from the React side.
    // Pending in-flight worker postMessages may or may not be persisted —
    // exactly the production scenario the experiment tests.
    location.replace("about:blank");
  };

  const totals = useMemo(() => {
    if (!project) return null;
    return {
      clipCount: project.clips.length,
      tracks: new Set(project.clips.map((c) => c.track)).size,
    };
  }, [project]);

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">
            Exp-16 · Project File Format, Autosave &amp; Crash Recovery
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Every mutation is appended to an OPFS write-ahead journal. On
            open, journal entries are replayed on top of the last snapshot.
            Snapshots consolidate + truncate. Killing the tab between
            snapshots reproduces a crash; reopening replays the journal.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {recoveredBanner && (
          <div className="rounded border border-emerald-500 bg-emerald-50 p-3 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
            Crash recovery: replayed{" "}
            <strong>{stats.journalEntries ?? 0}</strong> journal entries on
            top of last snapshot.
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Storage</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <dt className="text-zinc-500">project id</dt>
              <dd className="truncate">{stats.projectId ?? "—"}</dd>
              <dt className="text-zinc-500">opened</dt>
              <dd>{stats.opened ? "yes" : "no"}</dd>
              <dt className="text-zinc-500">journal entries</dt>
              <dd>{stats.journalEntries ?? 0}</dd>
              <dt className="text-zinc-500">journal bytes</dt>
              <dd>{stats.journalSize ?? 0}</dd>
              <dt className="text-zinc-500">snapshot bytes</dt>
              <dd>{stats.snapshotBytes ?? 0}</dd>
              <dt className="text-zinc-500">schema version</dt>
              <dd>{project?.version ?? "—"}</dd>
            </dl>
            <label className="mt-3 block text-xs">
              auto-snapshot every
              <input
                type="number"
                min={1}
                max={1000}
                value={autoSnapshotEveryN}
                onChange={(e) =>
                  setAutoSnapshotEveryN(parseInt(e.target.value) || 1)
                }
                className="ml-2 w-20 border bg-transparent px-1"
              />
              entries
            </label>
          </div>

          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Actions</h2>
            <div className="space-y-2 text-xs">
              <button
                type="button"
                disabled={!project}
                onClick={() =>
                  commit({
                    type: "add_clip",
                    clip: {
                      id: crypto.randomUUID(),
                      start: project!.clips.length * 1.5,
                      length: 1.5,
                      track: project!.clips.length % 4,
                    },
                  })
                }
                className="mr-2 rounded bg-zinc-900 px-2 py-1 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
              >
                add clip
              </button>
              <button
                type="button"
                disabled={!project || project.clips.length === 0}
                onClick={() =>
                  commit({
                    type: "remove_clip",
                    id: project!.clips[project!.clips.length - 1].id,
                  })
                }
                className="mr-2 rounded border border-zinc-400 px-2 py-1 disabled:opacity-40"
              >
                remove last
              </button>
              <button
                type="button"
                disabled={!project}
                onClick={() => stress(100)}
                className="mr-2 rounded border border-zinc-400 px-2 py-1 disabled:opacity-40"
              >
                stress: +100 clips
              </button>
              <button
                type="button"
                disabled={!project}
                onClick={snapshot}
                className="mr-2 rounded border border-emerald-400 px-2 py-1 text-emerald-700 disabled:opacity-40 dark:text-emerald-300"
              >
                snapshot now
              </button>
              <button
                type="button"
                onClick={simulateCrash}
                className="rounded border border-red-400 px-2 py-1 text-red-700 dark:text-red-300"
              >
                simulate crash
              </button>
              <button
                type="button"
                onClick={reset}
                className="ml-2 rounded border border-zinc-400 px-2 py-1"
              >
                delete project &amp; reload
              </button>
            </div>
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-2 text-base font-semibold">
            Project: {project?.name ?? "—"}
          </h2>
          {totals && (
            <p className="text-xs text-zinc-500">
              {totals.clipCount} clips across {totals.tracks} tracks
            </p>
          )}
          <div className="mt-3 max-h-72 overflow-auto rounded bg-zinc-100 p-2 text-[10px] dark:bg-zinc-900">
            <table className="w-full">
              <thead className="text-zinc-500">
                <tr>
                  <th className="text-left">id</th>
                  <th className="text-left">track</th>
                  <th className="text-left">start</th>
                  <th className="text-left">length</th>
                </tr>
              </thead>
              <tbody>
                {project?.clips.slice(-100).map((c: ClipV2) => (
                  <tr key={c.id}>
                    <td className="font-mono">{c.id.slice(0, 8)}</td>
                    <td>{c.track}</td>
                    <td>{c.start.toFixed(2)}</td>
                    <td>{c.length.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="text-xs text-zinc-500">
          Test procedure: hit &quot;+100 clips&quot; then &quot;simulate
          crash&quot;. Reopen this page. The recovery banner should show the
          replayed entries; clip count should match what was committed.
        </footer>
      </div>
    </main>
  );
}
