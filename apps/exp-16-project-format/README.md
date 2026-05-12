# exp-16 · Project File Format, Autosave & Crash Recovery

## Purpose

Persist project state on OPFS with a write-ahead journal, replay on open,
survive a tab kill mid-edit. Migrate between schema versions on load.

Without this, the timeline state from exp-09 is volatile in-memory and
every tab-crash takes the user's edits with it.

## Format

```
/projects/<projectId>/
├── snapshot.json   ← last consolidated state with {version: N}
└── journal.log     ← newline-delimited JSON of actions since snapshot
```

Schema versioning lives in `src/lib/schema.ts`:

- `ProjectV1` — { clips: { id, start, length }[] }
- `ProjectV2` — adds `track: number` to each clip (CURRENT)
- migrator chain `migrate(raw)` replays v1→v2→...→current on load

## Write-ahead protocol

```
commit(action):
  next = applyAction(currentProject, action)
  line = JSON.stringify(action) + "\n"
  syncHandle.write(line, { at: journalSize })
  syncHandle.flush()                ← I/O barrier; the write is durable
  journalSize += line.bytes
  currentProject = next
```

`flush()` returns synchronously and the bytes are guaranteed durable
before it returns. Tab-kill after this point is recoverable.

## Snapshot protocol

```
snapshot():
  text = JSON.stringify(currentProject)
  finalSyncHandle.truncate(0)
  finalSyncHandle.write(text, { at: 0 })
  finalSyncHandle.flush()
  journalSyncHandle.truncate(0)
  journalSyncHandle.flush()
```

The order matters: write the new snapshot first, then truncate the
journal. Crash between the two leaves a valid snapshot + a journal that
will be re-replayed harmlessly. Crash *during* the snapshot write leaves
a zero-length snapshot; the journal-only replay still reproduces state.

## Open protocol

```
open(projectId):
  1. load snapshot.json (or null) — migrate to current version
  2. read journal.log — for each line, applyAction
  3. on parse failure, truncate the tail at that point and warn
  4. yield the resulting Project + "recovered" flag
```

A partial last line from a crash mid-write is dropped silently — flush
boundaries make this rare but possible.

## Success criteria

1. Add 100 clips, hit "simulate crash" (the page navigates to
   `about:blank` before snapshot is reached). Reopen — clip count and IDs
   match exactly. Recovery banner shows the entries that were replayed.
2. Auto-snapshot every N entries: journal size resets to 0 each time;
   snapshot bytes grow.
3. Manually writing a v1 snapshot into OPFS (DevTools → Application →
   Storage) and opening: migrator runs, project loads as v2.
4. Journal append latency &lt; 1 ms p95 (it's an OPFS sync write +
   flush — bounded by SSD).

## Known foot-guns

- OPFS sync access handles must be in a **worker**, never the main
  thread. The page postMessages every commit.
- Only one `createSyncAccessHandle()` per file at a time — concurrent
  opens throw. The worker keeps a single handle for the duration of the
  open project.
- `flush()` is a barrier; it does not run on `requestIdleCallback`.
  Batch writes if commit latency matters (this experiment doesn't).
- `removeEntry` on the open project dir while a sync handle is held
  hangs in Chrome — the page closes via the worker's OPEN replacing
  the handle.
- `BeforeUnload` is not enough on its own — Chrome can kill the tab
  without firing it. The journal write must complete before the action
  is acknowledged to the user.

## Running

```
pnpm --filter exp-16-project-format dev
```
