# Exp-01 · OPFS File System

## Goal

Ingest a multi-GB video file from a `<input type="file">` into the Origin Private File System (OPFS) without loading it into RAM, then demonstrate byte-range reads at native I/O speed from a Web Worker.

This is the storage foundation. Every subsequent experiment reads media from OPFS — get this wrong and everything downstream is broken.

---

## App Location

`apps/exp-01-opfs/`

## Why This Matters in the Full NLE

Loading a 4K video into RAM via `FileReader` or a `Blob` URL kills the browser tab. OPFS gives us:
- Disk-speed random access (4× faster than IndexedDB for reads)
- `FileSystemSyncAccessHandle` for synchronous byte-range reads inside workers — no async overhead in the hot decode path
- An exclusive lock per file — safe for multi-worker access patterns

---

## Key APIs

| API | Where Used |
|---|---|
| `navigator.storage.getDirectory()` | Get OPFS root — worker only |
| `FileSystemDirectoryHandle.getFileHandle(name, {create: true})` | Create/open file in OPFS |
| `FileSystemFileHandle.createSyncAccessHandle()` | Get low-level sync R/W handle — **worker only** |
| `FileSystemSyncAccessHandle.write(buffer, {at: offset})` | Write bytes at offset |
| `FileSystemSyncAccessHandle.read(buffer, {at: offset})` | Read bytes at offset |
| `FileSystemSyncAccessHandle.getSize()` | Total file size |
| `FileSystemSyncAccessHandle.flush()` | Flush to disk |
| `FileSystemSyncAccessHandle.close()` | Release exclusive lock |
| `navigator.storage.estimate()` | Check available OPFS quota |

---

## Architecture

```
Main Thread
├── <input type="file"> → File object
├── postMessage({type: 'INGEST', file}, []) to OPFSWorker
└── receives progress events back

OPFSWorker (dedicated worker)
├── navigator.storage.getDirectory()
├── getFileHandle(name, {create: true})
├── createSyncAccessHandle()
├── Loop: read 4MB chunks from File via FileReaderSync, write to OPFS at offset
├── postMessage({type: 'PROGRESS', percent}) back to main thread
└── on complete: postMessage({type: 'DONE', fileId})
```

**Why copy-in instead of reading the original `File` directly?**
The `FileSystemSyncAccessHandle` only works on OPFS files. The user's original `File` object from the input doesn't support sync byte-range reads or exclusive locking. Copying to OPFS once unlocks all downstream fast-path reads.

---

## Implementation Steps

### 1. Scaffold the Next.js app

```bash
cd apps/
pnpm create next-app exp-01-opfs --typescript --tailwind --app --src-dir --eslint --no-import-alias
cd ..
pnpm install
```

> Next.js 16+ uses Turbopack by default — no `--turbopack` flag.

Apply the shared `next.config.ts` from the root README.

### 2. Create the OPFS worker (`src/workers/opfs.worker.ts`)

```ts
// This file runs in a dedicated worker — 'use client' not needed here

interface IngestMsg { type: 'INGEST'; file: File; fileId: string }
interface ReadRangeMsg { type: 'READ_RANGE'; fileId: string; offset: number; length: number }

self.onmessage = async (e: MessageEvent<IngestMsg | ReadRangeMsg>) => {
  if (e.data.type === 'INGEST') {
    await ingestFile(e.data.file, e.data.fileId)
  } else if (e.data.type === 'READ_RANGE') {
    const bytes = readRange(e.data.fileId, e.data.offset, e.data.length)
    self.postMessage({ type: 'READ_RESULT', fileId: e.data.fileId, bytes }, [bytes.buffer])
  }
}

const handles = new Map<string, FileSystemSyncAccessHandle>()

async function ingestFile(file: File, fileId: string) {
  const root = await navigator.storage.getDirectory()
  const fileHandle = await root.getFileHandle(fileId, { create: true })
  const syncHandle = await fileHandle.createSyncAccessHandle()

  const CHUNK = 4 * 1024 * 1024 // 4MB
  let offset = 0

  while (offset < file.size) {
    const slice = file.slice(offset, offset + CHUNK)
    const buffer = await slice.arrayBuffer()
    syncHandle.write(new Uint8Array(buffer), { at: offset })
    offset += buffer.byteLength
    self.postMessage({ type: 'PROGRESS', percent: (offset / file.size) * 100 })
  }

  syncHandle.flush()
  handles.set(fileId, syncHandle)
  // Keep handle open for future reads — close only when clip is deleted
  self.postMessage({ type: 'DONE', fileId, size: file.size })
}

function readRange(fileId: string, offset: number, length: number): Uint8Array {
  const handle = handles.get(fileId)
  if (!handle) throw new Error(`No open handle for ${fileId}`)
  const buf = new Uint8Array(length)
  handle.read(buf, { at: offset })
  return buf
}
```

