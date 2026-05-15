# Exp-19 · Multi-Tab Coordination via Web Locks

## Goal

Demonstrate the documented primary-writer pattern: two tabs open the
same "project," exactly one acquires an exclusive Web Lock and becomes
the writer, the other observes via `BroadcastChannel` and re-reads the
OPFS file on every change. Closing the primary tab must release the
lock; the reader can claim primary and resume writes without
corruption.

## App Location

`apps/exp-19-web-locks/`

## Why This Matters in the Full NLE

Two tabs holding `FileSystemSyncAccessHandle` to the same OPFS file is
immediate corruption — sync access handles are exclusive per-handle,
not per-origin, and `FileSystemFileHandle.createSyncAccessHandle()`
will throw `NoModificationAllowedError` on the second tab only after
the first one has the file open. Web Locks is the spec-blessed way to
elect a single writer across same-origin tabs before any handle is
even opened.

## Key APIs

| API | Where used |
|---|---|
| `navigator.locks.request(name, { mode, ifAvailable }, cb)` | Primary election |
| `navigator.locks.query()` | Lock-holder diagnostics |
| `BroadcastChannel('reelforge-project')` | Reader change-notification |
| `FileSystemSyncAccessHandle` | Primary's OPFS writes (worker) |
| `pagehide` / `beforeunload` | Voluntary lock release on close |

## Implementation Notes / Approach

- Each tab generates a short UUID identity on mount. On startup it
  calls `navigator.locks.request('reelforge-project', { mode:
  'exclusive', ifAvailable: true })`. If the callback runs, the tab is
  PRIMARY; the lock is held until the promise inside the callback
  resolves. A `release` flag plus a `Promise` is used so the lock can
  be released on user action.
- The PRIMARY tab spawns `writer.worker.ts`, which opens the OPFS file
  with `createSyncAccessHandle()`. The main thread debounces textarea
  input by 250 ms and posts `{ op: 'write', text }`. The worker writes,
  closes, reopens on every flush (handle reuse is fine but we close
  between flushes to keep the experiment honest about lock semantics)
  and posts back `{ op: 'wrote', at }`.
- After each successful write the PRIMARY tab broadcasts `{ kind:
  'updated', at }` on the channel.
- READER tabs subscribe to the channel and reload the OPFS file via
  `getFile()` / `text()` on every update message; they also poll once
  per second as a belt-and-braces fallback.
- A "Claim primary" button on a READER releases its standing request
  and re-issues a non-`ifAvailable` `navigator.locks.request` (waits)
  so it picks up the lock as soon as the previous PRIMARY closes.
- Cleanup: on `pagehide` the PRIMARY resolves its lock promise and
  terminates the worker.

## Success Criteria

1. Two tabs open simultaneously: the first labels itself PRIMARY, the
   second labels itself READER.
2. Typing in the PRIMARY textarea reflects in the READER pane within
   ~500 ms via the broadcast path.
3. Closing the PRIMARY tab releases the lock; the READER's "Claim
   primary" promotes it within one second.
4. `navigator.locks.query()` agrees with the on-screen role label.

## Foot-guns

- The lock is held only while the callback's returned promise is
  unresolved. A naive `await navigator.locks.request(...)` that runs
  to completion releases the lock immediately.
- `ifAvailable: true` resolves with `null` when the lock is held — do
  not treat that as an error path; it is how you detect "I am the
  reader."
- `BroadcastChannel` is not durable. If a reader misses a message
  (tab suspended) it must reconcile via OPFS state, not by buffering.
- `pagehide` may not fire on hard crash. The browser releases the lock
  automatically when the page is fully unloaded, but in-flight sync
  handles may take a moment to close — the new primary should retry
  open on `InvalidStateError`.
- Service Worker registration can also hold the lock if you ever move
  the writer there; pick one venue and stick with it.
