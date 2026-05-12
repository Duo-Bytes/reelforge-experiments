/// <reference lib="webworker" />

type IngestMsg = { type: 'INGEST'; reqId: string; file: File; fileId: string }
type ReadRangeMsg = { type: 'READ_RANGE'; reqId: string; fileId: string; offset: number; length: number }
type BenchOpfsMsg = { type: 'BENCH_OPFS'; reqId: string; fileId: string; iters: number; chunkBytes: number }
type BenchIdbMsg = { type: 'BENCH_IDB'; reqId: string; fileId: string; iters: number; chunkBytes: number }
type StoreIdbMsg = { type: 'STORE_IDB'; reqId: string; file: File; fileId: string }
type QuotaMsg = { type: 'QUOTA'; reqId: string }
type DeleteMsg = { type: 'DELETE'; reqId: string; fileId: string }

type InMsg =
  | IngestMsg
  | ReadRangeMsg
  | BenchOpfsMsg
  | BenchIdbMsg
  | StoreIdbMsg
  | QuotaMsg
  | DeleteMsg

const handles = new Map<string, FileSystemSyncAccessHandle>()

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const m = e.data
  try {
    switch (m.type) {
      case 'INGEST':
        await ingest(m); break
      case 'READ_RANGE':
        readRange(m); break
      case 'BENCH_OPFS':
        benchOpfs(m); break
      case 'STORE_IDB':
        await storeIdb(m); break
      case 'BENCH_IDB':
        await benchIdb(m); break
      case 'QUOTA':
        await quota(m); break
      case 'DELETE':
        await del(m); break
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', reqId: m.reqId, message: (err as Error).message })
  }
}

async function ingest(m: IngestMsg) {
  const t0 = performance.now()
  const root = await navigator.storage.getDirectory()
  const fileHandle = await root.getFileHandle(m.fileId, { create: true })
  const sync = await fileHandle.createSyncAccessHandle()
  sync.truncate(0)

  const CHUNK = 4 * 1024 * 1024 // 4 MiB
  let offset = 0
  while (offset < m.file.size) {
    const slice = m.file.slice(offset, Math.min(offset + CHUNK, m.file.size))
    const ab = await slice.arrayBuffer()
    sync.write(new Uint8Array(ab), { at: offset })
    offset += ab.byteLength
    self.postMessage({ type: 'PROGRESS', reqId: m.reqId, percent: (offset / m.file.size) * 100 })
  }
  sync.flush()
  handles.set(m.fileId, sync)
  const elapsedMs = performance.now() - t0
  self.postMessage({ type: 'INGEST_DONE', reqId: m.reqId, fileId: m.fileId, size: m.file.size, elapsedMs })
}

function readRange(m: ReadRangeMsg) {
  const h = handles.get(m.fileId)
  if (!h) throw new Error(`no open handle for ${m.fileId}`)
  const buf = new Uint8Array(m.length)
  const n = h.read(buf, { at: m.offset })
  // Transfer the underlying buffer back to caller
  self.postMessage(
    { type: 'READ_RESULT', reqId: m.reqId, fileId: m.fileId, bytes: buf.subarray(0, n) },
    [buf.buffer]
  )
}

function benchOpfs(m: BenchOpfsMsg) {
  const h = handles.get(m.fileId)
  if (!h) throw new Error(`no open handle for ${m.fileId}`)
  const size = h.getSize()
  const buf = new Uint8Array(m.chunkBytes)
  const samples: number[] = []
  for (let i = 0; i < m.iters; i++) {
    const maxOffset = Math.max(0, size - m.chunkBytes)
    const off = Math.floor(Math.random() * maxOffset)
    const t = performance.now()
    h.read(buf, { at: off })
    samples.push(performance.now() - t)
  }
  self.postMessage({ type: 'BENCH_RESULT', reqId: m.reqId, label: 'opfs', samples })
}

// ---------- IndexedDB baseline (whole-blob storage, slice on read) ----------

const IDB_DB = 'exp01-baseline'
const IDB_STORE = 'blobs'

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db: IDBDatabase, key: string, value: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function idbGet(db: IDBDatabase, key: string): Promise<Blob | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const r = tx.objectStore(IDB_STORE).get(key)
    r.onsuccess = () => resolve(r.result as Blob | undefined)
    r.onerror = () => reject(r.error)
  })
}

async function storeIdb(m: StoreIdbMsg) {
  const db = await openIdb()
  await idbPut(db, m.fileId, m.file)
  db.close()
  self.postMessage({ type: 'STORE_IDB_DONE', reqId: m.reqId, fileId: m.fileId })
}

async function benchIdb(m: BenchIdbMsg) {
  const db = await openIdb()
  const samples: number[] = []
  for (let i = 0; i < m.iters; i++) {
    const t = performance.now()
    const blob = await idbGet(db, m.fileId)
    if (!blob) throw new Error('idb blob missing')
    const maxOffset = Math.max(0, blob.size - m.chunkBytes)
    const off = Math.floor(Math.random() * maxOffset)
    await blob.slice(off, off + m.chunkBytes).arrayBuffer()
    samples.push(performance.now() - t)
  }
  db.close()
  self.postMessage({ type: 'BENCH_RESULT', reqId: m.reqId, label: 'idb', samples })
}

async function quota(m: QuotaMsg) {
  const est = await navigator.storage.estimate()
  self.postMessage({ type: 'QUOTA_RESULT', reqId: m.reqId, quota: est.quota ?? 0, usage: est.usage ?? 0 })
}

async function del(m: DeleteMsg) {
  handles.get(m.fileId)?.close()
  handles.delete(m.fileId)
  const root = await navigator.storage.getDirectory()
  try { await root.removeEntry(m.fileId) } catch {}
  self.postMessage({ type: 'DELETE_DONE', reqId: m.reqId, fileId: m.fileId })
}

export {}
