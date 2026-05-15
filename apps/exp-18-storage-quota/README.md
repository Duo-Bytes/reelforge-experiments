# exp-18 · Storage Quota & Eviction Drill

## Purpose

Prove that the editor can survive `QuotaExceededError`. A Web Worker
fills OPFS with fixed-size chunks until the browser refuses the next
write; the worker then deletes the lowest-index chunk (LRU) and
retries. The main thread polls `navigator.storage.estimate()` and
shows usage / quota / `usageDetails` live, plus a one-click
`persist()` request.

## Running

```
pnpm --filter exp-18-storage-quota dev
```

Open `http://localhost:3000`. The page works in any Chromium 120+
build. Firefox / Safari have OPFS but no `FileSystemSyncAccessHandle`
in workers across all versions; the page degrades to a warning.

## What to look for in the UI

- **Estimate panel**: `usage`, `quota`, `usage / quota`, and (when
  Chrome exposes them) `usageDetails.fileSystem`. Numbers tick up
  every 500 ms while a run is active.
- **Persistence pill**: shows current `persisted()` state. Click
  "Request persist" to upgrade.
- **Fill controls**: pick a chunk size (1 / 4 / 8 / 16 MiB) and Start
  to begin a continuous write loop. Stop halts cleanly.
- **Event log**: each chunk write, every eviction, every retry.
- **Warning bar**: appears red when `usage / quota > 0.8`.

## Success bar

1. Run hits at least one `QuotaExceededError` and the loop continues
   after evicting the oldest chunk.
2. Numbers in the estimate panel match the worker's reported chunk
   count to within rounding (Chrome rounds for privacy).
3. `persist()` flips `persisted()` to `true` on a real user gesture
   on an "engaged" origin (or to `false` cleanly otherwise).
4. Stop and unmount leave no orphaned files — reload and the OPFS
   directory listing is empty.

## Foot-guns covered

- Sync access handles only work in workers.
- `QuotaExceededError` is a `DOMException`, not a constructor;
  detect by `.name`.
- `estimate()` lags real writes by hundreds of ms.
- `persist()` must run inside a user-gesture event.
- Close every handle in a `finally` or the next open throws
  `NoModificationAllowedError`.
