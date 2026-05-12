'use client'

import { useEffect, useRef, useState } from 'react'

type WorkerOut =
  | { type: 'PROGRESS'; reqId: string; percent: number }
  | { type: 'INGEST_DONE'; reqId: string; fileId: string; size: number; elapsedMs: number }
  | { type: 'READ_RESULT'; reqId: string; fileId: string; bytes: Uint8Array }
  | { type: 'BENCH_RESULT'; reqId: string; label: 'opfs' | 'idb'; samples: number[] }
  | { type: 'QUOTA_RESULT'; reqId: string; quota: number; usage: number }
  | { type: 'STORE_IDB_DONE'; reqId: string; fileId: string }
  | { type: 'DELETE_DONE'; reqId: string; fileId: string }
  | { type: 'ERROR'; reqId: string; message: string }

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
function p95(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0
}
function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  return `${(n / 1024 ** 3).toFixed(2)} GiB`
}

export default function OPFSExperiment() {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<string, (msg: WorkerOut) => void>>(new Map())

  const [fileId, setFileId] = useState<string | null>(null)
  const [fileSize, setFileSize] = useState(0)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState<string>('idle')
  const [ingestMs, setIngestMs] = useState<number | null>(null)
  const [quota, setQuota] = useState<{ quota: number; usage: number } | null>(null)
  const [opfsSamples, setOpfsSamples] = useState<number[] | null>(null)
  const [idbSamples, setIdbSamples] = useState<number[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = new Worker(new URL('../workers/opfs.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data
      if (msg.type === 'PROGRESS') {
        setProgress(msg.percent)
        return
      }
      const cb = pendingRef.current.get(msg.reqId)
      if (cb) {
        pendingRef.current.delete(msg.reqId)
        cb(msg)
      }
    }
    return () => {
      w.terminate()
      workerRef.current = null
    }
  }, [])

  function request<T extends WorkerOut>(msg: { type: string } & Record<string, unknown>): Promise<T> {
    const w = workerRef.current
    if (!w) return Promise.reject(new Error('worker not ready'))
    const reqId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      pendingRef.current.set(reqId, (out) => {
        if (out.type === 'ERROR') reject(new Error(out.message))
        else resolve(out as T)
      })
      w.postMessage({ ...msg, reqId })
    })
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    setStatus(`ingesting ${file.name} (${fmtBytes(file.size)})…`)
    setProgress(0)
    setIngestMs(null)
    setOpfsSamples(null)
    setIdbSamples(null)
    const id = crypto.randomUUID()
    try {
      const done = await request<{ type: 'INGEST_DONE'; reqId: string; fileId: string; size: number; elapsedMs: number }>(
        { type: 'INGEST', file, fileId: id }
      )
      setFileId(done.fileId)
      setFileSize(done.size)
      setIngestMs(done.elapsedMs)
      setStatus(`ingested ${fmtBytes(done.size)} in ${done.elapsedMs.toFixed(0)} ms`)
      // store the same file in IDB for the baseline benchmark
      setStatus((s) => s + ' — staging IDB baseline…')
      await request({ type: 'STORE_IDB', file, fileId: id })
      setStatus((s) => s.replace(' — staging IDB baseline…', ' — IDB baseline ready'))
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
      // reset the input so re-selecting the same file fires onChange
      e.target.value = ''
    }
  }

  async function checkQuota() {
    const r = await request<{ type: 'QUOTA_RESULT'; reqId: string; quota: number; usage: number }>({ type: 'QUOTA' })
    setQuota({ quota: r.quota, usage: r.usage })
  }

  async function runBench() {
    if (!fileId) return
    setBusy(true)
    setStatus('benchmarking…')
    const iters = 100
    const chunkBytes = 1024 * 1024
    try {
      const opfs = await request<{ type: 'BENCH_RESULT'; reqId: string; label: 'opfs'; samples: number[] }>(
        { type: 'BENCH_OPFS', fileId, iters, chunkBytes }
      )
      setOpfsSamples(opfs.samples)
      const idb = await request<{ type: 'BENCH_RESULT'; reqId: string; label: 'idb'; samples: number[] }>(
        { type: 'BENCH_IDB', fileId, iters, chunkBytes }
      )
      setIdbSamples(idb.samples)
      setStatus(`benchmark done (${iters} × 1 MiB reads each)`)
    } catch (err) {
      setStatus(`bench error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function clearAll() {
    if (!fileId) return
    setBusy(true)
    await request({ type: 'DELETE', fileId })
    setFileId(null)
    setFileSize(0)
    setOpfsSamples(null)
    setIdbSamples(null)
    setIngestMs(null)
    setStatus('cleared')
    setBusy(false)
  }

  const opfsMed = opfsSamples ? median(opfsSamples) : null
  const opfsP95 = opfsSamples ? p95(opfsSamples) : null
  const idbMed = idbSamples ? median(idbSamples) : null
  const idbP95 = idbSamples ? p95(idbSamples) : null
  const speedup = opfsMed && idbMed ? idbMed / opfsMed : null

  return (
    <main className="mx-auto max-w-3xl p-8 font-mono text-sm">
      <h1 className="mb-1 text-2xl font-bold">Exp-01 · OPFS File System</h1>
      <p className="mb-6 text-zinc-500">
        Ingest a multi-GB video into OPFS without saturating RAM, then benchmark byte-range reads
        against an IndexedDB baseline. All disk I/O runs in a dedicated worker.
      </p>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <label className="block">
          <span className="block pb-2 font-semibold">Pick a file (video or any large binary)</span>
          <input type="file" onChange={onFileChange} disabled={busy} />
        </label>
        {progress > 0 && progress < 100 && (
          <progress value={progress} max={100} className="mt-3 w-full" />
        )}
        <p className="mt-3">
          <span className="text-zinc-500">status:</span> {status}
        </p>
        {ingestMs != null && (
          <p>
            <span className="text-zinc-500">ingest:</span> {fmtBytes(fileSize)} in{' '}
            {ingestMs.toFixed(0)} ms ({((fileSize / 1024 / 1024) / (ingestMs / 1000)).toFixed(1)} MiB/s)
          </p>
        )}
      </section>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="mb-3 font-semibold">Quota</h2>
        <button
          onClick={checkQuota}
          disabled={busy}
          className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
        >
          navigator.storage.estimate()
        </button>
        {quota && (
          <p className="mt-3">
            usage {fmtBytes(quota.usage)} / quota {fmtBytes(quota.quota)} ({((quota.usage / quota.quota) * 100).toFixed(1)}%)
          </p>
        )}
      </section>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="mb-3 font-semibold">Benchmark — 100 random 1 MiB reads</h2>
        <button
          onClick={runBench}
          disabled={busy || !fileId}
          className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
        >
          run
        </button>
        <button
          onClick={clearAll}
          disabled={busy || !fileId}
          className="ml-2 rounded border border-zinc-400 px-3 py-1 disabled:opacity-50"
        >
          clear
        </button>
        {(opfsSamples || idbSamples) && (
          <table className="mt-4 w-full text-left">
            <thead>
              <tr className="border-b border-zinc-300 dark:border-zinc-700">
                <th className="py-1">backend</th>
                <th className="py-1">median</th>
                <th className="py-1">p95</th>
                <th className="py-1">target</th>
              </tr>
            </thead>
            <tbody>
              {opfsMed != null && (
                <tr>
                  <td className="py-1">OPFS sync handle</td>
                  <td>{opfsMed.toFixed(2)} ms</td>
                  <td>{opfsP95!.toFixed(2)} ms</td>
                  <td className="text-zinc-500">&lt; 5 ms median</td>
                </tr>
              )}
              {idbMed != null && (
                <tr>
                  <td className="py-1">IndexedDB blob.slice</td>
                  <td>{idbMed.toFixed(2)} ms</td>
                  <td>{idbP95!.toFixed(2)} ms</td>
                  <td className="text-zinc-500">&gt; 15 ms median</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {speedup != null && (
          <p className="mt-3">
            OPFS is <span className="font-semibold">{speedup.toFixed(1)}×</span> faster than IDB on this run.
          </p>
        )}
      </section>

      <section className="rounded border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-semibold">Manual verification checklist (Chrome 120+ desktop)</p>
        <ul className="ml-6 mt-2 list-disc">
          <li>1 GB file ingest finishes in &lt; 15 s</li>
          <li>OPFS median read &lt; 5 ms; IDB median &gt; 15 ms</li>
          <li>DevTools Performance: main-thread CPU stays &lt; 5 % during ingest</li>
          <li>RAM stays within ~50 MB of baseline during ingest (no full file buffered)</li>
          <li>Heap snapshot after 60 s shows no growth</li>
        </ul>
      </section>
    </main>
  )
}
