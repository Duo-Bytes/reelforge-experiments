'use client'

import { useEffect, useRef, useState } from 'react'

type WorkerOut =
  | { type: 'INGEST_PROGRESS'; reqId: string; percent: number }
  | { type: 'TRANSCODE_PROGRESS'; reqId: string; percent: number; framesProcessed: number; totalFrames: number }
  | { type: 'INGEST_DONE'; reqId: string; fileId: string; size: number; width: number; height: number; durationUs: number; fps: number; frameCount: number; codec: string }
  | { type: 'TRANSCODE_DONE'; reqId: string; proxyFileId: string; proxySize: number; width: number; height: number; elapsedMs: number; sourceDurationUs: number; framesEncoded: number }
  | { type: 'PROXY_BLOB'; reqId: string; blob: Blob }
  | { type: 'PROXIES_LIST'; reqId: string; items: Array<Record<string, unknown>> }
  | { type: 'DELETE_DONE'; reqId: string; fileId: string }
  | { type: 'ENCODER_ERROR'; message: string }
  | { type: 'ERROR'; reqId: string; message: string }

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  return `${(n / 1024 ** 3).toFixed(2)} GiB`
}

export default function ProxyPage() {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<string, (msg: WorkerOut) => void>>(new Map())
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('idle')
  const [ingestPct, setIngestPct] = useState(0)
  const [transcodePct, setTranscodePct] = useState(0)
  const [framesProcessed, setFramesProcessed] = useState(0)

  const [source, setSource] = useState<Extract<WorkerOut, { type: 'INGEST_DONE' }> | null>(null)
  const [proxy, setProxy] = useState<Extract<WorkerOut, { type: 'TRANSCODE_DONE' }> | null>(null)

  const [targetHeight, setTargetHeight] = useState(720)
  const [bitrateMbps, setBitrateMbps] = useState(2)
  const [keyEvery, setKeyEvery] = useState(true)

  const [proxyList, setProxyList] = useState<Array<Record<string, unknown>> | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = new Worker(new URL('../workers/proxy.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data
      if (m.type === 'INGEST_PROGRESS') { setIngestPct(m.percent); return }
      if (m.type === 'TRANSCODE_PROGRESS') {
        setTranscodePct(m.percent)
        setFramesProcessed(m.framesProcessed)
        return
      }
      if (m.type === 'ENCODER_ERROR') { setStatus(`encoder error: ${m.message}`); return }
      const cb = pendingRef.current.get(m.reqId)
      if (cb) { pendingRef.current.delete(m.reqId); cb(m) }
    }
    return () => { w.terminate(); workerRef.current = null }
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
    setSource(null); setProxy(null); setIngestPct(0); setTranscodePct(0); setFramesProcessed(0)
    setStatus(`ingesting ${file.name}…`)
    const id = crypto.randomUUID()
    try {
      const done = await request<Extract<WorkerOut, { type: 'INGEST_DONE' }>>({ type: 'INGEST', file, fileId: id })
      setSource(done)
      setStatus(`source ready: ${done.codec} ${done.width}×${done.height} @ ${done.fps} fps, ${(done.durationUs / 1_000_000).toFixed(2)} s`)
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`)
    } finally { setBusy(false); e.target.value = '' }
  }

  async function transcode() {
    if (!source) return
    setBusy(true)
    setStatus('transcoding to proxy…')
    setTranscodePct(0); setFramesProcessed(0)
    try {
      const done = await request<Extract<WorkerOut, { type: 'TRANSCODE_DONE' }>>({
        type: 'TRANSCODE',
        sourceFileId: source.fileId,
        targetHeight,
        bitrate: bitrateMbps * 1_000_000,
        keyEveryFrame: keyEvery,
      })
      setProxy(done)
      const realSec = done.sourceDurationUs / 1_000_000
      const speedX = realSec / (done.elapsedMs / 1000)
      setStatus(`proxy ready: ${fmtBytes(done.proxySize)} in ${(done.elapsedMs / 1000).toFixed(1)} s — ${speedX.toFixed(2)}× real-time`)
    } catch (err) {
      setStatus(`transcode error: ${(err as Error).message}`)
    } finally { setBusy(false) }
  }

  async function playProxy() {
    if (!proxy) return
    const r = await request<Extract<WorkerOut, { type: 'PROXY_BLOB' }>>({ type: 'READ_PROXY', proxyFileId: proxy.proxyFileId })
    const url = URL.createObjectURL(r.blob)
    if (videoRef.current) videoRef.current.src = url
  }

  async function listProxies() {
    const r = await request<Extract<WorkerOut, { type: 'PROXIES_LIST' }>>({ type: 'LIST_PROXIES' })
    setProxyList(r.items)
  }

  async function clearAll() {
    if (!source) return
    setBusy(true)
    await request({ type: 'DELETE', fileId: source.fileId, proxyFileId: proxy?.proxyFileId })
    setSource(null); setProxy(null); setIngestPct(0); setTranscodePct(0); setStatus('cleared')
    setBusy(false)
  }

  return (
    <main className="mx-auto max-w-3xl p-8 font-mono text-sm">
      <h1 className="mb-1 text-2xl font-bold">Exp-07 · Proxy Workflow</h1>
      <p className="mb-6 text-zinc-500">
        Source → OPFS → mp4box demux → VideoDecoder → OffscreenCanvas scale → VideoEncoder →
        mediabunny EncodedVideoPacketSource → streaming MP4 muxer → OPFS proxy file. Proxy
        metadata is stored in IndexedDB via <code>idb</code>.
      </p>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <label className="block">
          <span className="block pb-2 font-semibold">Source MP4</span>
          <input type="file" accept="video/mp4,video/*" onChange={onFileChange} disabled={busy} />
        </label>
        {ingestPct > 0 && ingestPct < 100 && <progress value={ingestPct} max={100} className="mt-3 w-full" />}
        <p className="mt-3"><span className="text-zinc-500">status:</span> {status}</p>
        {source && (
          <table className="mt-3 w-full text-left">
            <tbody>
              <tr><td className="w-48 text-zinc-500">codec</td><td>{source.codec}</td></tr>
              <tr><td className="text-zinc-500">resolution</td><td>{source.width} × {source.height}</td></tr>
              <tr><td className="text-zinc-500">duration</td><td>{(source.durationUs / 1_000_000).toFixed(2)} s @ {source.fps} fps ({source.frameCount.toLocaleString()} frames)</td></tr>
              <tr><td className="text-zinc-500">size on disk</td><td>{fmtBytes(source.size)}</td></tr>
            </tbody>
          </table>
        )}
      </section>

      {source && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Proxy settings</h2>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2">
              <span className="text-zinc-500">target height</span>
              <select value={targetHeight} onChange={(e) => setTargetHeight(Number(e.target.value))} className="rounded border border-zinc-400 bg-transparent px-2 py-1">
                <option value={480}>480p</option>
                <option value={540}>540p</option>
                <option value={720}>720p</option>
                <option value={1080}>1080p</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-zinc-500">bitrate</span>
              <input type="number" min={0.5} max={20} step={0.5} value={bitrateMbps} onChange={(e) => setBitrateMbps(Number(e.target.value))} className="w-20 rounded border border-zinc-400 bg-transparent px-2 py-1" />
              <span>Mbps</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={keyEvery} onChange={(e) => setKeyEvery(e.target.checked)} />
              <span>keyframe every frame (instant seek)</span>
            </label>
          </div>
          <button onClick={transcode} disabled={busy} className="mt-3 rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black">
            transcode to proxy
          </button>
          <button onClick={clearAll} disabled={busy} className="ml-2 rounded border border-zinc-400 px-3 py-1 disabled:opacity-50">
            clear source + proxy
          </button>
          {transcodePct > 0 && transcodePct < 100 && (
            <>
              <progress value={transcodePct} max={100} className="mt-3 w-full" />
              <p className="text-zinc-500">{framesProcessed.toLocaleString()} / {source.frameCount.toLocaleString()} frames</p>
            </>
          )}
        </section>
      )}

      {proxy && source && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Proxy</h2>
          <table className="w-full text-left">
            <tbody>
              <tr><td className="w-48 text-zinc-500">file</td><td>{proxy.proxyFileId}</td></tr>
              <tr><td className="text-zinc-500">resolution</td><td>{proxy.width} × {proxy.height}</td></tr>
              <tr><td className="text-zinc-500">size</td><td>{fmtBytes(proxy.proxySize)} ({((proxy.proxySize / source.size) * 100).toFixed(1)}% of source)</td></tr>
              <tr><td className="text-zinc-500">elapsed</td><td>{(proxy.elapsedMs / 1000).toFixed(1)} s — {((proxy.sourceDurationUs / 1000) / proxy.elapsedMs).toFixed(2)}× real-time</td></tr>
              <tr><td className="text-zinc-500">frames encoded</td><td>{proxy.framesEncoded.toLocaleString()}</td></tr>
            </tbody>
          </table>
          <button onClick={playProxy} className="mt-3 rounded bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-black">
            load proxy into &lt;video&gt;
          </button>
          <video ref={videoRef} controls className="mt-3 w-full rounded border border-zinc-200 dark:border-zinc-800" />
        </section>
      )}

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="mb-3 font-semibold">IndexedDB proxy registry</h2>
        <button onClick={listProxies} className="rounded bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-black">refresh</button>
        {proxyList && (
          <pre className="mt-3 overflow-x-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
            {JSON.stringify(proxyList, null, 2)}
          </pre>
        )}
      </section>

      <section className="rounded border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-semibold">Manual verification checklist (Chrome 120+ desktop)</p>
        <ul className="ml-6 mt-2 list-disc">
          <li>30 s 1080p source → 720p proxy in &lt; 90 s</li>
          <li>Proxy loads in <code>&lt;video&gt;</code> and seeks instantly to any frame (keyEveryFrame=true)</li>
          <li>Visual spot-check at 5 random frames matches source</li>
          <li>Main thread CPU &lt; 2% during transcode (DevTools Performance)</li>
          <li>IndexedDB entry stored under <code>reelforge.proxies</code></li>
        </ul>
      </section>
    </main>
  )
}
