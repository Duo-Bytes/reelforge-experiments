# exp-01 · OPFS File System

## Purpose

Prove that we can ingest multi-GB video files into the **Origin Private File System** without RAM saturation, then perform native-speed byte-range reads from a Web Worker. OPFS is the storage foundation for every downstream experiment — get it wrong and nothing else works.

## Architecture

```
Main Thread (page.tsx, "use client")
├── <input type="file"> → File handle
├── postMessage({type:"INGEST", file, fileId}) → OPFSWorker
└── postMessage({type:"INGEST", file, fileId}) → IDBWorker (parallel baseline)

OPFSWorker (src/workers/opfs.worker.ts)
├── navigator.storage.estimate()                  # quota guard (file <= 80% remaining)
├── root.getFileHandle(fileId, {create:true})
├── fileHandle.createSyncAccessHandle()           # WORKER ONLY
├── loop: file.slice(off, off+4MB).arrayBuffer()
│        syncHandle.write(view, {at: off})
├── INGEST done -> keep handle in Map<fileId, handle>
├── BENCH -> 100 random 1MB reads, sorted samples -> median/p95/min/max
└── READ_RANGE -> returns Uint8Array via transferable

IDBWorker (src/workers/idb.worker.ts)
├── idb.openDB("exp01-idb-bench", 1) -> "blobs" store
├── INGEST -> db.put(STORE, file, fileId)         # whole Blob
└── BENCH -> blob.slice(off, off+1MB).arrayBuffer()
```

## Research notes

- **`createSyncAccessHandle()` is worker-only.** Throws `InvalidStateError` on main thread. No workaround.
- **Exclusive lock per file.** One worker owns the handle; all other workers go through it via postMessage.
- **`File` is structured-cloned across postMessage**, *not* transferable. Cheap because the bytes aren't copied — only the handle metadata.
- **Keep the handle open across reads.** `close() + reopen` adds ~5ms per call. Only close when the clip is deleted.
- **Quota** typically ~60% of free disk. Check `navigator.storage.estimate()` before writing.

## Files

| File | Purpose |
|---|---|
| `src/workers/opfs.worker.ts` | INGEST + READ_RANGE + BENCH + CLOSE |
| `src/workers/idb.worker.ts`  | IndexedDB baseline for read-speed comparison |
| `src/app/page.tsx`           | Dual-store UI, progress bar, benchmark panel |
| `next.config.ts`             | COOP / COEP headers |

## Run

```bash
pnpm --filter exp-01-opfs dev   # http://localhost:3000
```

## Success criteria (measure in Chrome DevTools)

| Metric | Target |
|---|---|
| 1GB ingest | < 15s |
| OPFS 1MB random read | < 5ms median |
| IDB 1MB random read | > 15ms median |
| Main-thread CPU during ingest | < 5% |
| RAM delta during ingest | < 50MB |
