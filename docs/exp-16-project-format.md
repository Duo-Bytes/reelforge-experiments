# Exp-16 · Project File Format, Autosave & Crash Recovery

## Goal

Persist timeline + asset references on OPFS using a versioned schema and
a write-ahead journal. Killing the tab mid-edit recovers to the last
consistent state on next open. Migrate older snapshots forward on load.

## App Location

`apps/exp-16-project-format/`

## Why This Matters in the Full NLE

exp-09 covers in-memory timeline state but nothing about persistence,
versioning, or crash recovery. Every browser editor that skips this
ships data-loss bugs (Clipchamp is currently being abandoned over
similar issues).

## Key APIs

| API | Where used |
|---|---|
| `FileSystemSyncAccessHandle.write/flush/truncate` | Worker-only OPFS journal writes |
| `navigator.storage.getDirectory()` | OPFS root |
| `Storage.persist()` | Request eviction-resistant storage |

## On-disk layout

```
/projects/<projectId>/
├── snapshot.json   ← last consolidated state, with {version}
└── journal.log     ← newline-delimited JSON actions since snapshot
```

## Protocols

**Write-ahead commit.** `applyAction` → append JSON line → `flush()`
→ ack. `flush()` returns synchronously and the bytes are durable.

**Snapshot.** Write consolidated state, then truncate journal. Crash
between the two is recoverable (zero-length snapshot + journal replay
still reproduces state).

**Open.** Load snapshot (or null) → migrate version → replay journal
lines on top → set `recovered=true` if both existed. Corrupt journal
tail is truncated at the bad line and warned.

## Schema versioning

- `ProjectV1` — clips with `{id, start, length}`
- `ProjectV2` — adds `track: number` to every clip (CURRENT)
- `migrate(raw)` runs the v1→v2→...→current chain

## Success Criteria

1. Add 100 clips, "simulate crash" (page navigates to `about:blank`
   before snapshot). Reopen — clip count and IDs match exactly; banner
   reports replayed entries.
2. Auto-snapshot every N commits resets journal to 0 bytes; snapshot
   bytes grow.
3. Manually injecting a v1 snapshot (DevTools → Application → Storage)
   loads via migrator as v2.
4. Journal append latency &lt; 1 ms p95.

## Foot-guns

- OPFS sync access handles are worker-only.
- One open `createSyncAccessHandle()` per file at a time.
- `BeforeUnload` is unreliable — Chrome can kill the tab without firing
  it. Writes must be durable before the action is acknowledged.
- `removeEntry` on the open project dir while a handle is live hangs;
  replace the handle via a new OPEN.