### 3. Create the page component (`src/app/page.tsx`)

```tsx
'use client'
import { useEffect, useRef, useState } from 'react'

export default function OPFSExperiment() {
  const workerRef = useRef<Worker | null>(null)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState<string>('idle')

  useEffect(() => {
    if (typeof window === 'undefined') return
    workerRef.current = new Worker(
      new URL('../workers/opfs.worker.ts', import.meta.url)
    )
    workerRef.current.onmessage = (e) => {
      if (e.data.type === 'PROGRESS') setProgress(e.data.percent)
      if (e.data.type === 'DONE') setStatus(`Done — ${e.data.size} bytes in OPFS`)
    }
    return () => workerRef.current?.terminate()
  }, [])

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !workerRef.current) return
    setStatus('ingesting...')
    workerRef.current.postMessage({ type: 'INGEST', file, fileId: crypto.randomUUID() })
    // Note: File objects are NOT transferable — they are structured-cloned automatically
  }

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-4">Exp-01: OPFS</h1>
      <input type="file" accept="video/*" onChange={onFileChange} />
      <p>{status}</p>
      <progress value={progress} max={100} className="w-full mt-4" />
    </main>
  )
}
```

### 4. Benchmark: compare OPFS vs IndexedDB read speed

Add a "Read 1MB at random offset" button to the UI. Time 100 reads with `performance.now()`. Also create a parallel IndexedDB version using `idb` library to store the same file as a single Blob. Compare median read latency.

Expected result: OPFS ~4× faster for large binary reads.

---

## Critical Gotchas

**`createSyncAccessHandle()` is worker-only.**
Calling it on the main thread throws `InvalidStateError: createSyncAccessHandle is only accessible from a dedicated worker`. There is no workaround — the sync handle must live in a worker.

**Exclusive lock.**
`createSyncAccessHandle()` gives one exclusive lock per file. If the decode worker already holds a handle open and a second worker tries to open the same file, it will block (or throw depending on Chrome version). Design: one worker owns all OPFS file handles and other workers request reads via postMessage.

**OPFS quota.**
Check `(await navigator.storage.estimate()).quota` before ingesting. Typically 60% of available disk. If the video is larger than remaining quota, the write will throw `QuotaExceededError`. Show the user a warning if `file.size > quota * 0.8`.

**`File` object is NOT transferable.**
You cannot put a `File` in the transferables array of `postMessage`. It is structured-cloned automatically. This means large files are fine to pass by reference (the `File` object is just a handle) but the actual bytes are read by the worker's `file.slice().arrayBuffer()` calls — not copied up front.

**Keep the handle open.**
Do not call `syncHandle.close()` after ingest. Keep it open in the `handles` Map. Closing and reopening on every read call adds ~5ms overhead per call. Close only when the user deletes the clip.

---

## Success Criteria

| Metric | Target |
|---|---|
| 1GB file ingest to OPFS | < 15 seconds |
| 1MB byte-range read (OPFS) | < 5ms |
| 1MB byte-range read (IndexedDB baseline) | > 15ms |
| Main thread CPU during ingest | < 5% (all work in worker) |
| RAM during ingest | < 50MB above baseline (no full file in RAM) |

Measure all of these in Chrome DevTools → Performance → Record.

---

## Feeds Into

- **Exp-02** uses `READ_RANGE` messages to feed chunks to the demuxer
- **Exp-07** writes proxy files back to OPFS using the same `SyncAccessHandle`
- **Exp-10** streams encoded chunks back to OPFS during export
