# exp-19 · Multi-Tab Coordination via Web Locks

## Purpose

Two tabs open the same "project." Exactly one wins an exclusive
`navigator.locks` lease and becomes the PRIMARY writer; the other
becomes a READER that subscribes to `BroadcastChannel` and re-reads
the shared OPFS file on every change. Closing the PRIMARY releases
the lock so the READER can claim it and resume writes — no OPFS
corruption.

## Running

```
pnpm --filter exp-19-web-locks dev
```

Open `http://localhost:3000` in two tabs (or two windows). The first
tab becomes PRIMARY, the second becomes READER.

## What to look for in the UI

- **Role pill**: PRIMARY (green) or READER (amber). Updates live.
- **Lock state**: output of `navigator.locks.query()` showing held /
  pending entries with each tab's UUID.
- **Editor / Mirror**:
  - PRIMARY: a textarea bound to the shared OPFS file. Edits debounce
    250 ms then write via a worker-side sync access handle.
  - READER: a read-only mirror that updates on every BroadcastChannel
    message, with a "Last update" timestamp.
- **Claim primary button**: on a READER, releases its standing
  request and re-issues a non-`ifAvailable` request that will resolve
  the moment the PRIMARY releases.
- **Event log**: lock acquired / released / broadcast received /
  write completed.

## Success bar

1. Open tab A — PRIMARY. Open tab B — READER.
2. Type in A: text appears in B's mirror within ~500 ms.
3. Close A: B's "Claim primary" promotes B to PRIMARY within ~1 s.
4. `navigator.locks.query()` always agrees with the on-screen role.
5. No `NoModificationAllowedError` ever appears in either tab's
   console.

## Foot-guns covered

- The lock is held only while the callback's returned promise is
  pending. A manual release-resolver is wired up.
- `ifAvailable: true` returning `null` is normal — that is how the
  reader path is detected.
- BroadcastChannel is best-effort; READER re-reads OPFS on every
  message instead of buffering deltas.
- `pagehide` is used to resolve the lock promise on close.
