# Exp-18 · Storage Quota & Eviction Drill

## Goal

Drive an OPFS write loop until it hits `QuotaExceededError`, recover
gracefully via LRU eviction of older chunks, and surface live
`navigator.storage.estimate()` numbers in the UI. Request
`navigator.storage.persist()` at the moment a real project would (first
big write) and demonstrate the difference between a persistent and
non-persistent origin.

## App Location

`apps/exp-18-storage-quota/`

## Why This Matters in the Full NLE

A browser-native NLE caches proxy media, decoded frame tiles, waveform
peaks, and project journals — all in OPFS. Chrome lets a single origin
use up to 60% of the disk, but a non-persistent origin's data can be
evicted in one shot under storage pressure: "all of its data, not parts
of it, is deleted at the same time." Without an explicit quota strategy
the editor will silently lose every project at once.

## Key APIs

| API | Where used |
|---|---|
| `navigator.storage.estimate()` | Live usage / quota / `usageDetails` panel |
| `navigator.storage.persist()` | One-shot upgrade to persistent storage |
| `navigator.storage.persisted()` | Current state read |
| `StorageManager` | Top-level entry point |
| `FileSystemSyncAccessHandle.write()` | Fast OPFS writes from a worker |
| `QuotaExceededError` | The signal that triggers LRU eviction |

## Implementation Notes / Approach

- All OPFS writes happen in a Web Worker (`opfs.worker.ts`) using
  `FileSystemSyncAccessHandle`. The main thread posts `{ op, size,
  index }` messages; the worker reports `{ kind, payload }` back.
- Chunks are named `chunk-<index>.bin` with a fixed payload size
  (default 8 MB) so eviction is predictable.
- LRU is approximated by index order: the oldest surviving chunk is
  always the lowest index. On `QuotaExceededError` the worker deletes
  the lowest 3 chunks then retries the write.
- The main thread polls `navigator.storage.estimate()` every 500 ms
  during a run and renders usage, quota, free percent and (when
  available) `usageDetails.fileSystem` / `usageDetails.indexedDB`.
- `navigator.storage.persist()` is wired to a button; status is shown
  before and after. The UI warns when `used/quota > 0.8`.
- A Stop button sets an `AbortSignal`-style flag the worker checks
  between writes; on unmount the worker is terminated and any pending
  handles are released.

## Success Criteria

1. The Fill button drives usage upward in the live estimate panel
   until a `QuotaExceededError` is observed, at which point LRU
   eviction kicks in and writes continue.
2. `persist()` reports `true` after the user-gesture click and survives
   reloads.
3. Stop reliably halts the loop within one chunk write and closes the
   sync access handle.
4. Closing the tab during a run does not leave a stuck handle (next
   reload can open and remove the OPFS chunks).

## Foot-guns

- `FileSystemSyncAccessHandle` is worker-only. Calling it from the main
  thread silently degrades to `createWritable()` and you lose the
  back-pressure characteristics the experiment is trying to measure.
- The first `persist()` call must be inside a user gesture; calling it
  from a `useEffect` will return `false` without prompting.
- `estimate()` is heavily rounded for privacy — do not display
  byte-exact remaining space; round to MB and treat as a soft signal.
- Closing a sync access handle takes a tick; if you reopen the same
  file too quickly you get `InvalidStateError`. Await `close()` before
  the next open.
- LRU by index breaks if you ever rename or compact; in production the
  registry needs a proper access-time map persisted alongside the data.
- Eviction of non-persistent origins is silent and total. Always
  request `persist()` before the first big write the user cares about.
