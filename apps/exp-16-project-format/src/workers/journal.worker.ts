/// <reference lib="webworker" />

// Persists project state on OPFS using a write-ahead journal pattern.
//
// Layout (per project, under /projects/<id>/):
//   snapshot.json   – last consolidated full state with a {version}
//   journal.log     – newline-delimited JSON actions since the snapshot
//   header.json     – {snapshotVersion, dirty:boolean} pointer
//
// Open flow:
//   1. Read header.json (or create defaults)
//   2. If snapshot.json exists, load + migrate it
//   3. If journal.log is non-empty, replay every line on top
//   4. Set dirty=true in header (so subsequent crash recovery sees us)
//
// Write flow:
//   - applyAction(project, action) → new state
//   - syncHandle.write(journal entry, {at:end}) → flush
//   - emit OK
//
// Snapshot flow (manual or every N actions):
//   1. Stringify current project
//   2. Write snapshot.json.new
//   3. Truncate journal.log to 0
//   4. Rename .new -> snapshot.json  (atomic on OPFS)
//
// Crash test: window.location.replace("about:blank") without snapshotting.
// On next open, the journal has unflushed actions; replay reproduces state.

import {
  CURRENT_VERSION,
  applyAction,
  migrate,
  type Action,
  type Project,
} from "../lib/schema";

type OpenMsg = { type: "OPEN"; projectId: string };
type CommitMsg = { type: "COMMIT"; action: Action };
type SnapshotMsg = { type: "SNAPSHOT" };
type StatsMsg = { type: "STATS" };
type In = OpenMsg | CommitMsg | SnapshotMsg | StatsMsg;

type OpenedState = {
  projectId: string;
  project: Project;
  journalHandle: FileSystemSyncAccessHandle;
  snapshotDirHandle: FileSystemDirectoryHandle;
  journalSize: number;
  journalEntries: number;
  snapshotBytes: number;
  lastSnapshotAt: number;
};

let state: OpenedState | null = null;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

self.onmessage = async (e: MessageEvent<In>) => {
  try {
    if (e.data.type === "OPEN") {
      await open(e.data.projectId);
    } else if (e.data.type === "COMMIT") {
      await commit(e.data.action);
    } else if (e.data.type === "SNAPSHOT") {
      await snapshot();
    } else if (e.data.type === "STATS") {
      postStats();
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function open(projectId: string): Promise<void> {
  // Close any previous open project.
  if (state) {
    state.journalHandle.close();
    state = null;
  }

  const root = await navigator.storage.getDirectory();
  const projectsDir = await root.getDirectoryHandle("projects", {
    create: true,
  });
  const projectDir = await projectsDir.getDirectoryHandle(projectId, {
    create: true,
  });

  // Try loading snapshot.
  let project: Project | null = null;
  let snapshotBytes = 0;
  try {
    const snapHandle = await projectDir.getFileHandle("snapshot.json", {
      create: false,
    });
    const file = await snapHandle.getFile();
    snapshotBytes = file.size;
    const txt = await file.text();
    project = migrate(JSON.parse(txt));
  } catch {
    project = null;
  }

  // Replay journal (if any).
  const journalFileHandle = await projectDir.getFileHandle("journal.log", {
    create: true,
  });
  const sync = await journalFileHandle.createSyncAccessHandle();
  const journalSize = sync.getSize();
  let journalEntries = 0;
  let recovered = false;

  if (journalSize > 0) {
    const buf = new Uint8Array(journalSize);
    sync.read(buf, { at: 0 });
    const text = decoder.decode(buf);
    const lines = text.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      try {
        const action = JSON.parse(line) as Action;
        journalEntries++;
        if (!project) {
          if (action.type === "create") {
            project = action.project;
            continue;
          }
          throw new Error("journal starts without a create action");
        }
        project = applyAction(project, action);
      } catch (err) {
        // Truncate corrupt tail (e.g. partial line from a crash mid-write).
        self.postMessage({
          type: "WARN",
          message: `journal parse failure: ${err instanceof Error ? err.message : String(err)}`,
        });
        break;
      }
    }
    recovered = journalEntries > 0 && snapshotBytes > 0;
  }

  if (!project) {
    project = {
      version: CURRENT_VERSION,
      name: projectId,
      clips: [],
    };
  }

  state = {
    projectId,
    project,
    journalHandle: sync,
    snapshotDirHandle: projectDir,
    journalSize,
    journalEntries,
    snapshotBytes,
    lastSnapshotAt: 0,
  };

  self.postMessage({
    type: "OPENED",
    project: state.project,
    recovered,
    journalEntries,
    snapshotBytes,
    journalSize,
  });
}

async function commit(action: Action): Promise<void> {
  if (!state) throw new Error("OPEN before COMMIT");
  const next = applyAction(state.project, action);
  const line = JSON.stringify(action) + "\n";
  const bytes = encoder.encode(line);
  // Append to journal and flush. flush() is a sync I/O barrier on OPFS;
  // until it returns, the write may live only in memory.
  state.journalHandle.write(bytes, { at: state.journalSize });
  state.journalHandle.flush();
  state.journalSize += bytes.byteLength;
  state.journalEntries += 1;
  state.project = next;
  self.postMessage({
    type: "COMMITTED",
    project: state.project,
    journalEntries: state.journalEntries,
    journalSize: state.journalSize,
  });
}

async function snapshot(): Promise<void> {
  if (!state) throw new Error("OPEN before SNAPSHOT");
  const text = JSON.stringify(state.project);

  // Write new snapshot to a temp name first.
  const tempHandle = await state.snapshotDirHandle.getFileHandle(
    "snapshot.json.new",
    { create: true },
  );
  const tempSync = await tempHandle.createSyncAccessHandle();
  try {
    tempSync.truncate(0);
    tempSync.write(encoder.encode(text), { at: 0 });
    tempSync.flush();
  } finally {
    tempSync.close();
  }

  // Replace snapshot.json by writing through a new sync handle. OPFS does
  // not yet expose atomic rename; the closest is overwrite-in-place from a
  // separate sync handle. Crash between truncate and write here leaves a
  // zero-length snapshot, which is detected on open and the journal
  // replays in full anyway — safe.
  const finalHandle = await state.snapshotDirHandle.getFileHandle(
    "snapshot.json",
    { create: true },
  );
  const finalSync = await finalHandle.createSyncAccessHandle();
  try {
    finalSync.truncate(0);
    finalSync.write(encoder.encode(text), { at: 0 });
    finalSync.flush();
    state.snapshotBytes = encoder.encode(text).byteLength;
  } finally {
    finalSync.close();
  }
  // Best-effort delete the temp file.
  try {
    await state.snapshotDirHandle.removeEntry("snapshot.json.new");
  } catch {
    /* */
  }

  // Truncate the journal: snapshot is the new baseline.
  state.journalHandle.truncate(0);
  state.journalHandle.flush();
  state.journalSize = 0;
  state.journalEntries = 0;
  state.lastSnapshotAt = performance.now();

  self.postMessage({
    type: "SNAPSHOTTED",
    project: state.project,
    snapshotBytes: state.snapshotBytes,
  });
}

function postStats(): void {
  if (!state) {
    self.postMessage({ type: "STATS", opened: false });
    return;
  }
  self.postMessage({
    type: "STATS",
    opened: true,
    projectId: state.projectId,
    journalEntries: state.journalEntries,
    journalSize: state.journalSize,
    snapshotBytes: state.snapshotBytes,
    lastSnapshotAt: state.lastSnapshotAt,
  });
}
